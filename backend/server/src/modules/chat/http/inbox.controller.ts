import { Body, Controller, Get, Param, Post, Req } from "@nestjs/common";
import { assertAllowed, parse, requirePrincipal } from "@workspace/service-kit";
import { withTransaction } from "@workspace/shared";
import type { Request } from "express";
import { z } from "zod";
import { assertMember, selectMessages } from "../domain.js";

import { ChatControllerBase } from "./base.controller.js";
import { channelNames, guard } from "./common.js";

/** Read state and the cross-channel views: threads I follow, mentions, mark read / unread. */
@Controller()
export class InboxController extends ChatControllerBase {
  /** Read state is monotonic: an older seq from a stale tab never moves it back. */
  @Post("channels/:id/read")
  async read(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(z.object({ seq: z.number().int().nonnegative() }), body);
    const res = await guard(() =>
      withTransaction(this.pool, async (c) => {
        await assertMember(c, p, id);
        const u = await c.query<{ last_read_seq: string; last_seq: string }>(
          `UPDATE channel_members cm SET last_read_seq = GREATEST(cm.last_read_seq, LEAST($3, ch.last_seq))
           FROM channels ch WHERE ch.id = cm.channel_id AND cm.channel_id = $1 AND cm.user_id = $2
         RETURNING cm.last_read_seq, ch.last_seq`,
          [id, p.id, b.seq],
        );
        const kind = (await c.query<{ kind: string }>("SELECT kind FROM channels WHERE id = $1", [id])).rows[0]?.kind;
        return { lastReadSeq: Number(u.rows[0]!.last_read_seq), unread: Number(u.rows[0]!.last_seq) - Number(u.rows[0]!.last_read_seq), direct: kind === "dm" || kind === "group" };
      }),
    );
    const { direct, ...r } = res;
    // Other devices of the same user clear their badge.
    this.rt.toUser(p.id, "read.updated", { channelId: id, ...r });
    // In direct and group messages the others see "Đã xem" move.
    if (direct) this.rt.toChannel(id, "read.cursor", { channelId: id, userId: p.id, seq: r.lastReadSeq });
    return r;
  }

  /** "Mark unread from here": moves the read cursor back to just before `seq` (the only way it may go backwards). */
  @Post("channels/:id/unread")
  async markUnread(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(z.object({ seq: z.number().int().positive() }), body);
    const r = await guard(() =>
      withTransaction(this.pool, async (c) => {
        await assertMember(c, p, id);
        const u = await c.query<{ last_read_seq: string; last_seq: string }>(
          `UPDATE channel_members cm SET last_read_seq = LEAST($3 - 1, ch.last_seq)
           FROM channels ch WHERE ch.id = cm.channel_id AND cm.channel_id = $1 AND cm.user_id = $2
         RETURNING cm.last_read_seq, ch.last_seq`,
          [id, p.id, b.seq],
        );
        return { lastReadSeq: Number(u.rows[0]!.last_read_seq), unread: Number(u.rows[0]!.last_seq) - Number(u.rows[0]!.last_read_seq) };
      }),
    );
    this.rt.toUser(p.id, "read.updated", { channelId: id, ...r });
    return r;
  }

  /** Threads the caller started or replied to, most recent reply first, with where they live. */
  @Get("threads")
  async threads(@Req() req: Request) {
    const p = requirePrincipal(req);
    assertAllowed(p, "message.read");
    return withTransaction(this.pool, async (c) => {
      const roots = await selectMessages(
        c,
        `m.reply_count > 0 AND m.deleted_at IS NULL AND (m.author_id = $1 OR EXISTS (SELECT 1 FROM messages r WHERE r.thread_root_id = m.id AND r.author_id = $1))
           AND EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = m.channel_id AND cm.user_id = $1)`,
        [p.id],
        p.id,
        "m.last_reply_at DESC NULLS LAST",
        50,
      );
      const last = roots.length
        ? (
            await c.query(
              `SELECT DISTINCT ON (thread_root_id) thread_root_id AS "rootId", author_id AS "authorId", CASE WHEN deleted_at IS NULL THEN body ELSE '' END AS body, created_at AS "createdAt"
           FROM messages WHERE thread_root_id = ANY($1) ORDER BY thread_root_id, seq DESC`,
              [roots.map((r) => r.id)],
            )
          ).rows
        : [];
      const participants = roots.length
        ? (
            await c.query<{ rootId: string; ids: string[] }>(
              `SELECT thread_root_id AS "rootId", array_agg(DISTINCT author_id) AS ids FROM messages WHERE thread_root_id = ANY($1) GROUP BY thread_root_id`,
              [roots.map((r) => r.id)],
            )
          ).rows
        : [];
      const names = await channelNames(c, [...new Set(roots.map((r) => r.channelId))], p.id);
      return {
        threads: roots.map((r) => ({
          root: r,
          channel: names[r.channelId] ?? null,
          lastReply: last.find((l) => l.rootId === r.id) ?? null,
          participants: participants.find((x) => x.rootId === r.id)?.ids ?? [],
        })),
      };
    });
  }

  /** Messages (including thread replies) that mention the caller, newest first. */
  @Get("mentions")
  async mentions(@Req() req: Request) {
    const p = requirePrincipal(req);
    assertAllowed(p, "message.read");
    return withTransaction(this.pool, async (c) => {
      const rows = await selectMessages(
        c,
        // `@>` (not `= ANY`) so the GIN index on mentions is used; `= ANY` scans every message of the workspace.
        `m.mentions @> ARRAY[$1]::text[] AND m.deleted_at IS NULL AND EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = m.channel_id AND cm.user_id = $1)`,
        [p.id],
        p.id,
        "m.created_at DESC",
        100,
      );
      const names = await channelNames(c, [...new Set(rows.map((r) => r.channelId))], p.id);
      return { messages: rows.map((m) => ({ ...m, channel: names[m.channelId] ?? null })) };
    });
  }

  @Post("read-all")
  async readAll(@Req() req: Request) {
    const p = requirePrincipal(req);
    await withTransaction(this.pool, (c) =>
      c.query(
        `UPDATE channel_members cm SET last_read_seq = ch.last_seq FROM channels ch
        WHERE ch.id = cm.channel_id AND cm.user_id = $1`,
        [p.id],
      ),
    );
    this.rt.toUser(p.id, "read.all", {});
    return { ok: true };
  }
}
