import type { Pool, PoolClient } from "pg";
import { inlineSafe, newId, runWithContext, uploadRefusal, withTransaction, type Principal } from "@workspace/shared";
import { logger, objectKey, type ObjectStorage } from "@workspace/service-kit";
import { assertCanRead, assertMember, Forbidden, Invalid, NotFound } from "./domain.js";

const MAX_CHAT_FILE_BYTES = 50 * 1024 * 1024;
const TTL = 15 * 60;

/** Step 1: a member asks to upload into a channel; the browser PUTs straight to storage. */
export async function requestChatUpload(c: PoolClient, storage: ObjectStorage, p: Principal, channelId: string, input: { name: string; contentType: string; size: number }) {
  if (input.size <= 0 || input.size > MAX_CHAT_FILE_BYTES) throw new Invalid(`file size must be 1..${MAX_CHAT_FILE_BYTES} bytes`);
  const refused = uploadRefusal(input.name, input.contentType);
  if (refused) throw new Invalid(refused);
  if (!p.grants.some((g) => g.permission === "file.upload")) throw new Forbidden("cannot upload");
  await assertMember(c, p, channelId);
  const id = newId();
  const key = objectKey("chat", id);
  await c.query(
    `INSERT INTO chat_files (id, channel_id, object_key, name, content_type, size, status, owner_id, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,'pending',$7, now() + interval '24 hours')`,
    [id, channelId, key, input.name, input.contentType, input.size, p.id],
  );
  return { fileId: id, uploadUrl: await storage.presignPut(key, input.contentType, input.size, TTL), expiresIn: TTL };
}

/** Step 2: the object must exist with the declared size and type, or it is deleted. */
export async function confirmChatUpload(c: PoolClient, storage: ObjectStorage, p: Principal, fileId: string) {
  const f = (
    await c.query<{ object_key: string; size: string; content_type: string; status: string; owner_id: string; name: string }>(
      "SELECT object_key, size, content_type, status, owner_id, name FROM chat_files WHERE id = $1 FOR UPDATE",
      [fileId],
    )
  ).rows[0];
  if (!f || f.owner_id !== p.id || f.status === "deleted") throw new NotFound("file not found");
  if (f.status === "pending") {
    const head = await storage.head(f.object_key);
    if (!head) throw new Invalid("upload not found in storage");
    if (head.size !== Number(f.size) || head.contentType !== f.content_type) {
      await storage.delete(f.object_key);
      await c.query("UPDATE chat_files SET status = 'deleted' WHERE id = $1", [fileId]);
      throw new Invalid("uploaded object does not match the declared size/type");
    }
    await c.query("UPDATE chat_files SET status = 'active', expires_at = NULL WHERE id = $1", [fileId]);
  }
  return { fileId, name: f.name, size: Number(f.size), contentType: f.content_type };
}

/**
 * Called inside postMessage's transaction: every attachment must be the poster's own confirmed,
 * not-yet-used upload in this channel. Returns the trusted metadata (client values are ignored).
 */
export async function bindAttachments(c: PoolClient, p: Principal, channelId: string, messageId: string, fileIds: string[]) {
  const out: { fileId: string; name: string; size: number; contentType: string }[] = [];
  for (const id of fileIds) {
    const f = (
      await c.query<{ name: string; size: string; content_type: string }>(
        `UPDATE chat_files SET message_id = $4 WHERE id = $1 AND owner_id = $2 AND channel_id = $3 AND status = 'active' AND message_id IS NULL RETURNING name, size, content_type`,
        [id, p.id, channelId, messageId],
      )
    ).rows[0];
    if (!f) throw new Invalid("attachment is not an uploaded file of yours in this channel");
    out.push({ fileId: id, name: f.name, size: Number(f.size), contentType: f.content_type });
  }
  return out;
}

/** Download: whoever can read the channel gets a 60-second link (never a permanent URL). */
export async function chatDownloadUrl(c: PoolClient, storage: ObjectStorage, p: Principal, fileId: string, inline: boolean) {
  const f = (
    await c.query<{ object_key: string; name: string; channel_id: string; status: string; message_id: string | null; owner_id: string; content_type: string }>(
      "SELECT object_key, name, channel_id, status, message_id, owner_id, content_type FROM chat_files WHERE id = $1",
      [fileId],
    )
  ).rows[0];
  if (!f || f.status !== "active" || (!f.message_id && f.owner_id !== p.id)) throw new NotFound("file not found");
  try {
    await assertCanRead(c, p, f.channel_id);
  } catch {
    throw new NotFound("file not found");
  }
  // Inline is for previews (pictures, PDF, sound, video): a file a browser would run (HTML, SVG) is always a download,
  // whatever the caller asked for.
  return { url: await storage.presignGet(f.object_key, 60, f.name, inline && inlineSafe(f.content_type)), expiresIn: 60 };
}

/** Files shared in a channel, newest first (the channel's "Tệp" tab). */
export async function channelFiles(c: PoolClient, p: Principal, channelId: string) {
  await assertCanRead(c, p, channelId);
  return (
    await c.query(
      `SELECT f.id AS "fileId", f.name, f.content_type AS "contentType", f.size::int AS size, f.owner_id AS "ownerId", f.message_id AS "messageId", f.created_at AS "createdAt"
      FROM chat_files f WHERE f.channel_id = $1 AND f.status = 'active' AND f.message_id IS NOT NULL ORDER BY f.created_at DESC LIMIT 200`,
      [channelId],
    )
  ).rows;
}

/** Never-confirmed uploads are removed from storage after 24 hours. */
export async function sweepChatFiles(pool: Pool, storage: ObjectStorage, limit = 500): Promise<number> {
  const rows = (
    await pool.query<{ id: string; object_key: string }>("SELECT id, object_key FROM chat_files WHERE status = 'pending' AND expires_at < now() ORDER BY expires_at LIMIT $1", [
      limit,
    ])
  ).rows;
  for (const f of rows) {
    try {
      await storage.delete(f.object_key);
      await runWithContext({ actorId: "service:chat-file-sweeper", requestId: newId() }, () =>
        withTransaction(pool, (c) => c.query("UPDATE chat_files SET status = 'deleted' WHERE id = $1 AND status = 'pending'", [f.id])),
      );
    } catch (err) {
      logger.warn({ err, fileId: f.id }, "chat file sweep failed");
    }
  }
  return rows.length;
}
