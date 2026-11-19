import type { PoolClient } from "pg";
import { newId, type Principal } from "@workspace/shared";
import { activity, allowedAny, emit, requireAny } from "./common.js";
import { announce, canEditDoc, canReadDoc, canReadSpace, createDoc, DOC_SELECT, getDoc, type DocRow } from "./documents.js";
import { Conflict, Forbidden, Invalid, NotFound } from "./errors.js";

/**
 * Spaces: a space is a team's or project's area with a
 * home page and a tree of pages. Workspace spaces are open to every member; restricted ones to a list.
 */
export interface SpaceRow {
  id: string;
  key: string;
  name: string;
  description: string;
  icon: string;
  visibility: "workspace" | "restricted";
  members: string[];
  home_id: string | null;
  created_by: string;
  archived: boolean;
  created_at: Date;
}

const spaceDto = (s: SpaceRow, pages?: number) => ({
  id: s.id,
  key: s.key,
  name: s.name,
  description: s.description,
  icon: s.icon,
  visibility: s.visibility,
  members: s.members,
  homeId: s.home_id,
  createdBy: s.created_by,
  archived: s.archived,
  createdAt: s.created_at,
  ...(pages === undefined ? {} : { pages }),
});

const pageDto = (d: DocRow) => ({
  id: d.id,
  code: d.code,
  title: d.title,
  emoji: d.emoji,
  parentId: d.parent_id,
  spaceId: d.space_id,
  position: d.position,
  labels: d.labels,
  ownerId: d.owner_id,
  lastEditorId: d.last_editor_id ?? d.owner_id,
  updatedAt: d.updated_at,
  version: d.current_version,
  draft: d.published === false,
  visibility: d.visibility,
});

function canManageSpace(p: Principal, s: SpaceRow) {
  return s.created_by === p.id || allowedAny(p, "document.edit", [{}]);
}

export async function listSpaces(c: PoolClient, p: Principal) {
  const rows = (
    await c.query<SpaceRow & { pages: number }>(`SELECT s.*, (SELECT count(*)::int FROM documents d WHERE d.space_id = s.id) AS pages FROM spaces s ORDER BY s.archived, s.name`)
  ).rows;
  return rows.filter((s) => canReadSpace(p, s)).map((s) => ({ ...spaceDto(s, s.pages), canManage: canManageSpace(p, s) }));
}

async function spaceByKeyOrId(c: PoolClient, p: Principal, keyOrId: string): Promise<SpaceRow> {
  const s = (await c.query<SpaceRow>("SELECT * FROM spaces WHERE key = upper($1) OR id = $1", [keyOrId])).rows[0];
  if (!s || !canReadSpace(p, s)) throw new NotFound("space not found");
  return s;
}

const HOME_TEXT = {
  vi: {
    intro: "Trang chủ của không gian. Giới thiệu mục đích, người phụ trách và các trang quan trọng.",
    start: "Bắt đầu: bấm <strong>+</strong> cạnh tên không gian để thêm trang, hoặc gõ <code>/</code> trong trang để chèn bảng, danh sách việc, ghi chú.",
    pages: "Trang quan trọng",
    owners: "Người phụ trách",
  },
  en: {
    intro: "The space's home page: what it is for, who looks after it and the pages that matter.",
    start: "To start: press <strong>+</strong> next to the space name to add a page, or type <code>/</code> in a page to insert a table, a task list or a note.",
    pages: "Key pages",
    owners: "Owners",
  },
} as const;
const HOME = (name: string, description: string, locale: "vi" | "en" = "vi") => {
  const t = HOME_TEXT[locale];
  return `<p>${esc(description || t.intro)}</p>` + `<div data-callout="info"><p>${t.start}</p></div>` + `<h2>${t.pages}</h2><ul><li><p>…</p></li></ul><h2>${t.owners}</h2><p>…</p>`;
};
const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);

export async function createSpace(
  c: PoolClient,
  p: Principal,
  input: { key: string; name: string; description: string; icon: string; visibility: SpaceRow["visibility"]; members: string[] },
  locale: "vi" | "en" = "vi",
) {
  requireAny(p, "document.create", [{}]);
  const key = input.key.toUpperCase();
  if ((await c.query("SELECT 1 FROM spaces WHERE key = $1", [key])).rowCount) throw new Conflict("this space key is taken", { key });
  const id = newId();
  await c.query("INSERT INTO spaces (id, key, name, description, icon, visibility, members, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [
    id,
    key,
    input.name,
    input.description,
    input.icon,
    input.visibility,
    [...new Set(input.members)],
    p.id,
  ]);
  const home = await createDoc(c, p, {
    title: input.name,
    content: HOME(input.name, input.description, locale),
    projectId: null,
    visibility: "space",
    spaceId: id,
    format: "html",
    emoji: input.icon,
  });
  await c.query("UPDATE spaces SET home_id = $2 WHERE id = $1", [id, home.id]);
  await activity(c, "space", id, "created", { key, name: input.name });
  return spaceDto((await c.query<SpaceRow>("SELECT * FROM spaces WHERE id = $1", [id])).rows[0]!, 1);
}

export async function updateSpace(
  c: PoolClient,
  p: Principal,
  keyOrId: string,
  input: {
    name?: string | undefined;
    description?: string | undefined;
    icon?: string | undefined;
    visibility?: SpaceRow["visibility"] | undefined;
    members?: string[] | undefined;
    archived?: boolean | undefined;
  },
) {
  const s = await spaceByKeyOrId(c, p, keyOrId);
  if (!canManageSpace(p, s)) throw new Forbidden("only the space owner or an admin can change it");
  await c.query(
    `UPDATE spaces SET name = coalesce($2, name), description = coalesce($3, description), icon = coalesce($4, icon), visibility = coalesce($5, visibility),
       members = coalesce($6, members), archived = coalesce($7, archived) WHERE id = $1`,
    [s.id, input.name ?? null, input.description ?? null, input.icon ?? null, input.visibility ?? null, input.members ? [...new Set(input.members)] : null, input.archived ?? null],
  );
  // Search permissions follow the space: re-announce every page so the index gets the new readers.
  if (input.visibility !== undefined || input.members !== undefined) {
    for (const d of (await c.query<DocRow>(`${DOC_SELECT} WHERE d.space_id = $1`, [s.id])).rows) await announce(c, d);
  }
  await activity(c, "space", s.id, "updated", input as Record<string, unknown>);
  return spaceDto((await c.query<SpaceRow>("SELECT * FROM spaces WHERE id = $1", [s.id])).rows[0]!);
}

/** A space with every page the caller can read, as a flat list the client turns into the tree. */
export async function spaceTree(c: PoolClient, p: Principal, keyOrId: string) {
  const s = await spaceByKeyOrId(c, p, keyOrId);
  const pages = (await c.query<DocRow>(`${DOC_SELECT} WHERE d.space_id = $1 ORDER BY d.position`, [s.id])).rows.filter((d) => canReadDoc(p, d));
  return {
    space: { ...spaceDto(s), canManage: canManageSpace(p, s), canCreate: !s.archived && allowedAny(p, "document.create", [{}]) },
    pages: pages.map(pageDto),
  };
}

/** Breadcrumb, child pages and the reader's own state for one page (Confluence page chrome). */
export async function docContext(c: PoolClient, p: Principal, d: DocRow) {
  const ancestors: { id: string; title: string; emoji: string }[] = [];
  let parent = d.parent_id;
  for (let i = 0; parent && i < 20; i++) {
    const a = (await c.query<DocRow>(`${DOC_SELECT} WHERE d.id = $1`, [parent])).rows[0];
    if (!a || !canReadDoc(p, a)) break;
    ancestors.unshift({ id: a.id, title: a.title, emoji: a.emoji });
    parent = a.parent_id;
  }
  const children = (await c.query<DocRow>(`${DOC_SELECT} WHERE d.parent_id = $1 ORDER BY d.position`, [d.id])).rows.filter((x) => canReadDoc(p, x)).map(pageDto);
  const space = d.space_id ? (await c.query<SpaceRow>("SELECT * FROM spaces WHERE id = $1", [d.space_id])).rows[0] : undefined;
  const [starred, views, comments, watching] = await Promise.all([
    c.query("SELECT 1 FROM doc_stars WHERE document_id = $1 AND user_id = $2", [d.id, p.id]),
    c.query<{ readers: number; views: number }>("SELECT count(*)::int AS readers, coalesce(sum(views), 0)::int AS views FROM doc_views WHERE document_id = $1", [d.id]),
    c.query<{ n: number }>("SELECT count(*)::int AS n FROM doc_comments WHERE document_id = $1 AND resolved_at IS NULL", [d.id]),
    c.query("SELECT 1 FROM doc_watchers WHERE document_id = $1 AND user_id = $2", [d.id, p.id]),
  ]);
  return {
    space: space ? { id: space.id, key: space.key, name: space.name, icon: space.icon, homeId: space.home_id } : null,
    ancestors,
    children,
    labels: d.labels,
    emoji: d.emoji,
    format: d.format,
    lastEditorId: d.last_editor_id ?? d.owner_id,
    updatedAt: d.updated_at,
    starred: !!starred.rowCount,
    watching: !!watching.rowCount,
    readers: views.rows[0]!.readers,
    views: views.rows[0]!.views,
    openComments: comments.rows[0]!.n,
    canEdit: canEditDoc(p, d),
  };
}

export async function recordView(c: PoolClient, p: Principal, documentId: string) {
  await c.query(
    `INSERT INTO doc_views (document_id, user_id) VALUES ($1,$2)
     ON CONFLICT (document_id, user_id) DO UPDATE SET views = doc_views.views + 1, viewed_at = now()`,
    [documentId, p.id],
  );
}

/** "Theo dõi trang": be told when the page changes (editing a page watches it too). */
export async function setWatch(c: PoolClient, p: Principal, documentId: string, on: boolean) {
  await getDoc(c, p, documentId);
  if (on) await c.query("INSERT INTO doc_watchers (document_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [documentId, p.id]);
  else await c.query("DELETE FROM doc_watchers WHERE document_id = $1 AND user_id = $2", [documentId, p.id]);
  return { watching: on };
}

export async function setStar(c: PoolClient, p: Principal, documentId: string, on: boolean) {
  await getDoc(c, p, documentId);
  if (on) await c.query("INSERT INTO doc_stars (document_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [documentId, p.id]);
  else await c.query("DELETE FROM doc_stars WHERE document_id = $1 AND user_id = $2", [documentId, p.id]);
  return { starred: on };
}

/** Docs home: what I starred, what I read or wrote lately, and what changed in my spaces. */
export async function docsHome(c: PoolClient, p: Principal) {
  const readable = (rows: DocRow[]) => rows.filter((d) => canReadDoc(p, d)).map(pageDto);
  const [starred, recent, updated] = await Promise.all([
    c.query<DocRow>(`${DOC_SELECT} JOIN doc_stars st ON st.document_id = d.id AND st.user_id = $1 ORDER BY st.created_at DESC LIMIT 30`, [p.id]),
    c.query<DocRow & { seen: Date }>(
      `${DOC_SELECT} JOIN (SELECT document_id, max(at) AS seen FROM (
          SELECT document_id, viewed_at AS at FROM doc_views WHERE user_id = $1
          UNION ALL SELECT id, updated_at FROM documents WHERE last_editor_id = $1 OR owner_id = $1) x GROUP BY document_id) r ON r.document_id = d.id
       ORDER BY r.seen DESC LIMIT 30`,
      [p.id],
    ),
    c.query<DocRow>(`${DOC_SELECT} WHERE d.space_id IS NOT NULL ORDER BY d.updated_at DESC LIMIT 60`),
  ]);
  return { starred: readable(starred.rows), recent: readable(recent.rows).slice(0, 12), updated: readable(updated.rows).slice(0, 20), spaces: await listSpaces(c, p) };
}

export async function docsByLabel(c: PoolClient, p: Principal, label: string) {
  return (await c.query<DocRow>(`${DOC_SELECT} WHERE $1 = ANY(d.labels) ORDER BY d.updated_at DESC LIMIT 200`, [label.toLowerCase()])).rows
    .filter((d) => canReadDoc(p, d))
    .map(pageDto);
}

// ---- comments (page comments, and inline ones quoting a passage) ----

export async function listComments(c: PoolClient, p: Principal, documentId: string) {
  await getDoc(c, p, documentId);
  return (
    await c.query(
      `SELECT id, parent_id AS "parentId", author_id AS "authorId", body, quote, resolved_at AS "resolvedAt", resolved_by AS "resolvedBy", created_at AS "createdAt"
         FROM doc_comments WHERE document_id = $1 ORDER BY created_at`,
      [documentId],
    )
  ).rows;
}

export async function addComment(
  c: PoolClient,
  p: Principal,
  documentId: string,
  input: { body: string; quote?: string | null | undefined; parentId?: string | null | undefined },
) {
  const d = await getDoc(c, p, documentId);
  if (input.parentId && !(await c.query("SELECT 1 FROM doc_comments WHERE id = $1 AND document_id = $2", [input.parentId, documentId])).rowCount)
    throw new NotFound("comment not found");
  const id = newId();
  const r = await c.query<{ created_at: Date }>("INSERT INTO doc_comments (id, document_id, parent_id, author_id, body, quote) VALUES ($1,$2,$3,$4,$5,$6) RETURNING created_at", [
    id,
    documentId,
    input.parentId ?? null,
    p.id,
    input.body,
    input.quote?.slice(0, 500) || null,
  ]);
  // The page's owner and last editor hear about it (and anyone @mentioned, through the usual mention handling).
  // Mentions as the comment box writes them (<@userId>, the same tokens as chat and task comments), and the older
  // @[Name](userId) form.
  const mentions = [...input.body.matchAll(/<@([A-Za-z0-9_-]{1,64})>|@\[[^\]]*\]\(([^)]+)\)/g)].map((m) => (m[1] ?? m[2])!).slice(0, 50);
  const notify = [...new Set([d.owner_id, d.last_editor_id ?? d.owner_id, ...mentions])].filter((u) => u && u !== p.id);
  await emit(c, "work.document.commented.v1", "work.document", documentId, {
    documentId,
    commentId: id,
    code: d.code,
    title: d.title,
    authorId: p.id,
    notify,
    quote: input.quote ?? null,
  });
  return { id, createdAt: r.rows[0]!.created_at };
}

export async function resolveComment(c: PoolClient, p: Principal, documentId: string, commentId: string, resolved: boolean) {
  const d = await getDoc(c, p, documentId);
  const cm = (await c.query<{ author_id: string }>("SELECT author_id FROM doc_comments WHERE id = $1 AND document_id = $2", [commentId, documentId])).rows[0];
  if (!cm) throw new NotFound("comment not found");
  if (cm.author_id !== p.id && !canEditDoc(p, d)) throw new Forbidden("cannot resolve this comment");
  await c.query("UPDATE doc_comments SET resolved_at = CASE WHEN $2 THEN now() END, resolved_by = CASE WHEN $2 THEN $3 END WHERE id = $1", [commentId, resolved, p.id]);
  return { resolved };
}

export async function deleteComment(c: PoolClient, p: Principal, documentId: string, commentId: string) {
  await getDoc(c, p, documentId);
  const cm = (await c.query<{ author_id: string }>("SELECT author_id FROM doc_comments WHERE id = $1 AND document_id = $2", [commentId, documentId])).rows[0];
  if (!cm) throw new NotFound("comment not found");
  if (cm.author_id !== p.id) throw new Forbidden("only the author can delete a comment");
  await c.query("DELETE FROM doc_comments WHERE id = $1 OR parent_id = $1", [commentId]);
  return { deleted: true };
}

export function assertSpaceKey(key: string) {
  if (!/^[A-Za-z][A-Za-z0-9]{1,9}$/.test(key)) throw new Invalid("space key: 2-10 letters or digits, starting with a letter");
}
