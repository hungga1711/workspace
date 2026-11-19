import type { PoolClient } from "pg";
import { newId, type Principal } from "@workspace/shared";
import { nextCode } from "./codes.js";
import { activity, allowedAny, emit, requireAny } from "./common.js";
import { Conflict, Forbidden, NotFound } from "./errors.js";

/**
 * Starting board; column names in the creator's UI language (renamable afterwards). Each column stands for one
 * status (migration work/007): moving a card sets it.
 */
const DEFAULT_COLUMNS = [
  { name: { vi: "Cần làm", en: "To do", zh: "待办", es: "Por hacer" }, status: "todo", wip: null },
  { name: { vi: "Đang làm", en: "In progress", zh: "进行中", es: "En curso" }, status: "in_progress", wip: 5 },
  { name: { vi: "Chờ duyệt", en: "Review", zh: "待审核", es: "En revisión" }, status: "review", wip: 3 },
  { name: { vi: "Xong", en: "Done", zh: "已完成", es: "Hecho" }, status: "done", wip: null },
] as const;

export type BoardLocale = "en" | "vi" | "zh" | "es";
export const boardLocale = (v: unknown): BoardLocale => (v === "vi" || v === "zh" || v === "es" ? v : "en");

/** The statuses a board column can stand for (cancelled has no column). */
export type ColumnStatus = "todo" | "in_progress" | "review" | "done";

/**
 * The status a column stands for when its creator did not say: what its name says (vi or en), else its place on the
 * board (the first column to do, the last done, anything between in progress). Same rule as
 * migrations/work/007_board_column_status.sql.
 */
export function columnStatusFor(name: string, index: number, total: number): ColumnStatus {
  const n = name.toLowerCase();
  if (/(done|xong|hoàn thành|hoàn tất|complete|closed|đóng|released|shipped)/.test(n)) return "done";
  if (/(review|duyệt|kiểm tra|qa|test|chờ)/.test(n)) return "review";
  if (/(progress|doing|đang|in dev|wip)/.test(n)) return "in_progress";
  if (/(to ?do|backlog|cần làm|chưa|mới|new|open)/.test(n)) return "todo";
  if (index === 0) return "todo";
  if (index === total - 1) return "done";
  return "in_progress";
}

export interface ProjectRow {
  id: string;
  code: string;
  name: string;
  description: string;
  owner_id: string;
  team_id: string | null;
  status: string;
  due_at: Date | null;
  version: number;
}

export async function getProject(c: PoolClient, id: string): Promise<ProjectRow> {
  const r = await c.query<ProjectRow>("SELECT id, code, name, description, owner_id, team_id, status, due_at, version FROM projects WHERE id = $1", [id]);
  if (!r.rows[0]) throw new NotFound("project not found");
  return r.rows[0];
}

export async function createProject(
  c: PoolClient,
  p: Principal,
  input: { name: string; description: string; teamId: string | null; ownerId?: string | undefined; dueAt: string | null },
  locale: BoardLocale = "en",
) {
  requireAny(p, "project.create", [{}]);
  const id = newId();
  const owner = input.ownerId ?? p.id;
  const code = await nextCode(c, "project", id);
  await c.query("INSERT INTO projects (id, code, name, description, owner_id, team_id, due_at) VALUES ($1,$2,$3,$4,$5,$6,$7)", [
    id,
    code,
    input.name,
    input.description,
    owner,
    input.teamId,
    input.dueAt,
  ]);
  for (const [i, col] of DEFAULT_COLUMNS.entries()) {
    await c.query("INSERT INTO board_columns (project_id, id, name, status, position, wip_limit) VALUES ($1,$2,$3,$4,$5,$6)", [
      id,
      newId(),
      col.name[locale],
      col.status,
      i,
      col.wip,
    ]);
  }
  await activity(c, "project", id, "created", { name: input.name });
  await emit(c, "work.project.created.v1", "work.project", id, { projectId: id, code, name: input.name, description: input.description, ownerId: owner, dueAt: input.dueAt });
  return { id, code };
}

/** Owner always may edit; otherwise project.edit at a scope covering the project. */
export function canEditProject(p: Principal, pr: Pick<ProjectRow, "owner_id" | "team_id">): boolean {
  return pr.owner_id === p.id || allowedAny(p, "project.edit", [{ ownerId: pr.owner_id, teamId: pr.team_id }]);
}

export function requireProjectEdit(p: Principal, pr: ProjectRow) {
  if (!canEditProject(p, pr)) throw new Forbidden("not allowed: project.edit");
}

/**
 * Edits a project (name, description, due date, owner) or archives/restores it. Version-checked;
 * a due-date change is recorded in the activity log so "who moved the deadline" stays traceable.
 */
export async function updateProject(
  c: PoolClient,
  p: Principal,
  id: string,
  input: {
    expectedVersion: number;
    name?: string | undefined;
    description?: string | undefined;
    dueAt?: string | null | undefined;
    ownerId?: string | undefined;
    teamId?: string | null | undefined;
    status?: "active" | "archived" | undefined;
    reason?: string | undefined;
  },
) {
  const pr = await getProject(c, id);
  requireProjectEdit(p, pr);
  const r = await c.query<ProjectRow>(
    `UPDATE projects SET name = $3, description = $4, due_at = $5, owner_id = $6, status = $7, team_id = $8, version = version + 1, updated_at = now()
      WHERE id = $1 AND version = $2 RETURNING id, code, name, description, owner_id, team_id, status, due_at, version`,
    [
      id,
      input.expectedVersion,
      input.name ?? pr.name,
      input.description ?? pr.description,
      input.dueAt === undefined ? pr.due_at : input.dueAt,
      input.ownerId ?? pr.owner_id,
      input.status ?? pr.status,
      input.teamId === undefined ? pr.team_id : input.teamId,
    ],
  );
  const u = r.rows[0];
  if (!u) throw new Conflict("project changed since you loaded it", { currentVersion: pr.version });
  // Tasks carry the project's team so TEAM-scope grants (the Manager role) cover them: keep them in step.
  if (u.team_id !== pr.team_id) await c.query("UPDATE tasks SET team_id = $2 WHERE project_id = $1 AND team_id IS DISTINCT FROM $2", [id, u.team_id]);
  const changes: Record<string, unknown> = {};
  for (const k of ["name", "due_at", "owner_id", "status", "team_id"] as const) if (String(pr[k]) !== String(u[k])) changes[k] = { from: pr[k], to: u[k] };
  if (input.reason) changes.reason = input.reason;
  await activity(c, "project", id, "updated", changes);
  await emit(c, "work.project.updated.v1", "work.project", id, {
    projectId: id,
    code: u.code,
    name: u.name,
    description: u.description,
    ownerId: u.owner_id,
    dueAt: u.due_at,
    status: u.status,
    changes,
  });
  return { id: u.id, code: u.code, name: u.name, description: u.description, ownerId: u.owner_id, teamId: u.team_id, status: u.status, dueAt: u.due_at, version: u.version };
}
