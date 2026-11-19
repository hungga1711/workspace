import { Body, Controller, Get, Param, Post, Query, Req } from "@nestjs/common";
import { parse, requirePrincipal } from "@workspace/service-kit";
import { withTransaction } from "@workspace/shared";
import type { Request } from "express";
import { z } from "zod";
import { channelFiles, chatDownloadUrl, confirmChatUpload, requestChatUpload } from "../files.js";

import { ChatControllerBase } from "./base.controller.js";
import { guard } from "./common.js";

/** Files shared in a channel: the browser uploads straight to storage; chat only authorizes and records. */
@Controller()
export class FilesController extends ChatControllerBase {
  @Post("channels/:id/files")
  async upload(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(z.object({ name: z.string().trim().min(1).max(255), contentType: z.string().min(1).max(127), size: z.number().int() }), body);
    return guard(() => withTransaction(this.pool, (c) => requestChatUpload(c, this.storage, p, id, b)));
  }

  @Post("files/:id/confirm")
  async confirm(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    return guard(() => withTransaction(this.pool, (c) => confirmChatUpload(c, this.storage, p, id)));
  }

  @Get("files/:id/download")
  async download(@Req() req: Request, @Param("id") id: string, @Query("inline") inline?: string) {
    const p = requirePrincipal(req);
    return guard(() => withTransaction(this.pool, (c) => chatDownloadUrl(c, this.storage, p, id, inline === "1")));
  }

  @Get("channels/:id/files")
  async files(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    return guard(() => withTransaction(this.pool, async (c) => ({ files: await channelFiles(c, p, id) })));
  }
}
