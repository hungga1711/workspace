import { api } from "./client";
import type { Attachment } from "@/components/chat/attachments";

/**
 * Stores a file with a task or a page: browser → presigned PUT → storage directly; the backend only authorizes and
 * records. Resolves to the file (read back at /app/files/<fileId>); rejects with the API's error when refused.
 * A workflow's asset attaches to `{ type: "workflow", id }`; a workflow not saved yet uses the id "draft" (the server
 * keeps the file with the uploader until the workflow that lists it is saved).
 */
export async function uploadWorkFile(file: File, attachTo: { type: "task" | "document" | "workflow"; id: string }): Promise<Attachment> {
  const contentType = file.type || "application/octet-stream";
  const u = await api<{ fileId: string; uploadUrl: string }>("work/files/uploads", {
    method: "POST",
    body: { name: file.name, contentType, size: file.size, attachTo },
  });
  const put = await fetch(u.uploadUrl, { method: "PUT", headers: { "content-type": contentType }, body: file });
  if (!put.ok) throw new Error("upload");
  await api(`work/files/${u.fileId}/confirm`, { method: "POST" });
  return { fileId: u.fileId, name: file.name, size: file.size, contentType };
}
