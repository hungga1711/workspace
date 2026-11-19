import type { PoolClient } from "pg";
import { TZ_SQL } from "./settings.js";

/**
 * Flow numbers for a slice of tasks (a project, a department, a person, the workspace). "% done" misleads on a board
 * where work is added at any time (done ÷ total falls while a team ships), so the boss reads the pace instead: per
 * week what got done and what came in, what is in flight now, what has not moved for STUCK_DAYS, what is overdue,
 * and how long work takes from start to done. Weeks start on Monday in the workspace's time zone.
 */
export const STUCK_DAYS = 7;
export const MAX_WEEKS = 26;

export type VelocityScope = { kind: "project"; id: string } | { kind: "people"; ids: string[] } | { kind: "workspace" };

export interface VelocityWeek {
  /** Monday of the week, YYYY-MM-DD in the workspace's time zone. */
  week: string;
  done: number;
  added: number;
  /** Median days from start to done of the tasks finished that week; null when none had a known start. */
  cycleDays: number | null;
}

export interface Velocity {
  weeks: VelocityWeek[];
  now: { inProgress: number; review: number; stuck: number; overdue: number; open: number };
  /**
   * The one-line summary: done and added over the last 7 days (rolling, so Monday morning does not read "0 done ·
   * 0 added"). The weekly buckets above stay calendar weeks for the sparkline.
   */
  thisWeek: { done: number; added: number };
  stuckDays: number;
}

/** Top-level tasks only: subtasks are steps of a task, and counting them would let one busy task swamp the week. */
function where(scope: VelocityScope, first: number): { sql: string; args: unknown[] } {
  if (scope.kind === "project") return { sql: `t.project_id = $${first} AND t.parent_id IS NULL`, args: [scope.id] };
  if (scope.kind === "people") return { sql: `t.assignee_id = ANY($${first}::text[]) AND t.parent_id IS NULL`, args: [scope.ids] };
  return { sql: `t.parent_id IS NULL`, args: [] };
}

export async function velocity(c: PoolClient, scope: VelocityScope, weeks = 8): Promise<Velocity> {
  const n = Math.min(Math.max(Math.trunc(weeks) || 8, 1), MAX_WEEKS);
  if (scope.kind === "people" && !scope.ids.length) return empty(n, await mondays(c, n));
  const w = where(scope, 2);
  // One pass per question, each on an index: arrivals by created_at, completions by completed_at, flight by status.
  const series = (
    await c.query<{ week: string; done: number; added: number; cycle_days: number | null }>(
      `WITH tz AS (SELECT ${TZ_SQL} AS z),
            span AS (SELECT (date_trunc('week', now() AT TIME ZONE z) - make_interval(weeks => $1 - 1)) AS from_local, z FROM tz),
            wk AS (SELECT generate_series(s.from_local, s.from_local + make_interval(weeks => $1 - 1), interval '1 week') AS w FROM span s),
            added AS (
              SELECT date_trunc('week', t.created_at AT TIME ZONE s.z) AS w, count(*)::int AS n
                FROM tasks t, span s
               WHERE ${w.sql} AND t.created_at >= (s.from_local AT TIME ZONE s.z)
               GROUP BY 1),
            done AS (
              SELECT date_trunc('week', t.completed_at AT TIME ZONE s.z) AS w, count(*)::int AS n,
                     percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM t.completed_at - t.started_at) / 86400)
                       FILTER (WHERE t.started_at IS NOT NULL AND t.started_at <= t.completed_at) AS cycle
                FROM tasks t, span s
               WHERE ${w.sql} AND t.status = 'done' AND t.completed_at >= (s.from_local AT TIME ZONE s.z)
               GROUP BY 1)
       SELECT to_char(wk.w, 'YYYY-MM-DD') AS week, coalesce(d.n, 0) AS done, coalesce(a.n, 0) AS added,
              round(d.cycle::numeric, 1)::float AS cycle_days
         FROM wk LEFT JOIN added a ON a.w = wk.w LEFT JOIN done d ON d.w = wk.w
        ORDER BY wk.w`,
      [n, ...w.args],
    )
  ).rows;
  const now = (
    await c.query<{ in_progress: number; review: number; stuck: number; overdue: number; open: number }>(
      `SELECT count(*) FILTER (WHERE t.status = 'in_progress')::int AS in_progress,
              count(*) FILTER (WHERE t.status = 'review')::int AS review,
              count(*) FILTER (WHERE t.status IN ('in_progress','review')
                AND coalesce(t.status_changed_at, t.updated_at) < now() - make_interval(days => $1))::int AS stuck,
              count(*) FILTER (WHERE t.due_at < now())::int AS overdue,
              count(*)::int AS open
         FROM tasks t WHERE ${where(scope, 2).sql} AND t.status IN ('todo','in_progress','review')`,
      [STUCK_DAYS, ...w.args],
    )
  ).rows[0]!;
  const recent = (
    await c.query<{ done: number; added: number }>(
      `SELECT count(*) FILTER (WHERE t.created_at >= now() - interval '7 days')::int AS added,
              count(*) FILTER (WHERE t.status = 'done' AND t.completed_at >= now() - interval '7 days')::int AS done
         FROM tasks t
        WHERE ${where(scope, 1).sql} AND (t.created_at >= now() - interval '7 days' OR t.completed_at >= now() - interval '7 days')`,
      w.args,
    )
  ).rows[0]!;
  return shape(series, now, recent);
}

export function shape(
  series: { week: string; done: number; added: number; cycle_days: number | null }[],
  now: { in_progress: number; review: number; stuck: number; overdue: number; open: number },
  recent?: { done: number; added: number },
): Velocity {
  const weeks = series.map((r) => ({ week: r.week, done: r.done, added: r.added, cycleDays: r.cycle_days ?? null }));
  const last = weeks.at(-1);
  return {
    weeks,
    now: { inProgress: now.in_progress, review: now.review, stuck: now.stuck, overdue: now.overdue, open: now.open },
    thisWeek: recent ?? { done: last?.done ?? 0, added: last?.added ?? 0 },
    stuckDays: STUCK_DAYS,
  };
}

async function mondays(c: PoolClient, n: number): Promise<string[]> {
  return (
    await c.query<{ week: string }>(
      `SELECT to_char(g, 'YYYY-MM-DD') AS week FROM generate_series(
         date_trunc('week', now() AT TIME ZONE ${TZ_SQL}) - make_interval(weeks => $1 - 1),
         date_trunc('week', now() AT TIME ZONE ${TZ_SQL}), interval '1 week') g`,
      [n],
    )
  ).rows.map((r) => r.week);
}

function empty(n: number, weeks: string[]): Velocity {
  return shape(
    weeks.slice(-n).map((week) => ({ week, done: 0, added: 0, cycle_days: null })),
    { in_progress: 0, review: 0, stuck: 0, overdue: 0, open: 0 },
  );
}

/**
 * The same numbers for many projects in two queries (the projects page): this week's done and added, the last
 * `weeks` of both for the sparkline, and what is stuck now. Keyed by project id.
 */
export async function projectFlows(c: PoolClient, ids: string[], weeks = 8): Promise<Map<string, ProjectFlow>> {
  const out = new Map<string, ProjectFlow>();
  if (!ids.length) return out;
  const n = Math.min(Math.max(weeks, 1), MAX_WEEKS);
  const rows = (
    await c.query<{ project_id: string; week: string; done: number; added: number }>(
      `WITH s AS (SELECT ${TZ_SQL} AS z),
            span AS (SELECT date_trunc('week', now() AT TIME ZONE z) - make_interval(weeks => $2 - 1) AS from_local, z FROM s),
            ev AS (
              SELECT t.project_id, date_trunc('week', t.created_at AT TIME ZONE span.z) AS w, 0 AS done, 1 AS added
                FROM tasks t, span WHERE t.project_id = ANY($1::text[]) AND t.parent_id IS NULL AND t.created_at >= (span.from_local AT TIME ZONE span.z)
              UNION ALL
              SELECT t.project_id, date_trunc('week', t.completed_at AT TIME ZONE span.z), 1, 0
                FROM tasks t, span WHERE t.project_id = ANY($1::text[]) AND t.parent_id IS NULL AND t.status = 'done'
                 AND t.completed_at >= (span.from_local AT TIME ZONE span.z))
       SELECT ev.project_id, to_char(ev.w, 'YYYY-MM-DD') AS week, sum(ev.done)::int AS done, sum(ev.added)::int AS added
         FROM ev GROUP BY 1, 2`,
      [ids, n],
    )
  ).rows;
  const flight = (
    await c.query<{ project_id: string; in_progress: number; stuck: number }>(
      `SELECT t.project_id, count(*)::int AS in_progress,
              count(*) FILTER (WHERE coalesce(t.status_changed_at, t.updated_at) < now() - make_interval(days => $2))::int AS stuck
         FROM tasks t WHERE t.project_id = ANY($1::text[]) AND t.parent_id IS NULL AND t.status IN ('in_progress','review')
        GROUP BY 1`,
      [ids, STUCK_DAYS],
    )
  ).rows;
  const recent = (
    await c.query<{ project_id: string; done: number; added: number }>(
      // Two index range reads (project + created, project + completed) instead of one OR that reads every task of
      // the projects.
      `SELECT project_id, sum(added)::int AS added, sum(done)::int AS done FROM (
         SELECT t.project_id, 1 AS added, 0 AS done FROM tasks t
          WHERE t.project_id = ANY($1::text[]) AND t.parent_id IS NULL AND t.created_at >= now() - interval '7 days'
         UNION ALL
         SELECT t.project_id, 0, 1 FROM tasks t
          WHERE t.project_id = ANY($1::text[]) AND t.parent_id IS NULL AND t.status = 'done' AND t.completed_at >= now() - interval '7 days'
       ) x GROUP BY 1`,
      [ids],
    )
  ).rows;
  const weeksList = await mondays(c, n);
  for (const id of ids) {
    const mine = rows.filter((r) => r.project_id === id);
    const f = flight.find((r) => r.project_id === id);
    const r = recent.find((x) => x.project_id === id);
    out.set(
      id,
      flowOf(weeksList, mine, f ? { inProgress: f.in_progress, stuck: f.stuck } : { inProgress: 0, stuck: 0 }, r ? { done: r.done, added: r.added } : { done: 0, added: 0 }),
    );
  }
  return out;
}

export interface ProjectFlow {
  done: number[];
  added: number[];
  thisWeek: { done: number; added: number };
  inProgress: number;
  stuck: number;
}

/** Lays sparse (week, done, added) rows onto the full list of weeks, oldest first, so every week has a number. */
export function flowOf(
  weeks: string[],
  rows: { week: string; done: number; added: number }[],
  now: { inProgress: number; stuck: number },
  recent?: { done: number; added: number },
): ProjectFlow {
  const done = weeks.map((w) => rows.find((r) => r.week === w)?.done ?? 0);
  const added = weeks.map((w) => rows.find((r) => r.week === w)?.added ?? 0);
  return { done, added, thisWeek: recent ?? { done: done.at(-1) ?? 0, added: added.at(-1) ?? 0 }, ...now };
}

/** Parses `project:<id>`, `person:<id>`, `department:<id or name>`, `workspace`. */
export function parseScope(s: string | undefined): { kind: "project" | "person" | "department"; id: string } | { kind: "workspace" } | null {
  if (!s || s === "workspace") return { kind: "workspace" };
  if (typeof s !== "string") return null;
  const i = s.indexOf(":");
  if (i < 1) return null;
  const kind = s.slice(0, i);
  const id = s.slice(i + 1).trim();
  if (!id || id.length > 200) return null;
  if (kind === "project" || kind === "person" || kind === "department") return { kind, id };
  return null;
}

export interface AttentionRow {
  id: string;
  code: string;
  title: string;
  status: string;
  project_id: string | null;
  owner_id: string;
  assignee_id: string | null;
  team_id: string | null;
  due_at: Date | null;
  since: Date | null;
}

/**
 * The open tasks behind "overdue" and "stuck", worst first (longest overdue, then longest without a status change),
 * for the Overview's "needs attention". The caller filters what the viewer may read before showing any.
 */
export async function attention(c: PoolClient, scope: VelocityScope, limit = 40): Promise<AttentionRow[]> {
  if (scope.kind === "people" && !scope.ids.length) return [];
  const w = where(scope, 3);
  return (
    await c.query<AttentionRow>(
      `SELECT t.id, t.code, t.title, t.status, t.project_id, t.owner_id, t.assignee_id, t.team_id, t.due_at,
              coalesce(t.status_changed_at, t.updated_at) AS since
         FROM tasks t
        WHERE ${w.sql} AND t.status IN ('todo','in_progress','review')
          AND (t.due_at < now()
            OR (t.status IN ('in_progress','review') AND coalesce(t.status_changed_at, t.updated_at) < now() - make_interval(days => $1)))
        ORDER BY (t.due_at < now()) DESC NULLS LAST, t.due_at ASC NULLS LAST, coalesce(t.status_changed_at, t.updated_at) ASC
        LIMIT $2`,
      [STUCK_DAYS, limit, ...w.args],
    )
  ).rows;
}

/** What got done since Monday (workspace time), newest first: the "what moved" of a weekly status update. */
export async function doneThisWeek(c: PoolClient, scope: VelocityScope, limit = 30): Promise<Omit<AttentionRow, "since">[]> {
  if (scope.kind === "people" && !scope.ids.length) return [];
  const w = where(scope, 2);
  return (
    await c.query<Omit<AttentionRow, "since">>(
      `SELECT t.id, t.code, t.title, t.status, t.project_id, t.owner_id, t.assignee_id, t.team_id, t.due_at
         FROM tasks t
        WHERE ${w.sql} AND t.status = 'done'
          AND t.completed_at >= (date_trunc('week', now() AT TIME ZONE ${TZ_SQL}) AT TIME ZONE ${TZ_SQL})
        ORDER BY t.completed_at DESC LIMIT $1`,
      [limit, ...w.args],
    )
  ).rows;
}
