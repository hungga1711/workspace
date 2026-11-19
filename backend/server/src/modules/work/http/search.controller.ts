import { Body, Controller, Get, HttpCode, Post, Req } from "@nestjs/common";
import { parse, requirePrincipal } from "@workspace/service-kit";
import { authorize, withTransaction } from "@workspace/shared";
import type { Request } from "express";
import { z } from "zod";
import { canReadDoc, DOC_SELECT, type DocRow } from "../documents.js";
import { canReadTask, TASK_COLS, type TaskRow } from "../tasks.js";
import { getBoard, searchContainers } from "../whiteboards.js";
import { APPROVALS_CONTAINER, decidesAllApprovals, readableKnowledge } from "../knowledge.js";

import { WorkControllerBase } from "./base.controller.js";

/** Search support for chat's search: readable containers and a recheck. */
@Controller()
export class SearchController extends WorkControllerBase {
  // ---- search support: containers for the query filter, then a top-K recheck ----
  /** Containers the caller may read in the search index: projects, workspace-visible documents and boards shared with them. */
  @Get("internal/search-scope")
  async searchScope(@Req() req: Request) {
    const p = requirePrincipal(req);
    return withTransaction(this.pool, async (c) => {
      const ids: string[] = [];
      if (authorize(p, "project.read").allowed) ids.push(...(await c.query<{ id: string }>("SELECT id FROM projects")).rows.map((r) => r.id));
      if (authorize(p, "document.read").allowed) ids.push("workspace");
      // Boards shared with some people only: each is its own container (whiteboards.ts whiteboardFeedPayload).
      ids.push(...(await searchContainers(c, p)));
      // Whoever decides requests for the whole company finds every request (knowledge.ts approvalDoc).
      if (decidesAllApprovals(p)) ids.push(APPROVALS_CONTAINER);
      return { containerIds: ids };
    });
  }

  /** Which of these ids the caller can still read right now (index results may be stale). */
  @Post("internal/readable")
  @HttpCode(200)
  async readableIds(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(
      z.object({
        tasks: z.array(z.string()).max(50).default([]),
        documents: z.array(z.string()).max(50).default([]),
        projects: z.array(z.string()).max(50).default([]),
        whiteboards: z.array(z.string()).max(50).default([]),
        // What AI retrieval finds besides those (knowledge.ts): each by its own rule.
        meetings: z.array(z.string()).max(50).default([]),
        events: z.array(z.string()).max(50).default([]),
        approvals: z.array(z.string()).max(50).default([]),
        files: z.array(z.string()).max(50).default([]),
      }),
      body,
    );
    return withTransaction(this.pool, async (c) => {
      const tasks = b.tasks.length
        ? (await c.query<TaskRow>(`SELECT ${TASK_COLS} FROM tasks WHERE id = ANY($1)`, [b.tasks])).rows.filter((t) => canReadTask(p, t)).map((t) => t.id)
        : [];
      const docs = b.documents.length ? (await c.query<DocRow>(`${DOC_SELECT} WHERE d.id = ANY($1)`, [b.documents])).rows.filter((d) => canReadDoc(p, d)).map((d) => d.id) : [];
      const projects =
        b.projects.length && authorize(p, "project.read").allowed
          ? (await c.query<{ id: string }>("SELECT id FROM projects WHERE id = ANY($1)", [b.projects])).rows.map((r) => r.id)
          : [];
      const whiteboards: string[] = [];
      for (const id of b.whiteboards)
        if (
          await getBoard(c, p, id).then(
            () => true,
            () => false,
          )
        )
          whiteboards.push(id);
      return { tasks, documents: docs, projects, whiteboards, ...(await readableKnowledge(c, p, b)) };
    });
  }
}
