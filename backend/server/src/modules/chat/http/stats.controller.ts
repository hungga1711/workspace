import { Controller, Get, Query, Req } from "@nestjs/common";
import { assertAllowed, requirePrincipal } from "@workspace/service-kit";
import { isTimeZone, withTransaction, workspaceTimeZone } from "@workspace/shared";
import type { Request } from "express";

import { ChatControllerBase } from "./base.controller.js";

/** Admin usage statistics (counts only, never content). */
@Controller()
export class StatsController extends ChatControllerBase {
  /**
   * Admin overview (usage): messages per day and how many people wrote, last `days` days in
   * the workspace time zone. Counts only, never content; people only (not agents or the system).
   */
  @Get("stats/activity")
  async activity(@Req() req: Request, @Query("days") daysQ?: string, @Query("tz") tzQ?: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "audit.read");
    const days = Math.min(Math.max(Number(daysQ) || 7, 1), 31);
    return withTransaction(this.pool, async (c) => {
      const tz = isTimeZone(tzQ) ? tzQ : await workspaceTimeZone(c);
      const r = await c.query<{ day: string; messages: number; senders: number }>(
        `WITH m AS (
           SELECT (created_at AT TIME ZONE $2)::date AS day, author_id, deleted_at FROM messages
            WHERE created_at >= (((now() AT TIME ZONE $2)::date - ($1::int - 1))::timestamp AT TIME ZONE $2)
              AND author_id NOT LIKE 'agent:%' AND author_id <> 'system')
         SELECT to_char(d, 'YYYY-MM-DD') AS day, count(m.day) FILTER (WHERE m.deleted_at IS NULL)::int AS messages, count(DISTINCT m.author_id)::int AS senders
           FROM generate_series((now() AT TIME ZONE $2)::date - ($1::int - 1), (now() AT TIME ZONE $2)::date, interval '1 day') AS d
           LEFT JOIN m ON m.day = d::date GROUP BY d ORDER BY d`,
        [days, tz],
      );
      const total = await c.query<{ senders: number }>(
        `SELECT count(DISTINCT author_id)::int AS senders FROM messages WHERE created_at >= now() - make_interval(days => $1::int) AND author_id NOT LIKE 'agent:%' AND author_id <> 'system'`,
        [days],
      );
      return { days: r.rows, totals: { messages: r.rows.reduce((n, d) => n + d.messages, 0), senders: total.rows[0]!.senders } };
    });
  }
}
