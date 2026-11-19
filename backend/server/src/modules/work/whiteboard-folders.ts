import type { PoolClient } from "pg";
import { newId, type Principal } from "@workspace/shared";
import { activity, allowedAny, requireAny } from "./common.js";
import { Forbidden, Invalid, NotFound } from "./errors.js";
import {
  folderAccess,
  folderEffective,
  loadAcl,
  normalizeGrants,
  requireFolderEdit,
  subtree,
  visibilityOf,
  visibleFolderIds,
  writeGrants,
  grantKey,
  type Acl,
  type Effective,
  type FolderRow,
  type Grant,
} from "./whiteboard-access.js";
import { boardCounts, getBoard, reannounceBoards } from "./whiteboards.js";

/**
 * Whiteboard folders: nested, each with its own access (whiteboard-access.ts). Deleting a folder never deletes
 * boards: what is inside moves up one level and keeps exactly the access it had (the folder's grants are copied onto
 * the children that inherited them).
 */
function folderDto(p: Principal, acl: Acl, f: FolderRow, visible: Set<string>, counts: Record<string, number>) {
  const a = folderAccess(p, acl, f);
  return {
    id: f.id,
    name: f.name,
    // A parent the caller cannot see: the folder shows at the top level.
    parentId: f.parent_id && visible.has(f.parent_id) ? f.parent_id : null,
    ownerId: f.owner_id,
    inherit: f.inherit,
    position: f.position,
    visibility: visibilityOf(folderEffective(acl, f.id), null),
    boards: counts[f.id] ?? 0,
    canEdit: a.edit,
    canManage: a.manage,
    updatedAt: f.updated_at,
  };
}

/** Every folder the caller may see, with how many of their boards each holds, and the top level's count. */
export async function listFolders(c: PoolClient, p: Principal) {
  const acl = await loadAcl(c);
  const visible = visibleFolderIds(p, acl);
  const counts = await boardCounts(c, p, acl, visible);
  const folders = [...acl.folders.values()]
    .filter((f) => visible.has(f.id))
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
    .map((f) => folderDto(p, acl, f, visible, counts));
  return { folders, rootBoards: counts.root ?? 0, total: Object.values(counts).reduce((n, x) => n + x, 0), canCreate: allowedAny(p, "document.create", [{}]) };
}

async function getFolder(c: PoolClient, p: Principal, id: string, acl: Acl) {
  const f = acl.folders.get(id);
  const access = f ? folderAccess(p, acl, f) : null;
  if (!f || !access?.view) throw new NotFound("folder not found");
  return { f, access };
}

/**
 * A new folder. Inside another it inherits that folder's access; at the top level everyone in the company may edit
 * what is in it, like a board made at the top level.
 */
/**
 * A new folder. Its members can be set right away (`grants`); without them a top-level folder is open to the whole
 * company to edit and a sub-folder only follows its parent.
 */
export async function createFolder(c: PoolClient, p: Principal, input: { name: string; parentId?: string | null | undefined; grants?: Grant[] | undefined }) {
  requireAny(p, "document.create", [{}]);
  const acl = await loadAcl(c);
  const parentId = input.parentId ?? null;
  if (parentId) await requireFolderEdit(c, p, parentId, acl);
  const id = newId();
  const position = (await c.query<{ n: number }>("SELECT coalesce(max(position), 0) + 1 AS n FROM whiteboard_folders WHERE parent_id IS NOT DISTINCT FROM $1", [parentId])).rows[0]!
    .n;
  await c.query("INSERT INTO whiteboard_folders (id, name, parent_id, owner_id, position) VALUES ($1,$2,$3,$4,$5)", [id, input.name.trim(), parentId, p.id, position]);
  if (input.grants) await writeGrants(c, "folder", id, input.grants);
  else if (!parentId) await writeGrants(c, "folder", id, [{ subjectType: "everyone", subjectId: "", role: "edit" }]);
  await activity(c, "whiteboard_folder", id, "created", { name: input.name.trim(), parentId });
  const next = await loadAcl(c);
  const visible = visibleFolderIds(p, next);
  return folderDto(p, next, next.folders.get(id)!, visible, {});
}

/** Rename or move a folder (null: to the top level). Moving needs edit on the new parent and no loop. */
export async function updateFolder(c: PoolClient, p: Principal, id: string, input: { name?: string | undefined; parentId?: string | null | undefined }) {
  const acl = await loadAcl(c);
  const { f, access } = await getFolder(c, p, id, acl);
  if (!access.manage) throw new Forbidden("only the folder's managers can rename or move it");
  const parentId = input.parentId === undefined ? f.parent_id : input.parentId;
  if (parentId !== f.parent_id) {
    if (parentId) {
      if (subtree(acl, f.id).has(parentId)) throw new Invalid("a folder cannot move into itself");
      await requireFolderEdit(c, p, parentId, acl);
    } else requireAny(p, "document.create", [{}]);
  }
  const name = input.name?.trim() || f.name;
  await c.query("UPDATE whiteboard_folders SET name = $2, parent_id = $3, updated_at = now() WHERE id = $1", [f.id, name, parentId]);
  if (parentId !== f.parent_id) await reannounceBoards(c, { folderIds: [...subtree(acl, f.id)] });
  await activity(c, "whiteboard_folder", f.id, "updated", { name, parentId });
  const next = await loadAcl(c);
  const visible = visibleFolderIds(p, next);
  return folderDto(p, next, next.folders.get(f.id)!, visible, {});
}

/** Deletes the folder; its boards and folders move up a level and keep the access they had. */
export async function deleteFolder(c: PoolClient, p: Principal, id: string) {
  const acl = await loadAcl(c);
  const { f, access } = await getFolder(c, p, id, acl);
  if (!access.manage) throw new Forbidden("only the folder's managers can delete it");
  // What the children received from this folder: its grants, and its creator as a manager.
  const handed: Grant[] = [...(acl.grants.get(grantKey("folder", f.id)) ?? []), { subjectType: "user", subjectId: f.owner_id, role: "manage" }];
  const children = [
    ...(await c.query<{ id: string; inherit: boolean }>("SELECT id, inherit FROM whiteboard_folders WHERE parent_id = $1", [f.id])).rows.map((r) => ({
      ...r,
      type: "folder" as const,
    })),
    ...(await c.query<{ id: string; inherit: boolean }>("SELECT id, inherit FROM whiteboards WHERE folder_id = $1", [f.id])).rows.map((r) => ({ ...r, type: "board" as const })),
  ];
  for (const ch of children) {
    if (!ch.inherit) continue;
    const own = acl.grants.get(grantKey(ch.type, ch.id)) ?? [];
    await writeGrants(c, ch.type, ch.id, normalizeGrants([...own, ...handed]));
    // A folder that did not inherit cut its contents off from what is above it: keep it that way.
    if (!f.inherit) await c.query(`UPDATE ${ch.type === "folder" ? "whiteboard_folders" : "whiteboards"} SET inherit = false WHERE id = $1`, [ch.id]);
  }
  await c.query("UPDATE whiteboard_folders SET parent_id = $2 WHERE parent_id = $1", [f.id, f.parent_id]);
  await c.query("UPDATE whiteboards SET folder_id = $2 WHERE folder_id = $1", [f.id, f.parent_id]);
  await c.query("DELETE FROM whiteboard_grants WHERE target_type = 'folder' AND target_id = $1", [f.id]);
  await c.query("DELETE FROM whiteboard_folders WHERE id = $1", [f.id]);
  await activity(c, "whiteboard_folder", f.id, "deleted", { name: f.name, moved: children.length });
}

// ---- access (the Share dialog) ----

/** `full`: everything that reaches the target (its own grants too), for the summary; `eff` lists only what is inherited. */
function accessDto(acl: Acl, ownerId: string, inherit: boolean, own: Grant[], eff: Effective, canManage: boolean, full: Effective = eff) {
  const inherited = eff.grants.filter((g) => g.from !== null).map((g) => ({ ...g, fromName: acl.folders.get(g.from!)?.name ?? "" }));
  return {
    ownerId,
    inherit,
    grants: own,
    inherited: canManage ? inherited : [],
    // Folder creators up the chain manage too.
    managers: [...new Set(eff.owners)].filter((o) => o !== ownerId),
    visibility: visibilityOf(full, null),
    canManage,
  };
}

export async function getAccess(c: PoolClient, p: Principal, target: { type: "folder" | "board"; id: string }) {
  const acl = await loadAcl(c);
  if (target.type === "board") {
    const { b, access, eff } = await getBoard(c, p, target.id, acl);
    return accessDto(acl, b.owner_id, b.inherit, access.manage ? (acl.grants.get(grantKey("board", b.id)) ?? []) : [], eff, access.manage);
  }
  const { f, access } = await getFolder(c, p, target.id, acl);
  const eff = folderEffective(acl, f.id);
  // The folder's own creator is already `ownerId`; its own grants are the ones without `from` above it.
  return accessDto(
    acl,
    f.owner_id,
    f.inherit,
    access.manage ? (acl.grants.get(grantKey("folder", f.id)) ?? []) : [],
    { grants: eff.grants.filter((g) => g.from !== f.id), owners: eff.owners },
    access.manage,
    eff,
  );
}

/** Replaces the own grants of a board or folder and whether it inherits; search learns the new readers. */
export async function setAccess(c: PoolClient, p: Principal, target: { type: "folder" | "board"; id: string }, input: { inherit: boolean; grants: Grant[] }) {
  const acl = await loadAcl(c);
  let id: string;
  if (target.type === "board") {
    const { b, access } = await getBoard(c, p, target.id, acl);
    if (!access.manage) throw new Forbidden("only the board's managers can share it");
    id = b.id;
    await c.query("UPDATE whiteboards SET inherit = $2 WHERE id = $1", [id, input.inherit]);
  } else {
    const { f, access } = await getFolder(c, p, target.id, acl);
    if (!access.manage) throw new Forbidden("only the folder's managers can share it");
    id = f.id;
    await c.query("UPDATE whiteboard_folders SET inherit = $2, updated_at = now() WHERE id = $1", [id, input.inherit]);
  }
  await writeGrants(c, target.type, id, input.grants);
  await activity(c, target.type === "board" ? "whiteboard" : "whiteboard_folder", id, "permissions_changed", { inherit: input.inherit, grants: normalizeGrants(input.grants) });
  await reannounceBoards(c, target.type === "board" ? { ids: [id] } : { folderIds: [...subtree(acl, id)] });
  return getAccess(c, p, { type: target.type, id });
}
