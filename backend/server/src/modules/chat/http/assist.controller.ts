import { Controller, Get, Param, Query, Req } from "@nestjs/common";
import { assertAllowed, requirePrincipal } from "@workspace/service-kit";
import { withTransaction } from "@workspace/shared";
import type { Request } from "express";
import { assertCanRead, membership, selectMessages } from "../domain.js";
import { looksLikeQuestion } from "../questions.js";

import { ChatControllerBase } from "./base.controller.js";
import { channelNames, guard } from "./common.js";

const clampInt = (v: string | undefined, def: number, min: number, max: number) => Math.min(Math.max(Math.trunc(Number(v ?? def)) || def, min), max);

/**
 * Reads for the AI assistant's chat tools, as the caller: what a channel said since a time or since the
 * person last read it, and the questions put to the person that nobody answered. Same membership rules as the views.
 */
@Controller()
export class AssistController extends ChatControllerBase {
  /**
   * A channel's messages (top level and thread replies, oldest first) since `since`, or since the caller last read it
   * when no time is given. At most `limit`; `more` says older ones in the window were left out.
   */
  @Get("assist/channels/:id/window")
  async window(@Req() req: Request, @Param("id") id: string, @Query("since") since?: string, @Query("limit") limit?: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "message.read");
    const n = clampInt(limit, 120, 1, 300);
    const at = since && !Number.isNaN(Date.parse(since)) ? new Date(since) : null;
    return guard(() =>
      withTransaction(this.pool, async (c) => {
        await assertCanRead(c, p, id);
        const m = await membership(c, id, p.id);
        const fromSeq = at ? null : Number(m?.last_read_seq ?? 0);
        // Newest first so a long window keeps its latest part, then turned to reading order.
        const rows = await selectMessages(
          c,
          at ? "m.channel_id = $1 AND m.deleted_at IS NULL AND m.created_at > $2" : "m.channel_id = $1 AND m.deleted_at IS NULL AND m.seq > $2",
          [id, at ?? fromSeq],
          p.id,
          "m.seq DESC",
          n + 1,
        );
        const names = await channelNames(c, [id], p.id);
        return {
          channel: names[id] ?? null,
          since: at ? at.toISOString() : null,
          fromLastRead: !at,
          more: rows.length > n,
          messages: rows.slice(0, n).reverse(),
        };
      }),
    );
  }

  /**
   * Questions and requests put to the caller (a mention, or a direct or group conversation) at least `hours` ago and
   * at most `days` ago that nobody answered: no later reply by someone else in the thread (or, in a direct
   * conversation, in it), and no reaction from the caller. `direct=1`: direct conversations only.
   */
  @Get("assist/unanswered")
  async unanswered(@Req() req: Request, @Query("hours") hours?: string, @Query("days") days?: string, @Query("direct") direct?: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "message.read");
    const h = clampInt(hours, 4, 0, 24 * 30);
    const d = clampInt(days, 14, 1, 60);
    return withTransaction(this.pool, async (c) => {
      const rows = await selectMessages(
        c,
        `m.deleted_at IS NULL AND m.author_type = 'user' AND m.author_id <> $1
         AND m.created_at > now() - make_interval(days => $2::int) AND m.created_at <= now() - make_interval(hours => $3::int)
         AND EXISTS (SELECT 1 FROM channel_members cm JOIN channels ch ON ch.id = cm.channel_id
                      WHERE cm.channel_id = m.channel_id AND cm.user_id = $1 AND NOT ch.archived
                        AND (ch.kind NOT IN ('public', 'private') OR ($4::boolean = false AND m.mentions @> ARRAY[$1]::text[])))
         AND NOT EXISTS (SELECT 1 FROM reactions x WHERE x.message_id = m.id AND x.user_id = $1)
         AND NOT EXISTS (
               SELECT 1 FROM messages r
                WHERE r.deleted_at IS NULL AND r.author_id <> m.author_id AND r.seq > m.seq AND r.channel_id = m.channel_id
                  AND (r.thread_root_id = coalesce(m.thread_root_id, m.id)
                       OR (m.thread_root_id IS NULL AND r.thread_root_id IS NULL
                           AND (SELECT kind FROM channels k WHERE k.id = m.channel_id) NOT IN ('public', 'private'))))`,
        [p.id, d, h, direct === "1"],
        p.id,
        "m.created_at DESC",
        300,
      );
      const asks = rows.filter((m) => looksLikeQuestion(m.body)).slice(0, 60);
      const names = await channelNames(c, [...new Set(asks.map((m) => m.channelId))], p.id);
      return { questions: asks.map((m) => ({ ...m, channel: names[m.channelId] ?? null })) };
    });
  }
}
