import { docCreateBody } from "@workspace/contracts";
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req } from "@nestjs/common";
import { assertAllowed, parse, requirePrincipal } from "@workspace/service-kit";
import { recordAudit, withTransaction } from "@workspace/shared";
import type { Request } from "express";
import { z } from "zod";
import {
  canEditDoc,
  canReadDoc,
  createDoc,
  deleteDoc,
  DOC_SELECT,
  docText,
  getDoc,
  listVersions,
  moveDoc,
  noNul,
  readableHtml,
  restoreVersion,
  saveDoc,
  shareDoc,
  updateDocMeta,
  type DocRow,
} from "../documents.js";
import { NotFound } from "../errors.js";
import {
  addComment as addDocComment,
  assertSpaceKey,
  createSpace,
  deleteComment as deleteDocComment,
  docContext,
  docsByLabel,
  docsHome,
  listComments as listDocComments,
  listSpaces,
  recordView,
  resolveComment,
  setStar,
  setWatch,
  spaceTree,
  updateSpace,
} from "../spaces.js";

import { WorkControllerBase } from "./base.controller.js";
import { guard, member } from "./common.js";
import { resolveRef } from "../ref.js";

/** Documents (pages, versions, comments, presence) and spaces. */
@Controller()
export class DocsController extends WorkControllerBase {
  // ---- documents: spaces, page tree, rich text, comments ----
  @Post("docs")
  async createDoc(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    // The web opens a new page as an untitled draft; API callers still name their page.
    const b = parse(docCreateBody.extend({ title: z.string().trim().max(300), draft: z.boolean().optional() }), noNul(body));
    return guard(() => withTransaction(this.pool, (c) => createDoc(c, p, b)));
  }

  @Get("docs")
  async docs(@Req() req: Request, @Query("label") label?: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "document.read");
    return withTransaction(this.pool, async (c) => {
      if (label) return { documents: await docsByLabel(c, p, label) };
      const rows = (await c.query<DocRow>(`${DOC_SELECT} ORDER BY d.updated_at DESC LIMIT 400`)).rows.filter((d) => canReadDoc(p, d)).slice(0, 200);
      return {
        documents: rows.map((d) => ({
          id: d.id,
          code: d.code,
          title: d.title,
          ownerId: d.owner_id,
          visibility: d.visibility,
          version: d.current_version,
          updatedAt: d.updated_at,
          spaceId: d.space_id,
          emoji: d.emoji,
        })),
      };
    });
  }

  /** Docs home: starred, recent, recently updated in my spaces, and the spaces themselves. */
  @Get("docs-home")
  async docsHome(@Req() req: Request) {
    const p = requirePrincipal(req);
    assertAllowed(p, "document.read");
    return withTransaction(this.pool, (c) => docsHome(c, p));
  }

  /** A document by its id or its code (`D-001`, any case). */
  @Get("docs/:ref")
  async doc(@Req() req: Request, @Param("ref") ref: string, @Query("version") version?: string, @Query("track") track?: string) {
    const p = requirePrincipal(req);
    return guard(() =>
      withTransaction(this.pool, async (c) => {
        const id = await resolveRef(c, "document", ref);
        const d = await getDoc(c, p, id);
        const v = version ? Number(version) : d.current_version;
        const content = (await c.query<{ content: string; format: string }>("SELECT content, format FROM document_versions WHERE document_id = $1 AND version = $2", [id, v]))
          .rows[0];
        if (!content) throw new NotFound("version not found");
        // Views are people opening the page, not the AI reading it for them (track=0).
        if (!version && track !== "0" && p.type === "user") await recordView(c, p, id);
        return {
          document: {
            id: d.id,
            code: d.code,
            title: d.title,
            ownerId: d.owner_id,
            visibility: d.visibility,
            sharedWith: d.shared_with,
            version: d.current_version,
            draft: d.published === false,
          },
          content: content.content,
          format: content.format,
          // Ready to show as is (reading needs no editor): cleaned again here, older Markdown pages turned into HTML.
          html: readableHtml(content.content, content.format as "markdown" | "html"),
          text: docText(content.content, content.format as "markdown" | "html"),
          viewingVersion: v,
          context: await docContext(c, p, d),
        };
      }),
    );
  }

  /** For chat's live editing session: may the caller edit this page, and which version is published. */
  @Get("docs/:id/collab")
  async collabAccess(@Req() req: Request, @Param("id") id: string) {
    const p = member(req);
    return guard(() =>
      withTransaction(this.pool, async (c) => {
        const d = await getDoc(c, p, id);
        return { canEdit: canEditDoc(p, d), version: d.current_version };
      }),
    );
  }

  /**
   * Presence on a page: the caller is here (and editing or not); the answer is everyone else seen in the
   * last 45 seconds, editors first. The page polls this every 20 seconds while open.
   */
  @Post("docs/:id/presence")
  @HttpCode(200)
  async presence(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = member(req);
    const b = parse(z.object({ editing: z.boolean().default(false), leaving: z.boolean().default(false) }), noNul(body ?? {}));
    return guard(() =>
      withTransaction(this.pool, async (c) => {
        await getDoc(c, p, id);
        if (b.leaving) await c.query("DELETE FROM doc_presence WHERE document_id = $1 AND user_id = $2", [id, p.id]);
        else
          await c.query(
            `INSERT INTO doc_presence (document_id, user_id, editing) VALUES ($1, $2, $3)
             ON CONFLICT (document_id, user_id) DO UPDATE SET editing = EXCLUDED.editing, seen_at = now()`,
            [id, p.id, b.editing],
          );
        const others = (
          await c.query<{ userId: string; editing: boolean }>(
            `SELECT user_id AS "userId", editing FROM doc_presence WHERE document_id = $1 AND user_id <> $2 AND seen_at > now() - interval '45 seconds' ORDER BY editing DESC, seen_at DESC`,
            [id, p.id],
          )
        ).rows;
        return { others };
      }),
    );
  }

  @Put("docs/:id")
  async saveDoc(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(
      z.object({
        title: z.string().trim().min(1).max(300).optional(),
        content: z.string().max(500_000),
        baseVersion: z.number().int().positive(),
        format: z.enum(["markdown", "html"]).optional(),
      }),
      noNul(body),
    );
    return guard(() => withTransaction(this.pool, (c) => saveDoc(c, p, id, b)));
  }

  /** Page properties that do not make a new version: labels, emoji, title. */
  @Patch("docs/:id")
  async docMeta(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(
      z.object({ labels: z.array(z.string().max(40)).max(20).optional(), emoji: z.string().max(16).optional(), title: z.string().trim().min(1).max(300).optional() }),
      noNul(body),
    );
    return guard(() => withTransaction(this.pool, async (c) => ({ ok: true, id: (await updateDocMeta(c, p, id, b)).id })));
  }

  @Post("docs/:id/move")
  @HttpCode(200)
  async moveDoc(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(z.object({ parentId: z.string().nullable(), beforeId: z.string().nullable().optional() }), noNul(body));
    return guard(() => withTransaction(this.pool, async (c) => ({ ok: true, id: (await moveDoc(c, p, id, b)).id })));
  }

  @Delete("docs/:id")
  async deleteDoc(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    return guard(() => withTransaction(this.pool, (c) => deleteDoc(c, p, id)));
  }

  @Put("docs/:id/star")
  async star(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    return guard(() => withTransaction(this.pool, (c) => setStar(c, p, id, true)));
  }

  @Put("docs/:id/watch")
  async watch(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    return guard(() => withTransaction(this.pool, (c) => setWatch(c, p, id, true)));
  }

  @Delete("docs/:id/watch")
  async unwatch(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    return guard(() => withTransaction(this.pool, (c) => setWatch(c, p, id, false)));
  }

  @Delete("docs/:id/star")
  async unstar(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    return guard(() => withTransaction(this.pool, (c) => setStar(c, p, id, false)));
  }

  @Get("docs/:id/comments")
  async docComments(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    return guard(() => withTransaction(this.pool, async (c) => ({ comments: await listDocComments(c, p, id) })));
  }

  @Post("docs/:id/comments")
  async addDocComment(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(
      z.object({ body: z.string().trim().min(1).max(10000), quote: z.string().max(500).nullable().optional(), parentId: z.string().nullable().optional() }),
      noNul(body),
    );
    return guard(() => withTransaction(this.pool, (c) => addDocComment(c, p, id, b)));
  }

  @Post("docs/:id/comments/:commentId/resolve")
  @HttpCode(200)
  async resolveDocComment(@Req() req: Request, @Param("id") id: string, @Param("commentId") commentId: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(z.object({ resolved: z.boolean().default(true) }), noNul(body ?? {}));
    return guard(() => withTransaction(this.pool, (c) => resolveComment(c, p, id, commentId, b.resolved)));
  }

  @Delete("docs/:id/comments/:commentId")
  async deleteDocComment(@Req() req: Request, @Param("id") id: string, @Param("commentId") commentId: string) {
    const p = requirePrincipal(req);
    return guard(() => withTransaction(this.pool, (c) => deleteDocComment(c, p, id, commentId)));
  }

  // ---- spaces ----
  @Get("spaces")
  async spaces(@Req() req: Request) {
    const p = requirePrincipal(req);
    return withTransaction(this.pool, async (c) => ({ spaces: await listSpaces(c, p) }));
  }

  @Post("spaces")
  async createSpace(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(
      z.object({
        key: z.string().trim(),
        name: z.string().trim().min(1).max(120),
        description: z.string().trim().max(1000).default(""),
        icon: z.string().max(16).default(""),
        visibility: z.enum(["workspace", "restricted"]).default("workspace"),
        members: z.array(z.string()).max(1000).default([]),
      }),
      noNul(body),
    );
    return guard(() =>
      withTransaction(this.pool, (c) => {
        assertSpaceKey(b.key);
        return createSpace(c, p, b, req.headers["x-locale"] === "vi" ? "vi" : "en").then(async (out) => {
          await recordAudit(c, {
            action: "work.space.created",
            targetType: "space",
            targetId: b.key,
            targetLabel: b.name,
            meta: { visibility: b.visibility, members: b.members.length },
          });
          return out;
        });
      }),
    );
  }

  @Get("spaces/:key")
  async space(@Req() req: Request, @Param("key") key: string) {
    const p = requirePrincipal(req);
    return guard(() => withTransaction(this.pool, (c) => spaceTree(c, p, key)));
  }

  @Patch("spaces/:key")
  async updateSpace(@Req() req: Request, @Param("key") key: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(
      z.object({
        name: z.string().trim().min(1).max(120).optional(),
        description: z.string().trim().max(1000).optional(),
        icon: z.string().max(16).optional(),
        visibility: z.enum(["workspace", "restricted"]).optional(),
        members: z.array(z.string()).max(1000).optional(),
        archived: z.boolean().optional(),
      }),
      noNul(body),
    );
    return guard(() =>
      withTransaction(this.pool, async (c) => {
        const out = await updateSpace(c, p, key, b);
        // The space's description is text people wrote: not on the trail.
        const shown = { ...b, description: undefined };
        await recordAudit(c, {
          action: b.archived === true ? "work.space.archived" : "work.space.updated",
          targetType: "space",
          targetId: key,
          targetLabel: b.name ?? null,
          meta: { ...shown, ...(shown.members ? { members: shown.members.length } : {}) },
        });
        return out;
      }),
    );
  }

  @Get("docs/:id/versions")
  async docVersions(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    return guard(() => withTransaction(this.pool, async (c) => ({ versions: await listVersions(c, p, id) })));
  }

  @Post("docs/:id/restore")
  async restoreDoc(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(z.object({ version: z.number().int().positive(), baseVersion: z.number().int().positive() }), noNul(body));
    return guard(() => withTransaction(this.pool, (c) => restoreVersion(c, p, id, b.version, b.baseVersion)));
  }

  @Put("docs/:id/sharing")
  async share(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(z.object({ userIds: z.array(z.string()).max(500), visibility: z.enum(["private", "project", "workspace"]).optional() }), noNul(body));
    return guard(() => withTransaction(this.pool, (c) => shareDoc(c, p, id, b.userIds, b.visibility)));
  }
}
