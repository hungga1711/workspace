import type { PoolClient } from "pg";
import { newId, type Principal } from "@workspace/shared";
import { activity, allowedAny, emit, requireAny } from "./common.js";
import { Conflict, Forbidden, Invalid, NotFound } from "./errors.js";
import { between, initialRank } from "./rank.js";
import { assertNotSynced, createTask, deleteTask, eventPayload, getTask, TASK_COLS, taskResources, updateTask, watchersOf, type TaskRow, type TaskStatus } from "./tasks.js";
import type { Recurrence } from "./calendar.js";

/**
 * The everyday actions on a task beyond editing its fields: follow it, move it to another project, copy it, turn a
 * subtask into a task (or back), order subtasks, change many tasks at once, and save or use templates.
 */

// ---- watchers ----

export async function setWatching(c: PoolClient, p: Principal, taskId: string, on: boolean) {
  await getTask(c, p, taskId);
  if (on) await c.query("INSERT INTO task_watchers (task_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [taskId, p.id]);
  else await c.query("DELETE FROM task_watchers WHERE task_id = $1 AND user_id = $2", [taskId, p.id]);
  const watchers = await watchersOf(c, taskId);
  return { watching: watchers.includes(p.id), watchers };
}

// ---- move to another project ----

/**
 * Moves a top-level task (and its subtasks) to another project, or to the person's own to-dos (null). The status is
 * kept: work_task_column_sync puts the card in the new project's column for that status, at its foot.
 */
export async function moveToProject(c: PoolClient, p: Principal, id: string, input: { projectId: string | null; expectedVersion: number }): Promise<TaskRow> {
  const t = await getTask(c, p, id);
  requireAny(p, "task.edit", taskResources(t));
  assertNotSynced(t);
  if (t.parent_id) throw new Invalid("a subtask moves with its parent task");
  if (input.projectId === t.project_id) return t;
  let teamId: string | null = null;
  if (input.projectId) {
    const pr = (await c.query<{ team_id: string | null; status: string }>("SELECT team_id, status FROM projects WHERE id = $1", [input.projectId])).rows[0];
    if (!pr) throw new NotFound("project not found");
    if (pr.status === "archived") throw new Invalid("project is archived");
    teamId = pr.team_id;
    // Putting work into a project is creating work there: the same permission as a new task in it.
    requireAny(p, "task.create", [{ ownerId: p.id, teamId }]);
  }
  const r = await c.query<TaskRow>(
    `UPDATE tasks SET project_id = $3, team_id = $4, column_id = NULL, version = version + 1, updated_at = now()
      WHERE id = $1 AND version = $2 RETURNING ${TASK_COLS}`,
    [id, input.expectedVersion, input.projectId, teamId],
  );
  let u = r.rows[0];
  if (!u) throw new Conflict("task changed since you loaded it", { currentVersion: t.version });
  if (u.column_id) {
    const last = await c.query<{ rank: string }>("SELECT rank FROM tasks WHERE column_id = $1 AND parent_id IS NULL AND id <> $2 ORDER BY rank DESC LIMIT 1", [u.column_id, id]);
    u = (await c.query<TaskRow>(`UPDATE tasks SET rank = $2 WHERE id = $1 RETURNING ${TASK_COLS}`, [id, last.rows[0] ? between(last.rows[0].rank, null) : initialRank()])).rows[0]!;
  }
  // Subtasks live in their parent's project.
  const subs = await c.query<TaskRow>(`UPDATE tasks SET project_id = $2, team_id = $3, version = version + 1, updated_at = now() WHERE parent_id = $1 RETURNING ${TASK_COLS}`, [
    id,
    input.projectId,
    teamId,
  ]);
  await activity(c, "task", id, "project_moved", { from: t.project_id, to: input.projectId });
  await emit(c, "work.task.updated.v1", "work.task", id, eventPayload(u));
  for (const s of subs.rows) await emit(c, "work.task.updated.v1", "work.task", s.id, eventPayload(s));
  return u;
}

// ---- duplicate ----

/** A copy of a task (open, unassigned fields kept), optionally with its subtasks; the copy says where it came from. */
export async function duplicateTask(c: PoolClient, p: Principal, id: string, input: { title?: string | undefined; withSubtasks: boolean }): Promise<TaskRow> {
  const t = await getTask(c, p, id);
  const copy = await createTask(c, p, {
    title: (input.title?.trim() || t.title).slice(0, 300),
    description: t.description,
    assigneeId: t.assignee_id,
    projectId: t.project_id,
    priority: t.priority,
    dueAt: t.due_at ? t.due_at.toISOString() : null,
    labels: t.labels,
    customFields: t.custom_fields,
    parentId: t.parent_id,
    source: { type: "duplicate", fromTaskId: t.id, fromCode: t.code },
    recurrence: t.recurrence,
    startAt: t.start_at ? t.start_at.toISOString() : null,
  });
  if (input.withSubtasks && !t.parent_id) {
    const subs = await c.query<TaskRow>(`SELECT ${TASK_COLS} FROM tasks WHERE parent_id = $1 ORDER BY rank, created_at`, [id]);
    for (const s of subs.rows)
      await createTask(c, p, {
        title: s.title,
        description: s.description,
        assigneeId: s.assignee_id,
        projectId: copy.project_id,
        priority: s.priority,
        dueAt: s.due_at ? s.due_at.toISOString() : null,
        labels: s.labels,
        customFields: s.custom_fields,
        parentId: copy.id,
        source: null,
      });
  }
  await activity(c, "task", id, "duplicated", { copyId: copy.id, copyCode: copy.code });
  return copy;
}

// ---- subtask ⇄ task ----

/**
 * Makes a subtask a task of its own (parentId null), or a task a subtask of another top-level task. Subtasks go one
 * level deep, so a task with subtasks cannot become one; the new subtask joins its parent's project.
 */
export async function setParent(c: PoolClient, p: Principal, id: string, input: { parentId: string | null; expectedVersion: number }): Promise<TaskRow> {
  const t = await getTask(c, p, id);
  requireAny(p, "task.edit", taskResources(t));
  assertNotSynced(t);
  if (input.parentId === t.parent_id) return t;
  let projectId = t.project_id;
  let teamId = t.team_id;
  if (input.parentId) {
    if (input.parentId === id) throw new Invalid("a task cannot be its own subtask");
    const parent = await getTask(c, p, input.parentId);
    if (parent.parent_id) throw new Invalid("subtasks cannot have subtasks");
    const kids = await c.query("SELECT 1 FROM tasks WHERE parent_id = $1 LIMIT 1", [id]);
    if (kids.rowCount) throw new Invalid("a task with subtasks cannot become a subtask");
    projectId = parent.project_id;
    teamId = parent.team_id;
  }
  const last = input.parentId
    ? await c.query<{ rank: string }>("SELECT rank FROM tasks WHERE parent_id = $1 ORDER BY rank DESC LIMIT 1", [input.parentId])
    : projectId
      ? await c.query<{ rank: string }>("SELECT rank FROM tasks WHERE column_id = work_column_for($1, $2) AND parent_id IS NULL ORDER BY rank DESC LIMIT 1", [projectId, t.status])
      : { rows: [] as { rank: string }[] };
  const rank = last.rows[0] ? between(last.rows[0].rank, null) : initialRank();
  const r = await c.query<TaskRow>(
    `UPDATE tasks SET parent_id = $3, project_id = $4, team_id = $5, column_id = NULL, rank = $6, version = version + 1, updated_at = now()
      WHERE id = $1 AND version = $2 RETURNING ${TASK_COLS}`,
    [id, input.expectedVersion, input.parentId, projectId, teamId, rank],
  );
  const u = r.rows[0];
  if (!u) throw new Conflict("task changed since you loaded it", { currentVersion: t.version });
  await activity(c, "task", id, input.parentId ? "made_subtask" : "made_task", { from: t.parent_id, to: input.parentId });
  await emit(c, "work.task.updated.v1", "work.task", id, eventPayload(u));
  return u;
}

/** Puts a task's subtasks in the order given (ids not among its subtasks are refused; missing ones keep their place after). */
export async function orderSubtasks(c: PoolClient, p: Principal, parentId: string, ids: string[]) {
  const parent = await getTask(c, p, parentId);
  requireAny(p, "task.edit", taskResources(parent));
  const subs = (await c.query<{ id: string }>("SELECT id FROM tasks WHERE parent_id = $1 ORDER BY rank, created_at", [parentId])).rows.map((r) => r.id);
  const known = new Set(subs);
  if (ids.some((x) => !known.has(x))) throw new Invalid("not a subtask of this task");
  const order = [...new Set(ids), ...subs.filter((x) => !ids.includes(x))];
  let rank: string | null = null;
  for (const sid of order) {
    rank = between(rank, null);
    await c.query("UPDATE tasks SET rank = $2 WHERE id = $1", [sid, rank]);
  }
  return { order };
}

// ---- bulk ----

export interface BulkInput {
  ids: string[];
  status?: TaskStatus | undefined;
  assigneeId?: string | null | undefined;
  priority?: string | undefined;
  dueAt?: string | null | undefined;
  addLabels?: string[] | undefined;
  removeLabels?: string[] | undefined;
  /** undefined: unchanged; null: the person's own to-dos. */
  projectId?: string | null | undefined;
  delete?: boolean | undefined;
}

/**
 * The same change on many tasks. Each task is checked and saved on its own (a savepoint each): one the person may not
 * change, or that someone else just changed, is reported and the rest still go through.
 */
export async function bulkTasks(c: PoolClient, p: Principal, input: BulkInput) {
  const ok: string[] = [];
  const failed: { id: string; error: string }[] = [];
  // Subtasks already removed with a parent picked earlier in the same request count as done, not as missing.
  const gone = new Set<string>();
  for (const id of [...new Set(input.ids)].slice(0, 500)) {
    if (gone.has(id)) {
      ok.push(id);
      continue;
    }
    await c.query("SAVEPOINT bulk_task");
    try {
      if (input.delete) {
        for (const d of await deleteTask(c, p, id)) gone.add(d);
      } else {
        let t = await getTask(c, p, id);
        if (input.projectId !== undefined && input.projectId !== t.project_id && !t.parent_id)
          t = await moveToProject(c, p, id, { projectId: input.projectId, expectedVersion: t.version });
        const labels =
          input.addLabels?.length || input.removeLabels?.length
            ? [...new Set([...t.labels.filter((l) => !input.removeLabels?.includes(l)), ...(input.addLabels ?? [])])].slice(0, 20)
            : undefined;
        const patch = {
          expectedVersion: t.version,
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {}),
          ...(input.priority !== undefined ? { priority: input.priority } : {}),
          ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
          ...(labels ? { labels } : {}),
        };
        if (Object.keys(patch).length > 1) await updateTask(c, p, id, patch);
      }
      await c.query("RELEASE SAVEPOINT bulk_task");
      ok.push(id);
    } catch (e) {
      await c.query("ROLLBACK TO SAVEPOINT bulk_task");
      const err = e as { status?: number; message?: string };
      failed.push({
        id,
        error:
          e instanceof Forbidden || err.status === 403
            ? "forbidden"
            : e instanceof NotFound || err.status === 404
              ? "not_found"
              : e instanceof Conflict
                ? "conflict"
                : (err.message ?? "failed"),
      });
    }
  }
  const rows = ok.length && !input.delete ? (await c.query<TaskRow>(`SELECT ${TASK_COLS} FROM tasks WHERE id = ANY($1)`, [ok])).rows : [];
  return { ok, failed, tasks: rows };
}

// ---- templates ----

export interface TemplatePayload {
  title: string;
  description: string;
  priority: string;
  labels: string[];
  subtasks: string[];
  recurrence?: Recurrence | null | undefined;
}
interface TemplateRow {
  id: string;
  name: string;
  project_id: string | null;
  created_by: string;
  payload: TemplatePayload;
  created_at: Date;
}
const templateDto = (r: TemplateRow) => ({ id: r.id, name: r.name, projectId: r.project_id, createdBy: r.created_by, payload: r.payload, createdAt: r.created_at });

/** Templates offered where a task is created: the workspace's, plus the project's when one is given. */
export async function listTemplates(c: PoolClient, p: Principal, projectId: string | null) {
  requireAny(p, "task.read", [{}]);
  const r = await c.query<TemplateRow>(
    "SELECT id, name, project_id, created_by, payload, created_at FROM task_templates WHERE project_id IS NULL OR project_id = $1 ORDER BY project_id NULLS LAST, name",
    [projectId],
  );
  return r.rows.map(templateDto);
}

/** Saves a task's shape (and its subtasks' titles) as a template for the project, or for everyone. */
export async function saveTemplate(c: PoolClient, p: Principal, input: { name: string; taskId: string; projectId: string | null }) {
  requireAny(p, "task.create", [{}]);
  const t = await getTask(c, p, input.taskId);
  if (input.projectId && input.projectId !== t.project_id) throw new Invalid("a project template comes from a task in that project");
  const subtasks = (await c.query<{ title: string }>("SELECT title FROM tasks WHERE parent_id = $1 ORDER BY rank, created_at", [t.id])).rows.map((r) => r.title);
  const payload: TemplatePayload = { title: t.title, description: t.description, priority: t.priority, labels: t.labels, subtasks, recurrence: t.recurrence };
  const r = await c.query<TemplateRow>(
    "INSERT INTO task_templates (id, name, project_id, created_by, payload) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, project_id, created_by, payload, created_at",
    [newId(), input.name.trim().slice(0, 120), input.projectId, p.id, JSON.stringify(payload)],
  );
  return templateDto(r.rows[0]!);
}

/** The person who saved it, or anyone who may delete tasks workspace-wide. */
export async function deleteTemplate(c: PoolClient, p: Principal, id: string) {
  const r = (await c.query<TemplateRow>("SELECT id, name, project_id, created_by, payload, created_at FROM task_templates WHERE id = $1", [id])).rows[0];
  if (!r) throw new NotFound("template not found");
  if (r.created_by !== p.id && !allowedAny(p, "task.delete", [{}])) throw new Forbidden("not allowed: task.delete");
  await c.query("DELETE FROM task_templates WHERE id = $1", [id]);
}

/** A new task (and its subtasks) from a template, in the project and column asked for. */
export async function useTemplate(
  c: PoolClient,
  p: Principal,
  id: string,
  input: { projectId: string | null; columnId?: string | null | undefined; assigneeId?: string | null | undefined; dueAt?: string | null | undefined; title?: string | undefined },
): Promise<TaskRow> {
  const r = (await c.query<TemplateRow>("SELECT id, name, project_id, created_by, payload, created_at FROM task_templates WHERE id = $1", [id])).rows[0];
  if (!r) throw new NotFound("template not found");
  const tp = r.payload;
  const task = await createTask(c, p, {
    title: (input.title?.trim() || tp.title).slice(0, 300),
    description: tp.description ?? "",
    assigneeId: input.assigneeId === undefined ? p.id : input.assigneeId,
    projectId: input.projectId,
    priority: tp.priority ?? "medium",
    dueAt: input.dueAt ?? null,
    labels: tp.labels ?? [],
    customFields: {},
    parentId: null,
    source: { type: "template", templateId: r.id, templateName: r.name },
    recurrence: input.dueAt ? (tp.recurrence ?? null) : null,
    columnId: input.columnId ?? null,
  });
  for (const title of tp.subtasks ?? [])
    await createTask(c, p, {
      title,
      description: "",
      assigneeId: task.assignee_id,
      projectId: task.project_id,
      priority: "medium",
      dueAt: null,
      labels: [],
      customFields: {},
      parentId: task.id,
      source: null,
    });
  return task;
}
