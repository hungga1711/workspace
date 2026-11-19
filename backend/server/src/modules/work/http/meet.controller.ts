import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Req } from "@nestjs/common";
import { withTransaction } from "@workspace/shared";
import type { Request } from "express";
import { z } from "zod";
import {
  createRoom,
  decideGuest,
  getRoom,
  guestJoin,
  guestPreview,
  guestStatus,
  hostAction,
  listRecordings,
  listRooms,
  liveInChannel,
  lobby,
  memberJoin,
  presence,
  startRecording,
  stopRecording,
  updateRoom,
} from "../rooms.js";

import { WorkControllerBase } from "./base.controller.js";
import { guard, guestAccess, member } from "./common.js";
import { parse } from "@workspace/service-kit";

/** Video meetings (LiveKit rooms, recordings, guest access through the gateway). */
@Controller()
export class MeetController extends WorkControllerBase {
  // ---- video meetings (LiveKit; rooms.ts) ----
  @Post("meet/rooms")
  async createRoom(@Req() req: Request, @Body() body: unknown) {
    const p = member(req);
    const b = parse(
      z.object({ title: z.string().max(200).optional(), eventId: z.string().max(40).optional(), guestAccess: guestAccess.optional(), channelId: z.string().max(40).optional() }),
      body,
    );
    return guard(() => withTransaction(this.pool, (c) => createRoom(c, p, b, req.headers["x-locale"] === "vi" ? "vi" : "en")));
  }

  /** Is a call going on in this chat conversation? (The chat header shows "join".) */
  @Get("meet/channels/:channelId/live")
  async liveCall(@Req() req: Request, @Param("channelId") channelId: string) {
    member(req);
    return guard(() => withTransaction(this.pool, async (c) => ({ live: this.meet ? await liveInChannel(c, this.meet, channelId) : null })));
  }

  @Get("meet/rooms")
  async rooms(@Req() req: Request) {
    const p = member(req);
    return guard(() => withTransaction(this.pool, async (c) => ({ rooms: await listRooms(c, p) })));
  }

  @Get("meet/rooms/:code")
  async room(@Req() req: Request, @Param("code") code: string) {
    member(req);
    return guard(() => withTransaction(this.pool, async (c) => ({ room: await getRoom(c, code), recording: !!this.livekit.recording })));
  }

  @Patch("meet/rooms/:code")
  async updateRoom(@Req() req: Request, @Param("code") code: string, @Body() body: unknown) {
    const p = member(req);
    const b = parse(z.object({ title: z.string().max(200).optional(), guestAccess: guestAccess.optional() }), body);
    return guard(() => withTransaction(this.pool, (c) => updateRoom(c, p, code, b)));
  }

  @Post("meet/rooms/:code/join")
  @HttpCode(200)
  async joinRoom(@Req() req: Request, @Param("code") code: string, @Body() body: unknown) {
    const p = member(req);
    const b = parse(z.object({ name: z.string().max(120) }), body);
    return guard(() => withTransaction(this.pool, (c) => memberJoin(c, this.livekit, p, code, b.name, req.headers["x-locale"] === "vi" ? "vi" : "en")));
  }

  @Get("meet/rooms/:code/presence")
  async roomPresence(@Req() req: Request, @Param("code") code: string) {
    member(req);
    return guard(() => withTransaction(this.pool, (c) => presence(c, this.livekit, code)));
  }

  @Get("meet/rooms/:code/lobby")
  async lobby(@Req() req: Request, @Param("code") code: string) {
    member(req);
    return guard(() => withTransaction(this.pool, async (c) => ({ waiting: await lobby(c, code) })));
  }

  @Post("meet/rooms/:code/lobby/:id")
  @HttpCode(204)
  async decideGuest(@Req() req: Request, @Param("code") code: string, @Param("id") id: string, @Body() body: unknown) {
    const p = member(req);
    const b = parse(z.object({ admit: z.boolean() }), body);
    await guard(() => withTransaction(this.pool, (c) => decideGuest(c, p, code, id, b.admit)));
  }

  @Post("meet/rooms/:code/recording")
  @HttpCode(200)
  async startRecording(@Req() req: Request, @Param("code") code: string) {
    const p = member(req);
    return guard(() => withTransaction(this.pool, (c) => startRecording(c, this.livekit, p, code)));
  }

  @Delete("meet/rooms/:code/recording")
  async stopRecording(@Req() req: Request, @Param("code") code: string) {
    member(req);
    return guard(() => withTransaction(this.pool, (c) => stopRecording(c, this.livekit, code)));
  }

  @Post("meet/rooms/:code/participants/:identity/:action")
  @HttpCode(200)
  async hostOnParticipant(@Req() req: Request, @Param("code") code: string, @Param("identity") identity: string, @Param("action") action: string) {
    const p = member(req);
    if (action !== "mute" && action !== "remove") throw new NotFoundException("unknown action");
    return guard(() => withTransaction(this.pool, (c) => hostAction(c, this.livekit, p, code, action, identity)));
  }

  @Post("meet/rooms/:code/end")
  @HttpCode(200)
  async endMeeting(@Req() req: Request, @Param("code") code: string) {
    const p = member(req);
    return guard(() => withTransaction(this.pool, (c) => hostAction(c, this.livekit, p, code, "end")));
  }

  @Get("meet/rooms/:code/recordings")
  async recordings(@Req() req: Request, @Param("code") code: string) {
    const p = member(req);
    return guard(() => withTransaction(this.pool, async (c) => ({ recordings: await listRecordings(c, this.storage, code, this.livekit, p) })));
  }

  @Get("internal/meet/:code")
  async guestPreview(@Req() req: Request, @Param("code") code: string) {
    return this.asRoomGuest(req, code, (c) => guestPreview(c, code));
  }

  @Post("internal/meet/:code/join")
  @HttpCode(200)
  async guestJoin(@Req() req: Request, @Param("code") code: string, @Body() body: unknown) {
    const b = parse(z.object({ name: z.string().max(120) }), body);
    return this.asRoomGuest(req, code, (c) => guestJoin(c, this.livekit, code, b.name));
  }

  @Post("internal/meet/:code/status")
  @HttpCode(200)
  async guestStatus(@Req() req: Request, @Param("code") code: string, @Body() body: unknown) {
    const b = parse(z.object({ requestId: z.string().max(40), secret: z.string().max(100) }), body);
    return this.asRoomGuest(req, code, (c) => guestStatus(c, this.livekit, code, b.requestId, b.secret));
  }
}
