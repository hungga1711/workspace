import type { PoolClient } from "pg";
import { objectKey, type ObjectStorage } from "@workspace/service-kit";
import { newId, recordAudit, uploadRefusal, type Principal } from "@workspace/shared";
import { activity, allowedAny } from "./common.js";
import { Forbidden, Invalid, NotFound } from "./errors.js";
import { knowledgeChanged } from "./knowledge.js";

/**
 * Drive: folders and files that are not part of a page or a task. Uploads use the
 * same presigned flow as attachments (files table, attached_type 'drive'); the item row holds the name,
 * folder, sharing and trash state. Sharing a folder shares what is inside it.
 */
const DRIVE_MAX_BYTES = 500 * 1024 * 1024;

export interface DriveRow {
  id: string;
  kind: "folder" | "file";
  name: string;
  parent_id: string | null;
  owner_id: string;
  file_id: string | null;
  size: string;
  content_type: string;
  visibility: "private" | "workspace";
  shared_with: string[];
  editors: string[];
  trashed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const dto = (r: DriveRow, starred = false) => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  parentId: r.parent_id,
  ownerId: r.owner_id,
  fileId: r.file_id,
  size: Number(r.size),
  contentType: r.content_type,
  visibility: r.visibility,
  sharedWith: r.shared_with,
  editors: r.editors,
  trashedAt: r.trashed_at,
  updatedAt: r.updated_at,
  starred,
});

/** The item and its folders up to the root (closest first), so folder sharing applies to what is inside. */
async function chain(c: PoolClient, id: string): Promise<DriveRow[]> {
  return (
    await c.query<DriveRow>(
      `WITH RECURSIVE up AS (SELECT * , 0 AS depth FROM drive_items WHERE id = $1
         UNION ALL SELECT d.*, up.depth + 1 FROM drive_items d JOIN up ON d.id = up.parent_id WHERE up.depth < 30)
       SELECT * FROM up ORDER BY depth`,
      [id],
    )
  ).rows;
}

/**
 * Which of `ids` the principal may read, in one query: the recursive walk up the folder chain runs for all candidates
 * at once rather than one `chain()` per row (search and "recent" check up to 300 rows).
 */
async function readableSet(c: PoolClient, p: Principal, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const workspaceRead = allowedAny(p, "file.read", [{}]);
  const r = await c.query<{ start_id: string }>(
    `WITH RECURSIVE up AS (
       SELECT id AS start_id, parent_id, owner_id, shared_with, editors, visibility, 0 AS depth FROM drive_items WHERE id = ANY($1::text[])
       UNION ALL
       SELECT up.start_id, d.parent_id, d.owner_id, d.shared_with, d.editors, d.visibility, up.depth + 1
         FROM drive_items d JOIN up ON d.id = up.parent_id WHERE up.depth < 30)
     SELECT DISTINCT start_id FROM up
      WHERE owner_id = $2 OR $2 = ANY(shared_with) OR $2 = ANY(editors) OR (visibility = 'workspace' AND $3)`,
    [ids, p.id, workspaceRead],
  );
  return new Set(r.rows.map((x) => x.start_id));
}

function reads(p: Principal, rows: DriveRow[]): boolean {
  return rows.some((r) => r.owner_id === p.id || r.shared_with.includes(p.id) || r.editors.includes(p.id) || (r.visibility === "workspace" && allowedAny(p, "file.read", [{}])));
}
function edits(p: Principal, rows: DriveRow[]): boolean {
  return rows.some((r) => r.owner_id === p.id || r.editors.includes(p.id));
}

async function getItem(c: PoolClient, p: Principal, id: string) {
  const rows = await chain(c, id);
  if (!rows[0] || !reads(p, rows)) throw new NotFound("item not found");
  return { item: rows[0], canEdit: edits(p, rows) };
}

export async function canReadDriveItem(c: PoolClient, p: Principal, id: string) {
  const rows = await chain(c, id);
  return !!rows[0] && reads(p, rows);
}

async function assertFolder(c: PoolClient, p: Principal, parentId: string | null) {
  if (!parentId) return;
  const { item, canEdit } = await getItem(c, p, parentId);
  if (item.kind !== "folder") throw new Invalid("not a folder");
  if (!canEdit) throw new Forbidden("you can only view this folder");
}

async function starredSet(c: PoolClient, p: Principal) {
  return new Set((await c.query<{ item_id: string }>("SELECT item_id FROM drive_stars WHERE user_id = $1", [p.id])).rows.map((r) => r.item_id));
}

/**
 * A folder's contents (or My Drive, shared with me, recent, starred, trash), folders first, with the path
 * to it and the workspace's storage use.
 */
export async function listDrive(c: PoolClient, p: Principal, view: { folder?: string | undefined; section?: string | undefined; q?: string | undefined }) {
  const stars = await starredSet(c, p);
  let rows: DriveRow[] = [];
  let path: { id: string; name: string }[] = [];
  let canEdit = true;
  const q = view.q?.trim();
  if (q) {
    rows = (await c.query<DriveRow>("SELECT * FROM drive_items WHERE trashed_at IS NULL AND name ILIKE $1 ORDER BY updated_at DESC LIMIT 300", [`%${q}%`])).rows;
    const readable = await readableSet(
      c,
      p,
      rows.map((r) => r.id),
    );
    rows = rows.filter((r) => readable.has(r.id));
  } else if (view.folder) {
    const f = await getItem(c, p, view.folder);
    if (f.item.kind !== "folder") throw new Invalid("not a folder");
    canEdit = f.canEdit;
    path = (await chain(c, view.folder)).reverse().map((r) => ({ id: r.id, name: r.name }));
    rows = (await c.query<DriveRow>("SELECT * FROM drive_items WHERE parent_id = $1 AND trashed_at IS NULL", [view.folder])).rows;
  } else if (view.section === "shared") {
    rows = (
      await c.query<DriveRow>(
        `SELECT * FROM drive_items d WHERE trashed_at IS NULL AND owner_id <> $1 AND ($1 = ANY(shared_with) OR $1 = ANY(editors) OR visibility = 'workspace')
           AND NOT EXISTS (SELECT 1 FROM drive_items pd WHERE pd.id = d.parent_id AND (pd.visibility = 'workspace' OR $1 = ANY(pd.shared_with) OR $1 = ANY(pd.editors)))
         ORDER BY updated_at DESC LIMIT 300`,
        [p.id],
      )
    ).rows.filter((r) => r.visibility !== "workspace" || allowedAny(p, "file.read", [{}]));
  } else if (view.section === "recent") {
    rows = (await c.query<DriveRow>("SELECT * FROM drive_items WHERE kind = 'file' AND trashed_at IS NULL ORDER BY updated_at DESC LIMIT 200")).rows;
    const readable = await readableSet(
      c,
      p,
      rows.map((r) => r.id),
    );
    rows = rows.filter((r) => readable.has(r.id)).slice(0, 50);
  } else if (view.section === "starred") {
    rows = (await c.query<DriveRow>("SELECT d.* FROM drive_items d JOIN drive_stars s ON s.item_id = d.id AND s.user_id = $1 WHERE d.trashed_at IS NULL", [p.id])).rows;
  } else if (view.section === "trash") {
    rows = (await c.query<DriveRow>("SELECT * FROM drive_items WHERE owner_id = $1 AND trashed_at IS NOT NULL ORDER BY trashed_at DESC LIMIT 300", [p.id])).rows;
  } else {
    rows = (await c.query<DriveRow>("SELECT * FROM drive_items WHERE owner_id = $1 AND parent_id IS NULL AND trashed_at IS NULL", [p.id])).rows;
  }
  rows.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, "vi") : a.kind === "folder" ? -1 : 1));
  const used = (await c.query<{ n: string }>("SELECT coalesce(sum(size), 0)::bigint AS n FROM drive_items WHERE kind = 'file'")).rows[0]!.n;
  return { items: rows.map((r) => dto(r, stars.has(r.id))), path, canEdit, usedBytes: Number(used) };
}

export async function createFolder(c: PoolClient, p: Principal, name: string, parentId: string | null) {
  await assertFolder(c, p, parentId);
  const id = newId();
  const r = await c.query<DriveRow>("INSERT INTO drive_items (id, kind, name, parent_id, owner_id) VALUES ($1,'folder',$2,$3,$4) RETURNING *", [id, name, parentId, p.id]);
  await activity(c, "drive", id, "created", { kind: "folder", name });
  return dto(r.rows[0]!);
}

/** Step 1 of an upload into a folder: the item (hidden until confirmed) and a presigned PUT. */
export async function requestDriveUpload(c: PoolClient, storage: ObjectStorage, p: Principal, input: { name: string; contentType: string; size: number; parentId: string | null }) {
  if (!allowedAny(p, "file.upload", [{}])) throw new Forbidden("cannot upload");
  if (input.size <= 0 || input.size > DRIVE_MAX_BYTES) throw new Invalid(`file size must be 1..${DRIVE_MAX_BYTES} bytes`);
  // HTML and SVG are accepted (they are common exports): work files only ever come back as a download.
  const refused = uploadRefusal(input.name, input.contentType);
  if (refused) throw new Invalid(refused);
  await assertFolder(c, p, input.parentId);
  const itemId = newId();
  const fileId = newId();
  const key = objectKey("documents", fileId);
  await c.query(
    `INSERT INTO files (id, object_key, name, content_type, size, status, owner_id, attached_type, attached_id, expires_at)
     VALUES ($1,$2,$3,$4,$5,'pending',$6,'drive',$7, now() + interval '24 hours')`,
    [fileId, key, input.name, input.contentType, input.size, p.id, itemId],
  );
  await c.query("INSERT INTO drive_items (id, kind, name, parent_id, owner_id, file_id, size, content_type, trashed_at) VALUES ($1,'file',$2,$3,$4,$5,$6,$7, now())", [
    itemId,
    input.name,
    input.parentId,
    p.id,
    fileId,
    input.size,
    input.contentType,
  ]);
  return { itemId, fileId, uploadUrl: await storage.presignPut(key, input.contentType, input.size, 15 * 60) };
}

/**
 * Search and AI retrieval index the words of Drive files with who may read them (knowledge.ts): a change to an item's
 * name, place, sharing or trash state is a change to every file under it whose text has been read.
 */
async function reindexUnder(c: PoolClient, itemId: string) {
  const files = (
    await c.query<{ file_id: string }>(
      `WITH RECURSIVE down AS (SELECT id, file_id, 0 AS depth FROM drive_items WHERE id = $1
         UNION ALL SELECT d.id, d.file_id, down.depth + 1 FROM drive_items d JOIN down ON d.parent_id = down.id WHERE down.depth < 30)
       SELECT down.file_id FROM down JOIN file_texts x ON x.file_id = down.file_id AND x.status = 'done' LIMIT 500`,
      [itemId],
    )
  ).rows;
  for (const f of files) await knowledgeChanged(c, "file", f.file_id);
}

/** Step 2: once the file is confirmed in storage, the item appears in its folder. */
export async function finishDriveUpload(c: PoolClient, p: Principal, itemId: string) {
  const r = await c.query<DriveRow & { status: string }>("SELECT d.*, f.status FROM drive_items d JOIN files f ON f.id = d.file_id WHERE d.id = $1 AND d.owner_id = $2", [
    itemId,
    p.id,
  ]);
  const it = r.rows[0];
  if (!it) throw new NotFound("item not found");
  if (it.status !== "active") throw new Invalid("the upload is not confirmed yet");
  await c.query("UPDATE drive_items SET trashed_at = NULL, updated_at = now() WHERE id = $1", [itemId]);
  await activity(c, "drive", itemId, "uploaded", { name: it.name, size: Number(it.size) });
  await reindexUnder(c, itemId);
  return { ok: true };
}

export async function updateItem(
  c: PoolClient,
  p: Principal,
  id: string,
  input: { name?: string | undefined; parentId?: string | null | undefined; starred?: boolean | undefined },
) {
  const { item, canEdit } = await getItem(c, p, id);
  if (input.starred !== undefined) {
    if (input.starred) await c.query("INSERT INTO drive_stars (item_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [id, p.id]);
    else await c.query("DELETE FROM drive_stars WHERE item_id = $1 AND user_id = $2", [id, p.id]);
  }
  if (input.name !== undefined || input.parentId !== undefined) {
    if (!canEdit) throw new Forbidden("you can only view this item");
    if (input.parentId !== undefined) {
      await assertFolder(c, p, input.parentId);
      if (input.parentId && (await chain(c, input.parentId)).some((r) => r.id === id)) throw new Invalid("a folder cannot move into itself");
    }
    await c.query("UPDATE drive_items SET name = coalesce($2, name), parent_id = CASE WHEN $3 THEN $4 ELSE parent_id END, updated_at = now() WHERE id = $1", [
      id,
      input.name ?? null,
      input.parentId !== undefined,
      input.parentId ?? null,
    ]);
    await reindexUnder(c, id);
  }
  return { ok: true, id: item.id };
}

export async function shareItem(c: PoolClient, p: Principal, id: string, input: { visibility: "private" | "workspace"; viewers: string[]; editors: string[] }) {
  const { item } = await getItem(c, p, id);
  if (item.owner_id !== p.id) throw new Forbidden("only the owner shares");
  await c.query("UPDATE drive_items SET visibility = $2, shared_with = $3, editors = $4, updated_at = now() WHERE id = $1", [
    id,
    input.visibility,
    [...new Set(input.viewers)],
    [...new Set(input.editors)],
  ]);
  await activity(c, "drive", id, "shared", input);
  await reindexUnder(c, id);
  await recordAudit(c, {
    action: "work.drive.shared",
    targetType: "drive_item",
    targetId: id,
    targetLabel: item.name,
    changes: { visibility: { from: item.visibility, to: input.visibility } },
    meta: { viewers: input.viewers, editors: input.editors },
  });
  return { ok: true };
}

/** Trash (restorable by the owner); deleting from the trash removes the stored files too. */
export async function trashItem(c: PoolClient, p: Principal, id: string, on: boolean) {
  const r = (await c.query<DriveRow>("SELECT * FROM drive_items WHERE id = $1", [id])).rows[0];
  if (!r || r.owner_id !== p.id) throw new NotFound("item not found");
  await c.query("UPDATE drive_items SET trashed_at = CASE WHEN $2 THEN now() END WHERE id = $1", [id, on]);
  await reindexUnder(c, id);
  await recordAudit(c, { action: on ? "work.drive.trashed" : "work.drive.restored", targetType: "drive_item", targetId: id, targetLabel: r.name });
  return { ok: true };
}

export async function purgeItem(c: PoolClient, storage: ObjectStorage, p: Principal, id: string) {
  const r = (await c.query<DriveRow>("SELECT * FROM drive_items WHERE id = $1 AND owner_id = $2 AND trashed_at IS NOT NULL", [id, p.id])).rows[0];
  if (!r) throw new NotFound("item not found in the trash");
  const all = (
    await c.query<{ id: string; file_id: string | null }>(
      "WITH RECURSIVE down AS (SELECT id, file_id FROM drive_items WHERE id = $1 UNION ALL SELECT d.id, d.file_id FROM drive_items d JOIN down ON d.parent_id = down.id) SELECT * FROM down",
      [id],
    )
  ).rows;
  for (const it of all) {
    if (it.file_id) {
      const f = (await c.query<{ object_key: string }>("SELECT object_key FROM files WHERE id = $1", [it.file_id])).rows[0];
      if (f) await storage.delete(f.object_key).catch(() => undefined);
      await c.query("UPDATE files SET status = 'deleted' WHERE id = $1", [it.file_id]);
      await knowledgeChanged(c, "file", it.file_id);
    }
  }
  await c.query("DELETE FROM drive_stars WHERE item_id = ANY($1)", [all.map((x) => x.id)]);
  await c.query("DELETE FROM drive_items WHERE id = ANY($1)", [all.map((x) => x.id)]);
  await recordAudit(c, { action: "work.drive.deleted", targetType: "drive_item", targetId: id, targetLabel: r.name, meta: { items: all.length } });
  return { deleted: all.length };
}
