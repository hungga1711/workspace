import type { PoolClient } from "pg";
import type { Principal } from "@workspace/shared";
import { allowedAny } from "./common.js";
import { Forbidden, NotFound } from "./errors.js";

/**
 * Who may view, edit or manage a whiteboard or a whiteboard folder (migration 004). A folder or board holds grants
 * to everyone, a department or a person, each with a role; it also receives its folder's grants (and that folder's
 * folder's, …) unless `inherit` is off. On top of the grants:
 *   - the creator of a board manages it; the creator of a folder manages it and everything that inherits from it;
 *   - workspace admins (document.edit for everyone's documents) manage everything that is shared with anyone; a
 *     board or folder with no grant and no other manager stays its creator's alone;
 *   - grants count only for people who may read documents at all, and edit/manage only for those who may create
 *     them (a read-only role such as an auditor views, never draws), as before folders existed.
 * The rules are pure functions over the folder tree and the grants, both small tables loaded whole (`loadAcl`).
 */
export type Role = "view" | "edit" | "manage";
export type SubjectType = "everyone" | "department" | "user";
export const ROLES = ["view", "edit", "manage"] as const;
export const SUBJECTS = ["everyone", "department", "user"] as const;
const RANK: Record<Role, number> = { view: 1, edit: 2, manage: 3 };

export interface Grant {
  subjectType: SubjectType;
  subjectId: string;
  role: Role;
}
/** A grant as it reaches a board or folder: `from` is the folder it comes from, null for its own. */
export interface EffectiveGrant extends Grant {
  from: string | null;
}

export interface FolderRow {
  id: string;
  name: string;
  parent_id: string | null;
  owner_id: string;
  inherit: boolean;
  position: number;
  created_at: Date;
  updated_at: Date;
}

export interface Acl {
  folders: Map<string, FolderRow>;
  grants: Map<string, Grant[]>;
}

export interface Access {
  view: boolean;
  edit: boolean;
  manage: boolean;
}
export const NO_ACCESS: Access = { view: false, edit: false, manage: false };
const FULL: Access = { view: true, edit: true, manage: true };

export const grantKey = (type: "folder" | "board", id: string) => `${type}:${id}`;

export async function loadAcl(c: PoolClient): Promise<Acl> {
  const [folders, grants] = await Promise.all([
    c.query<FolderRow>("SELECT id, name, parent_id, owner_id, inherit, position, created_at, updated_at FROM whiteboard_folders"),
    c.query<{ target_type: "folder" | "board"; target_id: string; subject_type: SubjectType; subject_id: string; role: Role }>(
      "SELECT target_type, target_id, subject_type, subject_id, role FROM whiteboard_grants",
    ),
  ]);
  const byTarget = new Map<string, Grant[]>();
  for (const g of grants.rows) {
    const k = grantKey(g.target_type, g.target_id);
    const list = byTarget.get(k) ?? [];
    list.push({ subjectType: g.subject_type, subjectId: g.subject_id, role: g.role });
    byTarget.set(k, list);
  }
  return { folders: new Map(folders.rows.map((f) => [f.id, f])), grants: byTarget };
}

export interface Effective {
  grants: EffectiveGrant[];
  /** Creators of the folders the grants come through: they manage. */
  owners: string[];
}

/** What reaches a folder (and so what its contents inherit): its own grants, then its ancestors' while it inherits. */
export function folderEffective(acl: Acl, folderId: string | null): Effective {
  const grants: EffectiveGrant[] = [];
  const owners: string[] = [];
  const seen = new Set<string>();
  let id = folderId;
  while (id && !seen.has(id) && seen.size < 64) {
    seen.add(id);
    const f = acl.folders.get(id);
    if (!f) break;
    owners.push(f.owner_id);
    for (const g of acl.grants.get(grantKey("folder", id)) ?? []) grants.push({ ...g, from: id });
    if (!f.inherit) break;
    id = f.parent_id;
  }
  return { grants, owners };
}

export function boardEffective(acl: Acl, b: { id: string; folder_id: string | null; inherit: boolean }): Effective {
  const own = (acl.grants.get(grantKey("board", b.id)) ?? []).map((g) => ({ ...g, from: null }));
  if (!b.inherit) return { grants: own, owners: [] };
  const up = folderEffective(acl, b.folder_id);
  return { grants: [...own, ...up.grants], owners: up.owners };
}

function matches(p: Principal, g: Grant): boolean {
  if (g.subjectType === "everyone") return true;
  if (g.subjectType === "department") return !!p.departmentId && p.departmentId === g.subjectId;
  return p.id === g.subjectId;
}

/** Shared with anyone besides its creator: admins see it. */
export const isShared = (ownerId: string, eff: Effective) => eff.grants.length > 0 || eff.owners.some((o) => o !== ownerId);

/** Everyone in the company may at least view it (search files it under "workspace"). */
export const isOpen = (eff: Effective) => eff.grants.some((g) => g.subjectType === "everyone");

export function accessFor(p: Principal, ownerId: string, eff: Effective): Access {
  if (ownerId === p.id || eff.owners.includes(p.id)) return FULL;
  if (!isShared(ownerId, eff)) return NO_ACCESS;
  if (allowedAny(p, "document.edit", [{ ownerId }])) return FULL;
  if (!allowedAny(p, "document.read", [{ ownerId }])) return NO_ACCESS;
  let best = 0;
  for (const g of eff.grants) if (matches(p, g)) best = Math.max(best, RANK[g.role]);
  const write = allowedAny(p, "document.create", [{}]);
  return { view: best >= 1, edit: best >= 2 && write, manage: best >= 3 && write };
}

/** The legacy one-word summary older clients and tests read: workspace, project, private or restricted. */
export function visibilityOf(eff: Effective, projectId: string | null): "workspace" | "project" | "private" | "restricted" {
  const every = Math.max(0, ...eff.grants.filter((g) => g.subjectType === "everyone").map((g) => RANK[g.role]));
  if (every >= 2) return "workspace";
  if (every === 1) return projectId ? "project" : "workspace";
  if (!eff.grants.length && !eff.owners.length) return "private";
  return "restricted";
}

/** Grants as stored: one per subject (the highest role wins), everyone without an id. */
export function normalizeGrants(grants: Grant[]): Grant[] {
  const by = new Map<string, Grant>();
  for (const g of grants) {
    const subjectId = g.subjectType === "everyone" ? "" : g.subjectId.trim();
    if (g.subjectType !== "everyone" && !subjectId) continue;
    const k = `${g.subjectType}:${subjectId}`;
    const cur = by.get(k);
    if (!cur || RANK[g.role] > RANK[cur.role]) by.set(k, { subjectType: g.subjectType, subjectId, role: g.role });
  }
  return [...by.values()];
}

export async function writeGrants(c: PoolClient, type: "folder" | "board", id: string, grants: Grant[]) {
  await c.query("DELETE FROM whiteboard_grants WHERE target_type = $1 AND target_id = $2", [type, id]);
  const list = normalizeGrants(grants);
  if (!list.length) return;
  await c.query(
    `INSERT INTO whiteboard_grants (target_type, target_id, subject_type, subject_id, role)
     SELECT $1, $2, s.t, s.i, s.r FROM unnest($3::text[], $4::text[], $5::text[]) AS s(t, i, r)`,
    [type, id, list.map((g) => g.subjectType), list.map((g) => g.subjectId), list.map((g) => g.role)],
  );
}

/** Folder ids inside `rootId`, itself included. */
export function subtree(acl: Acl, rootId: string): Set<string> {
  const out = new Set([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of acl.folders.values())
      if (f.parent_id && out.has(f.parent_id) && !out.has(f.id)) {
        out.add(f.id);
        grew = true;
      }
  }
  return out;
}

export function folderAccess(p: Principal, acl: Acl, f: FolderRow): Access {
  return accessFor(p, f.owner_id, folderEffective(acl, f.id));
}

/** Folders the caller may see. */
export function visibleFolderIds(p: Principal, acl: Acl): Set<string> {
  const out = new Set<string>();
  for (const f of acl.folders.values()) if (folderAccess(p, acl, f).view) out.add(f.id);
  return out;
}

/** A folder the caller may put boards and folders in; missing and unreadable look the same. */
export async function requireFolderEdit(c: PoolClient, p: Principal, folderId: string, acl?: Acl): Promise<FolderRow> {
  const a = acl ?? (await loadAcl(c));
  const f = a.folders.get(folderId);
  const access = f ? folderAccess(p, a, f) : NO_ACCESS;
  if (!f || !access.view) throw new NotFound("folder not found");
  if (!access.edit) throw new Forbidden("cannot add to this folder");
  return f;
}
