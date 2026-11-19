import type { PoolClient } from "pg";
import { newId, type Principal } from "@workspace/shared";
import { nextCode } from "./codes.js";
import { activity, allowedAny, emit, requireAny } from "./common.js";
import { Forbidden, Invalid, NotFound } from "./errors.js";
import { canEditProject } from "./projects.js";
import { resolveRef } from "./ref.js";
import { canReadTask, createTask, TASK_COLS, type TaskRow } from "./tasks.js";
import { boardText, checkSceneLimits, checkThumbnail, emptyScene, mergeScenes, normalizeScene, SceneError, type Scene } from "./whiteboard-scene.js";
import { buildTemplate, templateName, type TemplateKey } from "./whiteboard-templates.js";
import {
  accessFor,
  boardEffective,
  isOpen,
  loadAcl,
  requireFolderEdit,
  visibilityOf,
  visibleFolderIds,
  writeGrants,
  type Access,
  type Acl,
  type Effective,
  type Grant,
} from "./whiteboard-access.js";

/**
 * Whiteboards (ADR 0024). The row holds the last saved scene; live editing happens in chat's relay and every editor
 * saves snapshots here, merged element by element (whiteboard-scene.ts), so concurrent saves never lose each other's
 * work. Boards sit in folders (whiteboard-folders.ts); who may view, edit and manage a board is decided by its grants
 * and its folders' (whiteboard-access.ts). A board linked to a project also lets the project's editors manage it and
 * the people working on it (owner or assignee of one of its tasks) edit it, once they can view it.
 */
export type Visibility = "workspace" | "project" | "private";

export interface BoardRow {
  id: string;
  code: string;
  title: string;
  project_id: string | null;
  folder_id: string | null;
  inherit: boolean;
  owner_id: string;
  template: string | null;
  scene_version: number;
  thumbnail: string | null;
  created_at: Date;
  updated_at: Date;
  updated_by: string | null;
  project_name: string | null;
  project_owner: string | null;
  project_team: string | null;
}

const COLS = `w.id, w.code, w.title, w.project_id, w.folder_id, w.inherit, w.owner_id, w.template, w.scene_version, w.thumbnail, w.created_at, w.updated_at, w.updated_by,
  pr.name AS project_name, pr.owner_id AS project_owner, pr.team_id AS project_team`;
const SELECT = `SELECT ${COLS} FROM whiteboards w LEFT JOIN projects pr ON pr.id = w.project_id`;

export type { Access };

/** Projects the caller works on (owns or is assigned a task in): they edit that project's boards. */
async function projectsWorkedOn(c: PoolClient, p: Principal): Promise<Set<string>> {
  const r = await c.query<{ project_id: string }>("SELECT DISTINCT project_id FROM tasks WHERE project_id IS NOT NULL AND (assignee_id = $1 OR owner_id = $1)", [p.id]);
  return new Set(r.rows.map((x) => x.project_id));
}

type AccessRow = Pick<BoardRow, "id" | "folder_id" | "inherit" | "owner_id" | "project_id" | "project_owner" | "project_team">;

function boardAccess(p: Principal, b: AccessRow, eff: Effective, workedOn: Set<string>): Access {
  const a = accessFor(p, b.owner_id, eff);
  if (!a.view || a.manage || !b.project_id) return a;
  if (b.project_owner && canEditProject(p, { owner_id: b.project_owner, team_id: b.project_team })) return { view: true, edit: true, manage: true };
  return workedOn.has(b.project_id) ? { ...a, edit: true } : a;
}

/** A board by id or code, with what the caller may do; missing, archived and unreadable look the same. */
export async function getBoard(c: PoolClient, p: Principal, ref: string, acl?: Acl): Promise<{ b: BoardRow; access: Access; eff: Effective }> {
  const id = await resolveRef(c, "whiteboard", ref);
  const b = (await c.query<BoardRow>(`${SELECT} WHERE w.id = $1 AND w.archived_at IS NULL`, [id])).rows[0];
  if (!b) throw new NotFound("whiteboard not found");
  const eff = boardEffective(acl ?? (await loadAcl(c)), b);
  const access = boardAccess(p, b, eff, b.project_id ? await projectsWorkedOn(c, p) : new Set());
  if (!access.view) throw new NotFound("whiteboard not found");
  return { b, access, eff };
}

function summaryDto(b: BoardRow, a: Access, eff: Effective) {
  return {
    id: b.id,
    code: b.code,
    title: b.title,
    projectId: b.project_id,
    projectName: b.project_name,
    folderId: b.folder_id,
    inherit: b.inherit,
    ownerId: b.owner_id,
    visibility: visibilityOf(eff, b.project_id),
    template: b.template,
    createdAt: b.created_at,
    updatedAt: b.updated_at,
    updatedBy: b.updated_by,
    thumbnail: b.thumbnail,
    canEdit: a.edit,
    canManage: a.manage,
  };
}

/**
 * What search indexes; `projectId` names the container (see the contract in @workspace/contracts): "workspace" when
 * everyone may view the board, else null and the board's own container (`wb:<id>`), which the work module's
 * search scope lists for each person who may open it.
 */
export function whiteboardFeedPayload(b: Pick<BoardRow, "id" | "code" | "title" | "owner_id">, open: boolean, text: string) {
  return {
    whiteboardId: b.id,
    code: b.code,
    title: b.title,
    ownerId: b.owner_id,
    projectId: open ? "workspace" : null,
    text: text.slice(0, 20000),
  };
}

/** Tells search again about boards whose readers may have changed (a share, a move, a folder's share). */
export async function reannounceBoards(c: PoolClient, where: { ids?: string[]; folderIds?: string[] }) {
  const acl = await loadAcl(c);
  const rows = (
    await c.query<Pick<BoardRow, "id" | "code" | "title" | "owner_id" | "folder_id" | "inherit"> & { text: string }>(
      `SELECT id, code, title, owner_id, folder_id, inherit, text FROM whiteboards
        WHERE archived_at IS NULL AND (id = ANY($1::text[]) OR folder_id = ANY($2::text[]))`,
      [where.ids ?? [], where.folderIds ?? []],
    )
  ).rows;
  for (const b of rows) await emit(c, "work.whiteboard.updated.v1", "work.whiteboard", b.id, whiteboardFeedPayload(b, isOpen(boardEffective(acl, b)), b.text));
}

async function liveProject(c: PoolClient, p: Principal, projectId: string) {
  const pr = (await c.query<{ status: string }>("SELECT status FROM projects WHERE id = $1", [projectId])).rows[0];
  if (!pr || !allowedAny(p, "project.read", [{}])) throw new NotFound("project not found");
  if (pr.status === "archived") throw new Invalid("project is archived");
}

async function storedScene(c: PoolClient, id: string, lock = false): Promise<{ scene: Scene; text: string; version: number }> {
  const r = (
    await c.query<{ scene: Scene; text: string; scene_version: number }>(`SELECT scene, text, scene_version FROM whiteboards WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [id])
  ).rows[0];
  if (!r) throw new NotFound("whiteboard not found");
  return { scene: { ...emptyScene(), ...r.scene }, text: r.text, version: r.scene_version };
}

/** The grants a one-word visibility stands for (the API before folders, still accepted). */
function legacyGrants(v: Visibility): { inherit: boolean; grants: Grant[] } {
  if (v === "private") return { inherit: false, grants: [] };
  return { inherit: true, grants: [{ subjectType: "everyone", subjectId: "", role: v === "workspace" ? "edit" : "view" }] };
}

export interface CreateBoardInput {
  title?: string | undefined;
  projectId?: string | null | undefined;
  folderId?: string | null | undefined;
  visibility?: Visibility | undefined;
  template?: TemplateKey | undefined;
}

/**
 * A new board. In a folder it inherits the folder's access (the caller must be able to edit the folder); at the top
 * level everyone in the company may edit it, like a board made before folders existed. `visibility` overrides that.
 */
export async function createBoard(c: PoolClient, p: Principal, input: CreateBoardInput, locale: "vi" | "en") {
  requireAny(p, "document.create", [{}]);
  const projectId = input.projectId ?? null;
  if (projectId) await liveProject(c, p, projectId);
  const folderId = input.folderId ?? null;
  if (folderId) await requireFolderEdit(c, p, folderId);
  if (input.visibility === "project" && !projectId) throw new Invalid("a project board needs a project");
  const access = input.visibility ? legacyGrants(input.visibility) : folderId ? { inherit: true, grants: [] as Grant[] } : legacyGrants(projectId ? "project" : "workspace");
  const template = input.template ?? "blank";
  const scene = buildTemplate(template, locale);
  const text = boardText(scene).text;
  const id = newId();
  const code = await nextCode(c, "whiteboard", id);
  const title = input.title?.trim() || templateName(template, locale);
  await c.query(
    `INSERT INTO whiteboards (id, code, title, project_id, folder_id, inherit, owner_id, template, scene, text, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$7)`,
    [id, code, title, projectId, folderId, access.inherit, p.id, template, JSON.stringify(scene), text],
  );
  await writeGrants(c, "board", id, access.grants);
  await activity(c, "whiteboard", id, "created", { title, template, folderId });
  const eff = boardEffective(await loadAcl(c), { id, folder_id: folderId, inherit: access.inherit });
  await emit(c, "work.whiteboard.created.v1", "work.whiteboard", id, whiteboardFeedPayload({ id, code, title, owner_id: p.id }, isOpen(eff), text));
  return boardDetail(c, p, id);
}

/** A board with its scene and its task links, as the editor opens it. */
export async function boardDetail(c: PoolClient, p: Principal, ref: string) {
  const { b, access, eff } = await getBoard(c, p, ref);
  const s = await storedScene(c, b.id);
  const acl = await loadAcl(c);
  return { ...summaryDto(b, access, eff), path: folderPath(acl, b.folder_id), scene: s.scene, sceneVersion: s.version, links: await boardLinks(c, p, b.id) };
}

/** The folders from the top level down to `folderId`, for the breadcrumb. */
export function folderPath(acl: Acl, folderId: string | null): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  const seen = new Set<string>();
  let id = folderId;
  while (id && !seen.has(id) && seen.size < 64) {
    seen.add(id);
    const f = acl.folders.get(id);
    if (!f) break;
    out.unshift({ id: f.id, name: f.name });
    id = f.parent_id;
  }
  return out;
}

export interface ListInput {
  scope: "all" | "mine" | "project";
  projectId?: string | undefined;
  /** A folder's boards ("root": the top level); absent: every board the caller can open. */
  folderId?: string | undefined;
  q?: string | undefined;
}

/** Every board the caller can open (ids with their access), in SQL order; no scenes, no thumbnails. */
async function readableBoards(c: PoolClient, p: Principal, where = "TRUE", params: unknown[] = [], acl?: Acl) {
  const a = acl ?? (await loadAcl(c));
  const rows = (
    await c.query<AccessRow>(
      `SELECT w.id, w.folder_id, w.inherit, w.owner_id, w.project_id, pr.owner_id AS project_owner, pr.team_id AS project_team
         FROM whiteboards w LEFT JOIN projects pr ON pr.id = w.project_id
        WHERE w.archived_at IS NULL AND ${where} ORDER BY w.updated_at DESC, w.id DESC`,
      params,
    )
  ).rows;
  const workedOn = rows.some((b) => b.project_id) ? await projectsWorkedOn(c, p) : new Set<string>();
  return rows.flatMap((b) => {
    const eff = boardEffective(a, b);
    const access = boardAccess(p, b, eff, workedOn);
    return access.view ? [{ id: b.id, folderId: b.folder_id, access, eff }] : [];
  });
}

/** Boards the caller can open, most recently changed first (200 at most). */
export async function listBoards(c: PoolClient, p: Principal, input: ListInput) {
  const params: unknown[] = [];
  let where = "TRUE";
  if (input.scope === "mine") where += ` AND w.owner_id = $${params.push(p.id)}`;
  if (input.scope === "project") {
    if (!input.projectId) throw new Invalid("projectId is required for scope=project");
    where += ` AND w.project_id = $${params.push(input.projectId)}`;
  } else if (input.projectId) where += ` AND w.project_id = $${params.push(input.projectId)}`;
  const q = input.q?.trim();
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const n = params.push(like);
    where += ` AND (w.title ILIKE $${n} OR w.code ILIKE $${n} OR w.text ILIKE $${n})`;
  }
  const acl = await loadAcl(c);
  let readable = await readableBoards(c, p, where, params, acl);
  if (input.folderId) {
    // A board whose folder the caller cannot see shows at the top level, so a board shared with someone directly
    // is never out of reach.
    const seen = visibleFolderIds(p, acl);
    const at = (fid: string | null) => (fid && seen.has(fid) ? fid : "root");
    readable = readable.filter((r) => at(r.folderId) === input.folderId);
  }
  const page = readable.slice(0, 200);
  if (!page.length) return [];
  const rows = new Map((await c.query<BoardRow>(`${SELECT} WHERE w.id = ANY($1)`, [page.map((r) => r.id)])).rows.map((b) => [b.id, b]));
  return page.flatMap((r) => {
    const b = rows.get(r.id);
    return b ? [summaryDto(b, r.access, r.eff)] : [];
  });
}

/** For search: the board containers (`wb:<id>`) of boards the caller may open that are not open to everyone. */
export async function searchContainers(c: PoolClient, p: Principal): Promise<string[]> {
  return (await readableBoards(c, p)).filter((r) => !isOpen(r.eff)).map((r) => `wb:${r.id}`);
}

/** How many boards the caller can open in each folder ("root" for the top level), for the folder tree. */
export async function boardCounts(c: PoolClient, p: Principal, acl: Acl, visibleFolders: Set<string>): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const r of await readableBoards(c, p, "TRUE", [], acl)) {
    const k = r.folderId && visibleFolders.has(r.folderId) ? r.folderId : "root";
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

export interface UpdateBoardInput {
  title?: string | undefined;
  projectId?: string | null | undefined;
  /** Move to this folder (null: the top level); the caller must be able to edit the folder. */
  folderId?: string | null | undefined;
  visibility?: Visibility | undefined;
}

export async function updateBoard(c: PoolClient, p: Principal, ref: string, input: UpdateBoardInput) {
  const acl = await loadAcl(c);
  const { b, access } = await getBoard(c, p, ref, acl);
  if (!access.manage) throw new Forbidden("only the owner can rename, move or share this whiteboard");
  const projectId = input.projectId === undefined ? b.project_id : input.projectId;
  if (projectId && projectId !== b.project_id) await liveProject(c, p, projectId);
  if (input.visibility === "project" && !projectId) throw new Invalid("a project board needs a project");
  const folderId = input.folderId === undefined ? b.folder_id : input.folderId;
  if (folderId !== b.folder_id) {
    if (folderId) await requireFolderEdit(c, p, folderId, acl);
    else requireAny(p, "document.create", [{}]);
  }
  const legacy = input.visibility ? legacyGrants(input.visibility) : null;
  const inherit = legacy ? legacy.inherit : b.inherit;
  const title = input.title?.trim() || b.title;
  await c.query("UPDATE whiteboards SET title = $2, project_id = $3, folder_id = $4, inherit = $5, updated_at = now(), updated_by = $6 WHERE id = $1", [
    b.id,
    title,
    projectId,
    folderId,
    inherit,
    p.id,
  ]);
  if (legacy) await writeGrants(c, "board", b.id, legacy.grants);
  const changes: Record<string, unknown> = {};
  if (title !== b.title) changes.title = { from: b.title, to: title };
  if (projectId !== b.project_id) changes.projectId = { from: b.project_id, to: projectId };
  if (folderId !== b.folder_id) changes.folderId = { from: b.folder_id, to: folderId };
  if (legacy) changes.visibility = input.visibility;
  if (Object.keys(changes).length) {
    await activity(c, "whiteboard", b.id, "updated", changes);
    await reannounceBoards(c, { ids: [b.id] });
  }
  const next = await getBoard(c, p, b.id).catch(() => null);
  // Moved somewhere the caller cannot see any more (only possible for admins of a private folder): say so plainly.
  if (!next) return { id: b.id, moved: true };
  return summaryDto(next.b, next.access, next.eff);
}

export interface SaveSceneInput {
  baseVersion: number;
  scene: unknown;
  /** Undefined: keep the current one; null: remove it. */
  thumbnail?: string | null | undefined;
}

/**
 * Saves a snapshot. The save is merged into what is stored (whiteboard-scene.ts mergeScenes) instead of being
 * refused when someone saved in between: everyone in a live session sends the same elements anyway, and someone who
 * edited offline keeps their changes without anyone else's being lost. `merged` tells the saver the stored scene
 * held changes they had not loaded (baseVersion was behind); outside a live session they reload it.
 * The board's text is derived here from the merged scene, never taken from the client.
 */
export async function saveScene(c: PoolClient, p: Principal, ref: string, input: SaveSceneInput) {
  const { b, access, eff } = await getBoard(c, p, ref);
  if (!access.edit) throw new Forbidden("cannot edit this whiteboard");
  try {
    const incoming = normalizeScene(input.scene);
    const thumbnail = input.thumbnail === undefined || input.thumbnail === null ? input.thumbnail : checkThumbnail(input.thumbnail);
    const cur = await storedScene(c, b.id, true);
    const merged = cur.version > input.baseVersion;
    const m = mergeScenes(cur.scene, incoming);
    if (!m.changed) {
      if (thumbnail !== undefined) await c.query("UPDATE whiteboards SET thumbnail = $2 WHERE id = $1", [b.id, thumbnail]);
      return { sceneVersion: cur.version, merged };
    }
    checkSceneLimits(m.scene);
    const text = boardText(m.scene).text;
    const next = cur.version + 1;
    await c.query(
      `UPDATE whiteboards SET scene = $2, text = $3, scene_version = $4, thumbnail = CASE WHEN $5 THEN $6 ELSE thumbnail END, updated_at = now(), updated_by = $7
        WHERE id = $1`,
      [b.id, JSON.stringify(m.scene), text, next, thumbnail !== undefined, thumbnail ?? null, p.id],
    );
    // Search only cares about words: moving or recolouring shapes announces nothing.
    if (text !== cur.text) await emit(c, "work.whiteboard.updated.v1", "work.whiteboard", b.id, whiteboardFeedPayload(b, isOpen(eff), text));
    return { sceneVersion: next, merged };
  } catch (e) {
    if (e instanceof SceneError) throw new Invalid(e.message);
    throw e;
  }
}

/** Archives the board: it leaves lists, search and links; the row stays for the activity history. */
export async function deleteBoard(c: PoolClient, p: Principal, ref: string) {
  const { b, access } = await getBoard(c, p, ref);
  if (!access.manage) throw new Forbidden("only the owner can delete this whiteboard");
  await c.query("UPDATE whiteboards SET archived_at = now(), updated_by = $2 WHERE id = $1", [b.id, p.id]);
  await activity(c, "whiteboard", b.id, "deleted", { title: b.title });
  await emit(c, "work.whiteboard.deleted.v1", "work.whiteboard", b.id, { whiteboardId: b.id });
}

export interface LinkDto {
  elementId: string;
  taskId: string;
  code: string;
  status: string;
  title: string;
}

/** Task links of a board with each task's current status; tasks the caller cannot read are left out. */
export async function boardLinks(c: PoolClient, p: Principal, boardId: string, elementIds?: string[]): Promise<LinkDto[]> {
  const r = await c.query<TaskRow & { element_id: string }>(
    `SELECT l.element_id, ${TASK_COLS.split(", ")
      .map((col) => `t.${col}`)
      .join(", ")}
       FROM whiteboard_task_links l JOIN tasks t ON t.id = l.task_id
      WHERE l.whiteboard_id = $1 AND ($2::text[] IS NULL OR l.element_id = ANY($2))
      ORDER BY l.created_at, l.element_id`,
    [boardId, elementIds ?? null],
  );
  return r.rows.filter((t) => canReadTask(p, t)).map((t) => ({ elementId: t.element_id, taskId: t.id, code: t.code, status: t.status, title: t.title }));
}

export interface StickyTasksInput {
  items: { elementId: string; title: string; description?: string | undefined }[];
  /** Undefined: the board's project; null: no project. */
  projectId?: string | null | undefined;
  assigneeId?: string | null | undefined;
  dueAt?: string | null | undefined;
}

/**
 * One task per sticky note, made with the normal task rules (task.create, assigning someone else needs task.assign,
 * a live project) and linked back to the note. A note that already has a task keeps it: asking twice makes nothing
 * new. The task's source names the board, so the task page can link back to it.
 */
export async function tasksFromStickies(c: PoolClient, p: Principal, ref: string, input: StickyTasksInput) {
  const { b, access } = await getBoard(c, p, ref);
  if (!access.edit) throw new Forbidden("cannot edit this whiteboard");
  const items = [...new Map(input.items.map((i) => [i.elementId, i])).values()];
  const ids = items.map((i) => i.elementId);
  const linked = new Set(
    (await c.query<{ element_id: string }>("SELECT element_id FROM whiteboard_task_links WHERE whiteboard_id = $1 AND element_id = ANY($2)", [b.id, ids])).rows.map(
      (r) => r.element_id,
    ),
  );
  const projectId = input.projectId === undefined ? b.project_id : input.projectId;
  for (const item of items) {
    if (linked.has(item.elementId)) continue;
    const t = await createTask(c, p, {
      title: item.title,
      description: item.description ?? "",
      assigneeId: input.assigneeId ?? null,
      projectId,
      priority: "medium",
      dueAt: input.dueAt ?? null,
      labels: [],
      customFields: {},
      parentId: null,
      source: { type: "whiteboard", whiteboardId: b.id, code: b.code, elementId: item.elementId },
    });
    await c.query("INSERT INTO whiteboard_task_links (whiteboard_id, element_id, task_id, created_by) VALUES ($1,$2,$3,$4)", [b.id, item.elementId, t.id, p.id]);
  }
  if (items.length > linked.size) await activity(c, "whiteboard", b.id, "tasks_created", { elementIds: ids.filter((i) => !linked.has(i)) });
  return { links: await boardLinks(c, p, b.id, ids) };
}

/** The words on a board for the ai module (stickies with their place, everything else as labels). */
export async function boardTextFor(c: PoolClient, p: Principal, ref: string) {
  const { b } = await getBoard(c, p, ref);
  const s = await storedScene(c, b.id);
  const t = boardText(s.scene);
  return { id: b.id, code: b.code, title: b.title, stickies: t.stickies, labels: t.labels, text: t.text };
}
