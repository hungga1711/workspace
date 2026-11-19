import { Controller, Get, Param, Query, Req } from "@nestjs/common";
import { assertAllowed, requirePrincipal } from "@workspace/service-kit";
import { withTransaction } from "@workspace/shared";
import type { Request } from "express";
import { resolveRef } from "../ref.js";
import { duplicates, estimate, lateTasks, load } from "../task-tools.js";
import { WorkControllerBase } from "./base.controller.js";
import { guard } from "./common.js";

const ids = (s?: string) =>
  s
    ? s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, 500)
    : undefined;

/** Reads for the assistant's task tools (task-tools.ts): late work, a person's load, duplicates, estimates. */
@Controller()
export class TaskToolsController extends WorkControllerBase {
  @Get("task-tools/late")
  async late(@Req() req: Request, @Query("assignees") assignees?: string, @Query("project") project?: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "task.read");
    return guard(() =>
      withTransaction(this.pool, async (c) => lateTasks(c, p, { assigneeIds: ids(assignees), projectId: project ? await resolveRef(c, "project", project) : undefined })),
    );
  }

  @Get("task-tools/load/:userId")
  async load(@Req() req: Request, @Param("userId") userId: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "task.read");
    return withTransaction(this.pool, (c) => load(c, p, userId));
  }

  @Get("task-tools/duplicates")
  async duplicates(@Req() req: Request, @Query("project") project?: string, @Query("assignee") assignee?: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "task.read");
    return guard(() =>
      withTransaction(this.pool, async (c) => duplicates(c, p, { projectId: project ? await resolveRef(c, "project", project) : undefined, assigneeId: assignee || undefined })),
    );
  }

  @Get("task-tools/estimate")
  async estimate(@Req() req: Request, @Query("title") title = "", @Query("project") project?: string, @Query("assignee") assignee?: string, @Query("from") from?: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "task.read");
    const start = typeof from === "string" && !Number.isNaN(Date.parse(from)) ? new Date(from) : undefined;
    return guard(() =>
      withTransaction(this.pool, async (c) =>
        estimate(c, p, {
          title: typeof title === "string" ? title.slice(0, 300) : "",
          projectId: typeof project === "string" && project ? await resolveRef(c, "project", project) : undefined,
          assigneeId: typeof assignee === "string" && assignee ? assignee : undefined,
          from: start,
        }),
      ),
    );
  }
}
