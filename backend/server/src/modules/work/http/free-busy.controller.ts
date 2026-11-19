import { BadRequestException, Controller, Get, Query, Req } from "@nestjs/common";
import { requirePrincipal } from "@workspace/service-kit";
import { withTransaction } from "@workspace/shared";
import type { Request } from "express";
import { requireAny } from "../common.js";

import { WorkControllerBase } from "./base.controller.js";

/**
 * Busy time for a group, for finding a meeting slot (the assistant's find_meeting_slot). One merged list
 * for the whole group, start and end only: no titles, no places, and not who is busy, so a colleague's calendar never
 * shows through. Declined invitations do not count as busy.
 */
@Controller()
export class FreeBusyController extends WorkControllerBase {
  @Get("calendar/busy")
  async busy(@Req() req: Request, @Query("users") users?: string, @Query("from") from?: string, @Query("to") to?: string) {
    const p = requirePrincipal(req);
    requireAny(p, "calendar.read", [{ ownerId: p.id }]);
    const a = Date.parse(from ?? "");
    const b = Date.parse(to ?? "");
    if (Number.isNaN(a) || Number.isNaN(b) || b < a || b - a > 62 * 86400_000) throw new BadRequestException("from and to are required ISO dates, at most 62 days apart");
    const ids = [
      ...new Set(
        (users ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s && s.length <= 64),
      ),
    ].slice(0, 30);
    if (!ids.length) return { busy: [] };
    const rows = await withTransaction(
      this.pool,
      async (c) =>
        (
          await c.query<{ start: Date; end: Date }>(
            `SELECT DISTINCT e.starts_at AS start, e.ends_at AS "end"
             FROM calendar_events e JOIN event_attendees x ON x.event_id = e.id
            WHERE x.user_id = ANY($1) AND x.response <> 'declined' AND e.kind <> 'deadline'
              AND e.starts_at < $3 AND e.ends_at > $2
            ORDER BY 1 LIMIT 2000`,
            [ids, new Date(a).toISOString(), new Date(b).toISOString()],
          )
        ).rows,
    );
    return { busy: rows.map((r) => ({ start: r.start.toISOString(), end: r.end.toISOString() })) };
  }
}
