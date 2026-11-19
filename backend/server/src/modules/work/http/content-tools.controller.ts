import { Body, Controller, Get, Param, Post, Query, Req } from "@nestjs/common";
import { assertAllowed, parse, requirePrincipal } from "@workspace/service-kit";
import { withTransaction } from "@workspace/shared";
import type { Request } from "express";
import { z } from "zod";
import { canReadTask, TASK_COLS, taskDto, type TaskRow } from "../tasks.js";
import { boardDetail, saveScene } from "../whiteboards.js";
import { DIAGRAM_KINDS, diagramFor, NODE_SHAPES } from "../whiteboard-diagram.js";
import type { SceneElement } from "../whiteboard-scene.js";
import { WorkControllerBase } from "./base.controller.js";
import { guard, statusEnum } from "./common.js";

const diagramBody = z.object({
  kind: z.enum(DIAGRAM_KINDS).default("flow"),
  title: z.string().trim().max(200).optional(),
  nodes: z
    .array(z.object({ id: z.string().trim().min(1).max(40), label: z.string().trim().min(1).max(200), shape: z.enum(NODE_SHAPES).optional() }))
    .min(1)
    .max(80),
  edges: z
    .array(z.object({ from: z.string().max(40), to: z.string().max(40), label: z.string().trim().max(60).optional() }))
    .max(200)
    .default([]),
});

/**
 * What the assistant's content tools need from work beyond the pages' own routes: a diagram drawn onto
 * a board (laid out here, so the elements are the board's own format), and tasks by filter for a CSV report. Both run
 * as the asker: the board must be editable by them, and only tasks they may read are listed.
 */
@Controller()
export class ContentToolsController extends WorkControllerBase {
  @Post("whiteboards/:ref/diagram")
  async diagram(@Req() req: Request, @Param("ref") ref: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const d = parse(diagramBody, body);
    return guard(() =>
      withTransaction(this.pool, async (c) => {
        const b = await boardDetail(c, p, ref);
        const elements = diagramFor(d, (b.scene.elements ?? []) as SceneElement[]);
        const r = await saveScene(c, p, b.id, { baseVersion: b.sceneVersion, scene: { elements, appState: b.scene.appState ?? {}, files: {} } });
        return { id: b.id, code: b.code, title: b.title, sceneVersion: r.sceneVersion, added: elements.length };
      }),
    );
  }

  /** Tasks by filter (project, assignee, status, due window, overdue, words), at most `limit`, newest due first. */
  @Get("task-export")
  async tasks(@Req() req: Request, @Query() query: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "task.read");
    const q = parse(
      z.object({
        projectId: z.string().max(40).optional(),
        assigneeId: z.string().max(40).optional(),
        status: z.union([statusEnum, z.literal("open")]).optional(),
        overdue: z.enum(["1", "true"]).optional(),
        dueFrom: z.string().datetime({ offset: true }).optional(),
        dueTo: z.string().datetime({ offset: true }).optional(),
        q: z.string().trim().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(1000).default(500),
      }),
      query,
    );
    return withTransaction(this.pool, async (c) => {
      const where: string[] = [];
      const args: unknown[] = [];
      const add = (sql: string, v: unknown) => {
        args.push(v);
        where.push(sql.replace("?", `$${args.length}`));
      };
      if (q.projectId) add("project_id = ?", q.projectId);
      if (q.assigneeId) add("assignee_id = ?", q.assigneeId);
      if (q.status === "open") where.push("status NOT IN ('done','cancelled')");
      else if (q.status) add("status = ?", q.status);
      if (q.overdue) where.push("due_at < now() AND status NOT IN ('done','cancelled')");
      if (q.dueFrom) add("due_at >= ?", q.dueFrom);
      if (q.dueTo) add("due_at <= ?", q.dueTo);
      if (q.q) add("title ILIKE '%' || ? || '%'", q.q.replace(/[%_\\]/g, "\\$&"));
      // Read more than asked: rows the caller may not read are dropped after the query.
      const r = await c.query<TaskRow>(
        `SELECT ${TASK_COLS} FROM tasks ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY due_at DESC NULLS LAST, id LIMIT ${Math.min(q.limit * 4, 4000)}`,
        args,
      );
      const tasks = r.rows.filter((t) => canReadTask(p, t)).slice(0, q.limit);
      return { tasks: tasks.map(taskDto), truncated: tasks.length === q.limit };
    });
  }
}
