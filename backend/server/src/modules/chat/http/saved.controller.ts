import { Controller, Delete, Get, HttpCode, Param, Post, Req } from "@nestjs/common";
import { requirePrincipal } from "@workspace/service-kit";
import { withTransaction } from "@workspace/shared";
import type { Request } from "express";
import { assertCanRead, assertMember, loadMessage, selectMessages } from "../domain.js";

import { ChatControllerBase } from "./base.controller.js";
import { guard } from "./common.js";

/** Saved messages (per person) and pinned messages (per channel). */
@Controller()
export class SavedController extends ChatControllerBase {
  @Post("messages/:id/save")
  @HttpCode(204)
  async save(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    await guard(() =>
      withTransaction(this.pool, async (c) => {
        const m = await loadMessage(c, id, p.id);
        await assertCanRead(c, p, m.channelId);
        await c.query("INSERT INTO saved_messages (user_id, message_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [p.id, id]);
      }),
    );
  }

  @Delete("messages/:id/save")
  @HttpCode(204)
  async unsave(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    await withTransaction(this.pool, (c) => c.query("DELETE FROM saved_messages WHERE user_id = $1 AND message_id = $2", [p.id, id]));
  }

  @Get("saved")
  async saved(@Req() req: Request) {
    const p = requirePrincipal(req);
    return withTransaction(this.pool, async (c) => ({
      messages: await selectMessages(
        c,
        "m.id IN (SELECT message_id FROM saved_messages WHERE user_id = $1) AND EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = m.channel_id AND cm.user_id = $1)",
        [p.id],
        p.id,
        "m.created_at DESC",
        100,
      ),
    }));
  }

  @Post("messages/:id/pin")
  @HttpCode(204)
  async pin(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    const m = await guard(() =>
      withTransaction(this.pool, async (c) => {
        const m = await loadMessage(c, id, p.id);
        await assertMember(c, p, m.channelId);
        await c.query("INSERT INTO pins (channel_id, message_id, pinned_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [m.channelId, id, p.id]);
        return m;
      }),
    );
    this.rt.toChannel(m.channelId, "pins.updated", { channelId: m.channelId, messageId: id, pinned: true });
  }

  @Delete("messages/:id/pin")
  @HttpCode(204)
  async unpin(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    const m = await guard(() =>
      withTransaction(this.pool, async (c) => {
        const m = await loadMessage(c, id, p.id);
        await assertMember(c, p, m.channelId);
        await c.query("DELETE FROM pins WHERE message_id = $1", [id]);
        return m;
      }),
    );
    this.rt.toChannel(m.channelId, "pins.updated", { channelId: m.channelId, messageId: id, pinned: false });
  }

  @Get("channels/:id/pins")
  async pins(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    return guard(() =>
      withTransaction(this.pool, async (c) => {
        await assertCanRead(c, p, id);
        return { messages: await selectMessages(c, "m.id IN (SELECT message_id FROM pins WHERE channel_id = $1)", [id], p.id, "m.seq DESC", 50) };
      }),
    );
  }
}
