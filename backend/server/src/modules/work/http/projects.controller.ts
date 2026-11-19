import { BadRequestException, Body, ConflictException, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req } from "@nestjs/common";
import { assertAllowed, parse, requirePrincipal } from "@workspace/service-kit";
import { newId, withTransaction } from "@workspace/shared";
import type { Request } from "express";
import { z } from "zod";
import { activity } from "../common.js";
import { Conflict, NotFound } from "../errors.js";
import { boardLocale, canEditProject, columnStatusFor, createProject, getProject, requireProjectEdit, updateProject } from "../projects.js";
import { projectHealth } from "../goal-health.js";
import { latestUpdates, listUpdates, postUpdate } from "../project-updates.js";
import { projectFlows } from "../velocity.js";
import { announceStatusChanges, canReadTask, importTasks, TASK_COLS, taskDto, type TaskRow, type TaskStatus } from "../tasks.js";

import { WorkControllerBase } from "./base.controller.js";
import { columnStatusEnum, guard, iso, priorityEnum, statusEnum } from "./common.js";
import { resolveRef } from "../ref.js";
import { between, initialRank } from "../rank.js";

/** Projects, Kanban boards and custom fields. */
@Controller()
export class ProjectsController extends WorkControllerBase {
  // ---- projects & Kanban ----
  @Post("projects")
  async createProject(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(
      z.object({
        name: z.string().trim().min(1).max(120),
        description: z.string().max(5000).default(""),
        teamId: z.string().nullable().default(null),
        // Who leads it; the creator when left out.
        ownerId: z.string().min(1).optional(),
        dueAt: iso.nullable().default(null),
      }),
      body,
    );
    return guard(() => withTransaction(this.pool, (c) => createProject(c, p, b, boardLocale(req.headers["x-locale"]))));
  }

  /**
   * Projects with their health numbers. Lifetime counts (done, total, last activity) are columns kept by a trigger;
   * only the open tasks of each project are read here (the indexed (project, status) slice), so the cost follows
   * what is in flight, not everything ever done. `limit` caps the answer for callers that only need "any?".
   * `preview=1` (the projects page) adds, per project, the latest progress note and the work in flight, only what the
   * caller may read; a company runs a handful of projects, so this is skipped past 12.
   */
  @Get("projects")
  async projects(@Req() req: Request, @Query("status") status?: string, @Query("limit") limit?: string, @Query("preview") preview?: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "project.read");
    const size = Math.min(Math.max(Number(limit) || 200, 1), 200);
    // One transaction for the list, its pace and its previews (it was three, each its own BEGIN/COMMIT and checkout).
    return withTransaction(this.pool, async (c) => {
      const projects = (
        await c.query(
          `SELECT p.id, p.code, p.name, p.status, p.owner_id AS "ownerId", p.due_at AS "dueAt", p.version, p.description,
          o.open AS "openTasks", o.overdue AS "overdueTasks", p.done_count AS "doneTasks", p.total_count AS "totalTasks",
          o.blocked AS "blockedTasks", o.at_risk AS "atRiskTasks", o.people, (p.owner_id = $2 OR o.mine) AS "mine",
          p.last_task_at AS "lastActivityAt", p.created_at AS "createdAt"
        FROM projects p
        CROSS JOIN LATERAL (
          SELECT count(*)::int AS open,
                 count(*) FILTER (WHERE t.due_at < now())::int AS overdue,
                 count(*) FILTER (WHERE t.blocked_reason IS NOT NULL)::int AS blocked,
                 -- Due within two days and not yet in review (or a promised date past the due date): by dates, not by a
                 -- typed-in percentage, which nothing keeps current.
                 count(*) FILTER (WHERE t.due_at >= now()
                   AND (t.eta_at > t.due_at OR (t.due_at < now() + interval '2 days' AND t.status = ANY(ARRAY['todo','in_progress']))))::int AS at_risk,
                 coalesce(array_agg(DISTINCT t.assignee_id) FILTER (WHERE t.assignee_id IS NOT NULL), '{}') AS people,
                 coalesce(bool_or(t.assignee_id = $2), false) AS mine
            FROM tasks t WHERE t.project_id = p.id AND t.status NOT IN ('done','cancelled')) o
        WHERE p.status = $1 ORDER BY p.created_at DESC LIMIT $3`,
          [status === "archived" ? "archived" : "active", p.id, size],
        )
      ).rows.map((r) => {
        // One health rule for a project wherever it shows (and for the goals it moves): goal-health.ts.
        const h = projectHealth(r);
        return { ...r, mine: !!r.mine, health: h.health, daysLeft: h.daysLeft };
      });
      const r = await this.withFlow(c, projects);
      return preview === "1" && r.projects.length <= 12 ? this.withPreview(c, p, r.projects) : r;
    });
  }

  /**
   * Per project: the pace (done and added this week, 8 weeks of both, in flight and stuck now) in place of "% done",
   * and the latest weekly status update. Three queries for the whole page, not per project.
   */
  private async withFlow<T extends { id: string }>(c: import("pg").PoolClient, projects: T[]) {
    const ids = projects.map((x) => x.id);
    const flows = await projectFlows(c, ids);
    const updates = ids.length ? await latestUpdates(c, ids) : new Map();
    return { projects: projects.map((x) => ({ ...x, flow: flows.get(x.id) ?? null, statusUpdate: updates.get(x.id) ?? null })) };
  }

  /** A project's weekly status updates, newest first. */
  @Get("projects/:ref/updates")
  async updates(@Req() req: Request, @Param("ref") ref: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "project.read");
    return guard(() =>
      withTransaction(this.pool, async (c) => {
        const id = await resolveRef(c, "project", ref);
        const pr = await getProject(c, id);
        return { updates: await listUpdates(c, id), canPost: canEditProject(p, pr) };
      }),
    );
  }

  /**
   * Posts the project's status for the week: a health call and two lines. The owner (or whoever may edit the project)
   * writes it; `suggested` says the text started as the AI's draft. Replaces per-task progress check-ins for the boss.
   */
  @Post("projects/:id/updates")
  async postUpdate(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(
      z.object({
        health: z.enum(["on_track", "at_risk", "off_track"]),
        body: z.string().trim().min(1).max(2000),
        suggested: z.boolean().default(false),
      }),
      body,
    );
    return guard(() =>
      withTransaction(this.pool, async (c) => {
        const pr = await getProject(c, id);
        requireProjectEdit(p, pr);
        const u = await postUpdate(c, p.id, pr.id, b);
        await activity(c, "project", pr.id, "status_update", { health: b.health });
        return u;
      }),
    );
  }

  /** The latest progress note ("📍 …") and up to three tasks in progress or review per project, readable ones only. */
  private async withPreview<T extends { id: string }>(c: import("pg").PoolClient, p: ReturnType<typeof requirePrincipal>, projects: T[]) {
    const ids = projects.map((x) => x.id);
    if (!ids.length) return { projects };
    const active = (
      await c.query<TaskRow>(
        `SELECT ${TASK_COLS} FROM tasks WHERE project_id = ANY($1::text[]) AND parent_id IS NULL AND status IN ('in_progress','review')
          ORDER BY (due_at IS NULL), due_at, updated_at DESC`,
        [ids],
      )
    ).rows.filter((t) => canReadTask(p, t));
    const notes = (
      await c.query<TaskRow & { note: string; note_at: Date; note_by: string }>(
        `SELECT n.* FROM unnest($1::text[]) AS pid CROSS JOIN LATERAL (
           SELECT ${TASK_COLS.split(", ")
             .map((k) => `t.${k}`)
             .join(", ")}, m.body AS note, m.created_at AS note_at, m.author_id AS note_by
             FROM task_comments m JOIN tasks t ON t.id = m.task_id
            WHERE t.project_id = pid AND m.body LIKE '%📍 %' ORDER BY m.created_at DESC LIMIT 5) n`,
        [ids],
      )
    ).rows.filter((t) => canReadTask(p, t));
    return {
      projects: projects.map((x) => {
        const n = notes.find((t) => t.project_id === x.id);
        const text = n ? n.note.split("\n").slice(1).join(" ").trim() || n.note.replace(/📍\s*/, "").trim() : "";
        return {
          ...x,
          latestUpdate: n ? { taskId: n.id, taskCode: n.code, authorId: n.note_by, at: n.note_at, text: text.slice(0, 280) } : null,
          inFlight: active
            .filter((t) => t.project_id === x.id)
            .slice(0, 3)
            .map((t) => ({ id: t.id, code: t.code, title: t.title, status: t.status, assigneeId: t.assignee_id, dueAt: t.due_at })),
        };
      }),
    };
  }

  /**
   * A project's board (columns with WIP limits, virtualized on the client), filtered on the server so it stays fast with thousands of cards: search, assignee
   * (an id, "me" or "none"), label, priority, due (overdue | week | none), blocked; done cards (any column) from the
   * last `doneDays` days (14 by default, 0 for all). Each column returns its filtered count and the first `limit`
   * cards; `column` + `offset` loads more of one column.
   */
  @Get("projects/:ref/board")
  async board(
    @Req() req: Request,
    @Param("ref") ref: string,
    @Query("limit") limit?: string,
    @Query("q") q?: string,
    @Query("assignee") assignee?: string,
    @Query("label") label?: string,
    @Query("priority") priority?: string,
    @Query("due") due?: string,
    @Query("blocked") blocked?: string,
    @Query("doneDays") doneDays?: string,
    @Query("column") column?: string,
    @Query("offset") offset?: string,
  ) {
    const p = requirePrincipal(req);
    assertAllowed(p, "project.read");
    const n = Math.min(Math.max(Number(limit ?? 50) || 50, 1), 500);
    const skip = Math.max(Number(offset ?? 0) || 0, 0);
    const days = doneDays === undefined ? 14 : Math.max(Number(doneDays) || 0, 0);
    const where = ["project_id = $1", "parent_id IS NULL", "status <> 'cancelled'"];
    // $1 is the project's id, filled in once the address (id or code, e.g. P-001) is resolved.
    const params: unknown[] = [ref];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace("?", `$${params.length}`));
    };
    if (q?.trim()) add("(title ILIKE ? OR code ILIKE ?)".replace("?", `$${params.length + 1}`), `%${q.trim()}%`);
    if (assignee === "none") where.push("assignee_id IS NULL");
    else if (assignee) add("assignee_id = ?", assignee === "me" ? p.id : assignee);
    if (label) add("? = ANY(labels)", label);
    if (priority && ["urgent", "high", "medium", "low"].includes(priority)) add("priority = ?", priority);
    if (due === "overdue") where.push("due_at < now() AND status NOT IN ('done', 'cancelled')");
    else if (due === "week") where.push("due_at >= now() AND due_at < now() + interval '7 days'");
    else if (due === "none") where.push("due_at IS NULL");
    // Same rule as atRisk() in tasks.ts: the forecast is past the due date, or due within 2 days with under half reported done.
    else if (due === "risk")
      where.push(
        "status NOT IN ('done', 'cancelled') AND due_at IS NOT NULL AND (eta_at > due_at OR (due_at > now() AND due_at < now() + interval '2 days' AND status <> 'review' AND progress < 50))",
      );
    if (blocked === "1") where.push("blocked_reason IS NOT NULL");
    return guard(() =>
      withTransaction(this.pool, async (c) => {
        const id = await resolveRef(c, "project", ref);
        params[0] = id;
        const project = await getProject(c, id);
        const cols = (
          await c.query<{ id: string; name: string; status: string; position: number; wipLimit: number | null }>(
            `SELECT id, name, status, position, wip_limit AS "wipLimit" FROM board_columns WHERE project_id = $1 ORDER BY position`,
            [id],
          )
        ).rows.filter((col) => !column || col.id === column);
        // One round trip for every column: each column's first page (by rank), its filtered count,
        // and its real size for WIP limits. Done cards (by status, in any column) show only recently finished work.
        const ids = cols.map((col) => col.id);
        const ps = [...params, ids, days, skip, n];
        const k = params.length;
        const rows = (
          await c.query<TaskRow & { col: string; n: number }>(
            `WITH f AS (
               SELECT ${TASK_COLS}, column_id AS col, row_number() OVER (PARTITION BY column_id ORDER BY rank) AS rn, count(*) OVER (PARTITION BY column_id)::int AS n
                 FROM tasks
                WHERE ${where.join(" AND ")} AND column_id = ANY($${k + 1})
                  AND NOT ($${k + 2}::int > 0 AND status = 'done' AND coalesce(completed_at, updated_at) <= now() - make_interval(days => $${k + 2}::int))
             )
             SELECT * FROM f WHERE rn > $${k + 3} AND rn <= $${k + 3} + $${k + 4} ORDER BY col, rn`,
            ps,
          )
        ).rows;
        const counts = new Map<string, number>();
        for (const r of rows) counts.set(r.col, r.n);
        // A column whose filtered page is empty still needs its count (0 or beyond the offset).
        if (skip > 0 || rows.length === 0) {
          const cr = await c.query<{ col: string; n: number }>(
            `SELECT column_id AS col, count(*)::int AS n FROM tasks WHERE ${where.join(" AND ")} AND column_id = ANY($${k + 1})
               AND NOT ($${k + 2}::int > 0 AND status = 'done' AND coalesce(completed_at, updated_at) <= now() - make_interval(days => $${k + 2}::int)) GROUP BY column_id`,
            [...params, ids, days],
          );
          for (const r of cr.rows) counts.set(r.col, r.n);
        }
        const totals = new Map(
          (
            await c.query<{ col: string; n: number }>(
              "SELECT column_id AS col, count(*)::int AS n FROM tasks WHERE column_id = ANY($1) AND parent_id IS NULL AND status <> 'cancelled' GROUP BY column_id",
              [ids],
            )
          ).rows.map((r) => [r.col, r.n]),
        );
        // What a card shows besides its own fields: subtasks done of total, and the comment count. One query for the
        // page's cards (both indexed: tasks_parent_idx, task_comments_task_idx).
        const pageIds = rows.map((r) => r.id);
        const extras = new Map<string, { subtasks: { done: number; total: number } | null; comments: number }>();
        if (pageIds.length) {
          const er = await c.query<{ id: string; sub_total: number; sub_done: number; comments: number }>(
            `SELECT x.id,
                    (SELECT count(*)::int FROM tasks s WHERE s.parent_id = x.id AND s.status <> 'cancelled') AS sub_total,
                    (SELECT count(*)::int FROM tasks s WHERE s.parent_id = x.id AND s.status = 'done') AS sub_done,
                    (SELECT count(*)::int FROM task_comments m WHERE m.task_id = x.id) AS comments
               FROM unnest($1::text[]) AS x(id)`,
            [pageIds],
          );
          for (const e of er.rows) extras.set(e.id, { subtasks: e.sub_total ? { done: e.sub_done, total: e.sub_total } : null, comments: e.comments });
        }
        const columns = cols.map((col) => ({
          ...col,
          count: counts.get(col.id) ?? 0,
          total: totals.get(col.id) ?? 0,
          tasks: rows.filter((r) => r.col === col.id && canReadTask(p, r)).map((r) => ({ ...taskDto(r), ...(extras.get(r.id) ?? { subtasks: null, comments: 0 }) })),
        }));
        // canEdit: whether column changes (add, rename, limit, order, delete) would be allowed, so the board only offers those.
        return { project: { id: project.id, code: project.code, name: project.name, version: project.version, canEdit: canEditProject(p, project) }, columns, doneDays: days };
      }),
    );
  }

  @Patch("projects/:id")
  async updateProject(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(
      z.object({
        expectedVersion: z.number().int().positive(),
        name: z.string().trim().min(1).max(200).optional(),
        description: z.string().max(5000).optional(),
        dueAt: iso.nullable().optional(),
        ownerId: z.string().min(1).optional(),
        teamId: z.string().min(1).nullable().optional(),
        status: z.enum(["active", "archived"]).optional(),
        reason: z.string().max(500).optional(),
      }),
      body,
    );
    return guard(() => withTransaction(this.pool, (c) => updateProject(c, p, id, b)));
  }

  /** Tasks brought over from Jira, Trello, Asana, ClickUp, Notion or any CSV (parsed and mapped in the browser). */
  @Post("projects/:id/import")
  async importTasks(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(
      z.object({
        system: z.enum(["jira", "trello", "asana", "clickup", "notion", "csv"]).default("csv"),
        tasks: z
          .array(
            z.object({
              title: z.string().trim().min(1).max(300),
              description: z.string().max(20000).default(""),
              status: statusEnum.default("todo"),
              priority: priorityEnum.default("medium"),
              assigneeId: z.string().nullable().default(null),
              dueAt: iso.nullable().default(null),
              labels: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
              key: z.string().max(80).nullable().default(null),
              parentKey: z.string().max(80).nullable().default(null),
            }),
          )
          .min(1)
          .max(1000),
      }),
      body,
    );
    return guard(() => withTransaction(this.pool, (c) => importTasks(c, p, id, b.system, b.tasks)));
  }

  /** A project by its id or its code (`P-001`, any case). */
  @Get("projects/:ref")
  async project(@Req() req: Request, @Param("ref") ref: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "project.read");
    return guard(() =>
      withTransaction(this.pool, async (c) => {
        const id = await resolveRef(c, "project", ref);
        const pr = await getProject(c, id);
        const history = (await c.query(`SELECT actor, action, changes, at FROM activity WHERE entity_type = 'project' AND entity_id = $1 ORDER BY at DESC LIMIT 30`, [id])).rows;
        return {
          id: pr.id,
          code: pr.code,
          name: pr.name,
          description: pr.description,
          ownerId: pr.owner_id,
          teamId: pr.team_id,
          status: pr.status,
          dueAt: pr.due_at,
          version: pr.version,
          history,
        };
      }),
    );
  }

  /**
   * Custom columns: add one after a given column or at the end. A column is a free lane (name, order, WIP limit):
   * it never sets a task's status, so progress stays on status and due date.
   */
  @Post("projects/:id/columns")
  async addColumn(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(
      z.object({
        name: z.string().trim().min(1).max(60),
        afterId: z.string().nullable().default(null),
        wipLimit: z.number().int().positive().nullable().default(null),
        // The status the column stands for; without it, what the name and place say (columnStatusFor).
        status: columnStatusEnum.optional(),
      }),
      body,
    );
    return guard(() =>
      withTransaction(this.pool, async (c) => {
        requireProjectEdit(p, await getProject(c, id));
        const cols = (await c.query<{ id: string; position: number }>("SELECT id, position FROM board_columns WHERE project_id = $1 ORDER BY position FOR UPDATE", [id])).rows;
        if (cols.length >= 12) throw new BadRequestException("a board has at most 12 columns");
        const at = b.afterId ? cols.findIndex((x) => x.id === b.afterId) + 1 : cols.length;
        const colId = newId();
        const status = b.status ?? columnStatusFor(b.name, at, cols.length + 1);
        await c.query("UPDATE board_columns SET position = position + 1 WHERE project_id = $1 AND position >= $2", [id, at]);
        await c.query("INSERT INTO board_columns (project_id, id, name, status, position, wip_limit) VALUES ($1,$2,$3,$4,$5,$6)", [id, colId, b.name, status, at, b.wipLimit]);
        await activity(c, "project", id, "column_added", { name: b.name, status });
        return { id: colId, name: b.name, status, position: at, wipLimit: b.wipLimit };
      }),
    );
  }

  /** Rename a column, change its WIP limit, or the status it stands for (its cards take the new status). */
  @Put("projects/:id/columns/:columnId")
  async updateColumn(@Req() req: Request, @Param("id") id: string, @Param("columnId") columnId: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(
      z.object({
        wipLimit: z.number().int().positive().nullable().optional(),
        name: z.string().trim().min(1).max(60).optional(),
        status: columnStatusEnum.optional(),
      }),
      body,
    );
    return guard(() =>
      withTransaction(this.pool, async (c) => {
        requireProjectEdit(p, await getProject(c, id));
        const cur = (await c.query<{ name: string; status: string }>("SELECT name, status FROM board_columns WHERE project_id = $1 AND id = $2 FOR UPDATE", [id, columnId]))
          .rows[0];
        if (!cur) throw new NotFound("column not found");
        await c.query(
          `UPDATE board_columns SET wip_limit = CASE WHEN $3 THEN $4 ELSE wip_limit END, name = coalesce($5, name), status = coalesce($6, status) WHERE project_id = $1 AND id = $2`,
          [id, columnId, b.wipLimit !== undefined, b.wipLimit ?? null, b.name ?? null, b.status ?? null],
        );
        if (b.name && b.name !== cur.name) await activity(c, "project", id, "column_renamed", { from: cur.name, to: b.name });
        if (b.status && b.status !== cur.status) {
          // The column's cards take its new status (cancelled cards stay cancelled); they stay in the column.
          const before = (
            await c.query<{ id: string; status: TaskStatus }>(
              "SELECT id, status FROM tasks WHERE column_id = $1 AND parent_id IS NULL AND status NOT IN ('cancelled', $2) FOR UPDATE",
              [columnId, b.status],
            )
          ).rows;
          if (before.length) await c.query("UPDATE tasks SET status = $2, version = version + 1, updated_at = now() WHERE id = ANY($1)", [before.map((t) => t.id), b.status]);
          await announceStatusChanges(c, before);
          await activity(c, "project", id, "column_status_changed", { name: b.name ?? cur.name, from: cur.status, to: b.status });
        }
        return { ok: true };
      }),
    );
  }

  /**
   * Remove a column; its cards move to another column first: the one named, else the leftmost one of the same status,
   * else the first one left. Moved cards take the target column's status.
   */
  @Delete("projects/:id/columns/:columnId")
  async deleteColumn(@Req() req: Request, @Param("id") id: string, @Param("columnId") columnId: string, @Query("moveTo") moveTo?: string) {
    const p = requirePrincipal(req);
    return guard(() =>
      withTransaction(this.pool, async (c) => {
        requireProjectEdit(p, await getProject(c, id));
        const cols = (
          await c.query<{ id: string; name: string; status: string }>("SELECT id, name, status FROM board_columns WHERE project_id = $1 ORDER BY position FOR UPDATE", [id])
        ).rows;
        const gone = cols.find((x) => x.id === columnId);
        if (!gone) throw new NotFound("column not found");
        const left = cols.filter((x) => x.id !== columnId);
        if (moveTo && !left.some((x) => x.id === moveTo)) throw new BadRequestException("moveTo is not another column of this board");
        const target = left.find((x) => x.id === moveTo) ?? left.find((x) => x.status === gone.status) ?? left[0];
        if (!target) throw new Conflict("a board needs at least one column", { error: "last_column" });
        // The cards go to the foot of the target column in their current order, with its status.
        const last =
          (await c.query<{ rank: string }>("SELECT rank FROM tasks WHERE column_id = $1 AND parent_id IS NULL ORDER BY rank DESC LIMIT 1", [target.id])).rows[0]?.rank ?? null;
        const moving = (await c.query<{ id: string; status: TaskStatus }>("SELECT id, status FROM tasks WHERE column_id = $1 ORDER BY rank", [columnId])).rows;
        let prev = last;
        for (const t of moving) {
          prev = prev ? between(prev, null) : initialRank();
          await c.query("UPDATE tasks SET column_id = $2, rank = $3, version = version + 1, updated_at = now() WHERE id = $1", [t.id, target.id, prev]);
        }
        await announceStatusChanges(c, moving);
        await c.query("DELETE FROM board_columns WHERE project_id = $1 AND id = $2", [id, columnId]);
        await c.query(
          "UPDATE board_columns b SET position = o.pos FROM (SELECT id, (row_number() OVER (ORDER BY position) - 1)::int AS pos FROM board_columns WHERE project_id = $1) o WHERE b.id = o.id",
          [id],
        );
        await activity(c, "project", id, "column_removed", { name: gone.name, movedTo: target.name });
        return { ok: true, movedTo: target.id };
      }),
    );
  }

  /** Reorder columns: the full list of column ids, left to right. */
  @Put("projects/:id/columns")
  async reorderColumns(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(z.object({ ids: z.array(z.string().min(1)).min(1).max(12) }), body);
    return guard(() =>
      withTransaction(this.pool, async (c) => {
        requireProjectEdit(p, await getProject(c, id));
        const cur = (await c.query<{ id: string }>("SELECT id FROM board_columns WHERE project_id = $1 FOR UPDATE", [id])).rows.map((r) => r.id);
        if (cur.length !== b.ids.length || !cur.every((x) => b.ids.includes(x))) throw new BadRequestException("send every column once");
        for (const [i, colId] of b.ids.entries()) await c.query("UPDATE board_columns SET position = $3 WHERE project_id = $1 AND id = $2", [id, colId, i]);
        return { ok: true };
      }),
    );
  }

  // ---- custom fields ----
  /** Define or change a field. `?create=1` (the "add field" form) refuses a key in use instead of rewriting that field. */
  @Put("custom-fields/:entity/:key")
  async defineField(@Req() req: Request, @Param("entity") entity: string, @Param("key") key: string, @Body() body: unknown, @Query("create") create?: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "workspace.configure");
    const b = parse(
      z.object({
        label: z.string().min(1).max(60),
        type: z.enum(["text", "number", "date", "select", "boolean"]),
        options: z.array(z.string().max(60)).max(50).default([]),
        required: z.boolean().default(false),
      }),
      body,
    );
    if (!["task", "project"].includes(entity) || !/^[a-z][a-z0-9_]{0,39}$/.test(key)) throw new BadRequestException("invalid entity or key");
    if (b.type === "select" && b.options.length === 0) throw new BadRequestException("select fields need options");
    await withTransaction(this.pool, async (c) => {
      if (create === "1" && (await c.query("SELECT 1 FROM custom_field_defs WHERE entity = $1 AND key = $2", [entity, key])).rowCount)
        throw new ConflictException({ error: "key_taken", message: `a ${entity} field with key "${key}" already exists` });
      await c.query(
        `INSERT INTO custom_field_defs (entity, key, label, type, options, required) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (entity, key) DO UPDATE SET label = EXCLUDED.label, type = EXCLUDED.type, options = EXCLUDED.options, required = EXCLUDED.required`,
        [entity, key, b.label, b.type, b.options, b.required],
      );
    });
    return { ok: true };
  }

  /**
   * Removes a field. Its values go too: tasks keep the full customFields object and send it back on the next edit,
   * so a stale key would make every later change fail as "unknown custom field". Projects store no values.
   */
  @Delete("custom-fields/:entity/:key")
  async deleteField(@Req() req: Request, @Param("entity") entity: string, @Param("key") key: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "workspace.configure");
    if (!["task", "project"].includes(entity)) throw new BadRequestException("invalid entity");
    return guard(() =>
      withTransaction(this.pool, async (c) => {
        const r = await c.query("DELETE FROM custom_field_defs WHERE entity = $1 AND key = $2", [entity, key]);
        if (!r.rowCount) throw new NotFound("custom field not found");
        if (entity === "task") await c.query("UPDATE tasks SET custom_fields = custom_fields - $1::text WHERE custom_fields ? $1", [key]);
        return { ok: true };
      }),
    );
  }

  @Get("custom-fields")
  async fields(@Req() req: Request) {
    requirePrincipal(req);
    return withTransaction(this.pool, async (c) => ({
      fields: (await c.query("SELECT entity, key, label, type, options, required FROM custom_field_defs ORDER BY entity, key")).rows,
    }));
  }
}
