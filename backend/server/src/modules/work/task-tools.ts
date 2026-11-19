import type { PoolClient } from "pg";
import type { Principal } from "@workspace/shared";
import { atRisk, canReadTask, type TaskRow } from "./tasks.js";

/**
 * Reads behind the assistant's task tools (ai/tools-tasks.ts): what is late or about to be, how loaded a
 * person is, which open tasks look like the same work, and how long similar work took. Every list is filtered by
 * canReadTask after the query, so the assistant (which calls as the asker) never sees a task the asker could not.
 * Scans are bounded: a workspace is one company, and these answer a question, they are not exports.
 */

const DAY = 86_400_000;
/** How many candidate rows a scan reads before the per-row permission filter. */
const SCAN = 3000;

// Words that say nothing about what the work is: matching on them would pair every "Fix the …" with every other.
const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "for", "in", "on", "with", "at", "by", "from", "is", "be", "new", "task",
  "va", "cua", "cho", "voi", "cac", "nhung", "mot", "lam", "viec", "de", "tu", "trong", "ve", "la",
]); // prettier-ignore

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase();

/** The words of a title that carry its meaning: folded (accents off), no stop words, no one-letter bits. */
export function titleTokens(title: string): Set<string> {
  return new Set(
    fold(title)
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 1 && !STOP.has(w)),
  );
}

/** Jaccard overlap of two token sets: 1 the same words, 0 nothing in common. */
export function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let both = 0;
  for (const w of a) if (b.has(w)) both++;
  return both / (a.size + b.size - both);
}

export interface DuplicatePair<T> {
  a: T;
  b: T;
  score: number;
}

/**
 * Pairs of items whose titles share most of their words. Compares only items that share a word (an index by word),
 * so a few thousand open tasks stay cheap. Best pairs first.
 */
export function duplicatePairs<T extends { id: string; title: string }>(items: T[], threshold = 0.6, max = 30): DuplicatePair<T>[] {
  const tokens = items.map((t) => titleTokens(t.title));
  const byWord = new Map<string, number[]>();
  tokens.forEach((ws, i) => ws.forEach((w) => (byWord.get(w) ?? byWord.set(w, []).get(w)!).push(i)));
  const seen = new Set<string>();
  const pairs: DuplicatePair<T>[] = [];
  for (const list of byWord.values()) {
    // A word on hundreds of titles (a product name) is no evidence of a duplicate on its own.
    if (list.length > 200) continue;
    for (let x = 0; x < list.length; x++)
      for (let y = x + 1; y < list.length; y++) {
        const i = list[x]!;
        const j = list[y]!;
        const key = `${i}:${j}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // One shared word between one-word titles is too thin to call a duplicate.
        if (Math.min(tokens[i]!.size, tokens[j]!.size) < 2 && fold(items[i]!.title).trim() !== fold(items[j]!.title).trim()) continue;
        const score = overlap(tokens[i]!, tokens[j]!);
        if (score >= threshold) pairs.push({ a: items[i]!, b: items[j]!, score: Math.round(score * 100) / 100 });
      }
  }
  return pairs.sort((p, q) => q.score - p.score).slice(0, max);
}

export function quantile(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const at = (s.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return s[lo]! + (s[hi]! - s[lo]!) * (at - lo);
}

export interface Finished {
  code: string;
  title: string;
  startedAt: Date;
  completedAt: Date;
}

/**
 * How long work like `title` took: the finished tasks whose titles share words with it (the closest first), their
 * median and 75th-percentile days from start to done, and a due date that many days from `from`. With fewer than
 * three similar tasks it falls back to all of the sample (and says so), since one example is no estimate.
 */
export function estimateDays(title: string, done: Finished[], from: Date) {
  const want = titleTokens(title);
  const days = (f: Finished) => Math.max(0, (f.completedAt.getTime() - f.startedAt.getTime()) / DAY);
  const scored = done.map((f) => ({ f, s: overlap(want, titleTokens(f.title)) })).filter((x) => x.s >= 0.25);
  scored.sort((a, b) => b.s - a.s);
  const similar = scored.slice(0, 20).map((x) => x.f);
  const basis = similar.length >= 3 ? "similar" : "all";
  const sample = basis === "similar" ? similar : done;
  const ds = sample.map(days);
  const median = quantile(ds, 0.5);
  const p75 = quantile(ds, 0.75);
  const round = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);
  return {
    basis,
    sample: sample.length,
    medianDays: round(median),
    p75Days: round(p75),
    // Whole days, at least one: a same-day median still needs a date after today.
    suggestedDueAt: median === null ? null : new Date(from.getTime() + Math.max(1, Math.ceil(median)) * DAY).toISOString(),
    examples: similar.slice(0, 5).map((f) => ({ code: f.code, title: f.title, days: round(days(f)) })),
  };
}

const open = "status NOT IN ('done', 'cancelled')";

/**
 * What these reads need of a task: who may read it (canReadTask), whether it is late or at risk, and what the
 * assistant shows. Not the description, custom fields or source: the full rows made the late list 2.5 MB on a
 * workspace with 20k tasks, for an answer that shows fifteen lines per person.
 */
const LITE_COLS =
  "id, code, title, status, priority, owner_id, assignee_id, project_id, team_id, parent_id, due_at, progress, eta_at, blocked_reason, created_at, start_at, completed_at";
type LiteRow = Pick<
  TaskRow,
  | "id" | "code" | "title" | "status" | "priority" | "owner_id" | "assignee_id" | "project_id" | "team_id" | "parent_id"
  | "due_at" | "progress" | "eta_at" | "blocked_reason" | "created_at" | "start_at" | "completed_at"
>; // prettier-ignore
const liteDto = (t: LiteRow, now = Date.now()) => ({
  id: t.id,
  code: t.code,
  title: t.title,
  status: t.status,
  priority: t.priority,
  assigneeId: t.assignee_id,
  projectId: t.project_id,
  parentId: t.parent_id,
  dueAt: t.due_at,
  progress: t.progress,
  etaAt: t.eta_at,
  blockedReason: t.blocked_reason,
  createdAt: t.created_at,
  atRisk: atRisk(t, now),
});

/** Overdue and at-risk open tasks the caller may read, optionally for some assignees or one project. */
export async function lateTasks(c: PoolClient, p: Principal, f: { assigneeIds?: string[] | undefined; projectId?: string | undefined }) {
  const r = await c.query<LiteRow>(
    `SELECT ${LITE_COLS} FROM tasks
      WHERE ${open} AND due_at IS NOT NULL AND due_at < now() + interval '3 days'
        AND ($1::text[] IS NULL OR assignee_id = ANY($1)) AND ($2::text IS NULL OR project_id = $2)
      ORDER BY due_at LIMIT ${SCAN}`,
    [f.assigneeIds?.length ? f.assigneeIds : null, f.projectId ?? null],
  );
  const now = Date.now();
  const rows = r.rows.filter((t) => canReadTask(p, t));
  return {
    overdue: rows.filter((t) => t.due_at!.getTime() < now).map((t) => liteDto(t, now)),
    atRisk: rows.filter((t) => t.due_at!.getTime() >= now && atRisk(t, now)).map((t) => liteDto(t, now)),
    truncated: r.rows.length === SCAN,
  };
}

/** One person's open work as the caller can see it: what a reassignment would add to. */
export async function load(c: PoolClient, p: Principal, userId: string) {
  const r = await c.query<LiteRow>(`SELECT ${LITE_COLS} FROM tasks WHERE assignee_id = $1 AND ${open} ORDER BY coalesce(due_at, 'infinity') LIMIT 500`, [userId]);
  const now = Date.now();
  const rows = r.rows.filter((t) => canReadTask(p, t));
  return {
    open: rows.length,
    overdue: rows.filter((t) => t.due_at && t.due_at.getTime() < now).length,
    dueThisWeek: rows.filter((t) => t.due_at && t.due_at.getTime() >= now && t.due_at.getTime() < now + 7 * DAY).length,
    blocked: rows.filter((t) => t.blocked_reason).length,
  };
}

/** Open tasks the caller may read that look like the same work. */
export async function duplicates(c: PoolClient, p: Principal, f: { projectId?: string | undefined; assigneeId?: string | undefined }) {
  const r = await c.query<LiteRow>(
    `SELECT ${LITE_COLS} FROM tasks WHERE ${open} AND ($1::text IS NULL OR project_id = $1) AND ($2::text IS NULL OR assignee_id = $2)
      ORDER BY updated_at DESC LIMIT ${SCAN}`,
    [f.projectId ?? null, f.assigneeId ?? null],
  );
  const now = Date.now();
  const rows = r.rows.filter((t) => canReadTask(p, t)).map((t) => liteDto(t, now));
  return { pairs: duplicatePairs(rows), scanned: rows.length, truncated: r.rows.length === SCAN };
}

/** A due-date suggestion for new work from what similar finished work took (start, else creation, to done). */
export async function estimate(c: PoolClient, p: Principal, f: { title: string; projectId?: string | undefined; assigneeId?: string | undefined; from?: Date | undefined }) {
  const r = await c.query<Pick<TaskRow, "code" | "title" | "owner_id" | "assignee_id" | "project_id" | "team_id" | "start_at" | "created_at" | "completed_at">>(
    `SELECT code, title, owner_id, assignee_id, project_id, team_id, start_at, created_at, completed_at FROM tasks WHERE status = 'done' AND completed_at > now() - interval '365 days'
        AND ($1::text IS NULL OR project_id = $1) AND ($2::text IS NULL OR assignee_id = $2)
      ORDER BY completed_at DESC LIMIT ${SCAN}`,
    [f.projectId ?? null, f.assigneeId ?? null],
  );
  const done = r.rows
    .filter((t) => t.completed_at && canReadTask(p, t))
    .map((t) => ({ code: t.code, title: t.title, startedAt: t.start_at ?? t.created_at, completedAt: t.completed_at! }));
  return estimateDays(f.title, done, f.from ?? new Date());
}
