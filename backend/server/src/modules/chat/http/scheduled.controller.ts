import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Req } from "@nestjs/common";
import { assertAllowed, parse, requirePrincipal } from "@workspace/service-kit";
import { newId, withTransaction } from "@workspace/shared";
import type { Request } from "express";
import { z } from "zod";
import { assertMember } from "../domain.js";

import { ChatControllerBase } from "./base.controller.js";
import { guard } from "./common.js";

/** Messages scheduled to be sent later. */
@Controller()
export class ScheduledController extends ChatControllerBase {
  /** "Gửi sau": write now, post at a chosen time (within a year), as yourself. */
  @Post("channels/:id/scheduled")
  async schedule(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "message.post");
    const b = parse(z.object({ body: z.string().trim().min(1).max(20000), at: z.string().datetime({ offset: true }) }), body);
    const at = Date.parse(b.at);
    if (at < Date.now() + 30_000 || at > Date.now() + 366 * 86400_000) throw new BadRequestException("pick a time from now to a year ahead");
    return guard(() =>
      withTransaction(this.pool, async (c) => {
        await assertMember(c, p, id);
        const sid = newId();
        await c.query("INSERT INTO scheduled_messages (id, channel_id, author_id, body, send_at) VALUES ($1,$2,$3,$4,$5)", [sid, id, p.id, b.body, b.at]);
        return { id: sid, at: b.at };
      }),
    );
  }

  /** My messages waiting to go out (all conversations, or one with ?channelId=). */
  @Get("scheduled")
  async scheduledList(@Req() req: Request, @Query("channelId") channelId?: string) {
    const p = requirePrincipal(req);
    return withTransaction(this.pool, async (c) => ({
      scheduled: (
        await c.query(
          `SELECT id, channel_id AS "channelId", body, send_at AS "at" FROM scheduled_messages
            WHERE author_id = $1 AND sent_at IS NULL AND ($2::text IS NULL OR channel_id = $2) ORDER BY send_at LIMIT 100`,
          [p.id, channelId ?? null],
        )
      ).rows,
    }));
  }

  @Delete("scheduled/:id")
  @HttpCode(204)
  async unschedule(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    await withTransaction(this.pool, (c) => c.query("DELETE FROM scheduled_messages WHERE id = $1 AND author_id = $2 AND sent_at IS NULL", [id, p.id]));
  }
}
