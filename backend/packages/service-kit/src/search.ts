import pg from "pg";
import type { Pool, PoolClient } from "pg";
import { logger } from "./logger.js";

/**
 * Unified search (ADR 0013) on Postgres full-text search, in the `search` schema (backend/server/migrations/search).
 * The owning modules stay the source of truth. Documents carry container_id (+ acl_users for direct shares).
 * Queries filter by the caller's current container memberships, so revoking membership takes effect immediately
 * without rewriting documents. Callers re-check the top hits against the owning module before returning them.
 */
export interface SearchDoc {
  entity_type: "message" | "thread" | "channel" | "task" | "project" | "document" | "file" | "person" | "whiteboard" | "meeting" | "event" | "approval";
  entity_id: string;
  container_id: string;
  acl_users?: string[];
  title: string;
  body: string;
  url: string;
  created_at: string;
  updated_at: string;
}

/**
 * The text search configuration of the search schema: diacritics folded, then lower-cased, no stemming. Names in
 * this file are schema-qualified: the indexer (search role) and chat (its own role, with read access) both use it.
 */
const SEARCH_CONFIG = "search.workspace_search";

export function searchPool(connectionString: string, max = 10): Pool {
  const pool = new pg.Pool({ connectionString, max });
  // See watchPool(): an idle connection dropped by the server must not crash the process.
  pool.on("error", (err) => logger.warn({ err }, "idle search database connection lost"));
  return pool;
}

const COLUMNS = ["entity_type", "entity_id", "container_id", "acl_users", "title", "body", "url", "created_at", "updated_at"] as const;

/**
 * Upserts documents (one statement per batch) and adds their words to the workspace vocabulary used for typo
 * correction. Idempotent: documents are keyed by (type, id), so a redelivered event rewrites the same row,
 * and a stale version (older updated_at) never replaces a newer one.
 */
export async function indexDocs(c: PoolClient, docs: SearchDoc[]): Promise<void> {
  if (!docs.length) return;
  // Later duplicates of one key win (a message edited twice in one batch), as sequential writes would.
  // Sorted by key for the same reason as the vocabulary below: concurrent batches lock rows in one order.
  const unique = [...new Map(docs.map((d) => [`${d.entity_type}\u0000${d.entity_id}`, d])).entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, d]) => d);
  const col = <K extends (typeof COLUMNS)[number]>(k: K) => unique.map((d) => (k === "acl_users" ? JSON.stringify(d.acl_users ?? []) : d[k]));
  await c.query(
    `WITH input AS (
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::timestamptz[], $9::timestamptz[])
         AS t(entity_type, entity_id, container_id, acl, title, body, url, created_at, updated_at)
     ), upserted AS (
       INSERT INTO search.search_documents (entity_type, entity_id, container_id, acl_users, title, body, url, created_at, updated_at)
       SELECT entity_type, entity_id, container_id, ARRAY(SELECT jsonb_array_elements_text(acl::jsonb)), title, body, url, created_at, updated_at FROM input
       ON CONFLICT (entity_type, entity_id) DO UPDATE SET
         container_id = EXCLUDED.container_id, acl_users = EXCLUDED.acl_users, title = EXCLUDED.title, body = EXCLUDED.body,
         url = EXCLUDED.url, updated_at = EXCLUDED.updated_at
       -- The event bus does not order events: an older update arriving late must not overwrite a newer one.
       WHERE search_documents.updated_at <= EXCLUDED.updated_at
       RETURNING tsv
     )
     -- Sorted, so concurrent writers take the vocabulary's index locks in the same order (no deadlocks).
     INSERT INTO search.search_terms (word)
     SELECT DISTINCT w.lexeme FROM upserted u, unnest(u.tsv) AS w
     WHERE length(w.lexeme) BETWEEN 3 AND 40 AND w.lexeme ~ '^[[:alpha:]]+$'
     ORDER BY 1
     ON CONFLICT DO NOTHING`,
    COLUMNS.map((k) => col(k)),
  );
}

export async function deleteDoc(c: PoolClient, type: string, id: string): Promise<void> {
  await c.query("DELETE FROM search.search_documents WHERE entity_type = $1 AND entity_id = $2", [type, id]);
}

export type SearchCursor = [score: number, updatedAt: string, entityId: string];

export interface SearchQuery {
  userId: string;
  containerIds: string[];
  text: string;
  types?: SearchDoc["entity_type"][];
  size?: number;
  /** Keyset cursor from the previous page: [score, updated_at, entity_id] (no deep offset paging). */
  after?: SearchCursor;
  /**
   * The text's tsquery, already built (searchTsQuery): a caller searching several kinds side by side builds it once
   * instead of once per kind (the typo lookup behind it costs 5-15 ms on a large vocabulary).
   */
  tsq?: SearchTsQuery | null;
}

export type SearchTsQuery = { strict: string; loose: string | null };

/** A lexeme as a tsquery operand: quoted, with quotes and backslashes escaped. */
const operand = (w: string, prefix = false) => `'${w.replace(/\\/g, "\\\\").replace(/'/g, "''")}'${prefix ? ":*" : ""}`;

/** At most this many matches are ranked per query (the most recent ones); see search(). */
export const RANK_WINDOW = 1000;

/** Excerpts of long bodies are taken from their first this many characters. */
const EXCERPT_SCAN = 20_000;

/**
 * Builds the tsquery for a search text. Each word matches itself and, for the last word, any word it starts
 * (type-ahead). A word the workspace has never used is taken as a typo: it also matches the vocabulary words
 * within 1 edit (2 for words over 5 letters), as `search_query_words()` in the search schema finds them. Words are ANDed for `strict`, ORed for `loose`, the fallback when nothing has them all.
 */
export async function searchTsQuery(c: PoolClient, text: string): Promise<SearchTsQuery | null> {
  const r = await c.query<{ word: string; is_last: boolean; near: string[] }>("SELECT word, is_last, near FROM search.search_query_words($1)", [text]);
  if (!r.rows.length) return null;
  const groups = r.rows.map(({ word, is_last, near }) => {
    const alts = [operand(word, is_last), ...near.map((x) => operand(x))];
    return { word, query: alts.length > 1 ? `(${alts.join(" | ")})` : alts[0]! };
  });
  // The OR fallback leaves out function words: otherwise "what is the campaign deadline" matches any message
  // containing "the", which ranks noise as an answer (and feeds it to AI retrieval as a source).
  const content = groups.filter((g) => !STOP_WORDS.has(g.word));
  return { strict: groups.map((g) => g.query).join(" & "), loose: content.length ? content.map((g) => g.query).join(" | ") : null };
}

/** Function words dropped from the OR fallback, English and Vietnamese (lexemes are lower-cased and unaccented). */
const STOP_WORDS = new Set([
  ...["a", "an", "the", "is", "are", "was", "were", "be", "been", "am", "of", "to", "in", "on", "at", "for", "with", "by", "from"],
  ...["and", "or", "not", "what", "which", "who", "whom", "whose", "when", "where", "why", "how", "this", "that", "these", "those"],
  ...["it", "its", "i", "you", "he", "she", "we", "they", "me", "my", "your", "our", "their", "do", "does", "did", "can", "could"],
  ...["should", "would", "will", "may", "might", "must", "have", "has", "had", "there", "here", "about", "as", "into", "than"],
  ...["then", "so", "if", "but", "just", "also", "very", "any", "all", "some", "no", "please"],
  ...["la", "cua", "va", "cac", "nhung", "mot", "cho", "voi", "trong", "khi", "thi", "de", "da", "dang", "se", "khong", "nay"],
  ...["nao", "gi", "ve", "tu", "den", "duoc", "bi", "ma", "nhu", "roi", "cung", "hay", "hoac", "toi", "ban", "minh"],
]);

type Row = SearchDoc & { score: number };

/** The only search query search and AI retrieval may use. */
export async function search(c: PoolClient, q: SearchQuery): Promise<{ hits: Row[]; next: SearchCursor | null }> {
  const size = Math.min(q.size ?? 20, 50);
  const run = async (tsq: string) =>
    (
      await c.query<Row>(
        `WITH candidates AS (
           -- Ranking reads each candidate's tsvector, so it is bounded: a query matching more than RANK_WINDOW
           -- documents (a very common word) is ranked among its most recent matches (search_candidates()).
           SELECT * FROM search.search_candidates($1::tsquery, $2::text[], $3::text, $4::text[], ${RANK_WINDOW})
         ), matched AS (
           SELECT d.*, ts_rank(d.rank_tsv, $1::tsquery, 1)::float8 AS score
           FROM candidates k JOIN search.search_documents d ON d.entity_type = k.entity_type AND d.entity_id = k.entity_id
         )
         SELECT entity_type, entity_id, container_id, acl_users, title,
                -- Messages are short and shown whole; longer bodies come back as an excerpt around the match.
                CASE WHEN entity_type = 'message' OR length(body) <= 300 THEN body
                     ELSE ts_headline('${SEARCH_CONFIG}', left(body, ${EXCERPT_SCAN}), $1::tsquery, 'StartSel="",StopSel="",MaxWords=35,MinWords=15,MaxFragments=1,FragmentDelimiter=" … "')
                END AS body,
                url, created_at, updated_at, score
         FROM matched
         WHERE $5::float8 IS NULL OR (score, updated_at, entity_id) < ($5, $6::timestamptz, $7)
         ORDER BY score DESC, updated_at DESC, entity_id DESC
         LIMIT $8`,
        [tsq, q.containerIds, q.userId, q.types?.length ? q.types : null, q.after?.[0] ?? null, q.after?.[1] ?? null, q.after?.[2] ?? "", size],
      )
    ).rows;
  const tsq = q.tsq !== undefined ? q.tsq : await searchTsQuery(c, q.text);
  if (!tsq) return { hits: [], next: null };
  let rows = await run(tsq.strict);
  let paged = true;
  // Cursors continue the AND query, so the OR fallback is a single page.
  if (!rows.length && !q.after && tsq.loose && tsq.loose !== tsq.strict) [rows, paged] = [await run(tsq.loose), false];
  const hits = rows.map((r) => ({
    ...r,
    acl_users: r.acl_users ?? [],
    created_at: new Date(r.created_at).toISOString(),
    updated_at: new Date(r.updated_at).toISOString(),
  }));
  const last = hits.at(-1);
  return { hits, next: paged && hits.length === size && last ? [last.score, last.updated_at, last.entity_id] : null };
}

// ── Passages (AI retrieval) ──────────────────────────────────────────────────────────────────────────
// search_documents finds the page; passages find the paragraph (migration search/003). A long text is cut into
// overlapping pieces of about a thousand characters, each with its nearest heading. Ranking is lexical (cover
// density, title and heading weighted, a mild lift for recent text); a rerank by embeddings could be added on the
// candidates this returns without changing the index.

/** What the owning module says about one thing it knows: where it lives, who may read it, and all of its text. */
export interface KnowledgeDoc {
  entity_type: PassageType;
  entity_id: string;
  container_id: string;
  acl_users: string[];
  title: string;
  body: string;
  url: string;
  updated_at: string;
}
export const PASSAGE_TYPES = ["task", "document", "meeting", "event", "file", "approval"] as const;
export type PassageType = (typeof PASSAGE_TYPES)[number];
/** Short kinds that have no passages of their own: read from search_documents, each row one passage. */
const DOCUMENT_TYPES = ["message", "project", "whiteboard"] as const;

export interface PassagePiece {
  heading: string;
  body: string;
}

export const PASSAGE_TARGET = 1000;
const PASSAGE_MAX = 1300;
const PASSAGE_OVERLAP = 160;
/** A text's passages stop here (about 400,000 characters): the tail of a very long export is not indexed. */
export const PASSAGES_MAX = 400;

const HEADING = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
/** Lines the file readers write above each part of a workbook or a deck (work/workflows/extract.ts). */
const PART = /^(Sheet: .{1,80}|Slide \d{1,4})$/;

/** A piece no longer than `max`, cut at a sentence, then a line, then a word. */
function cut(text: string, max: number): [string, string] {
  if (text.length <= max) return [text, ""];
  const head = text.slice(0, max);
  const at = Math.max(head.lastIndexOf(". "), head.lastIndexOf("? "), head.lastIndexOf("! "), head.lastIndexOf("。"), head.lastIndexOf("\n"));
  const end = at > max * 0.5 ? at + 1 : head.lastIndexOf(" ") > max * 0.5 ? head.lastIndexOf(" ") : max;
  return [text.slice(0, end).trimEnd(), text.slice(end).trimStart()];
}

/** The last sentence or so of a passage, repeated at the start of the next so a fact on the cut is in both. */
function tail(text: string): string {
  if (text.length <= PASSAGE_OVERLAP) return "";
  const end = text.slice(-PASSAGE_OVERLAP);
  const at = Math.max(end.indexOf(". "), end.indexOf("\n"));
  return (at >= 0 ? end.slice(at + 1) : end.slice(end.indexOf(" ") + 1)).trim();
}

/**
 * Cuts a text into passages of about PASSAGE_TARGET characters at paragraph, heading and sentence boundaries. Each
 * carries the heading path above it ("Refunds › After 30 days"); a short text is one passage. Pure.
 */
export function splitPassages(text: string): PassagePiece[] {
  const clean = (text ?? "").replace(/\r\n?/g, "\n").split("\0").join("").trim();
  if (!clean) return [];
  const first = clean.split("\n")[0]!;
  if (clean.length <= PASSAGE_MAX && !HEADING.test(first) && !PART.test(first.trim())) return [{ heading: "", body: clean }];
  const out: PassagePiece[] = [];
  const path: { level: number; text: string }[] = [];
  const headingNow = () =>
    path
      .map((h) => h.text)
      .join(" › ")
      .slice(0, 200);
  let buf = "";
  let bufHeading = "";
  const flush = (carry: boolean) => {
    const body = buf.trim();
    if (body && out.length < PASSAGES_MAX) out.push({ heading: bufHeading, body });
    buf = carry && body ? tail(body) : "";
  };
  const add = (block: string) => {
    let rest = block;
    while (rest) {
      if (!buf.trim()) bufHeading = headingNow();
      const room = PASSAGE_MAX - buf.length - (buf ? 2 : 0);
      if (rest.length <= room) {
        buf += (buf ? "\n\n" : "") + rest;
        rest = "";
        if (buf.length >= PASSAGE_TARGET) flush(true);
      } else if (buf.length >= PASSAGE_TARGET * 0.5) {
        // Enough for a passage already: the block starts the next one.
        flush(true);
      } else {
        const [piece, more] = cut(rest, Math.max(200, room));
        buf += (buf ? "\n\n" : "") + piece;
        rest = more;
        flush(true);
      }
    }
  };
  for (const block of clean.split(/\n{2,}/)) {
    const lines = block.split("\n");
    let para: string[] = [];
    const emit = () => {
      if (para.length) add(para.join("\n").trim());
      para = [];
    };
    for (const line of lines) {
      const h = HEADING.exec(line);
      const part = !h && PART.test(line.trim());
      if (h || part) {
        emit();
        // A new section never shares a passage with the one before it, and does not repeat its last sentence.
        flush(false);
        const level = h ? h[1]!.length : 1;
        while (path.length && path[path.length - 1]!.level >= level) path.pop();
        path.push({ level, text: (h ? h[2]! : line.trim()).replace(/[*_`]/g, "").slice(0, 120) });
      } else para.push(line);
    }
    emit();
  }
  flush(false);
  // A heading with nothing under it (a title page) still says something: it is kept as its own passage.
  if (!out.length) return [{ heading: "", body: clean.slice(0, PASSAGE_MAX) }];
  return out;
}

/**
 * Replaces one thing's passages with those of its current text. Idempotent, and an older text arriving late never
 * replaces a newer one. The words join the vocabulary used for typo correction.
 */
export async function indexPassages(c: PoolClient, doc: KnowledgeDoc): Promise<number> {
  const newer = await c.query("SELECT 1 FROM search.search_passages WHERE entity_type = $1 AND entity_id = $2 AND updated_at > $3 LIMIT 1", [
    doc.entity_type,
    doc.entity_id,
    doc.updated_at,
  ]);
  if (newer.rowCount) return 0;
  await c.query("DELETE FROM search.search_passages WHERE entity_type = $1 AND entity_id = $2", [doc.entity_type, doc.entity_id]);
  const pieces = splitPassages(doc.body);
  // Something with a title and no text (a calendar entry) is still found by its title.
  if (!pieces.length && doc.title.trim()) pieces.push({ heading: "", body: doc.title.trim() });
  if (!pieces.length) return 0;
  await c.query(
    `WITH put AS (
       INSERT INTO search.search_passages (entity_type, entity_id, seq, container_id, acl_users, title, heading, body, url, updated_at)
       SELECT $1, $2, t.seq - 1, $3, $4::text[], $5, t.heading, t.body, $6, $7::timestamptz
         FROM unnest($8::text[], $9::text[]) WITH ORDINALITY AS t(heading, body, seq)
       RETURNING tsv
     )
     INSERT INTO search.search_terms (word)
     SELECT DISTINCT w.lexeme FROM put u, unnest(u.tsv) AS w
      WHERE length(w.lexeme) BETWEEN 3 AND 40 AND w.lexeme ~ '^[[:alpha:]]+$'
      ORDER BY 1
     ON CONFLICT DO NOTHING`,
    [doc.entity_type, doc.entity_id, doc.container_id, doc.acl_users, doc.title, doc.url, doc.updated_at, pieces.map((x) => x.heading), pieces.map((x) => x.body)],
  );
  return pieces.length;
}

/** Where one thing lives and who may read it, without its text (a file follows the task or page it is attached to). */
export interface KnowledgeAccess {
  entity_type: PassageType;
  entity_id: string;
  container_id: string;
  acl_users: string[];
}

/**
 * Moves what is already indexed of one thing to its readers of now, text untouched: cheap, and writes nothing when
 * they are the same (most of the time).
 */
export async function setPassageAccess(c: PoolClient, a: KnowledgeAccess): Promise<void> {
  for (const table of ["search_passages", "search_documents"])
    await c.query(
      `UPDATE search.${table} SET container_id = $3, acl_users = $4::text[]
        WHERE entity_type = $1 AND entity_id = $2 AND (container_id <> $3 OR acl_users IS DISTINCT FROM $4::text[])`,
      [a.entity_type, a.entity_id, a.container_id, a.acl_users],
    );
}

export async function deletePassages(c: PoolClient, type: string, id: string): Promise<void> {
  await c.query("DELETE FROM search.search_passages WHERE entity_type = $1 AND entity_id = $2", [type, id]);
}

export interface Passage {
  entity_type: SearchDoc["entity_type"];
  entity_id: string;
  seq: number;
  title: string;
  heading: string;
  text: string;
  url: string;
  updated_at: string;
  score: number;
}

export interface PassageQuery {
  userId: string;
  containerIds: string[];
  text: string;
  types?: string[] | undefined;
  size?: number | undefined;
  /** Only text changed since then (ISO date): "what was decided this week". */
  since?: string | undefined;
}

/** Title matches count most, then the heading, then the passage itself (tsvector weights D, C, B, A). */
const WEIGHTS = "{0.1, 0.4, 0.7, 1.0}";
/** How many passages one thing may put in an answer, so a long page does not crowd out everything else. */
const PER_ENTITY = 2;
/** A passage's score is lifted by up to this share when its text is new, fading over about three months. */
const RECENCY = 0.2;

/**
 * The passages that best answer a question, among what the reader may read: the same container and ACL filter as
 * search(), the same query (prefix on the last word, typo neighbours, an OR fallback when no passage has every
 * word). Ranked by cover density, so a passage where the words stand together beats one that only contains them.
 */
export async function searchPassages(c: PoolClient, q: PassageQuery): Promise<Passage[]> {
  const size = Math.min(Math.max(q.size ?? 8, 1), 24);
  const asked = q.types?.length ? q.types : null;
  const passageTypes = (PASSAGE_TYPES as readonly string[]).filter((t) => !asked || asked.includes(t));
  const documentTypes = (DOCUMENT_TYPES as readonly string[]).filter((t) => !asked || asked.includes(t));
  if (!passageTypes.length && !documentTypes.length) return [];
  const tsq = await searchTsQuery(c, q.text);
  if (!tsq) return [];
  const run = async (query: string) =>
    (
      await c.query<Passage>(
        `WITH found AS (
           SELECT p.entity_type, p.entity_id, p.seq, p.title, p.heading, p.body AS text, p.url, p.updated_at,
                  ts_rank_cd('${WEIGHTS}', p.tsv, $1::tsquery, 1)::float8 AS rank
             FROM (SELECT * FROM search.search_passages x
                    WHERE x.tsv @@ $1::tsquery AND x.entity_type = ANY ($4::text[])
                      AND (x.container_id = ANY ($2::text[]) OR x.acl_users && ARRAY[$3::text])
                      AND ($6::timestamptz IS NULL OR x.updated_at >= $6)
                    ORDER BY x.updated_at DESC LIMIT ${RANK_WINDOW}) p
           UNION ALL
           SELECT d.entity_type, d.entity_id, 0, d.title, '', left(d.body, 1500), d.url, d.updated_at,
                  ts_rank_cd('${WEIGHTS}', d.rank_tsv, $1::tsquery, 1)::float8
             FROM search.search_candidates($1::tsquery, $2::text[], $3::text, $5::text[], 300) k
             JOIN search.search_documents d ON d.entity_type = k.entity_type AND d.entity_id = k.entity_id
            WHERE cardinality($5::text[]) > 0 AND ($6::timestamptz IS NULL OR d.updated_at >= $6)
         ), scored AS (
           SELECT *, rank * (1 + ${RECENCY} * exp(-greatest(extract(epoch FROM now() - updated_at), 0) / (86400.0 * 90))) AS score FROM found
         ), capped AS (
           SELECT *, row_number() OVER (PARTITION BY entity_type, entity_id ORDER BY score DESC, seq) AS n FROM scored
         )
         SELECT entity_type, entity_id, seq, title, heading, text, url, updated_at, score FROM capped
          WHERE n <= ${PER_ENTITY}
          ORDER BY score DESC, updated_at DESC, entity_id, seq
          LIMIT $7`,
        [query, q.containerIds, q.userId, passageTypes, documentTypes, q.since ?? null, size],
      )
    ).rows;
  let rows = await run(tsq.strict);
  // A question is rarely the document's own words: when no passage has them all, any of the content words will do,
  // and cover density still puts the passages with most of them first.
  if (rows.length < Math.min(3, size) && tsq.loose && tsq.loose !== tsq.strict) {
    const have = new Set(rows.map((r) => `${r.entity_type}:${r.entity_id}:${r.seq}`));
    rows = [...rows, ...(await run(tsq.loose)).filter((r) => !have.has(`${r.entity_type}:${r.entity_id}:${r.seq}`))].slice(0, size);
  }
  return rows.map((r) => ({ ...r, updated_at: new Date(r.updated_at).toISOString() }));
}

/** The passages next to one (the same thing's text before and after it), for "read more of this". No permission check. */
export async function passagesAround(c: PoolClient, type: string, id: string, seq: number, radius = 1): Promise<Passage[]> {
  const r = Math.min(Math.max(radius, 0), 5);
  const rows = (
    await c.query<Passage>(
      `SELECT entity_type, entity_id, seq, title, heading, body AS text, url, updated_at, 0::float8 AS score FROM search.search_passages
        WHERE entity_type = $1 AND entity_id = $2 AND seq BETWEEN $3 AND $4 ORDER BY seq`,
      [type, id, seq - r, seq + r],
    )
  ).rows;
  if (rows.length) return rows.map((x) => ({ ...x, updated_at: new Date(x.updated_at).toISOString() }));
  // A kind without passages (a message, a project): the document itself.
  const doc = (
    await c.query<Passage>(
      "SELECT entity_type, entity_id, 0 AS seq, title, '' AS heading, left(body, 6000) AS text, url, updated_at, 0::float8 AS score FROM search.search_documents WHERE entity_type = $1 AND entity_id = $2",
      [type, id],
    )
  ).rows;
  return doc.map((x) => ({ ...x, updated_at: new Date(x.updated_at).toISOString() }));
}
