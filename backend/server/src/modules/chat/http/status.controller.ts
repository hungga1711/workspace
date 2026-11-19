import { Body, Controller, Delete, Get, HttpCode, Put, Query, Req } from "@nestjs/common";
import { parse, requirePrincipal } from "@workspace/service-kit";
import { withTransaction } from "@workspace/shared";
import type { Request } from "express";
import { z } from "zod";
import { emit } from "../domain.js";

import { ChatControllerBase } from "./base.controller.js";

/** Custom status, do-not-disturb and presence. */
@Controller()
export class StatusController extends ChatControllerBase {
  @Get("statuses")
  async statuses(@Req() req: Request) {
    const p = requirePrincipal(req);
    return withTransaction(this.pool, async (c) => ({
      statuses: (
        await c.query(
          `SELECT user_id AS "userId", emoji, text, clear_at AS "clearAt", CASE WHEN dnd_until > now() THEN dnd_until END AS "dndUntil" FROM user_status
            WHERE (clear_at IS NULL OR clear_at > now()) AND (text <> '' OR emoji <> '' OR dnd_until > now())`,
        )
      ).rows,
      me: p.id,
    }));
  }

  @Put("me/status")
  async setStatus(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(
      z.object({
        emoji: z.string().max(16).default(""),
        text: z.string().trim().max(100).default(""),
        clearAt: z.string().datetime({ offset: true }).nullable().default(null),
        dndUntil: z.string().datetime({ offset: true }).nullable().default(null),
      }),
      body,
    );
    return withTransaction(this.pool, async (c) => {
      await c.query(
        `INSERT INTO user_status (user_id, emoji, text, clear_at, dnd_until, updated_at) VALUES ($1,$2,$3,$4,$5, now())
         ON CONFLICT (user_id) DO UPDATE SET emoji = EXCLUDED.emoji, text = EXCLUDED.text, clear_at = EXCLUDED.clear_at, dnd_until = EXCLUDED.dnd_until, updated_at = now()`,
        [p.id, b.emoji, b.text, b.clearAt, b.dndUntil],
      );
      // Home holds pushes back while Do not disturb is on.
      await emit(c, "chat.status.set.v1", "chat.user", p.id, { userId: p.id, dndUntil: b.dndUntil });
      return { userId: p.id, ...b };
    });
  }

  @Delete("me/status")
  @HttpCode(204)
  async clearStatus(@Req() req: Request) {
    const p = requirePrincipal(req);
    await withTransaction(this.pool, async (c) => {
      await c.query("DELETE FROM user_status WHERE user_id = $1", [p.id]);
      await emit(c, "chat.status.set.v1", "chat.user", p.id, { userId: p.id, dndUntil: null });
    });
  }

  @Get("presence")
  async presence(@Req() req: Request, @Query("userIds") userIds?: string) {
    requirePrincipal(req);
    const ids = (userIds ?? "").split(",").filter(Boolean).slice(0, 200);
    return { presence: await this.rt.presence(ids) };
  }
}
