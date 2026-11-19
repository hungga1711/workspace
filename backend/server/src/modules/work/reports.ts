import type { PoolClient } from "pg";
import { TZ_SQL } from "./settings.js";
import type { VelocityScope } from "./velocity.js";

/**
 * Report reads behind the assistant's boss-visibility tools (ai/tools-reports.ts): what is blocked and
 * on what, output per person against the window before, and how many tasks were overdue at the end of each week.
 * Counts and task heads only; the controller filters rows by what the caller may read.
 */

/** Top-level tasks only, as velocity.ts counts them: a subtask is a step of a task. */
function scopeSql(scope: VelocityScope, first: number): { sql: string; args: unknown[] } {
  if (scope.kind === "project") return { sql: `t.project_id = $${first} AND t.parent_id IS NULL`, args: [scope.id] };
  if (scope.kind === "people") return { sql: `t.assignee_id = ANY($${first}::text[]) AND t.parent_id IS NULL`, args: [scope.ids] };
  return { sql: `t.parent_id IS NULL`, args: [] };
}

/**
 * Tasks overdue at the end of each of the last `weeks` weeks (Monday-based in the workspace's zone; the current
 * week ends now): due before that moment, created before it, and not finished by then. Cancelled tasks are left out.
 */
export async function overdueTrend(c: PoolClient, scope: VelocityScope, weeks: number): Promise<{ week: string; overdue: number }[]> {
  const n = Math.min(Math.max(Math.trunc(weeks) || 8, 1), 26);
  if (scope.kind === "people" && !scope.ids.length) return [];
  const w = scopeSql(scope, 2);
  return (
    await c.query<{ week: string; overdue: number }>(
      `WITH tz AS (SELECT ${TZ_SQL} AS z),
            wk AS (SELECT g AS w, least(((g + interval '1 week') AT TIME ZONE tz.z), now()) AS at
                     FROM tz, generate_series(date_trunc('week', now() AT TIME ZONE tz.z) - make_interval(weeks => $1 - 1),
                                              date_trunc('week', now() AT TIME ZONE tz.z), interval '1 week') g),
            -- One pass over the tasks that can be overdue in any of the weeks, then counted per week (a scan per
            -- week took 53 ms on 20k tasks, this 20 ms).
            c AS MATERIALIZED (
              SELECT t.due_at, t.created_at, t.completed_at FROM tasks t
               WHERE ${w.sql} AND t.status <> 'cancelled' AND t.due_at < now()
                 AND (t.completed_at IS NULL OR t.completed_at >= (SELECT min(at) FROM wk)))
       SELECT to_char(wk.w, 'YYYY-MM-DD') AS week, count(c.due_at)::int AS overdue
         FROM wk LEFT JOIN c ON c.due_at < wk.at AND c.created_at < wk.at AND (c.completed_at IS NULL OR c.completed_at >= wk.at)
        GROUP BY wk.w ORDER BY wk.w`,
      [n, ...w.args],
    )
  ).rows;
}

export interface BlockedRow {
  id: string;
  code: string;
  title: string;
  status: string;
  project_id: string | null;
  owner_id: string;
  assignee_id: string | null;
  team_id: string | null;
  due_at: Date | null;
  blocked_reason: string | null;
  /** When the reason was set (the last activity that set it), else when the task last changed. */
  since: Date;
}
export interface DependencyEdge {
  from: string;
  to: string;
  created_at: Date;
}

/**
 * Open top-level and subtasks that are blocked: a reason set, or waiting on an open predecessor. Also every
 * dependency edge between open tasks, so the chains can be followed (blockerChains).
 */
export async function blockedTasks(c: PoolClient): Promise<{ tasks: BlockedRow[]; edges: DependencyEdge[] }> {
  const edges = (
    await c.query<DependencyEdge>(
      `SELECT d.predecessor_id AS "from", d.successor_id AS "to", d.created_at
         FROM task_dependencies d JOIN tasks a ON a.id = d.predecessor_id JOIN tasks b ON b.id = d.successor_id
        WHERE a.status IN ('todo','in_progress','review') AND b.status IN ('todo','in_progress','review')
        LIMIT 5000`,
    )
  ).rows;
  const tasks = (
    await c.query<BlockedRow>(
      `SELECT t.id, t.code, t.title, t.status, t.project_id, t.owner_id, t.assignee_id, t.team_id, t.due_at, t.blocked_reason,
              coalesce((SELECT max(a.at) FROM activity a
                         WHERE a.entity_type = 'task' AND a.entity_id = t.id AND a.changes ? 'blocked_reason'
                           AND a.changes->'blocked_reason'->>'to' IS NOT NULL),
                       (SELECT min(d.created_at) FROM task_dependencies d WHERE d.successor_id = t.id),
                       t.updated_at) AS since
         FROM tasks t
        WHERE t.status IN ('todo','in_progress','review')
          -- IN (unnest) is a hashed lookup; "= ANY(array)" inside the OR compared every open task with every id
          -- (20k tasks × 2k waiting ones: 177 ms against 14 ms).
          AND (t.blocked_reason IS NOT NULL OR t.id IN (SELECT unnest($1::text[])))
        ORDER BY since
        LIMIT 500`,
      [[...new Set(edges.map((e) => e.to))]],
    )
  ).rows;
  // Everything on a chain, blocked itself or not, so a chain can name its first link.
  const ids = [...new Set(edges.flatMap((e) => [e.from, e.to]))].filter((id) => !tasks.some((t) => t.id === id));
  const more = ids.length
    ? (
        await c.query<BlockedRow>(
          `SELECT t.id, t.code, t.title, t.status, t.project_id, t.owner_id, t.assignee_id, t.team_id, t.due_at, t.blocked_reason, t.updated_at AS since
             FROM tasks t WHERE t.id = ANY($1::text[])`,
          [ids],
        )
      ).rows
    : [];
  return { tasks: [...tasks, ...more], edges };
}

export interface Chain {
  id: string;
  /** Open predecessors, nearest first, followed upstream (at most `depth` links). */
  waitingOn: string[];
  /** Open tasks downstream that wait on this one, directly or through others. */
  holdsUp: number;
}

/**
 * For each blocked task, the chain of open predecessors it waits on (the first one found at each step, so a chain
 * reads as one line) and how many open tasks wait on it in turn. Cycles stop at the first repeat.
 */
export function blockerChains(blocked: string[], edges: { from: string; to: string }[], depth = 5): Chain[] {
  const preds = new Map<string, string[]>();
  const succs = new Map<string, string[]>();
  for (const e of edges) {
    preds.set(e.to, [...(preds.get(e.to) ?? []), e.from]);
    succs.set(e.from, [...(succs.get(e.from) ?? []), e.to]);
  }
  return blocked.map((id) => {
    const waitingOn: string[] = [];
    const seen = new Set([id]);
    let at = id;
    while (waitingOn.length < depth) {
      const next = (preds.get(at) ?? []).find((x) => !seen.has(x));
      if (!next) break;
      waitingOn.push(next);
      seen.add(next);
      at = next;
    }
    const down = new Set<string>();
    const queue = [...(succs.get(id) ?? [])];
    while (queue.length && down.size < 1000) {
      const x = queue.shift()!;
      if (x === id || down.has(x)) continue;
      down.add(x);
      queue.push(...(succs.get(x) ?? []));
    }
    return { id, waitingOn, holdsUp: down.size };
  });
}

export interface OutputRow {
  userId: string;
  done: number;
  donePrev: number;
  dated: number;
  onTime: number;
}

/** Done per person in the last `days` and in the `days` before, and how many of this window's were on time. */
export async function outputWindows(c: PoolClient, ids: string[], days: number): Promise<OutputRow[]> {
  if (!ids.length) return [];
  return (
    await c.query<OutputRow>(
      `SELECT assignee_id AS "userId",
              count(*) FILTER (WHERE completed_at > now() - make_interval(days => $2))::int AS done,
              count(*) FILTER (WHERE completed_at <= now() - make_interval(days => $2))::int AS "donePrev",
              count(*) FILTER (WHERE completed_at > now() - make_interval(days => $2) AND due_at IS NOT NULL)::int AS dated,
              count(*) FILTER (WHERE completed_at > now() - make_interval(days => $2) AND due_at IS NOT NULL
                                 AND completed_at < date_trunc('day', due_at AT TIME ZONE ${TZ_SQL}) AT TIME ZONE ${TZ_SQL} + interval '1 day')::int AS "onTime"
         FROM tasks
        WHERE assignee_id = ANY($1::text[]) AND status = 'done' AND completed_at > now() - make_interval(days => $2 * 2)
          AND NOT (project_id IS NULL AND owner_id = assignee_id)
        GROUP BY assignee_id`,
      [ids, days],
    )
  ).rows;
}
