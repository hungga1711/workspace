import type { Pool, PoolClient } from "pg";
import { authorize, newId, runWithContext, withTransaction, type Principal } from "@workspace/shared";
import { feedEvent, logger, page, type FeedSource, type KnowledgeAccess, type KnowledgeDoc, type ObjectStorage, type PassageType } from "@workspace/service-kit";
import { emit } from "./common.js";
import { canReadDoc, DOC_SELECT, docText, documentPayload, type DocRow } from "./documents.js";
import { canReadDriveItem } from "./drive.js";
import { canReadTask, TASK_COLS, type TaskRow } from "./tasks.js";
import { readableAs, textOf } from "./workflows/extract.js";

/**
 * What the workspace knows, as text for search and AI retrieval (ADR 0013 addendum). The search index keeps
 * passages of these texts (search/indexer.ts); this file is the one place that says what a thing's text is, where it
 * lives and who may read it:
 *
 *   task       its status, description and comments (people's, and what a workflow posted)
 *   document   the whole page
 *   meeting    when and where, the agenda, the minutes, its action items
 *   event      a calendar entry that is not a meeting: title, time, place
 *   file       the words of a Drive file or of an attachment (text, PDF, Word, Excel, PowerPoint), read in the background
 *   approval   a request: what was asked, its fields, the decision, the exchange about it
 *
 * `container_id` and `acl_users` are what the index filters on, so they are the cheap, slightly wide version of each
 * thing's own rule; whoever serves results rechecks the top hits with `readableKnowledge` below, which is the rule itself.
 */

export type KnowledgeRef = { type: PassageType; id: string };
/** How much of one thing is indexed (about 400 passages). */
const TEXT_MAX = 400_000;
const iso = (d: Date | string | null | undefined) => new Date(d ?? Date.now()).toISOString();
const latest = (...dates: (Date | string | null | undefined)[]) => iso(new Date(Math.max(...dates.filter(Boolean).map((d) => new Date(d!).getTime()))));

/** Tells search that a thing's text (or who may read it) changed; the indexer reads it back with `knowledgeDocs`. */
export async function knowledgeChanged(c: PoolClient, type: PassageType, id: string) {
  await emit(c, "work.knowledge.changed.v1", "work.knowledge", `${type}:${id}`, { type, id });
}

async function taskDoc(c: PoolClient, id: string): Promise<KnowledgeDoc | null> {
  const t = (await c.query<TaskRow>(`SELECT ${TASK_COLS} FROM tasks WHERE id = $1`, [id])).rows[0];
  if (!t) return null;
  const comments = (
    await c.query<{ body: string; agent: string | null; created_at: Date; edited_at: Date | null }>(
      "SELECT body, agent, created_at, edited_at FROM task_comments WHERE task_id = $1 ORDER BY created_at LIMIT 200",
      [id],
    )
  ).rows;
  const text = [
    `Status: ${t.status}${t.due_at ? ` · due ${iso(t.due_at).slice(0, 10)}` : ""}${t.blocked_reason ? ` · blocked: ${t.blocked_reason}` : ""}`,
    (t.description ?? "").trim(),
    comments.length ? `## Comments\n${comments.map((m) => `${m.agent ? `[${m.agent}] ` : ""}${m.body.trim()}`).join("\n\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    entity_type: "task",
    entity_id: t.id,
    // The same container and readers as the task's own search document (search/indexer.ts).
    container_id: t.project_id || `user:${t.owner_id}`,
    acl_users: [t.owner_id, t.assignee_id].filter((x): x is string => !!x),
    title: `${t.code} ${t.title}`,
    body: text.slice(0, TEXT_MAX),
    url: `/app/work/tasks/${t.id}`,
    updated_at: latest(t.updated_at, ...comments.map((m) => m.edited_at ?? m.created_at)),
  };
}

async function documentDoc(c: PoolClient, id: string): Promise<KnowledgeDoc | null> {
  const d = (await c.query<DocRow>(`${DOC_SELECT} WHERE d.id = $1`, [id])).rows[0];
  if (!d) return null;
  // Where it lives and who it is shared with, as the page's own events say it (drafts: the owner only).
  const p = await documentPayload(c, d);
  const v = (
    await c.query<{ content: string; format: "markdown" | "html" }>("SELECT content, format FROM document_versions WHERE document_id = $1 AND version = $2", [
      d.id,
      d.current_version,
    ])
  ).rows[0];
  // Markdown is kept as written (its headings name the passages); HTML pages are read as text.
  const text = v ? (v.format === "html" ? docText(v.content, "html") : v.content) : "";
  return {
    entity_type: "document",
    entity_id: d.id,
    container_id: p.projectId || `doc:${d.id}`,
    acl_users: p.sharedWith,
    title: d.title,
    body: text.slice(0, TEXT_MAX),
    url: `/app/work/docs/${d.id}`,
    updated_at: iso(d.updated_at),
  };
}

interface EventRow {
  id: string;
  code: string | null;
  title: string;
  kind: "meeting" | "deadline" | "event";
  starts_at: Date;
  ends_at: Date;
  organizer_id: string;
  location: string;
  agenda: string;
  notes: string;
  updated_at: Date;
}

async function calendarDoc(c: PoolClient, type: "meeting" | "event", id: string): Promise<KnowledgeDoc | null> {
  const e = (
    await c.query<EventRow>("SELECT id, code, title, kind, starts_at, ends_at, organizer_id, location, agenda, notes, updated_at FROM calendar_events WHERE id = $1", [id])
  ).rows[0];
  // A meeting is indexed as a meeting and anything else as an event: asked for as the other kind, it is not there.
  if (!e || (e.kind === "meeting") !== (type === "meeting")) return null;
  const attendees = (await c.query<{ user_id: string }>("SELECT user_id FROM event_attendees WHERE event_id = $1", [id])).rows.map((r) => r.user_id);
  const items =
    type === "meeting"
      ? (
          await c.query<{ code: string; title: string; status: string }>(
            "SELECT code, title, status FROM tasks WHERE source->>'type' = 'meeting' AND source->>'eventId' = $1 ORDER BY created_at LIMIT 50",
            [id],
          )
        ).rows
      : [];
  const text = [
    `When: ${iso(e.starts_at)} to ${iso(e.ends_at)}${e.location ? `\nWhere: ${e.location}` : ""}`,
    e.agenda.trim() ? `## Agenda\n${e.agenda.trim()}` : "",
    e.notes.trim() ? `## Minutes\n${e.notes.trim()}` : "",
    items.length ? `## Action items\n${items.map((t) => `- ${t.code} ${t.title} [${t.status}]`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    entity_type: type,
    entity_id: e.id,
    // Nobody is "in" a calendar entry's container: only the people invited read it.
    container_id: `event:${e.id}`,
    acl_users: [...new Set([e.organizer_id, ...attendees])],
    title: `${e.code ? `${e.code} ` : ""}${e.title}`,
    body: text.slice(0, TEXT_MAX),
    url: type === "meeting" ? `/app/work/meetings/${e.id}` : `/app/work/calendar?event=${e.id}`,
    updated_at: iso(e.updated_at),
  };
}

interface ApprovalRow {
  id: string;
  code: string | null;
  title: string;
  details: string;
  requester_id: string;
  approver_id: string;
  on_behalf_of: string | null;
  status: string;
  kind: string;
  fields: Record<string, unknown>;
  amount: string | null;
  currency: string | null;
  comment: string | null;
  decided_at: Date | null;
  created_at: Date;
}
const APPROVAL_COLS = "id, code, title, details, requester_id, approver_id, on_behalf_of, status, kind, fields, amount, currency, comment, decided_at, created_at";

/** The container of every request, readable by whoever may decide any of them (and, each request, by its people). */
export const APPROVALS_CONTAINER = "approvals";
export const decidesAllApprovals = (p: Principal) => p.grants.some((g) => g.permission === "approval.decide" && g.scope === "WORKSPACE") && authorize(p, "approval.decide").allowed;

async function approvalDoc(c: PoolClient, id: string): Promise<KnowledgeDoc | null> {
  const a = (await c.query<ApprovalRow>(`SELECT ${APPROVAL_COLS} FROM approvals WHERE id = $1`, [id])).rows[0];
  if (!a) return null;
  const events = (
    await c.query<{ body: string | null; created_at: Date }>(
      "SELECT body, created_at FROM approval_events WHERE approval_id = $1 AND kind = 'comment' ORDER BY created_at LIMIT 100",
      [id],
    )
  ).rows;
  const fields = Object.entries(a.fields ?? {})
    .filter(([, v]) => v !== null && v !== "")
    .map(([k, v]) => `- ${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  const text = [
    `Request (${a.kind}) · ${a.status}${a.amount ? ` · ${a.amount} ${a.currency ?? ""}`.trimEnd() : ""}`,
    a.details.trim(),
    fields.length ? fields.join("\n") : "",
    a.comment?.trim() ? `## Decision\n${a.comment.trim()}` : "",
    events.some((x) => x.body?.trim())
      ? `## Discussion\n${events
          .map((x) => x.body?.trim())
          .filter(Boolean)
          .join("\n\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    entity_type: "approval",
    entity_id: a.id,
    // Everyone who decides requests for the whole company reads them all: one container they are in (search-scope).
    container_id: APPROVALS_CONTAINER,
    acl_users: [...new Set([a.requester_id, a.approver_id, a.on_behalf_of].filter((x): x is string => !!x))],
    title: `${a.code ? `${a.code} ` : ""}${a.title}`,
    body: text.slice(0, TEXT_MAX),
    url: `/app/work/approvals/${a.id}`,
    updated_at: latest(a.created_at, a.decided_at, ...events.map((x) => x.created_at)),
  };
}

interface FileRow {
  id: string;
  name: string;
  status: string;
  attached_type: string | null;
  attached_id: string | null;
  text: string | null;
  text_at: Date | null;
}

/**
 * A file's words, once the background reader has them (file_texts). Where it lives follows what it is attached to: a
 * Drive file by its own sharing and its folders', an attachment by its task or page.
 */
async function fileDoc(c: PoolClient, id: string): Promise<KnowledgeDoc | null> {
  const f = (
    await c.query<FileRow>(
      `SELECT f.id, f.name, f.status, f.attached_type, f.attached_id, x.text, x.updated_at AS text_at
         FROM files f LEFT JOIN file_texts x ON x.file_id = f.id AND x.status = 'done' WHERE f.id = $1`,
      [id],
    )
  ).rows[0];
  if (!f || f.status !== "active" || !f.text?.trim() || !f.attached_id) return null;
  let where: { container_id: string; acl_users: string[] } | null = null;
  if (f.attached_type === "drive") {
    const chain = (
      await c.query<{ owner_id: string; shared_with: string[]; editors: string[]; visibility: string; trashed_at: Date | null; depth: number }>(
        `WITH RECURSIVE up AS (SELECT *, 0 AS depth FROM drive_items WHERE id = $1
           UNION ALL SELECT d.*, up.depth + 1 FROM drive_items d JOIN up ON d.id = up.parent_id WHERE up.depth < 30)
         SELECT owner_id, shared_with, editors, visibility, trashed_at, depth FROM up ORDER BY depth`,
        [f.attached_id],
      )
    ).rows;
    if (!chain.length || chain.some((r) => r.trashed_at)) return null;
    where = {
      // Shared with the workspace (itself or a folder above it): everyone who reads workspace pages finds it.
      container_id: chain.some((r) => r.visibility === "workspace") ? "workspace" : `file:${f.id}`,
      acl_users: [...new Set(chain.flatMap((r) => [r.owner_id, ...r.shared_with, ...r.editors]))],
    };
  } else if (f.attached_type === "task") {
    const t = await taskDoc(c, f.attached_id);
    if (t) where = { container_id: t.container_id, acl_users: t.acl_users };
  } else if (f.attached_type === "document") {
    const d = await documentDoc(c, f.attached_id);
    if (d) where = { container_id: d.container_id, acl_users: d.acl_users };
  }
  if (!where) return null;
  return { entity_type: "file", entity_id: f.id, ...where, title: f.name, body: f.text.slice(0, TEXT_MAX), url: `/app/files/${f.id}`, updated_at: iso(f.text_at) };
}

const BUILD: Record<PassageType, (c: PoolClient, id: string) => Promise<KnowledgeDoc | null>> = {
  task: taskDoc,
  document: documentDoc,
  meeting: (c, id) => calendarDoc(c, "meeting", id),
  event: (c, id) => calendarDoc(c, "event", id),
  approval: approvalDoc,
  file: fileDoc,
};

/**
 * The current text of each thing asked for, and which of them are gone (deleted, trashed, not readable as text).
 * `access`: a task's or a page's attached files live where it lives, so when it is read again (a new assignee, a page
 * shared with someone) its files' readers are given too; their text is not sent or indexed again.
 */
export async function knowledgeDocs(c: PoolClient, items: KnowledgeRef[]): Promise<{ docs: KnowledgeDoc[]; gone: KnowledgeRef[]; access: KnowledgeAccess[] }> {
  const docs: KnowledgeDoc[] = [];
  const gone: KnowledgeRef[] = [];
  const access: KnowledgeAccess[] = [];
  for (const ref of items) {
    const doc = await BUILD[ref.type]?.(c, ref.id);
    if (doc) docs.push(doc);
    else gone.push(ref);
    if (doc && (ref.type === "task" || ref.type === "document")) {
      const files = await c.query<{ id: string }>(
        `SELECT f.id FROM files f JOIN file_texts x ON x.file_id = f.id AND x.status = 'done'
          WHERE f.attached_type = $1 AND f.attached_id = $2 AND f.status = 'active' LIMIT 200`,
        [ref.type, ref.id],
      );
      for (const f of files.rows) access.push({ entity_type: "file", entity_id: f.id, container_id: doc.container_id, acl_users: doc.acl_users });
    }
  }
  return { docs, gone, access };
}

/**
 * Which of these the caller may read right now, by each thing's own rule (the index's containers and ACLs are a
 * wider, older picture). Tasks and pages are rechecked by the search controller with the rest of its kinds.
 */
export async function readableKnowledge(c: PoolClient, p: Principal, b: { meetings: string[]; events: string[]; approvals: string[]; files: string[] }) {
  const calendar = [...b.meetings, ...b.events];
  const invited = calendar.length
    ? new Set(
        (
          await c.query<{ id: string }>(
            `SELECT e.id FROM calendar_events e WHERE e.id = ANY($1) AND (e.organizer_id = $2 OR EXISTS (SELECT 1 FROM event_attendees a WHERE a.event_id = e.id AND a.user_id = $2))`,
            [calendar, p.id],
          )
        ).rows.map((r) => r.id),
      )
    : new Set<string>();
  const decidesAll = decidesAllApprovals(p);
  const approvals = b.approvals.length
    ? (
        await c.query<{ id: string; requester_id: string; approver_id: string; on_behalf_of: string | null }>(
          "SELECT id, requester_id, approver_id, on_behalf_of FROM approvals WHERE id = ANY($1)",
          [b.approvals],
        )
      ).rows
        .filter((a) => decidesAll || a.requester_id === p.id || a.approver_id === p.id || a.on_behalf_of === p.id)
        .map((a) => a.id)
    : [];
  const files: string[] = [];
  if (b.files.length) {
    const rows = (
      await c.query<{ id: string; attached_type: string | null; attached_id: string | null }>(
        "SELECT id, attached_type, attached_id FROM files WHERE id = ANY($1) AND status = 'active'",
        [b.files],
      )
    ).rows;
    for (const f of rows) {
      if (!f.attached_id) continue;
      let ok = false;
      if (f.attached_type === "drive") ok = authorize(p, "file.read").allowed && (await canReadDriveItem(c, p, f.attached_id));
      else if (f.attached_type === "task") {
        const t = (await c.query<TaskRow>(`SELECT ${TASK_COLS} FROM tasks WHERE id = $1`, [f.attached_id])).rows[0];
        ok = !!t && canReadTask(p, t);
      } else if (f.attached_type === "document") {
        const d = (await c.query<DocRow>(`${DOC_SELECT} WHERE d.id = $1`, [f.attached_id])).rows[0];
        ok = !!d && canReadDoc(p, d);
      }
      if (ok) files.push(f.id);
    }
  }
  return { meetings: b.meetings.filter((id) => invited.has(id)), events: b.events.filter((id) => invited.has(id)), approvals, files };
}

// ── The re-index feed ────────────────────────────────────────────────────────────────────────────────

/** One page of a table's ids, each written as the event that carries its whole text (search/reindex.ts). */
const feed =
  (type: PassageType, sql: string): FeedSource =>
  async (c, after, limit) => {
    // Texts are large: a page of the feed is at most 50 things, whatever was asked for.
    const n = Math.min(limit, 50);
    const ids = (await c.query<{ id: string }>(sql, [after, n])).rows.map((r) => r.id);
    const events = [];
    for (const id of ids) {
      const doc = await BUILD[type](c, id);
      if (!doc) continue;
      events.push(
        feedEvent("work.knowledge.changed.v1", "work.knowledge", `${type}:${id}`, doc.updated_at, {
          type,
          id,
          doc: { containerId: doc.container_id, aclUsers: doc.acl_users, title: doc.title, text: doc.body, url: doc.url, updatedAt: doc.updated_at },
        }),
      );
    }
    // The cursor follows the ids read, not the events made: a page of things without text must not end the feed.
    return ids.length >= n ? { events, next: ids.at(-1)! } : page(events, ids.at(-1), n + 1);
  };

export const KNOWLEDGE_FEEDS: Record<string, FeedSource> = {
  "knowledge-tasks": feed("task", "SELECT id FROM tasks WHERE id > $1 ORDER BY id LIMIT $2"),
  "knowledge-documents": feed("document", "SELECT id FROM documents WHERE id > $1 ORDER BY id LIMIT $2"),
  "knowledge-meetings": feed("meeting", "SELECT id FROM calendar_events WHERE kind = 'meeting' AND id > $1 ORDER BY id LIMIT $2"),
  "knowledge-events": feed("event", "SELECT id FROM calendar_events WHERE kind <> 'meeting' AND id > $1 ORDER BY id LIMIT $2"),
  "knowledge-approvals": feed("approval", "SELECT id FROM approvals WHERE id > $1 ORDER BY id LIMIT $2"),
  "knowledge-files": feed("file", "SELECT file_id AS id FROM file_texts WHERE status = 'done' AND file_id > $1 ORDER BY file_id LIMIT $2"),
};

// ── Reading files in the background ──────────────────────────────────────────────────────────────────

/** Files read per run of the job: reading a PDF or a workbook takes a moment, and nobody waits for it. */
const FILES_PER_RUN = 5;
/** A file that cannot be fetched (storage away) is tried again a few times, then left. */
const MAX_ATTEMPTS = 3;

/**
 * Reads the text of files nobody has read yet (Drive files and attachments of tasks and pages): a few per run,
 * newest first. A file with words gets passages in the search index; one without (an image, a video, a damaged file)
 * is marked so it is not tried again. Never in a request: uploads stay as fast as they were.
 */
export async function readFileTexts(pool: Pool, storage: ObjectStorage, limit = FILES_PER_RUN): Promise<number> {
  const c = await pool.connect();
  let read = 0;
  try {
    const rows = (
      await c.query<{ id: string; object_key: string; name: string; content_type: string; size: string }>(
        `SELECT f.id, f.object_key, f.name, f.content_type, f.size FROM files f
           LEFT JOIN file_texts x ON x.file_id = f.id
          WHERE f.status = 'active' AND f.attached_type IN ('drive', 'task', 'document')
            AND (x.file_id IS NULL OR (x.status = 'failed' AND x.attempts < $2 AND x.updated_at < now() - interval '10 minutes'))
          ORDER BY f.created_at DESC LIMIT $1`,
        [limit, MAX_ATTEMPTS],
      )
    ).rows;
    for (const f of rows) {
      const size = Number(f.size);
      let status: "done" | "none" | "failed" = "none";
      let text = "";
      if (readableAs(f.name, f.content_type, size)) {
        try {
          const r = await fetch(await storage.presignGet(f.object_key, 60, f.name), { signal: AbortSignal.timeout(30_000) });
          if (!r.ok) throw new Error(`storage answered ${r.status}`);
          text = ((await textOf(Buffer.from(await r.arrayBuffer()), f.name, f.content_type)) ?? "").slice(0, TEXT_MAX);
          status = text.trim() ? "done" : "none";
        } catch (err) {
          status = "failed";
          logger.warn({ err, fileId: f.id }, "could not read a file's text; will retry");
        }
      }
      try {
        // A job has no request behind it: the event it writes is the job's own.
        await runWithContext({ actorId: "service:file-texts", requestId: newId() }, () =>
          withTransaction(pool, async (t) => {
            await t.query(
              `INSERT INTO file_texts (file_id, status, text, chars, attempts) VALUES ($1, $2, $3, $4, 1)
               ON CONFLICT (file_id) DO UPDATE SET status = EXCLUDED.status, text = EXCLUDED.text, chars = EXCLUDED.chars, attempts = file_texts.attempts + 1, updated_at = now()`,
              [f.id, status, status === "done" ? text : null, text.length],
            );
            if (status === "done") await knowledgeChanged(t, "file", f.id);
          }),
        );
        read++;
      } catch (err) {
        logger.warn({ err, fileId: f.id }, "could not keep a file's text");
      }
    }
  } finally {
    c.release();
  }
  return read;
}
