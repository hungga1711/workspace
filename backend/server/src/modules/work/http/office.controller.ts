import { Body, Controller, Get, Param, Post, Query, Req } from "@nestjs/common";
import { assertAllowed, parse, requirePrincipal } from "@workspace/service-kit";
import { withTransaction } from "@workspace/shared";
import type { Request } from "express";
import { z } from "zod";
import { findOfficeFiles, officeBytes, OFFICE_BYTES_MAX, saveOfficeFile } from "../office-files.js";
import { WorkControllerBase } from "./base.controller.js";
import { guard } from "./common.js";

/**
 * Files for the assistant's Office tools (office-files.ts): find and read a task attachment or a Drive
 * file the caller may read, and save a file the tools made on a task or in the caller's Drive.
 */
@Controller()
export class OfficeController extends WorkControllerBase {
  @Get("office/files")
  async find(@Req() req: Request, @Query() query: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "file.read");
    const q = parse(z.object({ id: z.string().max(40).optional(), task: z.string().max(80).optional(), name: z.string().max(200).optional() }), query);
    return guard(() => withTransaction(this.pool, async (c) => ({ files: (await findOfficeFiles(c, p, q)).slice(0, 20) })));
  }

  @Get("office/files/:id/content")
  async content(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "file.read");
    return guard(async () => {
      const [file] = await withTransaction(this.pool, (c) => findOfficeFiles(c, p, { id }));
      const data = await officeBytes(this.pool, this.storage, p, id);
      return { ...file!, data: data.toString("base64") };
    });
  }

  @Post("office/files")
  async save(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(
      z.object({
        name: z.string().trim().min(1).max(200),
        contentType: z.string().min(1).max(127),
        data: z.string().max(Math.ceil((OFFICE_BYTES_MAX * 4) / 3) + 8),
        task: z.string().max(80).optional(),
        folder: z.string().max(40).nullable().optional(),
      }),
      body,
    );
    return guard(() => saveOfficeFile(this.pool, this.storage, p, { ...b, data: Buffer.from(b.data, "base64") }));
  }
}
