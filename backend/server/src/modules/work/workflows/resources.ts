import type { PoolClient } from "pg";
import type { Principal } from "@workspace/shared";
import type { ObjectStorage } from "@workspace/service-kit";
import { canReadDoc, docText, getDoc } from "../documents.js";
import { Forbidden } from "../errors.js";
import { RESOURCES_MAX } from "./render.js";
import { canReadDriveItem } from "../drive.js";
import { getTask } from "../tasks.js";
import { readableAs, textOf } from "./extract.js";
import { PROBLEM_TEXT, readLink } from "./links.js";
import type { ResourceDriveFile, ResourceFile, Resources } from "./model.js";

/**
 * A workflow's resources, read for one run: the playbook, the text of its workspace pages and of its text files, and
 * a list of what else is there (other files, links). Pages are read as the person who started the run, so a page they
 * cannot open never reaches the model through a workflow someone else set up. Best effort: a page or file that fails
 * to read is named as unavailable and the run goes on.
 */

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

interface Part {
  head: string;
  body: string;
}

/**
 * The reference block within its budget: the playbook first and whole (it is the company's own rules), then each
 * page and file with an equal share of what is left, then the lists. Pure.
 */
export function composeResources(notes: string, parts: Part[], lists: string[], max = RESOURCES_MAX): string {
  const out: string[] = [];
  let left = max;
  const take = (text: string) => {
    out.push(text);
    left -= text.length + 2;
  };
  if (notes.trim()) take(`## Playbook\n${notes.trim().slice(0, Math.max(0, left - 20))}`);
  const tail = lists.filter(Boolean).join("\n\n");
  left -= tail.length + 2;
  parts.forEach((p, i) => {
    const share = Math.floor(left / (parts.length - i));
    if (share < 200) return;
    const room = share - p.head.length - 8;
    take(`## ${p.head}\n${p.body.length > room ? `${p.body.slice(0, Math.max(0, room)).trimEnd()}\n…` : p.body}`);
  });
  if (tail) out.push(tail);
  return out.join("\n\n").trim();
}

/** A stored file's text (plain text, PDF, Word, Excel, PowerPoint), or null when it has none we can read. */
async function fileText(storage: ObjectStorage, f: StoredFile): Promise<string | null> {
  if (!readableAs(f.name, f.contentType, f.size)) return null;
  try {
    const url = await storage.presignGet(f.key, 60, f.name);
    const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return null;
    return await textOf(Buffer.from(await r.arrayBuffer()), f.name, f.contentType);
  } catch {
    return null;
  }
}

export interface StoredFile {
  id: string;
  key: string;
  name: string;
  size: number;
  contentType: string;
}

/**
 * The Drive files a workflow lists that `p` may read (the person who started the run): a file someone else set up
 * in the workflow but never shared with them stays out, and is named as unavailable.
 */
export async function driveFiles(c: PoolClient, p: Principal, listed: ResourceDriveFile[]): Promise<{ files: StoredFile[]; missing: string[] }> {
  const files: StoredFile[] = [];
  const missing: string[] = [];
  if (!listed.length) return { files, missing };
  const rows = (
    await c.query<{ id: string; name: string; object_key: string; size: string; content_type: string }>(
      `SELECT d.id, d.name, f.object_key, f.size, f.content_type FROM drive_items d JOIN files f ON f.id = d.file_id
        WHERE d.id = ANY($1) AND d.kind = 'file' AND d.trashed_at IS NULL AND f.status = 'active'`,
      [listed.map((x) => x.id)],
    )
  ).rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const x of listed) {
    const r = byId.get(x.id);
    if (r && (await canReadDriveItem(c, p, x.id))) files.push({ id: r.id, key: r.object_key, name: r.name, size: Number(r.size), contentType: r.content_type });
    else missing.push(x.name || x.id);
  }
  return { files, missing };
}

/** The files a workflow lists that are really its own (active, attached to it): what a run may read or download. */
export async function workflowFiles(c: PoolClient, workflowId: string | null, files: ResourceFile[]): Promise<StoredFile[]> {
  if (!workflowId || !files.length) return [];
  const r = await c.query<{ id: string; object_key: string; name: string; size: string; content_type: string }>(
    "SELECT id, object_key, name, size, content_type FROM files WHERE id = ANY($1) AND attached_type = 'workflow' AND attached_id = $2 AND status = 'active'",
    [files.map((f) => f.id), workflowId],
  );
  const byId = new Map(r.rows.map((x) => [x.id, x]));
  return files.flatMap((f) => {
    const x = byId.get(f.id);
    return x ? [{ id: x.id, key: x.object_key, name: x.name, size: Number(x.size), contentType: x.content_type }] : [];
  });
}

/**
 * The reference block for one run, as `p` (the person who started it): the playbook, then the text of the workflow's
 * pages, files (its own and the Drive's), tasks and links. "" when the workflow has no resources.
 */
export async function readResources(c: PoolClient, storage: ObjectStorage | null, p: Principal, workflowId: string | null, res: Resources, onRunner: boolean): Promise<string> {
  const parts: Part[] = [];
  const missing: string[] = [];
  // A failed read inside the run's transaction would abort it: each source gets its own savepoint.
  const safe = async (name: string, read: () => Promise<void>) => {
    try {
      await c.query("SAVEPOINT wf_res");
      await read();
      await c.query("RELEASE SAVEPOINT wf_res");
    } catch {
      await c.query("ROLLBACK TO SAVEPOINT wf_res").catch(() => undefined);
      missing.push(name);
    }
  };
  for (const d of res.docs)
    await safe(d.title || d.id, async () => {
      const doc = await getDoc(c, p, d.id);
      if (!canReadDoc(p, doc)) throw new Forbidden("no access");
      const v = await c.query<{ content: string; format: "markdown" | "html" }>("SELECT content, format FROM document_versions WHERE document_id = $1 AND version = $2", [
        doc.id,
        doc.current_version,
      ]);
      const text = v.rows[0] ? docText(v.rows[0].content, v.rows[0].format).trim() : "";
      if (text) parts.push({ head: `Page: ${doc.title || d.title}`, body: text });
    });
  for (const x of res.tasks)
    await safe(x.code || x.title || x.id, async () => {
      const t = await getTask(c, p, x.id);
      const comments = (await c.query<{ body: string }>("SELECT body FROM task_comments WHERE task_id = $1 ORDER BY created_at DESC LIMIT 5", [t.id])).rows;
      const body = [
        `Status: ${t.status}`,
        (t.description || "").trim(),
        comments.length ? `Latest comments:\n${comments.map((m) => `- ${m.body.replace(/\s+/g, " ").trim().slice(0, 1500)}`).join("\n")}` : "",
      ];
      parts.push({ head: `Task: ${t.code} · ${t.title}`, body: body.filter(Boolean).join("\n\n") });
    });
  const drive = await driveFiles(c, p, res.drive);
  missing.push(...drive.missing);
  const other: string[] = [];
  for (const f of [...(await workflowFiles(c, workflowId, res.files)), ...drive.files]) {
    const text = storage ? await fileText(storage, f) : null;
    if (text) parts.push({ head: `File: ${f.name}`, body: text });
    else other.push(`- ${f.name} (${kb(f.size)})`);
  }
  const unread: string[] = [];
  for (const l of res.links) {
    const r = await readLink(l.url);
    if (r.ok) parts.push({ head: `Link: ${l.title || l.url}${l.title ? ` (${l.url})` : ""}`, body: r.text });
    else unread.push(`- ${l.title ? `${l.title}: ` : ""}${l.url} (${PROBLEM_TEXT[r.problem]})`);
  }
  const lists = [
    other.length ? `## Files\n${onRunner ? "In the assets folder of this run:" : "Attached to this workflow (their content is not included here):"}\n${other.join("\n")}` : "",
    unread.length ? `## Links\nTheir content is not included here; open them if you have a tool for it:\n${unread.join("\n")}` : "",
    missing.length ? `## Not available\nThe person who started the run cannot open: ${missing.join(", ")}` : "",
  ];
  return composeResources(res.notes, parts, lists);
}

/**
 * Saving a workflow: the files it lists must be the editor's own uploads for it (attached to this workflow, or still
 * in their draft), so a workflow can never list someone else's file and have a run read it: any other id is dropped
 * from the list (a copy of a workflow starts without the original's files). Draft files move to the workflow; files it
 * no longer lists are removed. Returns the list as stored, with the server's own name and size.
 */
export async function adoptFiles(c: PoolClient, p: Principal, workflowId: string, listed: ResourceFile[]): Promise<ResourceFile[]> {
  const ids = listed.map((f) => f.id);
  const rows = ids.length
    ? (
        await c.query<{ id: string; name: string; size: string; content_type: string; attached_id: string }>(
          "SELECT id, name, size, content_type, attached_id FROM files WHERE id = ANY($1) AND attached_type = 'workflow' AND status = 'active' AND (attached_id = $2 OR attached_id = $3)",
          [ids, workflowId, `draft:${p.id}`],
        )
      ).rows
    : [];
  if (rows.some((r) => r.attached_id !== workflowId))
    await c.query("UPDATE files SET attached_id = $2 WHERE id = ANY($1) AND attached_type = 'workflow' AND attached_id = $3", [ids, workflowId, `draft:${p.id}`]);
  // Dropped from the list: gone from the workflow (the object itself is swept with other deleted files).
  await c.query("UPDATE files SET status = 'deleted' WHERE attached_type = 'workflow' AND attached_id = $1 AND status = 'active' AND NOT (id = ANY($2))", [workflowId, ids]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return [...new Set(ids)].flatMap((id) => {
    const r = byId.get(id);
    return r ? [{ id, name: r.name, size: Number(r.size), contentType: r.content_type }] : [];
  });
}
