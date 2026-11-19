import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req } from "@nestjs/common";
import { parse, requirePrincipal } from "@workspace/service-kit";
import { withTransaction } from "@workspace/shared";
import type { Request } from "express";
import { z } from "zod";
import { isoDateTime } from "@workspace/contracts";
import { NotFound } from "../errors.js";
import { buildTemplate, templateName, TEMPLATES } from "../whiteboard-templates.js";
import { boardDetail, boardLinks, boardTextFor, createBoard, deleteBoard, getBoard, listBoards, saveScene, tasksFromStickies, updateBoard } from "../whiteboards.js";
import { createFolder, deleteFolder, getAccess, listFolders, setAccess, updateFolder } from "../whiteboard-folders.js";
import { ROLES, SUBJECTS } from "../whiteboard-access.js";

import { WorkControllerBase } from "./base.controller.js";
import { guard } from "./common.js";

const visibility = z.enum(["workspace", "project", "private"]);
const elementId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const folderId = z.string().max(40);
const grants = z.array(z.object({ subjectType: z.enum(SUBJECTS), subjectId: z.string().max(40).default(""), role: z.enum(ROLES) })).max(200);
const accessBody = z.object({ inherit: z.boolean(), grants });
const locale = (req: Request): "vi" | "en" => (req.headers["x-locale"] === "vi" ? "vi" : "en");

/** Whiteboards (ADR 0024): boards, their snapshots, sticky notes turned into tasks, and what chat and ai ask of them. */
@Controller()
export class WhiteboardsController extends WorkControllerBase {
  /** Starting scenes in the caller's language, for the new-board picker and "insert template" in the editor. */
  @Get("whiteboards/templates")
  templates(@Req() req: Request) {
    requirePrincipal(req);
    const l = locale(req);
    return { templates: TEMPLATES.map((key) => ({ key, name: templateName(key, l), scene: buildTemplate(key, l) })) };
  }

  @Get("whiteboards")
  async list(@Req() req: Request, @Query() query: unknown) {
    const p = requirePrincipal(req);
    const q = parse(
      z.object({
        scope: z.enum(["all", "mine", "project"]).default("all"),
        projectId: z.string().max(40).optional(),
        folderId: folderId.optional(),
        q: z.string().max(200).optional(),
      }),
      query,
    );
    return guard(() => withTransaction(this.pool, async (c) => ({ whiteboards: await listBoards(c, p, q) })));
  }

  @Post("whiteboards")
  async create(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(
      z.object({
        title: z.string().trim().max(200).optional(),
        projectId: z.string().max(40).nullable().optional(),
        folderId: folderId.nullable().optional(),
        visibility: visibility.optional(),
        template: z.enum(TEMPLATES).optional(),
      }),
      body,
    );
    return guard(() => withTransaction(this.pool, (c) => createBoard(c, p, b, locale(req))));
  }

  // ---- folders (declared before `whiteboards/:ref` so "folders" is never read as a board) ----

  @Get("whiteboards/folders")
  async folders(@Req() req: Request) {
    const p = requirePrincipal(req);
    return guard(() => withTransaction(this.pool, (c) => listFolders(c, p)));
  }

  @Post("whiteboards/folders")
  async createFolder(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(z.object({ name: z.string().trim().min(1).max(120), parentId: folderId.nullable().optional(), grants: grants.optional() }), body);
    return guard(() => withTransaction(this.pool, (c) => createFolder(c, p, b)));
  }

  @Patch("whiteboards/folders/:id")
  async updateFolder(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(z.object({ name: z.string().trim().min(1).max(120).optional(), parentId: folderId.nullable().optional() }), body);
    return guard(() => withTransaction(this.pool, (c) => updateFolder(c, p, id, b)));
  }

  /** The folder goes; its boards and folders move up a level with the access they had. */
  @Delete("whiteboards/folders/:id")
  @HttpCode(204)
  async deleteFolder(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    await guard(() => withTransaction(this.pool, (c) => deleteFolder(c, p, id)));
  }

  @Get("whiteboards/folders/:id/access")
  async folderAccess(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    return guard(() => withTransaction(this.pool, (c) => getAccess(c, p, { type: "folder", id })));
  }

  @Put("whiteboards/folders/:id/access")
  async setFolderAccess(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(accessBody, body);
    return guard(() => withTransaction(this.pool, (c) => setAccess(c, p, { type: "folder", id }, b)));
  }

  /** Who may view, edit and manage a board: its own grants and what it inherits. */
  @Get("whiteboards/:ref/access")
  async boardAccess(@Req() req: Request, @Param("ref") ref: string) {
    const p = requirePrincipal(req);
    return guard(() => withTransaction(this.pool, (c) => getAccess(c, p, { type: "board", id: ref })));
  }

  @Put("whiteboards/:ref/access")
  async setBoardAccess(@Req() req: Request, @Param("ref") ref: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(accessBody, body);
    return guard(() => withTransaction(this.pool, (c) => setAccess(c, p, { type: "board", id: ref }, b)));
  }

  /** The words on a board (stickies, labels, text), for agents and integrations that cannot read a scene (MCP read_whiteboard). */
  @Get("whiteboards/:ref/text")
  async boardText(@Req() req: Request, @Param("ref") ref: string) {
    const p = requirePrincipal(req);
    return guard(() => withTransaction(this.pool, (c) => boardTextFor(c, p, ref)));
  }

  /** A board by its id or its code (`W-001`, any case), with its scene and task links. */
  @Get("whiteboards/:ref")
  async get(@Req() req: Request, @Param("ref") ref: string) {
    const p = requirePrincipal(req);
    return guard(() => withTransaction(this.pool, (c) => boardDetail(c, p, ref)));
  }

  @Patch("whiteboards/:ref")
  async update(@Req() req: Request, @Param("ref") ref: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(
      z.object({
        title: z.string().trim().min(1).max(200).optional(),
        projectId: z.string().max(40).nullable().optional(),
        folderId: folderId.nullable().optional(),
        visibility: visibility.optional(),
      }),
      body,
    );
    return guard(() => withTransaction(this.pool, (c) => updateBoard(c, p, ref, b)));
  }

  /**
   * A snapshot from an editor. Always merged into the stored scene (never 409): the answer is the new version and
   * whether the stored scene had changes the saver had not loaded. `text` from older clients is accepted and
   * ignored; the server reads the text from the scene itself.
   */
  @Put("whiteboards/:ref/scene")
  async save(@Req() req: Request, @Param("ref") ref: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(
      z.object({
        baseVersion: z.number().int().min(0),
        scene: z.object({ elements: z.array(z.unknown()).max(20_000) }).passthrough(),
        text: z.string().max(400_000).optional(),
        thumbnail: z
          .string()
          .max(210 * 1024)
          .nullable()
          .optional(),
      }),
      body,
    );
    return guard(() => withTransaction(this.pool, (c) => saveScene(c, p, ref, { baseVersion: b.baseVersion, scene: b.scene, thumbnail: b.thumbnail })));
  }

  @Delete("whiteboards/:ref")
  @HttpCode(204)
  async remove(@Req() req: Request, @Param("ref") ref: string) {
    const p = requirePrincipal(req);
    await guard(() => withTransaction(this.pool, (c) => deleteBoard(c, p, ref)));
  }

  /** Sticky notes → tasks: one per note, linked back to it. */
  @Post("whiteboards/:ref/tasks")
  @HttpCode(200)
  async tasks(@Req() req: Request, @Param("ref") ref: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(
      z.object({
        items: z
          .array(z.object({ elementId, title: z.string().trim().min(1).max(300), description: z.string().max(20000).optional() }))
          .min(1)
          .max(50),
        projectId: z.string().max(40).nullable().optional(),
        assigneeId: z.string().max(40).nullable().optional(),
        dueAt: isoDateTime.nullable().optional(),
      }),
      body,
    );
    return guard(() => withTransaction(this.pool, (c) => tasksFromStickies(c, p, ref, b)));
  }

  /** Fresh statuses for the notes' task badges. */
  @Get("whiteboards/:ref/links")
  async links(@Req() req: Request, @Param("ref") ref: string) {
    const p = requirePrincipal(req);
    return guard(() =>
      withTransaction(this.pool, async (c) => {
        const { b } = await getBoard(c, p, ref);
        return { links: await boardLinks(c, p, b.id) };
      }),
    );
  }

  // ---- for other modules (the gateway never forwards internal/*) ----

  /** Chat's live-session check: may the caller (the signed-in person) watch or edit this board. Never 404s. */
  @Get("internal/whiteboards/:id/access")
  async access(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    return withTransaction(this.pool, async (c) => {
      try {
        const { access } = await getBoard(c, p, id);
        return { view: access.view, edit: access.edit };
      } catch (e) {
        if (e instanceof NotFound) return { view: false, edit: false };
        throw e;
      }
    });
  }

  /** The words on a board for the ai module, read as the caller (404 when they cannot open it). */
  @Get("internal/whiteboards/:id/text")
  async text(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    return guard(() => withTransaction(this.pool, (c) => boardTextFor(c, p, id)));
  }
}
