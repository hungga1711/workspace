import { Body, Controller, Get, Param, Patch, Query, Req } from "@nestjs/common";
import { parse, requirePrincipal } from "@workspace/service-kit";
import { withTransaction } from "@workspace/shared";
import type { Request } from "express";
import { z } from "zod";
import { getMeeting, listMeetings, meetingFollowups, updateMeeting } from "../meetings.js";

import { WorkControllerBase } from "./base.controller.js";
import { guard, iso } from "./common.js";
import { resolveRef } from "../ref.js";

/** Meeting notes: agenda, minutes, action items. */
@Controller()
export class MeetingsController extends WorkControllerBase {
  // ---- meetings: agenda, minutes, action items ----
  @Get("meetings")
  async meetings(@Req() req: Request, @Query("when") when?: string) {
    const p = requirePrincipal(req);
    return guard(() => withTransaction(this.pool, async (c) => ({ meetings: await listMeetings(c, p, when === "past" ? "past" : "upcoming") })));
  }

  @Get("meetings/followups")
  async meetingFollowups(@Req() req: Request) {
    const p = requirePrincipal(req);
    return guard(() => withTransaction(this.pool, (c) => meetingFollowups(c, p)));
  }

  /** A meeting by its id or its code (`H-012`, `H-012-3` in a series; any case). */
  @Get("meetings/:ref")
  async meeting(@Req() req: Request, @Param("ref") ref: string) {
    const p = requirePrincipal(req);
    return guard(() => withTransaction(this.pool, async (c) => getMeeting(c, p, await resolveRef(c, "meeting", ref))));
  }

  @Patch("meetings/:id")
  async updateMeeting(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(
      z.object({
        expectedVersion: z.number().int().positive(),
        title: z.string().trim().min(1).max(200).optional(),
        startsAt: iso.optional(),
        endsAt: iso.optional(),
        location: z.string().max(200).optional(),
        attendeeIds: z.array(z.string()).max(200).optional(),
        agenda: z.string().max(20000).optional(),
        notes: z.string().max(100000).optional(),
      }),
      body,
    );
    return guard(() => withTransaction(this.pool, (c) => updateMeeting(c, p, id, b)));
  }
}
