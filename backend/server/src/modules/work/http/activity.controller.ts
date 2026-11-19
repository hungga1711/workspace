import { Controller, Get, Query, Req } from "@nestjs/common";
import { assertAllowed, requirePrincipal } from "@workspace/service-kit";
import { isTimeZone, withTransaction } from "@workspace/shared";
import { workspaceTimeZone } from "../settings.js";
import type { Request } from "express";

import { WorkControllerBase } from "./base.controller.js";

/** Admin overview statistics. */
@Controller()
export class ActivityController extends WorkControllerBase {
  /** Admin overview (usage): tasks created/finished per day, documents edited and meetings held, last `days` days in the workspace time zone (or `tz`). */
  @Get("stats/activity")
  async activityStats(@Req() req: Request, @Query("days") daysQ?: string, @Query("tz") tzQ?: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "audit.read");
    const days = Math.min(Math.max(Number(daysQ) || 7, 1), 31);
    return withTransaction(this.pool, async (c) => {
      const tz = isTimeZone(tzQ) ? tzQ : await workspaceTimeZone(c);
      const since = `(((now() AT TIME ZONE $2)::date - ($1::int - 1))::timestamp AT TIME ZONE $2)`;
      const r = await c.query<{ day: string; created: number; done: number }>(
        `SELECT to_char(d, 'YYYY-MM-DD') AS day,
                (SELECT count(*)::int FROM tasks t WHERE t.created_at >= ${since} AND (t.created_at AT TIME ZONE $2)::date = d::date) AS created,
                (SELECT count(*)::int FROM tasks t WHERE t.completed_at >= ${since} AND (t.completed_at AT TIME ZONE $2)::date = d::date) AS done
           FROM generate_series((now() AT TIME ZONE $2)::date - ($1::int - 1), (now() AT TIME ZONE $2)::date, interval '1 day') AS d ORDER BY d`,
        [days, tz],
      );
      const t = (
        await c.query<{ docs: number; meetings: number }>(
          `SELECT (SELECT count(DISTINCT document_id)::int FROM document_versions WHERE created_at >= ${since}) AS docs,
                (SELECT count(*)::int FROM calendar_events WHERE kind = 'meeting' AND starts_at >= ${since} AND starts_at <= now()) AS meetings`,
          [days, tz],
        )
      ).rows[0]!;
      return {
        days: r.rows,
        totals: { tasksCreated: r.rows.reduce((n, d) => n + d.created, 0), tasksDone: r.rows.reduce((n, d) => n + d.done, 0), docsEdited: t.docs, meetings: t.meetings },
      };
    });
  }
}
