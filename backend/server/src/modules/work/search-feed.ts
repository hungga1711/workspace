import { Body, Controller, ForbiddenException, Get, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import type { Pool } from "pg";
import { feedEvent, page, parse, PASSAGE_TYPES, readSearchFeed, requirePrincipal, SEARCH_REINDEX_PERMISSION, type FeedSource } from "@workspace/service-kit";
import { authorize, runWithContext, withTransaction } from "@workspace/shared";
import { z } from "zod";
import { KNOWLEDGE_FEEDS, knowledgeDocs } from "./knowledge.js";
import { DOC_SELECT, documentPayload, type DocRow } from "./documents.js";
import { POOL } from "./http/common.js";
import { eventPayload, TASK_COLS, type TaskRow } from "./tasks.js";
import { whiteboardFeedPayload } from "./whiteboards.js";
import { boardEffective, isOpen, loadAcl } from "./whiteboard-access.js";

/** Tasks, projects, pages and whiteboards, as search knows them (service-kit search-feed.ts). */
const SOURCES: Record<string, FeedSource> = {
  tasks: async (c, after, limit) => {
    const rows = (await c.query<TaskRow>(`SELECT ${TASK_COLS} FROM tasks WHERE id > $1 ORDER BY id LIMIT $2`, [after, limit])).rows;
    return page(
      rows.map((t) => feedEvent("work.task.updated.v1", "work.task", t.id, t.updated_at, eventPayload(t))),
      rows.at(-1)?.id,
      limit,
    );
  },
  projects: async (c, after, limit) => {
    const rows = (
      await c.query<{ id: string; code: string; name: string; description: string | null; owner_id: string; status: string; due_at: Date | null; created_at: Date }>(
        "SELECT id, code, name, description, owner_id, status, due_at, created_at FROM projects WHERE id > $1 ORDER BY id LIMIT $2",
        [after, limit],
      )
    ).rows;
    return page(
      rows.map((p) =>
        feedEvent("work.project.updated.v1", "work.project", p.id, p.created_at, {
          projectId: p.id,
          code: p.code,
          name: p.name,
          description: p.description,
          ownerId: p.owner_id,
          dueAt: p.due_at,
          status: p.status,
          changes: {},
        }),
      ),
      rows.at(-1)?.id,
      limit,
    );
  },
  documents: async (c, after, limit) => {
    const rows = (await c.query<DocRow>(`${DOC_SELECT} WHERE d.id > $1 ORDER BY d.id LIMIT $2`, [after, limit])).rows;
    const events = [];
    for (const d of rows) events.push(feedEvent("work.document.updated.v1", "work.document", d.id, d.updated_at, await documentPayload(c, d)));
    return page(events, rows.at(-1)?.id, limit);
  },
  whiteboards: async (c, after, limit) => {
    const acl = await loadAcl(c);
    const rows = (
      await c.query<{
        id: string;
        code: string;
        title: string;
        owner_id: string;
        folder_id: string | null;
        inherit: boolean;
        text: string;
        updated_at: Date;
      }>("SELECT id, code, title, owner_id, folder_id, inherit, text, updated_at FROM whiteboards WHERE id > $1 AND archived_at IS NULL ORDER BY id LIMIT $2", [after, limit])
    ).rows;
    return page(
      rows.map((b) => feedEvent("work.whiteboard.updated.v1", "work.whiteboard", b.id, b.updated_at, whiteboardFeedPayload(b, isOpen(boardEffective(acl, b)), b.text))),
      rows.at(-1)?.id,
      limit,
    );
  },
  // The text behind AI retrieval's passages (knowledge.ts): tasks with their comments, whole pages, meetings,
  // calendar entries, requests and the words of files.
  ...KNOWLEDGE_FEEDS,
};

@Controller()
export class SearchFeedController {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  @Get("internal/search-feed/:kind")
  feed(@Req() req: Request, @Param("kind") kind: string, @Query() q: unknown) {
    return readSearchFeed(req, this.pool, SOURCES, kind, q);
  }

  /**
   * The current text of things whose events said they changed (the search indexer asks; search/indexer.ts): what each
   * is now, or that it is gone. The search module only, like the feed.
   */
  @Post("internal/knowledge")
  @HttpCode(200)
  knowledge(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    if (p.type !== "service" || !authorize(p, SEARCH_REINDEX_PERMISSION).allowed) throw new ForbiddenException("platform service required");
    const b = parse(z.object({ items: z.array(z.object({ type: z.enum(PASSAGE_TYPES), id: z.string().min(1).max(64) })).max(50) }), body);
    return runWithContext({ actorId: `service:${p.id}`, requestId: req.requestId ?? "knowledge" }, () => withTransaction(this.pool, (c) => knowledgeDocs(c, b.items)));
  }
}
