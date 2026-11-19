import type { PoolClient } from "pg";
import { authorize, type Principal } from "@workspace/shared";
import { canReadDoc, DOC_SELECT, type DocRow } from "./documents.js";
import { canReadTask, getTask, TASK_COLS, type TaskRow } from "./tasks.js";

/**
 * "Liên quan" for a task: what the workspace already knows that may help with it, found with full-text
 * search only, so it works for every company, AI or not. The ai module reads the same data (as the asker) to ground
 * its task chat. Everything is read as the caller: documents, tasks and messages they cannot open never appear.
 */

const STOP = new Set([
  // Vietnamese function syllables (unaccented), and the verbs every task title starts with.
  ..."la cua va cac nhung mot cho voi trong tren duoi khi thi de da se khong nay nao gi ve tu den duoc bi ma nhu roi cung hay hoac toi ban minh len lai ra vao theo tai o".split(
    " ",
  ),
  ..."lam viec task can them sua tao xem kiem tra moi cu".split(" "),
  ..."a an the is are of to in on at for with by from and or not this that it its be do new add fix make update".split(" "),
]);

/** Lower case, no tone marks, đ → d: how titles are compared ("Đăng nhập" finds "dang nhap"). */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();
}

/** The words a task is about: its title and labels, folded, without function words and codes; at most 8, in order. */
export function taskTerms(title: string, labels: string[] = []): string[] {
  const out: string[] = [];
  for (const w of fold(`${title} ${labels.join(" ")}`).split(/[^a-z0-9]+/)) {
    if (w.length < 2 || STOP.has(w) || /^\d+$/.test(w) || out.includes(w)) continue;
    out.push(w);
    if (out.length === 8) break;
  }
  return out;
}

/** How many of a task's words another task must share to count as "similar": two, or 40% of a long title. */
export const minShared = (terms: number) => Math.min(terms, Math.max(2, Math.ceil(terms * 0.4)));

/** Documents a text points at: links to /app/work/docs/<id>, and codes (`TL-012`) checked against documents later. */
export function docRefs(text: string): { ids: string[]; codes: string[] } {
  const ids = [...text.matchAll(/\/app\/work\/docs\/([0-9A-Za-z]{26})\b/g)].map((m) => m[1]!);
  const codes = [...text.matchAll(/(?<![\w-])([A-Z][A-Z0-9]{0,9}-\d{1,6})(?![\w-])/g)].map((m) => m[1]!);
  return { ids: [...new Set(ids)], codes: [...new Set(codes)] };
}

/** A message that names the task's code as a word ("WEB-42", not "WEB-420" or "XWEB-42"). */
export function mentionsCode(body: string, code: string): boolean {
  const esc = code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w-])${esc}(?![\\w]|-\\d)`, "i").test(body);
}

export interface RelatedDoc {
  id: string;
  code: string;
  title: string;
  /** Why it is listed: written in the task or its comments, in the task's project, or found by its words. */
  why: "mentioned" | "project" | "search";
  excerpt: string | null;
  updatedAt: string | null;
  url: string;
}
export interface SimilarTask {
  id: string;
  code: string;
  title: string;
  assigneeId: string | null;
  completedAt: string | null;
  /** Its last comment (or the start of its description): how it was done, in the doer's words. */
  how: string | null;
  subtasks: number;
  shared: number;
}
export interface RelatedMessage {
  id: string;
  channel: string;
  body: string;
  url: string;
  at: string;
}
export interface Related {
  keywords: string[];
  project: { id: string; code: string; name: string; description: string } | null;
  goals: { goal: string; keyResult: string }[];
  parent: { id: string; code: string; title: string; status: string; description: string } | null;
  docs: RelatedDoc[];
  similar: SimilarTask[];
  messages: RelatedMessage[];
  /** Chat search did not answer: documents found by words and messages are missing, the rest is complete. */
  partial: boolean;
}

/** Search as the caller (chat's unified search: index filtered by what they can read, top hits rechecked). */
export type SearchFn = (q: string, types: string) => Promise<{ entity_type: string; entity_id: string; title: string; body: string; url: string; created_at?: string }[]>;

const cut = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

/** Everything "Liên quan" shows for one task, read as `p`. Throws NotFound when the task is not theirs to read. */
export async function relatedForTask(c: PoolClient, p: Principal, taskId: string, search: SearchFn): Promise<Related> {
  const t = await getTask(c, p, taskId);
  const keywords = taskTerms(t.title, t.labels);
  const comments = (await c.query<{ body: string }>("SELECT body FROM task_comments WHERE task_id = $1 ORDER BY created_at DESC LIMIT 50", [t.id])).rows;

  const projectRead = authorize(p, "project.read").allowed;
  const project =
    t.project_id && projectRead
      ? ((await c.query<{ id: string; code: string; name: string; description: string }>("SELECT id, code, name, description FROM projects WHERE id = $1", [t.project_id]))
          .rows[0] ?? null)
      : null;
  const goals = project
    ? (
        await c.query<{ goal: string; keyResult: string }>(
          `SELECT g.title AS goal, k.title AS "keyResult" FROM key_results k JOIN goals g ON g.id = k.goal_id
            WHERE k.project_id = $1 AND NOT g.archived ORDER BY g.ends_on DESC LIMIT 3`,
          [project.id],
        )
      ).rows
    : [];
  const parentRow = t.parent_id ? (await c.query<TaskRow>(`SELECT ${TASK_COLS} FROM tasks WHERE id = $1`, [t.parent_id])).rows[0] : undefined;
  const parent =
    parentRow && canReadTask(p, parentRow)
      ? { id: parentRow.id, code: parentRow.code, title: parentRow.title, status: parentRow.status, description: cut(parentRow.description, 1200) }
      : null;

  // Documents: the ones the task names, then its project's, then search by its words (each readable, no repeats).
  const refs = docRefs([t.description, ...comments.map((x) => x.body)].join("\n"));
  const docs: RelatedDoc[] = [];
  const seen = new Set<string>();
  const add = (d: { id: string; code: string; title: string; updated_at?: Date | string | null }, why: RelatedDoc["why"], excerpt: string | null = null) => {
    if (seen.has(d.id) || docs.length >= 8) return;
    seen.add(d.id);
    docs.push({
      id: d.id,
      code: d.code,
      title: d.title,
      why,
      excerpt,
      updatedAt: d.updated_at ? new Date(d.updated_at).toISOString() : null,
      url: `/app/work/docs/${d.id}`,
    });
  };
  if (refs.ids.length || refs.codes.length) {
    const rows = (await c.query<DocRow>(`${DOC_SELECT} WHERE d.id = ANY($1::text[]) OR d.code = ANY($2::text[]) LIMIT 20`, [refs.ids, refs.codes])).rows;
    for (const d of rows) if (canReadDoc(p, d)) add(d, "mentioned");
  }
  if (t.project_id) {
    const rows = (await c.query<DocRow>(`${DOC_SELECT} WHERE d.project_id = $1 ORDER BY d.updated_at DESC LIMIT 20`, [t.project_id])).rows;
    let n = 0;
    for (const d of rows) {
      if (n >= 4 || !canReadDoc(p, d) || seen.has(d.id)) continue;
      add(d, "project");
      n++;
    }
  }

  // Finished tasks with the same words, newest first among equals, with who did them and how.
  const similar: SimilarTask[] = [];
  if (keywords.length) {
    const need = minShared(keywords.length);
    const rows = (
      await c.query<TaskRow & { shared: number }>(
        `WITH done AS MATERIALIZED (
           SELECT ${TASK_COLS} FROM tasks
            WHERE status = 'done' AND id <> $1 AND parent_id IS DISTINCT FROM $1
            ORDER BY completed_at DESC NULLS LAST LIMIT 3000)
         SELECT d.*, m.shared FROM done d,
           LATERAL (SELECT count(*)::int AS shared FROM unnest($2::text[]) w
                     WHERE to_tsvector('simple', public.unaccent(lower(d.title || ' ' || array_to_string(d.labels, ' ')))) @@ to_tsquery('simple', quote_literal(w))) m
          WHERE m.shared >= $3
          ORDER BY m.shared DESC, d.completed_at DESC NULLS LAST LIMIT 40`,
        [t.id, keywords, need],
      )
    ).rows.filter((x) => canReadTask(p, x));
    const picked = rows.slice(0, 5);
    if (picked.length) {
      const ids = picked.map((x) => x.id);
      const last = new Map(
        (
          await c.query<{ task_id: string; body: string }>(
            "SELECT DISTINCT ON (task_id) task_id, body FROM task_comments WHERE task_id = ANY($1::text[]) ORDER BY task_id, created_at DESC",
            [ids],
          )
        ).rows.map((r) => [r.task_id, r.body]),
      );
      const subs = new Map(
        (await c.query<{ parent_id: string; n: number }>("SELECT parent_id, count(*)::int AS n FROM tasks WHERE parent_id = ANY($1::text[]) GROUP BY parent_id", [ids])).rows.map(
          (r) => [r.parent_id, r.n],
        ),
      );
      for (const x of picked) {
        const how = last.get(x.id) ?? x.description;
        similar.push({
          id: x.id,
          code: x.code,
          title: x.title,
          assigneeId: x.assignee_id,
          completedAt: x.completed_at ? new Date(x.completed_at).toISOString() : null,
          how: how?.trim() ? cut(how.replace(/<@[\w:-]+>/g, "@"), 240) : null,
          subtasks: subs.get(x.id) ?? 0,
          shared: x.shared,
        });
      }
    }
  }

  // Chat's search: documents by the task's words, and messages that name its code. Best effort: without it the rest stands.
  let partial = false;
  const messages: RelatedMessage[] = [];
  const [docHits, msgHits] = await Promise.all([
    keywords.length ? search(keywords.slice(0, 5).join(" "), "document").catch(() => ((partial = true), [])) : Promise.resolve([]),
    search(t.code, "message").catch(() => ((partial = true), [])),
  ]);
  // Search falls back to any one word when all of them match nothing: keep only documents that share enough of them.
  const enough = (h: { title: string; body: string }) => {
    const text = fold(`${h.title} ${h.body ?? ""}`);
    return keywords.slice(0, 5).filter((w) => new RegExp(`\\b${w}`).test(text)).length >= minShared(Math.min(keywords.length, 5));
  };
  for (const h of docHits.filter((x) => x.entity_type === "document" && enough(x)).slice(0, 6))
    add({ id: h.entity_id, code: "", title: h.title, updated_at: null }, "search", h.body ? cut(h.body.replace(/[*_#`>|]+/g, ""), 200) : null);
  for (const h of msgHits) {
    if (h.entity_type !== "message" || !mentionsCode(h.body ?? "", t.code)) continue;
    messages.push({ id: h.entity_id, channel: h.title ?? "", body: cut(h.body ?? "", 300), url: h.url, at: h.created_at ?? "" });
    if (messages.length === 6) break;
  }
  messages.sort((a, b) => (a.at < b.at ? 1 : -1));

  return { keywords, project, goals, parent, docs, similar, messages, partial };
}
