import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req } from "@nestjs/common";
import { assertAllowed, parse, requirePrincipal } from "@workspace/service-kit";
import { withTransaction } from "@workspace/shared";
import type { Request } from "express";
import { z } from "zod";
import { createFolder, finishDriveUpload, listDrive, purgeItem, requestDriveUpload, shareItem, trashItem, updateItem } from "../drive.js";
import { confirmUpload, deleteFile, downloadUrl, requestUpload } from "../files.js";

import { WorkControllerBase } from "./base.controller.js";
import { guard } from "./common.js";

/** Files (presigned uploads/downloads) and the Drive. */
@Controller()
export class DriveController extends WorkControllerBase {
  // ---- files (presigned flow) ----
  @Post("files/uploads")
  async upload(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(
      z.object({
        name: z.string().trim().min(1).max(255),
        contentType: z.string().min(1).max(127),
        size: z.number().int(),
        attachTo: z.object({ type: z.enum(["document", "task", "whiteboard", "workflow"]), id: z.string() }),
      }),
      body,
    );
    return guard(() => withTransaction(this.pool, (c) => requestUpload(c, this.storage, p, b)));
  }

  @Post("files/:id/confirm")
  async confirm(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    return guard(() => withTransaction(this.pool, (c) => confirmUpload(c, this.storage, p, id)));
  }

  // ---- drive: folders and files ----
  @Get("drive")
  async drive(@Req() req: Request, @Query("folder") folder?: string, @Query("section") section?: string, @Query("q") q?: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "file.read");
    return guard(() => withTransaction(this.pool, (c) => listDrive(c, p, { folder, section, q })));
  }

  @Post("drive/folders")
  async driveFolder(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(z.object({ name: z.string().trim().min(1).max(255), parentId: z.string().nullable().default(null) }), body);
    return guard(() => withTransaction(this.pool, (c) => createFolder(c, p, b.name, b.parentId)));
  }

  @Post("drive/uploads")
  async driveUpload(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(
      z.object({ name: z.string().trim().min(1).max(255), contentType: z.string().min(1).max(127), size: z.number().int(), parentId: z.string().nullable().default(null) }),
      body,
    );
    return guard(() => withTransaction(this.pool, (c) => requestDriveUpload(c, this.storage, p, b)));
  }

  @Post("drive/items/:id/finish")
  @HttpCode(200)
  async driveFinish(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    return guard(() => withTransaction(this.pool, (c) => finishDriveUpload(c, p, id)));
  }

  @Patch("drive/items/:id")
  async driveUpdate(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(z.object({ name: z.string().trim().min(1).max(255).optional(), parentId: z.string().nullable().optional(), starred: z.boolean().optional() }), body);
    return guard(() => withTransaction(this.pool, (c) => updateItem(c, p, id, b)));
  }

  @Put("drive/items/:id/sharing")
  async driveShare(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(
      z.object({ visibility: z.enum(["private", "workspace"]), viewers: z.array(z.string()).max(500).default([]), editors: z.array(z.string()).max(500).default([]) }),
      body,
    );
    return guard(() => withTransaction(this.pool, (c) => shareItem(c, p, id, b)));
  }

  @Post("drive/items/:id/trash")
  @HttpCode(200)
  async driveTrash(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(z.object({ trashed: z.boolean().default(true) }), body ?? {});
    return guard(() => withTransaction(this.pool, (c) => trashItem(c, p, id, b.trashed)));
  }

  @Delete("drive/items/:id")
  async drivePurge(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    return guard(() => withTransaction(this.pool, (c) => purgeItem(c, this.storage, p, id)));
  }

  @Get("files/:id/download")
  async download(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    return guard(() => withTransaction(this.pool, (c) => downloadUrl(c, this.storage, p, id)));
  }

  @Delete("files/:id")
  @HttpCode(204)
  async removeFile(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    await guard(() => withTransaction(this.pool, (c) => deleteFile(c, this.storage, p, id)));
  }
}
