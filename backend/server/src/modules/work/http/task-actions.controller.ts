import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Req } from "@nestjs/common";
import { parse, requirePrincipal } from "@workspace/service-kit";
import { withTransaction } from "@workspace/shared";
import type { Request } from "express";
import { z } from "zod";
import { taskPriority, taskStatus } from "@workspace/contracts";
import { bulkTasks, deleteTemplate, duplicateTask, listTemplates, moveToProject, orderSubtasks, saveTemplate, setParent, setWatching, useTemplate } from "../task-actions.js";
import { taskDto } from "../tasks.js";
import { WorkControllerBase } from "./base.controller.js";
import { guard } from "./common.js";

const isoDateTime = z.string().datetime({ offset: true });

/** Follow, move, copy, re-parent and order tasks; change many at once; task templates. */
@Controller()
export class TaskActionsController extends WorkControllerBase {
  @Post("tasks/bulk")
  async bulk(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(
      z.object({
        ids: z.array(z.string().min(1)).min(1).max(500),
        status: taskStatus.optional(),
        assigneeId: z.string().nullable().optional(),
        priority: taskPriority.optional(),
        dueAt: isoDateTime.nullable().optional(),
        addLabels: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
        removeLabels: z.array(z.string().max(40)).max(20).optional(),
        projectId: z.string().nullable().optional(),
        delete: z.boolean().optional(),
      }),
      body,
    );
    return guard(() =>
      withTransaction(this.pool, async (c) => {
        const r = await bulkTasks(c, p, b);
        return { ok: r.ok, failed: r.failed, tasks: r.tasks.map(taskDto) };
      }),
    );
  }

  @Put("tasks/:id/watch")
  async watch(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    return guard(() => withTransaction(this.pool, (c) => setWatching(c, p, id, true)));
  }

  @Delete("tasks/:id/watch")
  async unwatch(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    return guard(() => withTransaction(this.pool, (c) => setWatching(c, p, id, false)));
  }

  @Post("tasks/:id/project")
  async moveProject(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(z.object({ projectId: z.string().min(1).nullable(), expectedVersion: z.number().int().positive() }), body);
    return guard(() => withTransaction(this.pool, async (c) => taskDto(await moveToProject(c, p, id, b))));
  }

  @Post("tasks/:id/duplicate")
  async duplicate(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(z.object({ title: z.string().trim().max(300).optional(), withSubtasks: z.boolean().default(true) }), body);
    return guard(() => withTransaction(this.pool, async (c) => taskDto(await duplicateTask(c, p, id, b))));
  }

  @Post("tasks/:id/parent")
  async parent(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(z.object({ parentId: z.string().min(1).nullable(), expectedVersion: z.number().int().positive() }), body);
    return guard(() => withTransaction(this.pool, async (c) => taskDto(await setParent(c, p, id, b))));
  }

  @Put("tasks/:id/subtask-order")
  async subtaskOrder(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(z.object({ ids: z.array(z.string().min(1)).max(200) }), body);
    return guard(() => withTransaction(this.pool, (c) => orderSubtasks(c, p, id, b.ids)));
  }

  // ---- templates ----
  @Get("task-templates")
  async templates(@Req() req: Request, @Query("projectId") projectId?: string) {
    const p = requirePrincipal(req);
    return guard(() => withTransaction(this.pool, (c) => listTemplates(c, p, projectId || null)));
  }

  @Post("task-templates")
  async saveTemplate(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(z.object({ name: z.string().trim().min(1).max(120), taskId: z.string().min(1), projectId: z.string().min(1).nullable().default(null) }), body);
    return guard(() => withTransaction(this.pool, (c) => saveTemplate(c, p, b)));
  }

  @Delete("task-templates/:id")
  @HttpCode(204)
  async deleteTemplate(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    await guard(() => withTransaction(this.pool, (c) => deleteTemplate(c, p, id)));
  }

  @Post("task-templates/:id/use")
  async useTemplate(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(
      z.object({
        projectId: z.string().min(1).nullable().default(null),
        columnId: z.string().min(1).nullable().optional(),
        assigneeId: z.string().nullable().optional(),
        dueAt: isoDateTime.nullable().optional(),
        title: z.string().trim().max(300).optional(),
      }),
      body,
    );
    return guard(() => withTransaction(this.pool, async (c) => taskDto(await useTemplate(c, p, id, b))));
  }
}
