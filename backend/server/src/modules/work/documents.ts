import type { PoolClient } from "pg";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import { newId, type Principal } from "@workspace/shared";
import { nextCode } from "./codes.js";
import { activity, allowedAny, emit, requireAny } from "./common.js";
import { Conflict, Forbidden, Invalid, NotFound } from "./errors.js";

export interface DocRow {
  id: string;
  code: string;
  title: string;
  owner_id: string;
  project_id: string | null;
  visibility: "private" | "project" | "workspace" | "space";
  shared_with: string[];
  current_version: number;
  updated_at: Date;
  space_id: string | null;
  parent_id: string | null;
  position: number;
  labels: string[];
  emoji: string;
  format: "markdown" | "html";
  last_editor_id: string | null;
  /** False while a new page has never been published: only its owner can read it, and its title may be empty. */
  published: boolean;
  /** Joined from the page's space, when it has one. */
  space_visibility: "workspace" | "restricted" | null;
  space_members: string[] | null;
  space_owner: string | null;
}

export type Format = DocRow["format"];

const COLS = `d.id, d.code, d.title, d.owner_id, d.project_id, d.visibility, d.shared_with, d.current_version, d.updated_at,
  d.space_id, d.parent_id, d.position, d.labels, d.emoji, d.format, d.last_editor_id, d.published,
  s.visibility AS space_visibility, s.members AS space_members, s.created_by AS space_owner`;
export const DOC_SELECT = `SELECT ${COLS} FROM documents d LEFT JOIN spaces s ON s.id = d.space_id`;

/** Whoever can read the space: everyone for a workspace space, its members for a restricted one. */
export function canReadSpace(p: Principal, s: { visibility: string; members: string[]; created_by: string }): boolean {
  if (s.visibility === "workspace") return allowedAny(p, "document.read", [{}]);
  return s.created_by === p.id || s.members.includes(p.id) || allowedAny(p, "document.edit", [{}]);
}

function spaceOf(d: DocRow) {
  return d.space_id && d.space_visibility ? { visibility: d.space_visibility, members: d.space_members ?? [], created_by: d.space_owner ?? "" } : null;
}

export function canReadDoc(p: Principal, d: DocRow): boolean {
  if (d.owner_id === p.id) return true;
  if (d.published === false) return false;
  if (d.shared_with.includes(p.id)) return true;
  if (d.visibility === "space") {
    const s = spaceOf(d);
    return !!s && canReadSpace(p, s);
  }
  if (d.visibility !== "private") return allowedAny(p, "document.read", [{ ownerId: d.owner_id }]);
  return false;
}

/** Space pages are edited by anyone who can read the space and create pages. */
export function canEditDoc(p: Principal, d: DocRow): boolean {
  if (d.published === false) return d.owner_id === p.id;
  if (d.owner_id === p.id || d.shared_with.includes(p.id) || allowedAny(p, "document.edit", [{ ownerId: d.owner_id }])) return true;
  return d.visibility === "space" && canReadDoc(p, d) && allowedAny(p, "document.create", [{}]);
}

/**
 * Drops NUL characters from every string in a request body. Postgres text cannot hold U+0000, so one stray NUL (an
 * editor plug-in once put one before every @mention) turned each save into a 500 and the page could not be kept.
 */
export function noNul<T>(v: T): T {
  if (typeof v === "string") return v.replaceAll(String.fromCharCode(0), "") as T;
  if (Array.isArray(v)) return v.map(noNul) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, noNul(x)])) as T;
  return v;
}

export async function getDoc(c: PoolClient, p: Principal, id: string): Promise<DocRow> {
  const r = await c.query<DocRow>(`${DOC_SELECT} WHERE d.id = $1`, [id]);
  const d = r.rows[0];
  // Same response for missing and unreadable: do not reveal existence.
  if (!d || !canReadDoc(p, d)) throw new NotFound("document not found");
  return d;
}

// ---- rich text ----

/** What the editor produces, and nothing else: no scripts, styles, event handlers or foreign protocols. */
export function sanitizeDoc(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      "p",
      "br",
      "hr",
      "h1",
      "h2",
      "h3",
      "h4",
      "strong",
      "b",
      "em",
      "i",
      "u",
      "s",
      "del",
      "mark",
      "code",
      "pre",
      "blockquote",
      "ul",
      "ol",
      "li",
      "a",
      "img",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "colgroup",
      "col",
      "div",
      "span",
      "label",
      "input",
    ],
    allowedAttributes: {
      a: ["href", "target", "rel"],
      img: ["src", "alt", "title", "data-file-id"],
      th: ["colspan", "rowspan", "colwidth"],
      td: ["colspan", "rowspan", "colwidth"],
      col: ["style"],
      ul: ["data-type"],
      li: ["data-type", "data-checked"],
      div: ["data-callout", "data-toggle", "data-toc"],
      span: ["data-type", "data-id", "data-label", "data-page"],
      input: ["type", "checked", "disabled"],
      ol: ["start"],
      pre: ["data-language"],
      code: ["class"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: ["https", "http"] },
    allowProtocolRelative: false,
    // Images come from our own file route or https; links open safely.
    transformTags: { a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer" }) },
    allowedStyles: { col: { width: [/^\d+px$/] } },
  });
}

/** The page as HTML a browser can show directly: Markdown (older pages) converted, everything cleaned. */
export function readableHtml(content: string, format: Format): string {
  return sanitizeDoc(format === "html" ? content : (marked.parse(content, { async: false, gfm: true }) as string));
}

/** Plain text of a page, for search, AI and previews. */
export function docText(content: string, format: Format): string {
  if (format !== "html") return content;
  const blocks = content.replace(/<\/(p|h[1-6]|li|tr|div|blockquote|pre)>/gi, "$&\n").replace(/<br\s*\/?>/gi, "\n");
  return sanitizeHtml(blocks, { allowedTags: [], allowedAttributes: {} })
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function payload(d: DocRow, content: string, format: Format) {
  const draft = d.published === false;
  const restricted = d.visibility === "space" && d.space_visibility === "restricted";
  const open = d.visibility !== "private" && !restricted && !draft;
  return {
    documentId: d.id,
    code: d.code,
    title: d.title,
    ownerId: d.owner_id,
    spaceId: d.space_id,
    projectId: open ? (d.project_id ?? "workspace") : null,
    sharedWith: draft ? [d.owner_id] : [...new Set([d.owner_id, ...d.shared_with, ...(restricted ? [d.space_owner ?? "", ...(d.space_members ?? [])].filter(Boolean) : [])])],
    text: docText(content, format).slice(0, 20000),
    version: d.current_version,
  };
}

async function currentContent(c: PoolClient, d: DocRow): Promise<{ content: string; format: Format }> {
  const r = await c.query<{ content: string; format: Format }>("SELECT content, format FROM document_versions WHERE document_id = $1 AND version = $2", [d.id, d.current_version]);
  return r.rows[0] ?? { content: "", format: d.format };
}

export interface CreateDocInput {
  title: string;
  content: string;
  projectId: string | null;
  visibility?: DocRow["visibility"] | undefined;
  spaceId?: string | null | undefined;
  parentId?: string | null | undefined;
  format?: Format | undefined;
  labels?: string[] | undefined;
  emoji?: string | undefined;
  /** A page opened for writing at once: owner-only and untitled allowed until the first publish. */
  draft?: boolean | undefined;
}

export async function createDoc(c: PoolClient, p: Principal, input: CreateDocInput) {
  requireAny(p, "document.create", [{}]);
  const draft = !!input.draft;
  const title = input.title.trim();
  if (!title && !draft) throw new Invalid("a page needs a title");
  let spaceId = input.spaceId ?? null;
  let parentId = input.parentId ?? null;
  if (parentId) {
    // A child page lives in its parent's space.
    const parent = await getDoc(c, p, parentId);
    spaceId = parent.space_id;
    if (!spaceId) throw new Invalid("pages can be nested inside a space only");
  }
  if (spaceId) {
    const s = (
      await c.query<{ visibility: string; members: string[]; created_by: string; archived: boolean }>(
        "SELECT visibility, members, created_by, archived FROM spaces WHERE id = $1",
        [spaceId],
      )
    ).rows[0];
    if (!s || !canReadSpace(p, s)) throw new NotFound("space not found");
    if (s.archived) throw new Invalid("this space is archived");
  } else parentId = null;
  const format: Format = input.format ?? "markdown";
  const content = format === "html" ? sanitizeDoc(input.content) : input.content;
  const id = newId();
  const code = await nextCode(c, "document", id);
  const position = (
    await c.query<{ n: number }>("SELECT coalesce(max(position), 0) + 1 AS n FROM documents WHERE space_id IS NOT DISTINCT FROM $1 AND parent_id IS NOT DISTINCT FROM $2", [
      spaceId,
      parentId,
    ])
  ).rows[0]!.n;
  await c.query(
    `INSERT INTO documents (id, code, title, owner_id, project_id, visibility, space_id, parent_id, position, labels, emoji, format, last_editor_id, published)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$4,$13)`,
    [
      id,
      code,
      title,
      p.id,
      input.projectId,
      spaceId ? (input.visibility === "private" ? "private" : "space") : input.visibility === "space" || !input.visibility ? "private" : input.visibility,
      spaceId,
      parentId,
      position,
      normLabels(input.labels ?? []),
      input.emoji ?? "",
      format,
      !draft,
    ],
  );
  await c.query("INSERT INTO document_versions (document_id, version, content, author_id, format) VALUES ($1,1,$2,$3,$4)", [id, content, p.id, format]);
  const d = await getDoc(c, p, id);
  await activity(c, "document", id, "created", { title });
  await c.query("INSERT INTO doc_watchers (document_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [id, p.id]);
  await emit(c, "work.document.created.v1", "work.document", id, payload(d, content, format));
  return d;
}

/** Saves a new version; baseVersion must match the current one (no silent overwrite). */
export async function saveDoc(c: PoolClient, p: Principal, id: string, input: { title?: string | undefined; content: string; baseVersion: number; format?: Format | undefined }) {
  const d = await getDoc(c, p, id);
  if (!canEditDoc(p, d)) throw new Forbidden("cannot edit this document");
  const format: Format = input.format ?? d.format;
  const content = format === "html" ? sanitizeDoc(input.content) : input.content;
  const next = d.current_version + 1;
  const title = (input.title ?? d.title).trim();
  if (!title) throw new Invalid("a page needs a title");
  // Saving is publishing: a draft becomes a normal page that everyone with access can find.
  const u = await c.query(
    "UPDATE documents SET current_version = $3, title = $4, format = $5, last_editor_id = $6, published = true, updated_at = now() WHERE id = $1 AND current_version = $2",
    [id, input.baseVersion, next, title, format, p.id],
  );
  if (!u.rowCount) throw new Conflict("document changed since you opened it", { currentVersion: d.current_version });
  await c.query("INSERT INTO document_versions (document_id, version, content, author_id, format) VALUES ($1,$2,$3,$4,$5)", [id, next, content, p.id, format]);
  const nd = await getDoc(c, p, id);
  await activity(c, "document", id, "edited", { version: next });
  // Editing a page watches it; watchers who can still read it are told about the change.
  await c.query("INSERT INTO doc_watchers (document_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [id, p.id]);
  const watchers = (await c.query<{ user_id: string }>("SELECT user_id FROM doc_watchers WHERE document_id = $1", [id])).rows.map((x) => x.user_id);
  await emit(c, "work.document.updated.v1", "work.document", id, { ...payload(nd, content, format), editorId: p.id, watchers: watchers.filter((u) => u !== p.id) });
  return nd;
}

export async function shareDoc(c: PoolClient, p: Principal, id: string, userIds: string[], visibility: DocRow["visibility"] | undefined) {
  const d = await getDoc(c, p, id);
  if (d.owner_id !== p.id) requireAny(p, "document.share", [{ ownerId: d.owner_id }]);
  if (visibility === "space" && !d.space_id) throw new Invalid("this page is not in a space");
  await c.query("UPDATE documents SET shared_with = $2, visibility = $3, updated_at = now() WHERE id = $1", [id, [...new Set(userIds)], visibility ?? d.visibility]);
  const nd = await getDoc(c, p, id);
  const cur = await currentContent(c, nd);
  await activity(c, "document", id, "permissions_changed", { sharedWith: nd.shared_with, visibility: nd.visibility });
  await emit(c, "work.document.updated.v1", "work.document", id, payload(nd, cur.content, cur.format));
  return nd;
}

/** Version history: who saved each version and when, newest first. Anyone who can read the document. */
export async function listVersions(c: PoolClient, p: Principal, id: string) {
  await getDoc(c, p, id);
  return (
    await c.query<{ version: number; authorId: string; createdAt: Date; length: number; format: Format }>(
      `SELECT version, author_id AS "authorId", created_at AS "createdAt", length(content) AS length, format FROM document_versions WHERE document_id = $1 ORDER BY version DESC LIMIT 200`,
      [id],
    )
  ).rows;
}

/** Restoring writes the old content as a new version, so nothing in between is lost. */
export async function restoreVersion(c: PoolClient, p: Principal, id: string, version: number, baseVersion: number) {
  const old = (await c.query<{ content: string; format: Format }>("SELECT content, format FROM document_versions WHERE document_id = $1 AND version = $2", [id, version])).rows[0];
  if (!old) throw new NotFound("version not found");
  const d = await saveDoc(c, p, id, { content: old.content, baseVersion, format: old.format });
  await activity(c, "document", id, "restored", { from: version, version: d.current_version });
  return d;
}

// ---- page properties, tree moves, deletion ----

function normLabels(labels: string[]): string[] {
  return [...new Set(labels.map((l) => l.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 40)).filter(Boolean))].slice(0, 20);
}

/** Labels, emoji and title change without a new version (page properties). */
export async function updateDocMeta(c: PoolClient, p: Principal, id: string, input: { labels?: string[] | undefined; emoji?: string | undefined; title?: string | undefined }) {
  const d = await getDoc(c, p, id);
  if (!canEditDoc(p, d)) throw new Forbidden("cannot edit this document");
  await c.query("UPDATE documents SET labels = coalesce($2, labels), emoji = coalesce($3, emoji), title = coalesce($4, title), updated_at = now() WHERE id = $1", [
    id,
    input.labels ? normLabels(input.labels) : null,
    input.emoji ?? null,
    input.title ?? null,
  ]);
  const nd = await getDoc(c, p, id);
  if (input.title && input.title !== d.title) {
    const cur = await currentContent(c, nd);
    await emit(c, "work.document.updated.v1", "work.document", id, payload(nd, cur.content, cur.format));
  }
  return nd;
}

/** Moves a page under another one (or to the top of its space) and before a sibling, or to the end. */
export async function moveDoc(c: PoolClient, p: Principal, id: string, input: { parentId: string | null; beforeId?: string | null | undefined }) {
  const d = await getDoc(c, p, id);
  if (!canEditDoc(p, d)) throw new Forbidden("cannot edit this document");
  if (!d.space_id) throw new Invalid("only pages in a space can be moved in its tree");
  if (input.parentId) {
    const parent = await getDoc(c, p, input.parentId);
    if (parent.space_id !== d.space_id) throw new Invalid("the new parent is in another space");
    // No cycles: the new parent cannot be the page itself or one of its descendants.
    const desc = await c.query<{ id: string }>(
      `WITH RECURSIVE t AS (SELECT id FROM documents WHERE id = $1 UNION ALL SELECT x.id FROM documents x JOIN t ON x.parent_id = t.id) SELECT id FROM t WHERE id = $2`,
      [id, input.parentId],
    );
    if (desc.rows.length) throw new Invalid("a page cannot move under itself");
  }
  const siblings = (
    await c.query<{ id: string; position: number }>("SELECT id, position FROM documents WHERE space_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND id <> $3 ORDER BY position", [
      d.space_id,
      input.parentId,
      id,
    ])
  ).rows;
  const at = input.beforeId ? siblings.findIndex((s) => s.id === input.beforeId) : -1;
  const position = at < 0 ? (siblings.at(-1)?.position ?? 0) + 1 : at === 0 ? siblings[0]!.position - 1 : (siblings[at - 1]!.position + siblings[at]!.position) / 2;
  await c.query("UPDATE documents SET parent_id = $2, position = $3 WHERE id = $1", [id, input.parentId, position]);
  await activity(c, "document", id, "moved", { parentId: input.parentId });
  return getDoc(c, p, id);
}

/** Deleting a page keeps its children: they move up to its parent. */
export async function deleteDoc(c: PoolClient, p: Principal, id: string) {
  const d = await getDoc(c, p, id);
  if (d.owner_id !== p.id) requireAny(p, "document.edit", [{ ownerId: d.owner_id }]);
  const home = (await c.query<{ id: string }>("SELECT id FROM spaces WHERE home_id = $1", [id])).rows[0];
  if (home) throw new Invalid("the space home page cannot be deleted");
  await c.query("UPDATE documents SET parent_id = $2 WHERE parent_id = $1", [id, d.parent_id]);
  await c.query("DELETE FROM doc_comments WHERE document_id = $1", [id]);
  await c.query("DELETE FROM doc_stars WHERE document_id = $1", [id]);
  await c.query("DELETE FROM doc_watchers WHERE document_id = $1", [id]);
  await c.query("DELETE FROM doc_views WHERE document_id = $1", [id]);
  await c.query("DELETE FROM documents WHERE id = $1", [id]);
  await emit(c, "work.document.deleted.v1", "work.document", id, { documentId: id });
  return { deleted: true };
}

export { currentContent };

/** A page as its events describe it (text of the current version, who may read it). */
export async function documentPayload(c: PoolClient, d: DocRow) {
  const cur = await currentContent(c, d);
  return payload(d, cur.content, cur.format);
}

/** Tells search (and anything else listening) about a page again, e.g. after its space's readers changed. */
export async function announce(c: PoolClient, d: DocRow) {
  await emit(c, "work.document.updated.v1", "work.document", d.id, await documentPayload(c, d));
}
