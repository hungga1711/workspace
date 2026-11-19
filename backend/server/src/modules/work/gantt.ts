import type { PoolClient } from "pg";
import { newId, type Principal } from "@workspace/shared";
import { activity, emit, requireAny } from "./common.js";
import { Conflict, Invalid, NotFound } from "./errors.js";
import { assertNotSynced, atRisk, canReadTask, eventPayload, getTask, TASK_COLS, taskDto, taskResources, type TaskRow } from "./tasks.js";

const requireTaskEdit = (p: Principal, t: TaskRow) => {
  requireAny(p, "task.edit", taskResources(t));
  assertNotSynced(t);
};

const DAY = 86_400_000;

/**
 * What a bar of the chart needs (GanttView's GanttTask), and who may read it. The full task row (description, custom
 * fields, source…) made one project's timeline 860 KB at a thousand tasks; this is about a quarter of it.
 */
const GANTT_COLS =
  "id, code, title, status, priority, owner_id, assignee_id, project_id, team_id, parent_id, column_id, start_at, due_at, progress, eta_at, blocked_reason, created_at, version";
type GanttRow = Pick<
  TaskRow,
  | "id" | "code" | "title" | "status" | "priority" | "owner_id" | "assignee_id" | "project_id" | "team_id" | "parent_id"
  | "column_id" | "start_at" | "due_at" | "progress" | "eta_at" | "blocked_reason" | "created_at" | "version"
>; // prettier-ignore
const ganttDto = (t: GanttRow) => ({
  id: t.id,
  code: t.code,
  title: t.title,
  status: t.status,
  priority: t.priority,
  assigneeId: t.assignee_id,
  parentId: t.parent_id,
  columnId: t.column_id,
  startAt: t.start_at,
  dueAt: t.due_at,
  progress: t.progress,
  blockedReason: t.blocked_reason,
  createdAt: t.created_at,
  version: t.version,
  atRisk: atRisk(t),
});

/** The Gantt for one project: every open task (and subtask) with dates, plus the links between them. */
export async function timeline(c: PoolClient, p: Principal, projectId: string) {
  const pr = await c.query<{ id: string; code: string; name: string; due_at: Date | null }>("SELECT id, code, name, due_at FROM projects WHERE id = $1", [projectId]);
  if (!pr.rows[0]) throw new NotFound("project not found");
  const loaded = (
    await c.query<GanttRow>(
      `SELECT ${GANTT_COLS} FROM tasks WHERE project_id = $1 AND status <> 'cancelled'
        ORDER BY coalesce(start_at, due_at, created_at), rank LIMIT 2000`,
      [projectId],
    )
  ).rows;
  // A Gantt of more than 2,000 rows is not readable anyway; say so instead of silently drawing the first 2,000.
  const truncated = loaded.length === 2000;
  const rows = loaded.filter((t) => canReadTask(p, t));
  const ids = rows.map((t) => t.id);
  const deps = ids.length
    ? (
        await c.query<{ id: string; from: string; to: string }>(
          `SELECT id, predecessor_id AS "from", successor_id AS "to" FROM task_dependencies WHERE predecessor_id = ANY($1) AND successor_id = ANY($1)`,
          [ids],
        )
      ).rows
    : [];
  const project = pr.rows[0];
  const columns = (await c.query<{ id: string; name: string }>("SELECT id, name FROM board_columns WHERE project_id = $1 ORDER BY position", [projectId])).rows;
  return { project: { id: project.id, code: project.code, name: project.name, dueAt: project.due_at }, columns, tasks: rows.map(ganttDto), dependencies: deps, truncated };
}

/** Finish-to-start link: `successor` starts after `predecessor` is done. Same project, no cycles. */
export async function addDependency(c: PoolClient, p: Principal, successorId: string, predecessorId: string) {
  const succ = await getTask(c, p, successorId);
  const pred = await getTask(c, p, predecessorId);
  requireTaskEdit(p, succ);
  if (succ.id === pred.id) throw new Invalid("a task cannot depend on itself");
  if (!succ.project_id || succ.project_id !== pred.project_id) throw new Invalid("both tasks must be in the same project");
  // A cycle: the predecessor already (transitively) waits on the successor.
  const loop = await c.query(
    `WITH RECURSIVE up(id) AS (
       SELECT predecessor_id FROM task_dependencies WHERE successor_id = $1
       UNION SELECT d.predecessor_id FROM task_dependencies d JOIN up ON d.successor_id = up.id
     ) SELECT 1 FROM up WHERE id = $2 LIMIT 1`,
    [pred.id, succ.id],
  );
  if (loop.rowCount) throw new Conflict("this link would make a loop", { error: "cycle" });
  const id = newId();
  const r = await c.query<{ id: string }>(
    `INSERT INTO task_dependencies (id, predecessor_id, successor_id, created_by) VALUES ($1,$2,$3,$4)
     ON CONFLICT (predecessor_id, successor_id) DO UPDATE SET created_by = task_dependencies.created_by RETURNING id`,
    [id, pred.id, succ.id, p.id],
  );
  await activity(c, "task", succ.id, "dependency_added", { predecessor: pred.code });
  return { id: r.rows[0]!.id, from: pred.id, to: succ.id };
}

export async function removeDependency(c: PoolClient, p: Principal, depId: string) {
  const d = (await c.query<{ successor_id: string; predecessor_id: string }>("SELECT successor_id, predecessor_id FROM task_dependencies WHERE id = $1", [depId])).rows[0];
  if (!d) throw new NotFound("link not found");
  requireTaskEdit(p, await getTask(c, p, d.successor_id));
  await c.query("DELETE FROM task_dependencies WHERE id = $1", [depId]);
  await activity(c, "task", d.successor_id, "dependency_removed", {});
}

/**
 * Pushes every task that now starts before one of its predecessors ends (transitively), keeping each
 * one's length. A task's "end" is its due date (or start if undated); a successor without dates is left alone.
 */
export async function shiftDependents(c: PoolClient, p: Principal, taskId: string) {
  const root = await getTask(c, p, taskId);
  requireTaskEdit(p, root);
  if (!root.project_id) return { changed: [] };
  // Only the chain downstream of this task is read and locked (not the whole project): walk the dependency links
  // first, then lock exactly those rows in id order so two overlapping shifts cannot deadlock.
  const reach = (
    await c.query<{ id: string }>(
      `WITH RECURSIVE down AS (SELECT $1::text AS id, 0 AS depth
          UNION SELECT d.successor_id, down.depth + 1 FROM task_dependencies d JOIN down ON d.predecessor_id = down.id WHERE down.depth < 200)
       SELECT id FROM down`,
      [root.id],
    )
  ).rows.map((r) => r.id);
  const all = (
    await c.query<TaskRow>(`SELECT ${TASK_COLS} FROM tasks WHERE id = ANY($1::text[]) AND project_id = $2 AND status <> 'cancelled' ORDER BY id FOR UPDATE`, [
      reach,
      root.project_id,
    ])
  ).rows;
  const byId = new Map(all.map((t) => [t.id, { ...t }]));
  const links = (
    await c.query<{ from: string; to: string }>(`SELECT predecessor_id AS "from", successor_id AS "to" FROM task_dependencies WHERE predecessor_id = ANY($1)`, [
      all.map((t) => t.id),
    ])
  ).rows;
  const next = new Map<string, string[]>();
  for (const l of links) next.set(l.from, [...(next.get(l.from) ?? []), l.to]);
  const end = (t: TaskRow) => (t.due_at ?? t.start_at)?.getTime() ?? null;
  const changed = new Set<string>();
  const queue = [root.id];
  let guard = 0;
  while (queue.length && guard++ < 5000) {
    const id = queue.shift()!;
    const pred = byId.get(id);
    const pe = pred ? end(pred) : null;
    for (const sid of next.get(id) ?? []) {
      const s = byId.get(sid);
      if (!s || pe === null || s.status === "done") continue;
      const start = s.start_at?.getTime() ?? s.due_at?.getTime() ?? null;
      if (start === null) continue;
      // Already after the predecessor: fine. Otherwise start the day after it ends (same time of day as before).
      if (start > pe) continue;
      const d = Math.floor((pe - start) / DAY) * DAY + DAY;
      if (s.start_at) s.start_at = new Date(s.start_at.getTime() + d);
      if (s.due_at) s.due_at = new Date(s.due_at.getTime() + d);
      changed.add(sid);
      queue.push(sid);
    }
  }
  // Every task that moves must be editable by this person; otherwise nothing moves (one transaction).
  for (const id of changed) requireTaskEdit(p, byId.get(id)!);
  if (!changed.size) return { changed: [] };
  // One UPDATE for every moved task; the activity row and the event stay per task (each is its own history).
  const moved = [...changed].map((id) => byId.get(id)!);
  const updated = (
    await c.query<TaskRow>(
      `UPDATE tasks t SET start_at = v.start_at, due_at = v.due_at, version = t.version + 1, updated_at = now()
         FROM unnest($1::text[], $2::timestamptz[], $3::timestamptz[]) AS v(id, start_at, due_at)
        WHERE t.id = v.id RETURNING ${TASK_COLS.split(", ")
          .map((col) => `t.${col}`)
          .join(", ")}`,
      [moved.map((t) => t.id), moved.map((t) => t.start_at), moved.map((t) => t.due_at)],
    )
  ).rows;
  const out = [];
  for (const u of updated) {
    await activity(c, "task", u.id, "rescheduled", { by: root.code });
    await emit(c, "work.task.updated.v1", "work.task", u.id, eventPayload(u));
    out.push(taskDto(u));
  }
  return { changed: out };
}
