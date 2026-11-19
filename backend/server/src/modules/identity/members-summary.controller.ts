import { Controller, Get, Inject, Query, Req } from "@nestjs/common";
import { assertAllowed, decodeNameCursor, encodeNameCursor, requirePrincipal } from "@workspace/service-kit";
import { withTransaction } from "@workspace/shared";
import type { Request } from "express";
import type { Pool } from "pg";
import { POOL } from "./identity.controller.js";

export interface MemberSummary {
  userId: string;
  displayName: string;
  status: string;
  /** 0 = no photo; otherwise the version in the photo's URL (`members/:id/avatar?v=`). */
  avatarVersion: number;
  /** Their "Tên gọi" when they chose one; chat shows it. Absent while it is still the default (the last word of the name). */
  nickname?: string;
}

type Row = Omit<MemberSummary, "nickname"> & { givenName: string | null };

/**
 * Accounts start with one word of the full name as their given name: the last in Vietnamese order ("Trần Minh Hưng" →
 * "Hưng"), the first from an import in Western order ("Maya Patel" → "Maya"). Only one the person
 * changed counts as a nickname, so two Hưngs are not both shown as "Hưng" by default.
 */
export function withNickname<T extends Row>({ givenName, ...m }: T): Omit<T, "givenName"> & { nickname?: string } {
  const given = givenName?.trim();
  const words = m.displayName.trim().split(/\s+/);
  return given && given !== words[0] && given !== words.at(-1) && given !== m.displayName.trim() ? { ...m, nickname: given } : m;
}

const COLS = `m.user_id AS "userId", m.display_name AS "displayName", m.status, m.avatar_version AS "avatarVersion", u.given_name AS "givenName"`;

/**
 * The directory the web shell needs for names and avatars, without roles or e-mails and without loading every
 * member on every page: a cursor-paged summary (`after`, `limit` ≤ 500, plus `ids` for the people a page mentions)
 * and a name search. The caller's own row is always included in the first page.
 */
@Controller()
export class MembersSummaryController {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  @Get("members/summary")
  async summary(@Req() req: Request, @Query("after") after?: string, @Query("limit") limit?: string, @Query("ids") ids?: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "member.read");
    const wanted = ids ? [...new Set(ids.split(",").filter(Boolean))].slice(0, 500) : null;
    const size = Math.min(Math.max(Number(limit) || 300, 1), 500);
    const cursor = after ? decodeNameCursor(after) : null;
    return withTransaction(this.pool, async (c) => {
      if (wanted) {
        const r = await c.query<Row>(`SELECT ${COLS} FROM members m LEFT JOIN users u ON u.id = m.user_id WHERE m.user_id = ANY($1::text[])`, [wanted]);
        return { members: r.rows.map(withNickname), nextCursor: null, total: null };
      }
      const [page, total] = await Promise.all([
        c.query<Row>(
          `SELECT ${COLS} FROM members m LEFT JOIN users u ON u.id = m.user_id
            WHERE ($1::text IS NULL OR (m.display_name, m.user_id) > ($1, $2)) ORDER BY m.display_name, m.user_id LIMIT $3`,
          [cursor?.name ?? null, cursor?.userId ?? null, size + 1],
        ),
        c.query<{ n: number }>("SELECT count(*)::int AS n FROM members WHERE status <> 'disabled'"),
      ]);
      const rows = (page.rows.length > size ? page.rows.slice(0, size) : page.rows).map(withNickname);
      const last = rows.at(-1);
      // The signed-in person is needed by every shell render (name, admin check): ship them with the first page.
      const meRow = (
        await c.query<Row & { isOwner: boolean; roles: string[] }>(
          `SELECT ${COLS}, m.is_owner AS "isOwner",
                  coalesce(array_agg(r.name ORDER BY r.name) FILTER (WHERE r.name IS NOT NULL), '{}') AS roles
             FROM members m
             LEFT JOIN users u ON u.id = m.user_id
             LEFT JOIN member_roles mr ON mr.user_id = m.user_id
             LEFT JOIN roles r ON r.id = mr.role_id
            WHERE m.user_id = $1 GROUP BY m.user_id, u.given_name`,
          [p.id],
        )
      ).rows[0];
      const me = meRow ? withNickname(meRow) : undefined;
      const others = cursor ? rows : rows.filter((m) => m.userId !== p.id);
      return {
        members: cursor || !me ? others : [...others, me],
        me: me ?? null,
        nextCursor: page.rows.length > size && last ? encodeNameCursor(last.displayName, last.userId) : null,
        total: total.rows[0]!.n,
      };
    });
  }

  @Get("members/search")
  async search(@Req() req: Request, @Query("q") q?: string, @Query("limit") limit?: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "member.read");
    const size = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const needle = (q ?? "").trim();
    if (!needle) return { members: [] };
    return withTransaction(this.pool, async (c) => ({
      members: (
        await c.query<Row>(
          `SELECT ${COLS} FROM members m LEFT JOIN users u ON u.id = m.user_id
            WHERE m.status <> 'disabled' AND (m.display_name ILIKE '%' || $1 || '%' OR m.email ILIKE $1 || '%' OR u.given_name ILIKE $1 || '%')
            ORDER BY m.display_name LIMIT $2`,
          [needle, size],
        )
      ).rows.map(withNickname),
    }));
  }
}
