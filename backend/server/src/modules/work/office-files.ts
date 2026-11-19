import type { Pool, PoolClient } from "pg";
import { withTransaction, type Principal } from "@workspace/shared";
import type { ObjectStorage } from "@workspace/service-kit";
import { canReadDriveItem, finishDriveUpload, requestDriveUpload } from "./drive.js";
import { confirmUpload, downloadUrl, requestUpload } from "./files.js";
import { getTask } from "./tasks.js";
import { resolveRef } from "./ref.js";
import { Invalid, NotFound } from "./errors.js";

/**
 * Files for the assistant's Office tools: the bytes of a task attachment or a Drive file the asker may
 * read, and a file the tools made saved on a task or in the asker's Drive, through the same checks, storage and audit
 * as an upload from the app. The storage's presigned links are used from here, so the AI module never sees them.
 */

/** Office files, PDFs and their neighbours: what the tools read and write. */
const READABLE = /\.(docx|xlsx|pptx|pdf|csv|tsv|txt|md|zip)$/i;
export const OFFICE_BYTES_MAX = 15 * 1024 * 1024;

export interface FoundFile {
  fileId: string;
  name: string;
  contentType: string;
  size: number;
  where: { type: "task"; id: string; code: string; title: string } | { type: "drive"; id: string };
}

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase().trim();

/** The best match of a name among files (exact, then without the extension, then containing it). */
function best<T extends { name: string }>(list: T[], name: string): T[] {
  const q = fold(name);
  const bare = (n: string) => fold(n).replace(/\.[a-z0-9]+$/, "");
  const exact = list.filter((f) => fold(f.name) === q);
  if (exact.length) return exact;
  const stem = list.filter((f) => bare(f.name) === bare(q));
  if (stem.length) return stem;
  return list.filter((f) => fold(f.name).includes(bare(q)));
}

/**
 * The Office files the asker may read: a task's attachments (`task`), or the Drive files matching `name`, or one file
 * by id. Several matches come back as a list for the model to choose from.
 */
export async function findOfficeFiles(c: PoolClient, p: Principal, q: { id?: string | undefined; task?: string | undefined; name?: string | undefined }): Promise<FoundFile[]> {
  if (q.id) {
    const f = (
      await c.query<{ id: string; name: string; content_type: string; size: string; attached_type: string; attached_id: string }>(
        "SELECT id, name, content_type, size, attached_type, attached_id FROM files WHERE id = $1 AND status = 'active'",
        [q.id],
      )
    ).rows[0];
    if (!f) throw new NotFound("file not found");
    if (f.attached_type === "drive") {
      if (!(await canReadDriveItem(c, p, f.attached_id))) throw new NotFound("file not found");
      return [{ fileId: f.id, name: f.name, contentType: f.content_type, size: Number(f.size), where: { type: "drive", id: f.attached_id } }];
    }
    if (f.attached_type !== "task") throw new NotFound("file not found");
    const t = await getTask(c, p, f.attached_id);
    return [{ fileId: f.id, name: f.name, contentType: f.content_type, size: Number(f.size), where: { type: "task", id: t.id, code: t.code, title: t.title } }];
  }
  if (q.task) {
    const t = await getTask(c, p, await resolveRef(c, "task", q.task));
    const rows = (
      await c.query<{ id: string; name: string; content_type: string; size: string }>(
        "SELECT id, name, content_type, size FROM files WHERE attached_type = 'task' AND attached_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 100",
        [t.id],
      )
    ).rows.filter((f) => READABLE.test(f.name));
    const list = q.name ? best(rows, q.name) : rows;
    return list.map((f) => ({ fileId: f.id, name: f.name, contentType: f.content_type, size: Number(f.size), where: { type: "task", id: t.id, code: t.code, title: t.title } }));
  }
  if (!q.name?.trim()) throw new Invalid("name a file, a task or a file id");
  const words = fold(q.name).replace(/\.[a-z0-9]+$/, "");
  // Names are compared without accents in JS: "bang luong" finds "Bảng lương.xlsx".
  const rows = (
    await c.query<{ item_id: string; file_id: string; name: string; content_type: string; size: string }>(
      `SELECT d.id AS item_id, d.file_id, d.name, d.content_type, d.size FROM drive_items d
        WHERE d.kind = 'file' AND d.trashed_at IS NULL AND d.file_id IS NOT NULL ORDER BY d.updated_at DESC LIMIT 3000`,
    )
  ).rows.filter((f) => READABLE.test(f.name) && fold(f.name).includes(words));
  const readable: typeof rows = [];
  for (const r of rows) if (await canReadDriveItem(c, p, r.item_id)) readable.push(r);
  return best(readable, q.name).map((f) => ({ fileId: f.file_id, name: f.name, contentType: f.content_type, size: Number(f.size), where: { type: "drive", id: f.item_id } }));
}

/** One file's bytes, read as the asker (downloadUrl checks and audits the read). */
export async function officeBytes(pool: Pool, storage: ObjectStorage, p: Principal, fileId: string): Promise<Buffer> {
  const { url } = await withTransaction(pool, (c) => downloadUrl(c, storage, p, fileId));
  const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Invalid(`storage answered ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > OFFICE_BYTES_MAX) throw new Invalid("the file is too large to open here");
  return buf;
}

export interface SavedFile {
  fileId: string;
  name: string;
  size: number;
  where: { type: "task"; id: string; code: string; title: string } | { type: "drive"; id: string };
}

/** Saves a file the tools made: on a task (as an attachment) or in the asker's Drive (a folder, or the top). */
export async function saveOfficeFile(
  pool: Pool,
  storage: ObjectStorage,
  p: Principal,
  input: { name: string; contentType: string; data: Buffer; task?: string | undefined; folder?: string | null | undefined },
): Promise<SavedFile> {
  if (!input.data.length || input.data.length > OFFICE_BYTES_MAX) throw new Invalid("the file is empty or too large");
  const size = input.data.length;
  if (input.task) {
    const t = await withTransaction(pool, async (c) => getTask(c, p, await resolveRef(c, "task", input.task!)));
    const up = await withTransaction(pool, (c) => requestUpload(c, storage, p, { name: input.name, contentType: input.contentType, size, attachTo: { type: "task", id: t.id } }));
    await put(up.uploadUrl, input.contentType, input.data);
    await withTransaction(pool, (c) => confirmUpload(c, storage, p, up.fileId));
    return { fileId: up.fileId, name: input.name, size, where: { type: "task", id: t.id, code: t.code, title: t.title } };
  }
  const up = await withTransaction(pool, (c) => requestDriveUpload(c, storage, p, { name: input.name, contentType: input.contentType, size, parentId: input.folder ?? null }));
  await put(up.uploadUrl, input.contentType, input.data);
  await withTransaction(pool, async (c) => {
    await confirmUpload(c, storage, p, up.fileId);
    await finishDriveUpload(c, p, up.itemId);
  });
  return { fileId: up.fileId, name: input.name, size, where: { type: "drive", id: up.itemId } };
}

async function put(url: string, contentType: string, data: Buffer) {
  const r = await fetch(url, {
    method: "PUT",
    headers: { "content-type": contentType, "content-length": String(data.length) },
    body: data as BodyInit,
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) throw new Invalid(`storage refused the file (${r.status})`);
}
