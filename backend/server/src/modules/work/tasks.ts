import type { PoolClient } from "pg";
import { workspaceTimeZone } from "./settings.js";
import { ddmm, newId, type Principal, type Resource } from "@workspace/shared";
import { nextCode } from "./codes.js";
import { activity, allowedAny, emit, requireAny } from "./common.js";
import { validateCustomFields } from "./custom-fields.js";
import { Conflict, Forbidden, Invalid, NotFound } from "./errors.js";
import { between, initialRank } from "./rank.js";
import type { Recurrence } from "./calendar.js";

/**
 * The next due date of a recurring task: one step after the previous due date, repeated until it is in
 * the future (a series finished late does not produce a backlog of overdue copies). Monthly keeps the
 * day of month, or the month's last day when it is shorter (31st → 30th/28th).
 */
export function nextDue(prev: Date, rule: Recurrence, timeZone: string, now = new Date()): Date {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" });
  const step = (d: Date): Date => {
    if (rule === "monthly") {
      const day = prev.getUTCDate();
      const n = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, d.getUTCHours(), d.getUTCMinutes()));
      const last = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 0)).getUTCDate();
      n.setUTCDate(Math.min(day, last));
      return n;
    }
    let n = new Date(d.getTime() + (rule === "weekly" ? 7 : rule === "biweekly" ? 14 : 1) * 86400_000);
    if (rule === "weekdays") while (["Sat", "Sun"].includes(weekday.format(n))) n = new Date(n.getTime() + 86400_000);
    return n;
  };
  let d = step(prev);
  for (let i = 0; i < 1000 && d <= now; i++) d = step(d);
  return d;
}

export type TaskStatus = "todo" | "in_progress" | "review" | "done" | "cancelled";

/**
 * Tasks synced from Asana, ClickUp, Linear or Jira (task-sync/) are read-only here: the next sync would overwrite an
 * edit, so it is refused with where to make it. Comments, watching and AI stay open.
 */
export function assertNotSynced(t: { source: unknown }) {
  const s = t.source as { type?: string; system?: string } | null;
  if (s?.type === "sync") throw new Invalid(`synced from ${s.system ?? "another tool"}: edit it there`);
}

export interface TaskRow {
  id: string;
  code: string;
  title: string;
  description: string;
  owner_id: string;
  assignee_id: string | null;
  project_id: string | null;
  team_id: string | null;
  status: TaskStatus;
  priority: string;
  due_at: Date | null;
  labels: string[];
  custom_fields: Record<string, unknown>;
  rank: string;
  parent_id: string | null;
  source: unknown;
  completed_at: Date | null;
  blocked_reason: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
  recurrence: Recurrence | null;
  progress: number | null;
  eta_at: Date | null;
  checkin_at: Date | null;
  /** The Kanban column (custom columns); null outside a project. */
  column_id: string | null;
  /** Gantt: when work starts (due_at is when it must be done). */
  start_at: Date | null;
  /** The agent workflow it is handed to (workflows.ts). */
  workflow_id: string | null;
}

export const TASK_COLS =
  "id, code, title, description, owner_id, assignee_id, project_id, team_id, status, priority, due_at, labels, custom_fields, rank, parent_id, source, completed_at, blocked_reason, version, created_at, updated_at, recurrence, progress, eta_at, checkin_at, column_id, start_at, workflow_id";

export function taskDto(t: TaskRow) {
  return {
    id: t.id,
    code: t.code,
    title: t.title,
    description: t.description,
    ownerId: t.owner_id,
    assigneeId: t.assignee_id,
    projectId: t.project_id,
    teamId: t.team_id,
    status: t.status,
    priority: t.priority,
    dueAt: t.due_at,
    labels: t.labels,
    customFields: t.custom_fields,
    rank: t.rank,
    parentId: t.parent_id,
    source: t.source,
    completedAt: t.completed_at,
    blockedReason: t.blocked_reason,
    version: t.version,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    recurrence: t.recurrence,
    progress: t.progress,
    etaAt: t.eta_at,
    checkinAt: t.checkin_at,
    columnId: t.column_id,
    startAt: t.start_at,
    workflowId: t.workflow_id,
    atRisk: atRisk(t),
  };
}

/**
 * Likely to miss its due date: the assignee's own forecast is past it, or it is due within two days
 * and they reported less than half done. Finished and undated work is never at risk.
 */
export function atRisk(t: Pick<TaskRow, "status" | "due_at" | "eta_at" | "progress">, now = Date.now()): boolean {
  if (!t.due_at || t.status === "done" || t.status === "cancelled") return false;
  if (t.eta_at && t.eta_at.getTime() > t.due_at.getTime()) return true;
  // Only a reported number counts: with no check-in we do not know (that shows as "chưa báo tiến độ").
  return t.due_at.getTime() - now < 2 * 86400_000 && t.due_at.getTime() > now && t.status !== "review" && t.progress != null && t.progress < 50;
}

/** A task is an owned resource for both its owner and its assignee. */
export function taskResources(t: Pick<TaskRow, "owner_id" | "assignee_id" | "team_id">): Resource[] {
  return [{ ownerId: t.owner_id, teamId: t.team_id }, ...(t.assignee_id ? [{ ownerId: t.assignee_id, teamId: t.team_id }] : [])];
}

/** Personal tasks (no project) are visible to owner, assignee and workspace-wide editors only. */
export function canReadTask(p: Principal, t: Pick<TaskRow, "project_id" | "owner_id" | "assignee_id" | "team_id">): boolean {
  if (t.project_id) return allowedAny(p, "task.read", taskResources(t));
  return t.owner_id === p.id || t.assignee_id === p.id || allowedAny(p, "task.edit", [{}]);
}

export async function getTask(c: PoolClient, p: Principal, id: string): Promise<TaskRow> {
  const r = await c.query<TaskRow>(`SELECT ${TASK_COLS} FROM tasks WHERE id = $1`, [id]);
  const t = r.rows[0];
  if (!t || !canReadTask(p, t)) throw new NotFound("task not found");
  return t;
}

/** People following a task (task_watchers): told about comments and completion like its owner and assignee. */
export async function watchersOf(c: PoolClient, taskId: string): Promise<string[]> {
  return (await c.query<{ user_id: string }>("SELECT user_id FROM task_watchers WHERE task_id = $1 ORDER BY created_at", [taskId])).rows.map((r) => r.user_id);
}

/**
 * Told, in the task's own transaction, when a task is created (`from` null) or its status changes: how workflows that
 * start by themselves hear of it (workflow-triggers.ts) without this file knowing about workflows.
 */
type TaskChangeListener = (c: PoolClient, t: TaskRow, from: TaskStatus | null) => Promise<void>;
const taskChangeListeners: TaskChangeListener[] = [];
export const onTaskChange = (fn: TaskChangeListener) => void taskChangeListeners.push(fn);
async function taskChanged(c: PoolClient, t: TaskRow, from: TaskStatus | null) {
  for (const fn of taskChangeListeners) await fn(c, t, from);
}

export function eventPayload(t: TaskRow) {
  return {
    taskId: t.id,
    code: t.code,
    title: t.title,
    description: t.description,
    ownerId: t.owner_id,
    assigneeId: t.assignee_id,
    projectId: t.project_id,
    status: t.status,
    priority: t.priority,
    dueAt: t.due_at,
    labels: t.labels,
    version: t.version,
    blockedReason: t.blocked_reason,
    source: t.source,
  };
}

export interface CreateTaskInput {
  title: string;
  description: string;
  assigneeId: string | null;
  projectId: string | null;
  priority: string;
  dueAt: string | null;
  labels: string[];
  customFields: Record<string, unknown>;
  parentId: string | null;
  source: Record<string, unknown> | null;
  recurrence?: Recurrence | null | undefined;
  /** Imports only: the status the task already had in the old tool. */
  status?: TaskStatus | undefined;
  /** Task sync only: the source's own key (ENG-123) as the code, when it is free. */
  code?: string | undefined;
  /** Kanban "+" on a column: the task starts there, with that column's status. */
  columnId?: string | null | undefined;
  /** When work starts (the Gantt bar's left end); due date is the right end. */
  startAt?: string | null | undefined;
}

export async function createTask(c: PoolClient, p: Principal, input: CreateTaskInput): Promise<TaskRow> {
  if (input.startAt && input.dueAt && Date.parse(input.startAt) > Date.parse(input.dueAt)) throw new Invalid("the start date is after the due date");
  requireAny(p, "task.create", [{}]);
  let teamId: string | null = null;
  if (input.projectId) {
    const pr = await c.query<{ team_id: string | null; status: string }>("SELECT team_id, status FROM projects WHERE id = $1", [input.projectId]);
    if (!pr.rows[0]) throw new NotFound("project not found");
    if (pr.rows[0].status === "archived") throw new Invalid("project is archived");
    teamId = pr.rows[0].team_id;
  }
  if (input.assigneeId && input.assigneeId !== p.id) {
    // Assigning someone else is the task.assign permission on the new task.
    requireAny(p, "task.assign", [{ ownerId: p.id, teamId }]);
  }
  if (input.parentId) {
    const parent = await c.query<{ parent_id: string | null }>("SELECT parent_id FROM tasks WHERE id = $1", [input.parentId]);
    if (!parent.rows[0]) throw new NotFound("parent task not found");
    if (parent.rows[0].parent_id) throw new Invalid("subtasks cannot have subtasks");
  }
  await validateCustomFields(c, "task", input.customFields, false);
  if (input.recurrence && !input.dueAt) throw new Invalid("a recurring task needs a due date");
  if (input.columnId) {
    if (!input.projectId) throw new Invalid("a column belongs to a project");
    const col = await c.query<{ status: TaskStatus }>("SELECT status FROM board_columns WHERE id = $1 AND project_id = $2", [input.columnId, input.projectId]);
    if (!col.rows[0]) throw new NotFound("column not found");
    // A column stands for a status, so a card added in "Review" is a task in review.
    return insertTask(c, p.id, teamId, { ...input, status: col.rows[0].status });
  }
  return insertTask(c, p.id, teamId, input);
}

/**
 * The highest rank in a project's status lane. `project_id IS NOT DISTINCT FROM` cannot use
 * tasks_project_status_rank_idx (a full scan while task creation holds the code counter lock), so the null and
 * non-null cases are separate queries.
 */
function lastRank(c: PoolClient, projectId: string | null, status: string, exceptId?: string) {
  const params: unknown[] = [status];
  let where = "status = $1";
  if (projectId === null) where += " AND project_id IS NULL";
  else where += ` AND project_id = $${params.push(projectId)}`;
  if (exceptId !== undefined) where += ` AND id <> $${params.push(exceptId)}`;
  return c.query<{ rank: string }>(`SELECT rank FROM tasks WHERE ${where} ORDER BY rank DESC LIMIT 1`, params);
}

/** Inserts a task (permissions already checked) and announces it. */
export async function insertTask(c: PoolClient, ownerId: string, teamId: string | null, input: CreateTaskInput): Promise<TaskRow> {
  const id = newId();
  const code = input.code ?? (await nextCode(c, "task", id));
  // A project's top-level task lands at the foot of its board column (the named one, else its status's); others in their status lane.
  const last =
    input.projectId && !input.parentId
      ? await c.query<{ rank: string }>("SELECT rank FROM tasks WHERE column_id = coalesce($1, work_column_for($2, $3)) AND parent_id IS NULL ORDER BY rank DESC LIMIT 1", [
          input.columnId ?? null,
          input.projectId,
          input.status ?? "todo",
        ])
      : await lastRank(c, input.projectId ?? null, input.status ?? "todo");
  const rank = last.rows[0] ? between(last.rows[0].rank, null) : initialRank();
  const r = await c.query<TaskRow>(
    `INSERT INTO tasks (id, code, title, description, owner_id, assignee_id, project_id, team_id, priority, due_at, labels, custom_fields, rank, parent_id, source, recurrence, status, completed_at, column_id, start_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, CASE WHEN $17 = 'done' THEN now() END, $18, $19) RETURNING ${TASK_COLS}`,
    [
      id,
      code,
      input.title,
      input.description,
      ownerId,
      input.assigneeId,
      input.projectId,
      teamId,
      input.priority,
      input.dueAt,
      input.labels,
      JSON.stringify(input.customFields),
      rank,
      input.parentId,
      input.source ? JSON.stringify(input.source) : null,
      input.recurrence ?? null,
      input.status ?? "todo",
      input.columnId ?? null,
      input.startAt ?? null,
    ],
  );
  const t = r.rows[0]!;
  await activity(c, "task", id, "created", { title: t.title, source: input.source });
  await emit(c, "work.task.created.v1", "work.task", id, eventPayload(t));
  await taskChanged(c, t, null);
  return t;
}

/** Finishing a recurring task creates the next one (same owner, assignee, project and fields; next due date). */
async function spawnNext(c: PoolClient, before: TaskRow, after: TaskRow): Promise<void> {
  if (!after.recurrence || !after.due_at || before.status === "done" || after.status !== "done") return;
  const next = await insertTask(c, after.owner_id, after.team_id, {
    title: after.title,
    description: after.description,
    assigneeId: after.assignee_id,
    projectId: after.project_id,
    priority: after.priority,
    dueAt: nextDue(after.due_at, after.recurrence, await workspaceTimeZone(c)).toISOString(),
    labels: after.labels,
    customFields: after.custom_fields,
    parentId: null,
    source: { type: "recurring", fromTaskId: after.id, fromCode: after.code },
    recurrence: after.recurrence,
  });
  await activity(c, "task", after.id, "recurred", { nextTaskId: next.id, nextCode: next.code });
}

export interface UpdateTaskInput {
  expectedVersion: number;
  title?: string | undefined;
  description?: string | undefined;
  assigneeId?: string | null | undefined;
  priority?: string | undefined;
  dueAt?: string | null | undefined;
  labels?: string[] | undefined;
  customFields?: Record<string, unknown> | undefined;
  status?: TaskStatus | undefined;
  /** A reason marks the task blocked; null clears it. Finishing or cancelling the task clears it too. */
  blockedReason?: string | null | undefined;
  recurrence?: Recurrence | null | undefined;
  /** Gantt: the day work starts; must not be after the due date. */
  startAt?: string | null | undefined;
}

/** Optimistic concurrency: callers send the version they edited; stale writes get 409. */
export async function updateTask(c: PoolClient, p: Principal, id: string, input: UpdateTaskInput): Promise<TaskRow> {
  const t = await getTask(c, p, id);
  requireAny(p, "task.edit", taskResources(t));
  assertNotSynced(t);
  if (input.assigneeId !== undefined && input.assigneeId !== t.assignee_id) requireAny(p, "task.assign", taskResources(t));
  if (input.customFields) await validateCustomFields(c, "task", input.customFields, true);
  const status = input.status ?? t.status;
  const blocked = ["done", "cancelled"].includes(status) ? null : input.blockedReason === undefined ? t.blocked_reason : input.blockedReason?.trim() || null;
  const startAt = input.startAt === undefined ? t.start_at : input.startAt;
  const dueAt = input.dueAt === undefined ? t.due_at : input.dueAt;
  if (startAt && dueAt && new Date(startAt).getTime() > new Date(dueAt).getTime()) throw new Invalid("the start date is after the due date");
  const r = await c.query<TaskRow>(
    `UPDATE tasks SET title = $3, description = $4, assignee_id = $5, priority = $6, due_at = $7, labels = $8,
            custom_fields = custom_fields || $9::jsonb, status = $10, blocked_reason = $11, recurrence = CASE WHEN $12 THEN $13 ELSE recurrence END,
            completed_at = CASE WHEN $10 = 'done' AND status <> 'done' THEN now() WHEN $10 <> 'done' THEN NULL ELSE completed_at END,
            start_at = $14, version = version + 1, updated_at = now()
      WHERE id = $1 AND version = $2 RETURNING ${TASK_COLS}`,
    [
      id,
      input.expectedVersion,
      input.title ?? t.title,
      input.description ?? t.description,
      input.assigneeId === undefined ? t.assignee_id : input.assigneeId,
      input.priority ?? t.priority,
      input.dueAt === undefined ? t.due_at : input.dueAt,
      input.labels ?? t.labels,
      JSON.stringify(input.customFields ?? {}),
      status,
      blocked,
      input.recurrence !== undefined,
      input.recurrence ?? null,
      startAt,
    ],
  );
  let u = r.rows[0];
  if (!u) throw new Conflict("task changed since you loaded it", { currentVersion: t.version });
  // A new status moved the card to another column (work_task_column_sync): it goes to the foot of that column.
  if (u.column_id && u.column_id !== t.column_id) {
    const last = await c.query<{ rank: string }>("SELECT rank FROM tasks WHERE column_id = $1 AND parent_id IS NULL AND id <> $2 ORDER BY rank DESC LIMIT 1", [u.column_id, id]);
    const rank = last.rows[0] ? between(last.rows[0].rank, null) : initialRank();
    u = (await c.query<TaskRow>(`UPDATE tasks SET rank = $2 WHERE id = $1 RETURNING ${TASK_COLS}`, [id, rank])).rows[0]!;
  }
  const changes: Record<string, unknown> = {};
  for (const k of ["title", "assignee_id", "priority", "start_at", "due_at", "status", "blocked_reason"] as const) {
    if (String(t[k]) !== String(u[k])) changes[k] = { from: t[k], to: u[k] };
  }
  if (u.recurrence && !u.due_at) throw new Invalid("a recurring task needs a due date");
  await activity(c, "task", id, "updated", changes);
  await emit(c, "work.task.updated.v1", "work.task", id, eventPayload(u));
  if (u.status === "done" && t.status !== "done") await emit(c, "work.task.completed.v1", "work.task", id, { ...eventPayload(u), watchers: await watchersOf(c, id) });
  if (u.status !== t.status) await taskChanged(c, u, t.status);
  await spawnNext(c, t, u);
  return u;
}

/**
 * Kanban move: column and position, and/or a new status. Each column stands for a status: moving a card to another
 * column gives it that column's status (a cancelled card dragged onto the board is reopened with it), and a new status
 * without a column moves the card to its status's column, unless its current column already has that status.
 * WIP limits apply to the target column; moves inside the same column never count against it.
 */
export async function moveTask(
  c: PoolClient,
  p: Principal,
  id: string,
  input: { status?: TaskStatus | undefined; columnId?: string | undefined; afterId: string | null; beforeId: string | null; expectedVersion: number },
): Promise<TaskRow> {
  const t = await getTask(c, p, id);
  requireAny(p, "task.edit", taskResources(t));
  assertNotSynced(t);
  type Col = { id: string; wip_limit: number | null; name: string; status: TaskStatus };
  let col: Col | null = null;
  let from: string | null = null;
  let status: TaskStatus = input.status ?? t.status;
  if (t.project_id && !t.parent_id) {
    const cur = t.column_id ? (await c.query<Col>("SELECT id, wip_limit, name, status FROM board_columns WHERE id = $1", [t.column_id])).rows[0] : undefined;
    // The target column: the one named, else the current one when it already has the status, else the status's column.
    const target = input.columnId ?? (cur && (cur.status === status || status === "cancelled") ? cur.id : null);
    const r = await c.query<Col>("SELECT id, wip_limit, name, status FROM board_columns WHERE id = coalesce($1, work_column_for($2, $3)) AND project_id = $2 FOR UPDATE", [
      target,
      t.project_id,
      status,
    ]);
    col = r.rows[0] ?? null;
    if (input.columnId && !col) throw new NotFound("column not found");
    if (col && input.columnId) status = col.status;
    if (col && cur && cur.id !== col.id) from = cur.name;
  }
  if (col && t.column_id !== col.id && col.wip_limit !== null) {
    const n = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM tasks WHERE column_id = $1 AND id <> $2 AND parent_id IS NULL AND status <> 'cancelled'", [col.id, id]);
    if ((n.rows[0]?.n ?? 0) >= col.wip_limit) throw new Conflict(`WIP limit reached for ${col.name}`, { error: "wip_limit", limit: col.wip_limit });
  }
  const rankOf = async (otherId: string | null) => {
    if (!otherId) return null;
    const r = await c.query<{ rank: string; status: string; project_id: string | null; column_id: string | null }>(
      "SELECT rank, status, project_id, column_id FROM tasks WHERE id = $1",
      [otherId],
    );
    const o = r.rows[0];
    const same = col ? o?.column_id === col.id : o?.status === status;
    if (!o || !same || o.project_id !== t.project_id) throw new Invalid("neighbour is not in the target column");
    return o.rank;
  };
  const after = await rankOf(input.afterId);
  const before = await rankOf(input.beforeId);
  let rank: string;
  if (after === null && before === null) {
    if (col && t.column_id === col.id && !input.columnId) rank = t.rank;
    else {
      const last = col
        ? // Subtasks never carry a column (work_task_column_sync clears it), so the predicate only lets tasks_column_rank apply.
          await c.query<{ rank: string }>("SELECT rank FROM tasks WHERE column_id = $1 AND parent_id IS NULL AND id <> $2 ORDER BY rank DESC LIMIT 1", [col.id, id])
        : await lastRank(c, t.project_id, status, id);
      rank = last.rows[0] ? between(last.rows[0].rank, null) : initialRank();
    }
  } else {
    rank = between(after, before);
  }
  const r = await c.query<TaskRow>(
    `UPDATE tasks SET status = $3, rank = $4, column_id = coalesce($5, column_id), version = version + 1, updated_at = now(),
            blocked_reason = CASE WHEN $3 IN ('done', 'cancelled') THEN NULL ELSE blocked_reason END,
            completed_at = CASE WHEN $3 = 'done' AND status <> 'done' THEN now() WHEN $3 <> 'done' THEN NULL ELSE completed_at END
      WHERE id = $1 AND version = $2 RETURNING ${TASK_COLS}`,
    [id, input.expectedVersion, status, rank, col?.id ?? null],
  );
  const u = r.rows[0];
  if (!u) throw new Conflict("task changed since you loaded it", { currentVersion: t.version });
  // History: a status change reads "from → to" in statuses; a move between two columns of one status in column names.
  if (u.status !== t.status) await activity(c, "task", id, "moved", { from: t.status, to: u.status });
  else if (col && t.column_id !== col.id) await activity(c, "task", id, "moved", { from: from ?? "", to: col.name, column: col.name });
  await emit(c, "work.task.updated.v1", "work.task", id, eventPayload(u));
  if (u.status === "done" && t.status !== "done") await emit(c, "work.task.completed.v1", "work.task", id, { ...eventPayload(u), watchers: await watchersOf(c, id) });
  if (u.status !== t.status) await taskChanged(c, u, t.status);
  await spawnNext(c, t, u);
  return u;
}

/**
 * After a column write that changed tasks' status through work_task_column_sync (a column deleted into another, or a
 * column made to stand for another status): each task whose status changed gets the same history line and events as
 * a move, so reports, notifications and search see it.
 */
export async function announceStatusChanges(c: PoolClient, before: { id: string; status: TaskStatus }[]) {
  if (!before.length) return;
  const was = new Map(before.map((t) => [t.id, t.status]));
  const rows = (await c.query<TaskRow>(`SELECT ${TASK_COLS} FROM tasks WHERE id = ANY($1)`, [before.map((t) => t.id)])).rows;
  for (const u of rows) {
    const from = was.get(u.id);
    if (!from || from === u.status) continue;
    await activity(c, "task", u.id, "moved", { from, to: u.status });
    await taskChanged(c, u, from);
    await emit(c, "work.task.updated.v1", "work.task", u.id, eventPayload(u));
    if (u.status === "done") await emit(c, "work.task.completed.v1", "work.task", u.id, { ...eventPayload(u), watchers: await watchersOf(c, u.id) });
  }
}

/**
 * Whoever created a task may take it back (a typo, a duplicate) without a manager; anyone else needs
 * `task.delete` on it (Manager on the team's tasks, Admin everywhere). Being the assignee is not enough:
 * deleting work someone handed you would hide it from them.
 */
export function canDeleteTask(p: Principal, t: Pick<TaskRow, "owner_id" | "assignee_id" | "team_id">): boolean {
  return t.owner_id === p.id || allowedAny(p, "task.delete", taskResources(t));
}

/** Returns every id removed: the task and its subtasks. */
export async function deleteTask(c: PoolClient, p: Principal, id: string): Promise<string[]> {
  const t = await getTask(c, p, id);
  if (!canDeleteTask(p, t)) throw new Forbidden("not allowed: task.delete");
  assertNotSynced(t);
  // Subtasks go with their parent (any depth): left behind they would surface as loose tasks nobody asked for.
  const subs = (
    await c.query<{ id: string; code: string }>(
      `WITH RECURSIVE sub AS (SELECT id, code FROM tasks WHERE parent_id = $1
         UNION ALL SELECT t.id, t.code FROM tasks t JOIN sub ON t.parent_id = sub.id)
       SELECT id, code FROM sub`,
      [id],
    )
  ).rows;
  await c.query("DELETE FROM tasks WHERE id = ANY($1)", [[id, ...subs.map((s) => s.id)]]);
  for (const s of subs) {
    await activity(c, "task", s.id, "deleted", { code: s.code, withParent: t.code });
    await emit(c, "work.task.deleted.v1", "work.task", s.id, { taskId: s.id, code: s.code });
  }
  await activity(c, "task", id, "deleted", { code: t.code, subtasks: subs.length });
  await emit(c, "work.task.deleted.v1", "work.task", id, { taskId: id, code: t.code });
  return [id, ...subs.map((s) => s.id)];
}

export async function addComment(c: PoolClient, p: Principal, taskId: string, body: string) {
  const t = await getTask(c, p, taskId);
  if (!canReadTask(p, t)) throw new Forbidden("cannot comment");
  return insertComment(c, p, t, body);
}

/** Writes a comment and notifies mentions; callers decide who may comment. */
/** `agent`: a workflow posting its result; the comment shows under that name, `p` stays its author (migration work/010). */
export async function insertComment(c: PoolClient, p: Principal, t: TaskRow, body: string, agent: string | null = null) {
  const taskId = t.id;
  const id = newId();
  await c.query("INSERT INTO task_comments (id, task_id, author_id, body, agent) VALUES ($1,$2,$3,$4,$5)", [id, taskId, p.id, body, agent ? agent.slice(0, 200) : null]);
  await activity(c, "task", taskId, "commented", { commentId: id });
  const mentions = mentionsIn(body, p.id);
  await emit(c, "work.task.commented.v1", "work.task", taskId, {
    taskId,
    commentId: id,
    authorId: p.id,
    ownerId: t.owner_id,
    assigneeId: t.assignee_id,
    code: t.code,
    title: t.title,
    watchers: await watchersOf(c, taskId),
    mentions,
  });
  return { id };
}

/** People @mentioned in a comment (the same <@userId> tokens as chat), never its author. */
function mentionsIn(body: string, authorId: string): string[] {
  return [...new Set([...body.matchAll(/<@([A-Za-z0-9_-]{1,64})>/g)].map((m) => m[1]!))].filter((u) => u !== authorId).slice(0, 50);
}

export interface CommentDto {
  id: string;
  authorId: string;
  /** Set when a workflow wrote it: its name. */
  agent: string | null;
  body: string;
  createdAt: Date;
  editedAt: Date | null;
}
const COMMENT_COLS = `id, author_id AS "authorId", agent, body, created_at AS "createdAt", edited_at AS "editedAt"`;

async function commentOn(c: PoolClient, taskId: string, commentId: string) {
  const cm = (await c.query<CommentDto>(`SELECT ${COMMENT_COLS} FROM task_comments WHERE id = $1 AND task_id = $2`, [commentId, taskId])).rows[0];
  if (!cm) throw new NotFound("comment not found");
  return cm;
}

/**
 * The author rewrites their comment. People @mentioned for the first time hear about it; those mentioned before
 * are not told again, and owner and assignee get no second "new comment".
 */
export async function editTaskComment(c: PoolClient, p: Principal, taskId: string, commentId: string, body: string): Promise<CommentDto> {
  const t = await getTask(c, p, taskId);
  if (!canReadTask(p, t)) throw new Forbidden("cannot read this task");
  const cm = await commentOn(c, taskId, commentId);
  if (cm.authorId !== p.id) throw new Forbidden("only the author can edit a comment");
  if (cm.body === body) return cm;
  const u = (await c.query<CommentDto>(`UPDATE task_comments SET body = $2, edited_at = now() WHERE id = $1 RETURNING ${COMMENT_COLS}`, [commentId, body])).rows[0]!;
  await activity(c, "task", taskId, "comment_edited", { commentId });
  const before = new Set(mentionsIn(cm.body, p.id));
  const added = mentionsIn(body, p.id).filter((x) => !before.has(x));
  await emit(c, "work.task.comment_edited.v1", "work.task", taskId, { taskId, commentId, authorId: p.id, code: t.code, title: t.title, mentions: added });
  return u;
}

/**
 * Deletes a comment outright (its text is gone, not hidden): the author, or anyone who may delete the task itself
 * (and every comment with it). The history keeps a line saying who removed whose comment, without the text.
 */
export async function deleteTaskComment(c: PoolClient, p: Principal, taskId: string, commentId: string): Promise<void> {
  const t = await getTask(c, p, taskId);
  if (!canReadTask(p, t)) throw new Forbidden("cannot read this task");
  const cm = await commentOn(c, taskId, commentId);
  if (cm.authorId !== p.id) requireAny(p, "task.delete", taskResources(t));
  await c.query("DELETE FROM task_comments WHERE id = $1", [commentId]);
  await activity(c, "task", taskId, "comment_deleted", { commentId, authorId: cm.authorId });
  await emit(c, "work.task.comment_deleted.v1", "work.task", taskId, { taskId, commentId });
}

/**
 * "Cập nhật tiến độ": the assignee (or anyone who may edit the task) says how far along it is, when
 * they expect to finish, and optionally what is going on. It is kept on the task and posted as a
 * comment, so whoever assigned it is notified and the history stays in one place.
 */
export async function checkIn(c: PoolClient, p: Principal, id: string, input: { progress: number; etaAt: string | null; note: string }, locale: "vi" | "en" = "vi") {
  const t = await getTask(c, p, id);
  requireAny(p, "task.edit", taskResources(t));
  assertNotSynced(t);
  if (t.status === "done" || t.status === "cancelled") throw new Conflict("this task is finished");
  const status = input.progress > 0 && t.status === "todo" ? "in_progress" : t.status;
  const r = await c.query<TaskRow>(
    `UPDATE tasks SET progress = $2, eta_at = $3, checkin_at = now(), status = $4, version = version + 1, updated_at = now() WHERE id = $1 RETURNING ${TASK_COLS}`,
    [id, input.progress, input.etaAt, status],
  );
  const u = r.rows[0]!;
  // The comment stays as written, so it is in the language of whoever checked in (x-locale), like a message.
  const words = locale === "en" ? { progress: "Progress", eta: "expected done" } : { progress: "Tiến độ", eta: "dự kiến xong" };
  const eta = u.eta_at ? ` · ${words.eta} ${ddmm(u.eta_at, await workspaceTimeZone(c))}` : "";
  const notify = t.owner_id !== p.id ? `<@${t.owner_id}> ` : "";
  const body = `${notify}📍 ${words.progress} ${input.progress}%${eta}${input.note.trim() ? `\n${input.note.trim()}` : ""}`.slice(0, 4000);
  const comment = await insertComment(c, p, u, body);
  await activity(c, "task", id, "checked_in", { progress: input.progress, etaAt: input.etaAt });
  return { ...taskDto(u), comment: { id: comment.id, body } };
}

export interface ImportRow {
  title: string;
  description: string;
  status: TaskStatus;
  priority: string;
  assigneeId: string | null;
  dueAt: string | null;
  labels: string[];
  key: string | null;
  /** The source key of the parent task in the same import (ClickUp subtasks); subtasks go one level deep. */
  parentKey?: string | null;
}

/**
 * Brings a project's tasks over from another tool (Jira, Trello, Asana, ClickUp, Notion, any CSV) in one transaction.
 * Each task keeps its status and its old key in the source. If the importer may not assign a task to
 * someone else, that task is imported unassigned rather than failing the whole import. Parents are created before
 * their subtasks; a parent that is not in the import leaves the subtask at the top level.
 */
export async function importTasks(c: PoolClient, p: Principal, projectId: string, system: string, rows: ImportRow[]) {
  let created = 0;
  let unassigned = 0;
  const idByKey = new Map<string, string>();
  const ordered = [...rows.filter((r) => !r.parentKey), ...rows.filter((r) => r.parentKey)];
  for (const r of ordered) {
    const input: CreateTaskInput = {
      title: r.title,
      description: r.description,
      assigneeId: r.assigneeId,
      projectId,
      priority: r.priority,
      dueAt: r.dueAt,
      labels: r.labels,
      customFields: {},
      parentId: (r.parentKey && idByKey.get(r.parentKey)) || null,
      source: { type: "import", system, key: r.key },
      status: r.status,
    };
    let task: { id: string };
    try {
      await c.query("SAVEPOINT import_row");
      task = await createTask(c, p, input);
    } catch (e) {
      await c.query("ROLLBACK TO SAVEPOINT import_row");
      if (!(e instanceof Forbidden) || !r.assigneeId) throw e;
      task = await createTask(c, p, { ...input, assigneeId: null });
      unassigned++;
    }
    if (r.key && !r.parentKey) idByKey.set(r.key, task.id);
    created++;
  }
  return { created, unassigned };
}
