import { createHash } from "node:crypto";
import { Body, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { newId } from "@workspace/shared";
import { assertAllowed, parse, pruneInBatches, requirePrincipal } from "@workspace/service-kit";
import { POOL } from "./common.js";

/** A stack frame as the web app resolved it (source-mapped when the build's maps were found, else the raw line). */
export const frameSchema = z.object({
  file: z.string().max(300),
  line: z.number().int().nonnegative().nullable(),
  col: z.number().int().nonnegative().nullable(),
  name: z.string().max(200).nullable(),
  /** The frame as the browser printed it, kept when the map did not resolve it. */
  raw: z.string().max(500).optional(),
});
export type Frame = z.infer<typeof frameSchema>;

export const reportSchema = z.object({
  code: z.string().regex(/^[A-Z0-9-]{4,40}$/),
  kind: z.enum(["boundary", "uncaught"]),
  message: z.string().min(1).max(500),
  stack: z.string().max(4000).nullish(),
  frames: z.array(frameSchema).max(12).default([]),
  route: z.string().max(120).nullish(),
  path: z.string().max(300).nullish(),
  userAgent: z.string().max(200).nullish(),
});

/**
 * One group per kind of error: the message with what changes from one occurrence to the next (ids, numbers,
 * quoted values, URLs) taken out, so "Cannot read properties of undefined (reading 'name')" from a hundred
 * people is one row of the admin's list, not a hundred.
 */
export function normalizeMessage(message: string): string {
  return message
    .trim()
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "<str>")
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/\b[0-9A-HJKMNP-TV-Z]{26}\b/g, "<id>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .slice(0, 300);
}

export const groupKey = (message: string): string => createHash("sha1").update(normalizeMessage(message)).digest("hex").slice(0, 16);

/** The browser family from a user-agent string, for the occurrences table ("Chrome", "Safari", …). */
export function browserName(ua: string | null | undefined): string | null {
  if (!ua) return null;
  if (/Edg\//.test(ua)) return "Edge";
  if (/OPR\/|Opera/.test(ua)) return "Opera";
  if (/Firefox\//.test(ua)) return "Firefox";
  if (/Chrome\/|CriOS\//.test(ua)) return "Chrome";
  if (/Safari\//.test(ua)) return "Safari";
  return null;
}

/** The list keeps 30 days (the error screen tells the person the admin can look the code up in that time). */
export const CLIENT_ERRORS_DAYS = 30;

/**
 * Errors browsers raise that break nothing for the person: a resize loop the browser recovers from, a request the page
 * cancelled while navigating (prefetch, unmount). Kept, but folded away so real errors stay on top.
 */
const BENIGN = [
  /ResizeObserver loop/i,
  /\bAbortError\b/,
  /aborted a request/i,
  /signal is aborted/i,
  /The operation was aborted/i,
  /NEXT_(REDIRECT|NOT_FOUND)/,
  /^Script error\.?$/,
];
export const isBenign = (message: string): boolean => BENIGN.some((r) => r.test(message));
const BATCH = 5000;

/** Rows older than `days`, in batches: the module's own role owns the table, no SECURITY DEFINER function needed. */
export async function pruneClientErrors(pool: Pool, days: number, budgetMs = 60_000): Promise<number> {
  return pruneInBatches(BATCH, budgetMs, async () => {
    const r = await pool.query(
      `DELETE FROM client_errors e USING (SELECT id FROM client_errors WHERE created_at < now() - make_interval(days => $1) ORDER BY created_at LIMIT $2) old WHERE e.id = old.id`,
      [Math.max(1, days), BATCH],
    );
    return r.rowCount ?? 0;
  });
}

interface Occurrence {
  id: string;
  code: string;
  kind: string;
  message: string;
  groupKey: string;
  stack: string | null;
  frames: Frame[];
  route: string | null;
  path: string | null;
  userId: string | null;
  browser: string | null;
  at: Date;
}

const COLUMNS = `id, code, kind, message, group_key AS "groupKey", stack, frames, route, path, user_id AS "userId", user_agent AS "userAgent", created_at AS at`;
const withBrowser = (r: Occurrence & { userAgent?: string | null }): Occurrence => {
  const { userAgent, ...rest } = r;
  return { ...rest, browser: browserName(userAgent) };
};

/**
 * Browser errors (Admin › Lỗi trình duyệt). The web app posts each one as the signed-in person (the gateway's
 * principal, never an id from the body); holders of `workspace.configure` read them grouped by message, by group,
 * or one by its code.
 */
@Controller("client-errors")
export class ClientErrorsController {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  @Post()
  @HttpCode(204)
  async record(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(reportSchema, body);
    await this.pool.query(
      `INSERT INTO client_errors (id, code, kind, message, group_key, stack, frames, route, path, user_id, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        newId(),
        b.code,
        b.kind,
        b.message,
        groupKey(b.message),
        b.stack ?? null,
        JSON.stringify(b.frames),
        b.route ?? null,
        b.path ?? null,
        p.type === "user" ? p.id : null,
        b.userAgent ?? null,
      ],
    );
  }

  @Get()
  async list(@Req() req: Request, @Query() query: Record<string, string>) {
    const p = requirePrincipal(req);
    assertAllowed(p, "workspace.configure");
    const q = parse(
      z.object({
        code: z.string().trim().toUpperCase().max(40).optional(),
        group: z
          .string()
          .regex(/^[0-9a-f]{16}$/)
          .optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
      query,
    );
    const since = `created_at > now() - make_interval(days => ${CLIENT_ERRORS_DAYS})`;
    if (q.code) {
      const row = (await this.pool.query<Occurrence>(`SELECT ${COLUMNS} FROM client_errors WHERE code = $1 ORDER BY created_at DESC LIMIT 1`, [q.code])).rows[0];
      if (!row) throw new NotFoundException({ error: "not_found", message: "no error with this code" });
      return { occurrence: withBrowser(row) };
    }
    if (q.group) {
      const rows = (
        await this.pool.query<Occurrence>(`SELECT ${COLUMNS} FROM client_errors WHERE group_key = $1 AND ${since} ORDER BY created_at DESC LIMIT $2`, [q.group, q.limit])
      ).rows;
      return { occurrences: rows.map(withBrowser) };
    }
    const rows = (
      await this.pool.query<{
        groupKey: string;
        message: string;
        kind: string;
        count: number;
        users: number;
        firstAt: Date;
        lastAt: Date;
        routes: string[];
        lastCode: string;
        resolvedAt: Date | null;
      }>(
        `SELECT e.group_key AS "groupKey",
                (array_agg(message ORDER BY created_at DESC))[1] AS message,
                (array_agg(kind ORDER BY created_at DESC))[1] AS kind,
                (array_agg(code ORDER BY created_at DESC))[1] AS "lastCode",
                count(*)::int AS count,
                count(DISTINCT user_id)::int AS users,
                min(created_at) AS "firstAt", max(created_at) AS "lastAt",
                (SELECT array_agg(DISTINCT r) FROM unnest(array_agg(route)) AS r WHERE r IS NOT NULL) AS routes,
                g.resolved_at AS "resolvedAt"
           FROM client_errors e LEFT JOIN client_error_groups g ON g.group_key = e.group_key
          WHERE e.${since}
          GROUP BY e.group_key, g.resolved_at ORDER BY max(e.created_at) DESC LIMIT $1`,
        [q.limit],
      )
    ).rows;
    const groups = rows.map((r) => ({
      ...r,
      routes: r.routes ?? [],
      benign: isBenign(r.message),
      // Resolved while nothing came after the admin marked it; a newer occurrence reopens it.
      status: r.resolvedAt && r.lastAt <= r.resolvedAt ? ("resolved" as const) : r.resolvedAt ? ("reopened" as const) : ("open" as const),
    }));
    const counts = { open: 0, resolved: 0, benign: 0 };
    for (const g of groups) counts[g.benign ? "benign" : g.status === "resolved" ? "resolved" : "open"]++;
    return { groups, counts, days: CLIENT_ERRORS_DAYS };
  }

  /** Marks a kind of error as handled (the fix shipped); a later occurrence reopens it on its own. */
  @Post("groups/:key/resolve")
  @HttpCode(204)
  async resolve(@Req() req: Request, @Param("key") key: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "workspace.configure");
    if (!/^[0-9a-f]{16}$/.test(key)) throw new NotFoundException();
    await this.pool.query(
      `INSERT INTO client_error_groups (group_key, resolved_at, resolved_by) VALUES ($1, now(), $2)
       ON CONFLICT (group_key) DO UPDATE SET resolved_at = now(), resolved_by = $2`,
      [key, p.id],
    );
  }

  @Delete("groups/:key/resolve")
  @HttpCode(204)
  async reopen(@Req() req: Request, @Param("key") key: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "workspace.configure");
    await this.pool.query("DELETE FROM client_error_groups WHERE group_key = $1", [key]);
  }
}
