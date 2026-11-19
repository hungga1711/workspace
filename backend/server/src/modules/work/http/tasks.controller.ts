import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { assertAllowed, parse, requirePrincipal } from "@workspace/service-kit";
import { startOfDay, wallClock, withTransaction } from "@workspace/shared";
import { allowedAny } from "../common.js";
import type { Request } from "express";
import type { PoolClient } from "pg";
import type { Principal } from "@workspace/shared";
import { z } from "zod";
import { taskCheckInBody, taskCommentBody, taskCreateBody, taskUpdateBody } from "@workspace/contracts";
import { addDependency, removeDependency, shiftDependents, timeline } from "../gantt.js";
import {
  addComment,
  atRisk,
  canDeleteTask,
  canReadTask,
  checkIn,
  createTask,
  deleteTask,
  deleteTaskComment,
  editTaskComment,
  getTask,
  moveTask,
  TASK_COLS,
  taskDto,
  updateTask,
  watchersOf,
  type TaskRow,
} from "../tasks.js";

import { WorkControllerBase } from "./base.controller.js";
import { guard, statusEnum } from "./common.js";
import { resolveRef } from "../ref.js";
import { taskAsks } from "../workflows.js";
import { workspaceTimeZone } from "../settings.js";

/** Tasks, my summary, insights and the Gantt (dependencies, scheduling). */
@Controller()
export class TasksController extends WorkControllerBase {
  // ---- tasks ----
  @Post("tasks")
  async createTask(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(taskCreateBody, body);
    return guard(() => withTransaction(this.pool, async (c) => taskDto(await createTask(c, p, b))));
  }

  /** My work: assigned to me or owned by me, open first, cursor by (due_at, id). */
  @Get("tasks")
  async myTasks(@Req() req: Request, @Query("scope") scope?: string, @Query("status") status?: string, @Query("cursor") cursor?: string, @Query("projectId") projectId?: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "task.read");
    // "Việc của tôi": assigned to me, plus my own to-dos nobody is assigned to yet.
    const who = scope === "owned" ? "owner_id = $1" : "(assignee_id = $1 OR (owner_id = $1 AND assignee_id IS NULL))";
    return withTransaction(this.pool, async (c) => {
      const [cDue, cId] = cursor ? cursor.split("|") : [null, null];
      // One project's tasks (the list view of a project), top-level only, by due date; the same cursor as "my work".
      // Rows the caller may not read are dropped after the page is cut, so a page can be short: the cursor still
      // moves, so nothing is skipped and nothing silently stops at a fixed size.
      if (projectId) {
        const r = await c.query<TaskRow>(
          `SELECT ${TASK_COLS} FROM tasks WHERE project_id = $1 AND parent_id IS NULL
              AND ($2::text IS NULL OR (coalesce(due_at, 'infinity'), id) > (coalesce($2::timestamptz, 'infinity'), $3))
            ORDER BY coalesce(due_at, 'infinity'), id LIMIT 200`,
          [projectId, cDue === "" ? null : cDue, cId],
        );
        const last = r.rows.at(-1);
        return {
          tasks: r.rows.filter((t) => canReadTask(p, t)).map(taskDto),
          nextCursor: r.rows.length === 200 && last ? `${last.due_at ? last.due_at.toISOString() : ""}|${last.id}` : null,
        };
      }
      const r = await c.query<TaskRow>(
        `SELECT ${TASK_COLS} FROM tasks WHERE ${who} AND ($2::text IS NULL OR status = $2)
            AND ($3::text IS NULL OR (coalesce(due_at, 'infinity'), id) > (coalesce($3::timestamptz, 'infinity'), $4))
          ORDER BY coalesce(due_at, 'infinity'), id LIMIT 50`,
        [p.id, status ?? null, cDue === "" ? null : cDue, cId],
      );
      const last = r.rows.at(-1);
      return { tasks: r.rows.map(taskDto), nextCursor: r.rows.length === 50 && last ? `${last.due_at ? last.due_at.toISOString() : ""}|${last.id}` : null };
    });
  }

  /**
   * "Của tôi" overview: my open work (assigned to me, or my own unassigned to-dos), how my week is
   * going (done this week vs last, on-time rate over 30 days) and what I finished last. One round trip.
   */
  @Get("me/summary")
  async mySummary(@Req() req: Request) {
    const p = requirePrincipal(req);
    assertAllowed(p, "task.read");
    return withTransaction(this.pool, async (c) => {
      const mine = "(assignee_id = $1 OR (owner_id = $1 AND assignee_id IS NULL))";
      // The list shows the next 300 by due date; every number below is counted in SQL over all of them.
      const open = (
        await c.query<TaskRow>(`SELECT ${TASK_COLS} FROM tasks WHERE ${mine} AND status NOT IN ('done', 'cancelled') ORDER BY coalesce(due_at, 'infinity'), rank LIMIT 300`, [p.id])
      ).rows;
      const recent = (
        await c.query<TaskRow>(
          `SELECT ${TASK_COLS} FROM tasks WHERE ${mine} AND status = 'done' AND completed_at > now() - interval '30 days' ORDER BY completed_at DESC LIMIT 6`,
          [p.id],
        )
      ).rows;
      // Weeks start on Monday, in the workspace's zone.
      const tz = await workspaceTimeZone(c);
      const w = wallClock(new Date(), tz);
      const mondayKey = new Date(Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate() - ((w.getUTCDay() + 6) % 7))).toISOString().slice(0, 10);
      const monday = startOfDay(mondayKey, tz);
      // Home's ring: what I finished since midnight in the workspace's zone.
      const midnight = startOfDay(new Date(Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate())).toISOString().slice(0, 10), tz);
      const s = (
        await c.query<{ today: number; thisWeek: number; lastWeek: number; dated: number; onTime: number; inProgress: number; overdue: number }>(
          `SELECT count(*) FILTER (WHERE status = 'done' AND completed_at >= $3)::int AS today,
                  count(*) FILTER (WHERE status = 'done' AND completed_at >= $2)::int AS "thisWeek",
                  count(*) FILTER (WHERE status = 'done' AND completed_at >= $2 - interval '7 days' AND completed_at < $2)::int AS "lastWeek",
                  count(*) FILTER (WHERE status = 'done' AND completed_at > now() - interval '30 days' AND due_at IS NOT NULL)::int AS dated,
                  count(*) FILTER (WHERE status = 'done' AND completed_at > now() - interval '30 days' AND due_at IS NOT NULL AND completed_at <= due_at + interval '1 minute')::int AS "onTime",
                  count(*) FILTER (WHERE status IN ('in_progress', 'review'))::int AS "inProgress",
                  count(*) FILTER (WHERE status NOT IN ('done', 'cancelled') AND due_at < now())::int AS overdue
             FROM tasks WHERE ${mine}`,
          [p.id, monday, midnight],
        )
      ).rows[0]!;
      const projects = (
        await c.query<{ id: string; code: string; name: string }>("SELECT id, code, name FROM projects WHERE id = ANY($1)", [
          [...new Set(open.map((t) => t.project_id).filter(Boolean))],
        ])
      ).rows;
      return {
        open: open.map(taskDto),
        recentlyDone: recent.map(taskDto),
        projects,
        stats: {
          doneToday: s.today,
          doneThisWeek: s.thisWeek,
          doneLastWeek: s.lastWeek,
          onTimeRate: s.dated ? Math.round((s.onTime / s.dated) * 100) : null,
          // How many finished tasks had a due date: the rate means little on one or two.
          onTimeOf: s.dated,
          inProgress: s.inProgress,
          overdue: s.overdue,
        },
      };
    });
  }

  /**
   * Work insights (manager view): counts over the tasks the caller may read, never more.
   * Workload per assignee, overdue and blocked, due this week, completed per week (8 weeks), project health.
   */
  @Get("insights")
  async insights(@Req() req: Request) {
    const p = requirePrincipal(req);
    assertAllowed(p, "task.read");
    return withTransaction(this.pool, async (c) => {
      // Someone who may read every task (a manager or admin at workspace scope) gets the numbers straight from SQL,
      // whatever the workspace's size. Others (a team-scoped manager) still get the row-by-row path, bounded.
      if (allowedAny(p, "task.read", [{}])) return insightsSql(c, p);
      const loaded = (
        await c.query<TaskRow>(
          `SELECT ${TASK_COLS} FROM tasks WHERE status <> 'cancelled' AND (status <> 'done' OR completed_at > now() - interval '56 days') ORDER BY updated_at DESC LIMIT 5000`,
        )
      ).rows;
      const rows = loaded.filter((t) => canReadTask(p, t));
      const truncated = loaded.length === 5000;
      const now = Date.now();
      const week = now + 7 * 86400_000;
      const open = rows.filter((t) => t.status !== "done");
      const people = new Map<string, { userId: string; open: number; overdue: number; atRisk: number; dueSoon: number; blocked: number; done7: number }>();
      const person = (id: string) => people.get(id) ?? people.set(id, { userId: id, open: 0, overdue: 0, atRisk: 0, dueSoon: 0, blocked: 0, done7: 0 }).get(id)!;
      for (const t of rows) {
        if (!t.assignee_id) continue;
        const r = person(t.assignee_id);
        if (t.status === "done") {
          if (t.completed_at && now - t.completed_at.getTime() < 7 * 86400_000) r.done7++;
          continue;
        }
        r.open++;
        if (t.due_at && t.due_at.getTime() < now) r.overdue++;
        else if (t.due_at && t.due_at.getTime() < week) r.dueSoon++;
        if (t.blocked_reason) r.blocked++;
        if (atRisk(t, now) && !(t.due_at && t.due_at.getTime() < now)) r.atRisk++;
      }
      const weeks = Array.from({ length: 8 }, (_, i) => {
        const end = now + 1 - (7 - i) * 7 * 86400_000; // the last bucket is the 7 days up to now
        const start = end - 7 * 86400_000;
        return {
          weekStart: new Date(start).toISOString(),
          done: rows.filter((t) => t.completed_at && t.completed_at.getTime() >= start && t.completed_at.getTime() < end).length,
          created: rows.filter((t) => t.created_at.getTime() >= start && t.created_at.getTime() < end).length,
        };
      });
      const overdue = open
        .filter((t) => t.due_at && t.due_at.getTime() < now)
        .sort((a, b) => a.due_at!.getTime() - b.due_at!.getTime())
        .slice(0, 10)
        .map(taskDto);
      const byStatus = ["todo", "in_progress", "review"].map((s) => ({ status: s, count: open.filter((t) => t.status === s).length }));
      const byPriority = ["urgent", "high", "medium", "low"].map((x) => ({ priority: x, count: open.filter((t) => t.priority === x).length }));
      return {
        totals: {
          open: open.length,
          overdue: open.filter((t) => t.due_at && t.due_at.getTime() < now).length,
          atRisk: open.filter((t) => atRisk(t, now) && !(t.due_at && t.due_at.getTime() < now)).length,
          dueThisWeek: open.filter((t) => t.due_at && t.due_at.getTime() >= now && t.due_at.getTime() < week).length,
          blocked: open.filter((t) => t.blocked_reason).length,
          unassigned: open.filter((t) => !t.assignee_id).length,
          done7: rows.filter((t) => t.completed_at && now - t.completed_at.getTime() < 7 * 86400_000).length,
          created7: rows.filter((t) => now - t.created_at.getTime() < 7 * 86400_000).length,
        },
        // The same numbers a week ago, for the ▲/▼ on the tiles (blocked has no history, so no delta).
        previous: (() => {
          const ago = now - 7 * 86400_000;
          const openThen = rows.filter((t) => t.created_at.getTime() < ago && (t.status !== "done" || (t.completed_at && t.completed_at.getTime() >= ago)));
          return {
            open: openThen.length,
            overdue: openThen.filter((t) => t.due_at && t.due_at.getTime() < ago).length,
            done7: rows.filter((t) => t.completed_at && t.completed_at.getTime() >= ago - 7 * 86400_000 && t.completed_at.getTime() < ago).length,
            /** Whether anything existed a week ago: a first week has nothing to compare with. */
            any: rows.some((t) => t.created_at.getTime() < ago),
          };
        })(),
        workload: [...people.values()]
          .filter((x) => x.open || x.done7)
          .sort((a, b) => b.overdue - a.overdue || b.open - a.open)
          .slice(0, 50),
        weeks,
        overdue,
        byStatus,
        byPriority,
        truncated,
      };
    });
  }

  /** A task by its id or its code (`T-041`, any case): what shared links and chat mentions carry. */
  @Get("tasks/:ref")
  async task(@Req() req: Request, @Param("ref") ref: string) {
    const p = requirePrincipal(req);
    return guard(() =>
      withTransaction(this.pool, async (c) => {
        const id = await resolveRef(c, "task", ref);
        const t = await getTask(c, p, id);
        const comments = (
          await c.query(
            `SELECT id, author_id AS "authorId", agent, body, created_at AS "createdAt", edited_at AS "editedAt" FROM task_comments WHERE task_id = $1 ORDER BY created_at`,
            [id],
          )
        ).rows;
        const act = (await c.query(`SELECT actor, action, changes, at FROM activity WHERE entity_type = 'task' AND entity_id = $1 ORDER BY at DESC LIMIT 100`, [id])).rows;
        const subtasks = (await c.query<TaskRow>(`SELECT ${TASK_COLS} FROM tasks WHERE parent_id = $1 ORDER BY rank, created_at`, [id])).rows.map(taskDto);
        // Who follows the task (task_watchers): the page shows Watch / Unwatch and how many follow it.
        const watchers = await watchersOf(c, id);
        const files = (
          await c.query(`SELECT id, name, content_type AS "contentType", size FROM files WHERE attached_type = 'task' AND attached_id = $1 AND status = 'active'`, [id])
        ).rows;
        // Gantt links: what this task waits on, and what waits on it.
        const dependencies = {
          waitingOn: (
            await c.query(
              `SELECT d.id AS "linkId", x.id, x.code, x.title, x.status FROM task_dependencies d JOIN tasks x ON x.id = d.predecessor_id WHERE d.successor_id = $1 ORDER BY x.code`,
              [id],
            )
          ).rows,
          blocking: (
            await c.query(
              `SELECT d.id AS "linkId", x.id, x.code, x.title, x.status FROM task_dependencies d JOIN tasks x ON x.id = d.successor_id WHERE d.predecessor_id = $1 ORDER BY x.code`,
              [id],
            )
          ).rows,
        };
        // The page offers "Xoá việc" only to whoever the delete would let through (same rule as deleteTask).
        // What the task's agent is asking right now (agent-ask.ts): the card at the top of the task answers in place.
        const agentAsks = t.workflow_id ? await taskAsks(c, p, t) : [];
        return {
          task: taskDto(t),
          comments,
          activity: act,
          subtasks,
          files,
          dependencies,
          canDelete: canDeleteTask(p, t) && (t.source as { type?: string } | null)?.type !== "sync",
          agentAsks,
          watchers,
          watching: watchers.includes(p.id),
        };
      }),
    );
  }

  @Patch("tasks/:id")
  async updateTask(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(taskUpdateBody, body);
    return guard(() => withTransaction(this.pool, async (c) => taskDto(await updateTask(c, p, id, b))));
  }

  // ---- Gantt ----
  @Get("projects/:id/timeline")
  async timeline(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "project.read");
    return guard(() => withTransaction(this.pool, (c) => timeline(c, p, id)));
  }

  @Post("tasks/:id/dependencies")
  async addDependency(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(z.object({ predecessorId: z.string().min(1) }), body);
    return guard(() => withTransaction(this.pool, (c) => addDependency(c, p, id, b.predecessorId)));
  }

  @Delete("task-dependencies/:id")
  @HttpCode(204)
  async removeDependency(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    await guard(() => withTransaction(this.pool, (c) => removeDependency(c, p, id)));
  }

  @Post("tasks/:id/shift-dependents")
  async shiftDependents(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    return guard(() => withTransaction(this.pool, (c) => shiftDependents(c, p, id)));
  }

  @Post("tasks/:id/move")
  async move(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(
      z
        .object({
          status: statusEnum.optional(),
          columnId: z.string().min(1).optional(),
          afterId: z.string().nullable().default(null),
          beforeId: z.string().nullable().default(null),
          expectedVersion: z.number().int().positive(),
        })
        .refine((x) => x.status || x.columnId, "status or columnId is required"),
      body,
    );
    return guard(() => withTransaction(this.pool, async (c) => taskDto(await moveTask(c, p, id, b))));
  }

  @Delete("tasks/:id")
  @HttpCode(204)
  async deleteTask(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    await guard(() => withTransaction(this.pool, (c) => deleteTask(c, p, id)));
  }

  @Post("tasks/:id/comments")
  async comment(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(taskCommentBody, body);
    return guard(() => withTransaction(this.pool, (c) => addComment(c, p, id, b.body)));
  }

  /** The author rewrites their comment. */
  @Patch("tasks/:id/comments/:commentId")
  async editComment(@Req() req: Request, @Param("id") id: string, @Param("commentId") commentId: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(taskCommentBody, body);
    return guard(() => withTransaction(this.pool, (c) => editTaskComment(c, p, id, commentId, b.body)));
  }

  /** The author, or whoever may delete the task, removes a comment. */
  @Delete("tasks/:id/comments/:commentId")
  @HttpCode(204)
  async deleteComment(@Req() req: Request, @Param("id") id: string, @Param("commentId") commentId: string) {
    const p = requirePrincipal(req);
    await guard(() => withTransaction(this.pool, (c) => deleteTaskComment(c, p, id, commentId)));
  }

  /** "Cập nhật tiến độ": % done, when it should be finished, and a note; whoever assigned it is told. */
  @Post("tasks/:id/checkin")
  async checkIn(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(taskCheckInBody, body);
    return guard(() => withTransaction(this.pool, (c) => checkIn(c, p, id, b, req.headers["x-locale"] === "vi" ? "vi" : "en")));
  }
}

/** A string literal for SQL built from a trusted id (a ULID: letters and digits only; anything else is refused). */
function q(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("bad id");
  return `'${id}'`;
}

// "At risk" as the SQL twin of atRisk() in tasks.ts: a reported ETA past the due date, or due within two days with
// a reported progress under half.
const AT_RISK_SQL =
  "(due_at IS NOT NULL AND ((eta_at IS NOT NULL AND eta_at > due_at) OR (due_at > now() AND due_at < now() + interval '2 days' AND status <> 'review' AND progress IS NOT NULL AND progress < 50)))";

/**
 * The insights numbers for someone who may read every project task: counted by Postgres, never loaded into the
 * server. Private to-dos (no project) stay out unless they are the caller's or the caller may edit every task,
 * the same rule canReadTask() applies row by row.
 */
async function insightsSql(c: PoolClient, p: Principal) {
  const privateToo = allowedAny(p, "task.edit", [{}]);
  const scope = `status <> 'cancelled' AND (status <> 'done' OR completed_at > now() - interval '56 days')
    AND (project_id IS NOT NULL OR ${privateToo ? "true" : `owner_id = ${q(p.id)} OR assignee_id = ${q(p.id)}`})`;
  const open = "status <> 'done'";
  const totals = (
    await c.query<Record<string, number | boolean | null>>(
      `SELECT count(*) FILTER (WHERE ${open})::int AS open,
              count(*) FILTER (WHERE ${open} AND due_at < now())::int AS overdue,
              count(*) FILTER (WHERE ${open} AND ${AT_RISK_SQL} AND NOT (due_at < now()))::int AS "atRisk",
              count(*) FILTER (WHERE ${open} AND due_at >= now() AND due_at < now() + interval '7 days')::int AS "dueThisWeek",
              count(*) FILTER (WHERE ${open} AND blocked_reason IS NOT NULL)::int AS blocked,
              count(*) FILTER (WHERE ${open} AND assignee_id IS NULL)::int AS unassigned,
              count(*) FILTER (WHERE completed_at > now() - interval '7 days')::int AS done7,
              count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS created7,
              count(*) FILTER (WHERE created_at < now() - interval '7 days' AND (${open} OR completed_at >= now() - interval '7 days'))::int AS "openThen",
              count(*) FILTER (WHERE created_at < now() - interval '7 days' AND (${open} OR completed_at >= now() - interval '7 days') AND due_at < now() - interval '7 days')::int AS "overdueThen",
              count(*) FILTER (WHERE completed_at >= now() - interval '14 days' AND completed_at < now() - interval '7 days')::int AS "done7Then",
              coalesce(bool_or(created_at < now() - interval '7 days'), false) AS "anyThen",
              count(*) FILTER (WHERE status = 'todo')::int AS "sTodo",
              count(*) FILTER (WHERE status = 'in_progress')::int AS "sInProgress",
              count(*) FILTER (WHERE status = 'review')::int AS "sReview",
              count(*) FILTER (WHERE ${open} AND priority = 'urgent')::int AS "pUrgent",
              count(*) FILTER (WHERE ${open} AND priority = 'high')::int AS "pHigh",
              count(*) FILTER (WHERE ${open} AND priority = 'medium')::int AS "pMedium",
              count(*) FILTER (WHERE ${open} AND priority = 'low')::int AS "pLow"
         FROM tasks WHERE ${scope}`,
    )
  ).rows[0]!;
  const n = (k: string) => Number(totals[k] ?? 0);
  const now = Date.now();
  // 8 weekly buckets, the last one being the 7 days up to now (the same edges the row-by-row path draws).
  // Bucket b holds the rows whose age in days is in (7·(7−b), 7·(8−b)], i.e. 8 − ceil(age / 7). One pass over the
  // 56 days per column instead of sixteen correlated counts (943 ms against 54 ms at 600k tasks); the done branch
  // names status = 'done' so tasks_completed_idx applies.
  const weekRows = (
    await c.query<{ bucket: number; done: number; created: number }>(
      `SELECT b.bucket, coalesce(d.n, 0)::int AS done, coalesce(cr.n, 0)::int AS created
         FROM generate_series(0, 7) AS b(bucket)
         LEFT JOIN (SELECT 8 - ceil(extract(epoch FROM now() - completed_at) / 604800)::int AS bucket, count(*) AS n
                      FROM tasks WHERE ${scope} AND status = 'done' AND completed_at >= now() - interval '56 days' AND completed_at < now() GROUP BY 1) d ON d.bucket = b.bucket
         LEFT JOIN (SELECT 8 - ceil(extract(epoch FROM now() - created_at) / 604800)::int AS bucket, count(*) AS n
                      FROM tasks WHERE ${scope} AND created_at >= now() - interval '56 days' AND created_at < now() GROUP BY 1) cr ON cr.bucket = b.bucket
        ORDER BY b.bucket`,
    )
  ).rows;
  const weeks = weekRows.map((r) => ({ weekStart: new Date(now + 1 - (8 - r.bucket) * 7 * 86400_000).toISOString(), done: r.done, created: r.created }));
  const workload = (
    await c.query<{ userId: string; open: number; overdue: number; atRisk: number; dueSoon: number; blocked: number; done7: number }>(
      `SELECT assignee_id AS "userId",
              count(*) FILTER (WHERE ${open})::int AS open,
              count(*) FILTER (WHERE ${open} AND due_at < now())::int AS overdue,
              count(*) FILTER (WHERE ${open} AND ${AT_RISK_SQL} AND NOT (due_at < now()))::int AS "atRisk",
              count(*) FILTER (WHERE ${open} AND due_at >= now() AND due_at < now() + interval '7 days')::int AS "dueSoon",
              count(*) FILTER (WHERE ${open} AND blocked_reason IS NOT NULL)::int AS blocked,
              count(*) FILTER (WHERE status = 'done' AND completed_at > now() - interval '7 days')::int AS done7
         FROM tasks WHERE ${scope} AND assignee_id IS NOT NULL
        GROUP BY assignee_id
       HAVING count(*) FILTER (WHERE ${open}) > 0 OR count(*) FILTER (WHERE status = 'done' AND completed_at > now() - interval '7 days') > 0
        ORDER BY overdue DESC, open DESC LIMIT 50`,
    )
  ).rows;
  const overdue = (await c.query<TaskRow>(`SELECT ${TASK_COLS} FROM tasks WHERE ${scope} AND ${open} AND due_at < now() ORDER BY due_at LIMIT 10`)).rows.map(taskDto);
  return {
    totals: {
      open: n("open"),
      overdue: n("overdue"),
      atRisk: n("atRisk"),
      dueThisWeek: n("dueThisWeek"),
      blocked: n("blocked"),
      unassigned: n("unassigned"),
      done7: n("done7"),
      created7: n("created7"),
    },
    previous: { open: n("openThen"), overdue: n("overdueThen"), done7: n("done7Then"), any: totals["anyThen"] === true },
    workload,
    weeks,
    overdue,
    byStatus: [
      { status: "todo", count: n("sTodo") },
      { status: "in_progress", count: n("sInProgress") },
      { status: "review", count: n("sReview") },
    ],
    byPriority: [
      { priority: "urgent", count: n("pUrgent") },
      { priority: "high", count: n("pHigh") },
      { priority: "medium", count: n("pMedium") },
      { priority: "low", count: n("pLow") },
    ],
    truncated: false,
  };
}
