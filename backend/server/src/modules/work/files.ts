import type { Pool, PoolClient } from "pg";
import { newId, recordAudit, uploadRefusal, type Principal } from "@workspace/shared";
import { logger, objectKey, type ObjectStorage } from "@workspace/service-kit";
import { canReadDriveItem } from "./drive.js";
import { canEditDoc, canReadDoc, getDoc } from "./documents.js";
import { canReadTask, getTask, taskResources } from "./tasks.js";
import { allowedAny } from "./common.js";
import { getBoard } from "./whiteboards.js";
import { Forbidden, Invalid, NotFound } from "./errors.js";
import { knowledgeChanged } from "./knowledge.js";

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const UPLOAD_TTL_SECONDS = 15 * 60;
const PENDING_GRACE_HOURS = 24;

export type AttachType = "document" | "task" | "whiteboard" | "workflow";

async function assertCanAttach(c: PoolClient, p: Principal, type: AttachType, id: string) {
  if (type === "workflow") {
    // A workflow's reference files: whoever may edit it. "draft": a workflow not saved yet, kept with the uploader.
    if (!allowedAny(p, "ai.use", [{}])) throw new Forbidden("cannot attach to a workflow");
    if (id === "draft") return;
    const w = (await c.query<{ created_by: string }>("SELECT created_by FROM agent_workflows WHERE id = $1 AND NOT archived", [id])).rows[0];
    if (!w) throw new NotFound("workflow not found");
    if (w.created_by !== p.id && !allowedAny(p, "ai.agent.manage", [{}])) throw new Forbidden("cannot attach to this workflow");
  } else if (type === "whiteboard") {
    // Images placed on a board: whoever may edit it.
    if (!(await getBoard(c, p, id)).access.edit) throw new Forbidden("cannot attach to this whiteboard");
  } else if (type === "document") {
    const d = await getDoc(c, p, id);
    if (!canEditDoc(p, d)) throw new Forbidden("cannot attach to this document");
  } else {
    const t = await getTask(c, p, id);
    if (!allowedAny(p, "task.edit", taskResources(t))) throw new Forbidden("cannot attach to this task");
  }
}

/** Step 1: authorize, create a pending row, hand out a presigned PUT. */
export async function requestUpload(
  c: PoolClient,
  storage: ObjectStorage,
  p: Principal,
  input: { name: string; contentType: string; size: number; attachTo: { type: AttachType; id: string } },
) {
  if (input.size <= 0 || input.size > MAX_FILE_BYTES) throw new Invalid(`file size must be 1..${MAX_FILE_BYTES} bytes`);
  // Any kind of file but programs and scripts (shared/upload-types.ts). Every download is an attachment, never
  // shown inline, so an uploaded HTML page or SVG cannot run in the app.
  const refused = uploadRefusal(input.name, input.contentType);
  if (refused) throw new Invalid(refused);
  if (!allowedAny(p, "file.upload", [{}])) throw new Forbidden("cannot upload");
  await assertCanAttach(c, p, input.attachTo.type, input.attachTo.id);
  const id = newId();
  const key = objectKey("documents", id);
  await c.query(
    `INSERT INTO files (id, object_key, name, content_type, size, status, owner_id, attached_type, attached_id, expires_at)
     VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8, now() + interval '${PENDING_GRACE_HOURS} hours')`,
    [
      id,
      key,
      input.name,
      input.contentType,
      input.size,
      p.id,
      input.attachTo.type,
      input.attachTo.type === "workflow" && input.attachTo.id === "draft" ? `draft:${p.id}` : input.attachTo.id,
    ],
  );
  return { fileId: id, uploadUrl: await storage.presignPut(key, input.contentType, input.size, UPLOAD_TTL_SECONDS), expiresIn: UPLOAD_TTL_SECONDS };
}

/** Step 2: confirm. The object must exist with the declared size and type; otherwise it is deleted. Idempotent. */
export async function confirmUpload(c: PoolClient, storage: ObjectStorage, p: Principal, fileId: string) {
  const r = await c.query<{ object_key: string; size: string; content_type: string; status: string; owner_id: string }>(
    "SELECT object_key, size, content_type, status, owner_id FROM files WHERE id = $1 FOR UPDATE",
    [fileId],
  );
  const f = r.rows[0];
  if (!f || f.owner_id !== p.id) throw new NotFound("file not found");
  if (f.status === "active") return { fileId, status: "active" };
  if (f.status !== "pending") throw new NotFound("file not found");
  const head = await storage.head(f.object_key);
  if (!head) throw new Invalid("upload not found in storage");
  if (head.size !== Number(f.size) || head.contentType !== f.content_type) {
    await storage.delete(f.object_key);
    await c.query("UPDATE files SET status = 'deleted' WHERE id = $1", [fileId]);
    throw new Invalid("uploaded object does not match the declared size/type");
  }
  await c.query("UPDATE files SET status = 'active', expires_at = NULL WHERE id = $1", [fileId]);
  return { fileId, status: "active" };
}

/** Download: authorize against the attached entity, then a 60s presigned GET. */
export async function downloadUrl(c: PoolClient, storage: ObjectStorage, p: Principal, fileId: string) {
  const r = await c.query<{ object_key: string; name: string; status: string; attached_type: AttachType; attached_id: string }>(
    "SELECT object_key, name, status, attached_type, attached_id FROM files WHERE id = $1",
    [fileId],
  );
  const f = r.rows[0];
  if (!f || f.status !== "active") throw new NotFound("file not found");
  if (!allowedAny(p, "file.read", [{}])) throw new NotFound("file not found");
  try {
    if ((f.attached_type as string) === "drive") {
      if (!(await canReadDriveItem(c, p, f.attached_id))) throw new NotFound("file not found");
    } else if (f.attached_type === "workflow") {
      // Workflows are read by everyone who reads tasks; a draft's files only by who uploaded them.
      if (f.attached_id.startsWith("draft:") ? f.attached_id !== `draft:${p.id}` : !allowedAny(p, "task.read", [{}])) throw new NotFound("file not found");
    } else if (f.attached_type === "whiteboard") {
      await getBoard(c, p, f.attached_id);
    } else if (f.attached_type === "document") {
      if (!canReadDoc(p, await getDoc(c, p, f.attached_id))) throw new NotFound("file not found");
    } else if (!canReadTask(p, await getTask(c, p, f.attached_id))) throw new NotFound("file not found");
  } catch {
    throw new NotFound("file not found");
  }
  // Downloads are on the audit trail (ADR 0025): one entry per person and file per ten minutes (previews repeat).
  await recordAudit(c, {
    action: "work.file.downloaded",
    targetType: "file",
    targetId: fileId,
    targetLabel: f.name,
    meta: { attachedType: f.attached_type, attachedId: f.attached_id },
    coalesceMinutes: 10,
  });
  return { url: await storage.presignGet(f.object_key, 60, f.name), expiresIn: 60 };
}

export async function deleteFile(c: PoolClient, storage: ObjectStorage, p: Principal, fileId: string) {
  const r = await c.query<{ object_key: string; owner_id: string; status: string; name: string }>("SELECT object_key, owner_id, status, name FROM files WHERE id = $1", [fileId]);
  const f = r.rows[0];
  if (!f || f.status === "deleted") throw new NotFound("file not found");
  if (f.owner_id !== p.id) throw new Forbidden("only the uploader can delete");
  await storage.delete(f.object_key);
  await c.query("UPDATE files SET status = 'deleted' WHERE id = $1", [fileId]);
  // Its words leave search and AI retrieval with it (knowledge.ts).
  await knowledgeChanged(c, "file", fileId);
  await recordAudit(c, { action: "work.file.deleted", targetType: "file", targetId: fileId, targetLabel: f.name });
}

/**
 * Sweeper: pending uploads never confirmed within the grace period are removed from storage and marked deleted.
 */
export async function sweepPendingFiles(pool: Pool, storage: ObjectStorage, limit = 500): Promise<number> {
  const rows = (
    await pool.query<{ id: string; object_key: string }>("SELECT id, object_key FROM files WHERE status = 'pending' AND expires_at < now() ORDER BY expires_at LIMIT $1", [limit])
  ).rows;
  let swept = 0;
  for (const f of rows) {
    try {
      await storage.delete(f.object_key);
      await pool.query("UPDATE files SET status = 'deleted' WHERE id = $1 AND status = 'pending'", [f.id]);
      swept++;
    } catch (err) {
      logger.warn({ err, fileId: f.id }, "file sweep failed; will retry next run");
    }
  }
  if (swept) logger.info({ swept }, "swept expired pending uploads");
  return swept;
}
