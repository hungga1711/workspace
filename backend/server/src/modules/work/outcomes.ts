import type { PoolClient } from "pg";
import { TZ_SQL } from "./settings.js";

/**
 * Outcomes: what each person got done, for the boss's other question next to AI use ("does the AI we
 * pay for help people get work done?"). Công việc › AI puts these numbers beside each person's AI use.
 *
 *  - per person in the window: tasks finished, how many of the dated ones landed on time (by the end of
 *    the due day), median days from creation to done, and what is open / late now;
 *  - per week for the last 8 weeks (from Monday, in the workspace's zone): tasks finished by these people, for the trend
 *    next to AI use.
 *
 *  - tasks finished in the window with the company AI's help (any AI call on the task before it was done,
 *    projected from the ai module into task_ai_assists, ADR 0011) against those finished without: how many, how
 *    many on time, median days to done. This is the direct answer to "does AI help?"; the per-person view
 *    (frequent AI users against the rest) sits beside it.
 *
 * Same privacy rule as Follow-up: a person's own private to-dos (no project, made for themselves) stay out.
 */
const OUTCOME_WEEKS = 8;
const VISIBLE = "assignee_id = ANY($1::text[]) AND NOT (project_id IS NULL AND owner_id = assignee_id)";

export interface PersonOutcome {
  userId: string;
  done: number;
  dated: number;
  onTime: number;
  cycleDays: number | null;
  open: number;
  overdue: number;
}

export interface TaskGroup {
  done: number;
  dated: number;
  onTime: number;
  cycleDays: number | null;
}
export interface Weekly {
  week: string;
  done: number;
  dated: number;
  onTime: number;
  aiDone: number;
}

const NO_GROUP: TaskGroup = { done: 0, dated: 0, onTime: 0, cycleDays: null };

export async function outcomes(c: PoolClient, ids: string[], days: number) {
  if (!ids.length) return { days, people: [] as PersonOutcome[], weekly: [] as Weekly[], withAi: { assisted: NO_GROUP, other: NO_GROUP } };
  const rows = (
    await c.query<PersonOutcome>(
      `SELECT assignee_id AS "userId",
              count(*) FILTER (WHERE status = 'done' AND completed_at > now() - make_interval(days => $2))::int AS done,
              count(*) FILTER (WHERE status = 'done' AND completed_at > now() - make_interval(days => $2) AND due_at IS NOT NULL)::int AS dated,
              count(*) FILTER (WHERE status = 'done' AND completed_at > now() - make_interval(days => $2) AND due_at IS NOT NULL
                                 AND completed_at < date_trunc('day', due_at AT TIME ZONE ${TZ_SQL}) AT TIME ZONE ${TZ_SQL} + interval '1 day')::int AS "onTime",
              round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM completed_at - created_at) / 86400)
                       FILTER (WHERE status = 'done' AND completed_at > now() - make_interval(days => $2)))::numeric, 1)::float AS "cycleDays",
              count(*) FILTER (WHERE status IN ('todo','in_progress','review'))::int AS open,
              count(*) FILTER (WHERE status IN ('todo','in_progress','review') AND due_at < now())::int AS overdue
         FROM tasks
        WHERE ${VISIBLE}
          AND (status IN ('todo','in_progress','review') OR (status = 'done' AND completed_at > now() - make_interval(days => $2)))
        GROUP BY assignee_id`,
      [ids, days],
    )
  ).rows;
  // Everyone asked about gets a row: no tasks is an answer (0 done), not a missing person.
  const byId = new Map(rows.map((r) => [r.userId, r]));
  const people = ids.map((userId) => byId.get(userId) ?? { userId, done: 0, dated: 0, onTime: 0, cycleDays: null, open: 0, overdue: 0 });
  const weekly = (
    await c.query<Weekly>(
      `WITH w AS (
         SELECT generate_series(date_trunc('week', now() AT TIME ZONE ${TZ_SQL}) - interval '${OUTCOME_WEEKS - 1} weeks',
                                date_trunc('week', now() AT TIME ZONE ${TZ_SQL}), interval '1 week') AS week)
       SELECT to_char(w.week, 'YYYY-MM-DD') AS week,
              count(t.id)::int AS done,
              count(t.id) FILTER (WHERE a.first_at <= t.completed_at)::int AS "aiDone",
              count(t.id) FILTER (WHERE t.due_at IS NOT NULL)::int AS dated,
              count(t.id) FILTER (WHERE t.due_at IS NOT NULL
                                    AND t.completed_at < date_trunc('day', t.due_at AT TIME ZONE ${TZ_SQL}) AT TIME ZONE ${TZ_SQL} + interval '1 day')::int AS "onTime"
         FROM w LEFT JOIN tasks t
           ON t.status = 'done' AND t.assignee_id = ANY($1::text[]) AND NOT (t.project_id IS NULL AND t.owner_id = t.assignee_id)
          -- bounded: only the charted weeks, so the join never reads every task these people ever finished
          AND t.completed_at > now() - interval '${OUTCOME_WEEKS + 1} weeks'
          AND date_trunc('week', t.completed_at AT TIME ZONE ${TZ_SQL}) = w.week
         LEFT JOIN task_ai_assists a ON a.task_id = t.id
        GROUP BY w.week ORDER BY w.week`,
      [ids],
    )
  ).rows;
  const groups = (
    await c.query<TaskGroup & { assisted: boolean }>(
      `SELECT (a.first_at IS NOT NULL AND a.first_at <= t.completed_at) AS assisted,
              count(*)::int AS done,
              count(*) FILTER (WHERE t.due_at IS NOT NULL)::int AS dated,
              count(*) FILTER (WHERE t.due_at IS NOT NULL
                                 AND t.completed_at < date_trunc('day', t.due_at AT TIME ZONE ${TZ_SQL}) AT TIME ZONE ${TZ_SQL} + interval '1 day')::int AS "onTime",
              round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM t.completed_at - t.created_at) / 86400))::numeric, 1)::float AS "cycleDays"
         FROM tasks t LEFT JOIN task_ai_assists a ON a.task_id = t.id
        WHERE t.assignee_id = ANY($1::text[]) AND NOT (t.project_id IS NULL AND t.owner_id = t.assignee_id)
          AND t.status = 'done' AND t.completed_at > now() - make_interval(days => $2)
        GROUP BY 1`,
      [ids, days],
    )
  ).rows;
  const group = (assisted: boolean): TaskGroup => {
    const g = groups.find((x) => x.assisted === assisted);
    return g ? { done: g.done, dated: g.dated, onTime: g.onTime, cycleDays: g.cycleDays } : NO_GROUP;
  };
  return { days, people, weekly, withAi: { assisted: group(true), other: group(false) } };
}

export interface ProjectAiTask {
  id: string;
  code: string;
  title: string;
  status: string;
  assigneeId: string | null;
  dueAt: string | null;
  completedAt: string | null;
  overdue: boolean;
  /** Days from creation to done, for finished tasks. */
  cycleDays: number | null;
  /** Finished by the end of the due day; null when undated or open. */
  onTime: boolean | null;
  /** The company AI's help on the task (task_ai_assists), when it had any before it was done. */
  ai: { calls: number; people: number; firstAt: string } | null;
}
export interface ProjectAi {
  id: string;
  code: string;
  name: string;
  tasks: number;
  aiTasks: number;
  assisted: TaskGroup;
  other: TaskGroup;
  aiCalls: number;
  aiPeople: string[];
  list: ProjectAiTask[];
}

/**
 * Áp dụng AI, per project: of the tasks these people have open or finished in the window, which had the company AI's
 * help (task_ai_assists before the task was done), and how those finished against the rest (median days, on time).
 * Each project carries its tasks, AI-helped first, so the page opens a project into its tasks without another call.
 * Same privacy rule as the rest of the outcomes: private to-dos have no project, so they never show here.
 */
export async function aiByProject(
  c: PoolClient,
  ids: string[],
  days: number,
  perProject = 40,
): Promise<{ projects: ProjectAi[]; total: { tasks: number; aiTasks: number; assisted: TaskGroup; other: TaskGroup } }> {
  const total = { tasks: 0, aiTasks: 0, assisted: { ...NO_GROUP }, other: { ...NO_GROUP } };
  if (!ids.length) return { projects: [], total };
  const all = { a: [] as number[], o: [] as number[] };
  const rows = (
    await c.query<{
      id: string;
      code: string;
      title: string;
      status: string;
      assigneeId: string | null;
      dueAt: Date | null;
      completedAt: Date | null;
      createdAt: Date;
      projectId: string;
      projectCode: string;
      projectName: string;
      calls: number | null;
      people: string[] | null;
      firstAt: Date | null;
    }>(
      `SELECT t.id, t.code, t.title, t.status, t.assignee_id AS "assigneeId", t.due_at AS "dueAt", t.completed_at AS "completedAt",
              t.created_at AS "createdAt", p.id AS "projectId", p.code AS "projectCode", p.name AS "projectName",
              a.calls, a.people, a.first_at AS "firstAt"
         FROM tasks t JOIN projects p ON p.id = t.project_id AND p.status = 'active'
         LEFT JOIN task_ai_assists a ON a.task_id = t.id AND (t.completed_at IS NULL OR a.first_at <= t.completed_at)
        WHERE t.assignee_id = ANY($1::text[])
          AND (t.status IN ('todo','in_progress','review') OR (t.status = 'done' AND t.completed_at > now() - make_interval(days => $2)))`,
      [ids, days],
    )
  ).rows;
  // The due day ends at midnight in the workspace's zone; a day of slack keeps the check simple and matches the SQL above.
  const endOfDue = (d: Date) => d.getTime() + 86_400_000;
  const now = Date.now();
  const byProject = new Map<string, ProjectAi & { cyc: { a: number[]; o: number[] } }>();
  for (const r of rows) {
    let p = byProject.get(r.projectId);
    if (!p) {
      p = {
        id: r.projectId,
        code: r.projectCode,
        name: r.projectName,
        tasks: 0,
        aiTasks: 0,
        assisted: { ...NO_GROUP },
        other: { ...NO_GROUP },
        aiCalls: 0,
        aiPeople: [],
        list: [],
        cyc: { a: [], o: [] },
      };
      byProject.set(r.projectId, p);
    }
    const ai = r.calls ? { calls: r.calls, people: r.people?.length ?? 0, firstAt: r.firstAt!.toISOString() } : null;
    const done = r.status === "done" && r.completedAt;
    const cycleDays = done ? Math.round(((r.completedAt!.getTime() - r.createdAt.getTime()) / 86_400_000) * 10) / 10 : null;
    const onTime = done && r.dueAt ? r.completedAt!.getTime() < endOfDue(r.dueAt) : null;
    p.tasks++;
    total.tasks++;
    if (ai) total.aiTasks++;
    if (ai) {
      p.aiTasks++;
      p.aiCalls += ai.calls;
      for (const u of r.people ?? []) if (!p.aiPeople.includes(u)) p.aiPeople.push(u);
    }
    if (done) {
      const g = ai ? p.assisted : p.other;
      g.done++;
      if (r.dueAt) {
        g.dated++;
        if (onTime) g.onTime++;
      }
      (ai ? p.cyc.a : p.cyc.o).push(cycleDays!);
      const t = ai ? total.assisted : total.other;
      t.done++;
      if (r.dueAt) {
        t.dated++;
        if (onTime) t.onTime++;
      }
      (ai ? all.a : all.o).push(cycleDays!);
    }
    p.list.push({
      id: r.id,
      code: r.code,
      title: r.title,
      status: r.status,
      assigneeId: r.assigneeId,
      dueAt: r.dueAt?.toISOString() ?? null,
      completedAt: r.completedAt?.toISOString() ?? null,
      overdue: !done && !!r.dueAt && endOfDue(r.dueAt) < now,
      cycleDays,
      onTime,
      ai,
    });
  }
  const median = (xs: number[]) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return Math.round((s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2) * 10) / 10;
  };
  total.assisted.cycleDays = median(all.a);
  total.other.cycleDays = median(all.o);
  const projects = [...byProject.values()]
    .map(({ cyc, ...p }) => ({
      ...p,
      assisted: { ...p.assisted, cycleDays: median(cyc.a) },
      other: { ...p.other, cycleDays: median(cyc.o) },
      // AI-helped first (most calls), then open before done, then the latest.
      list: p.list
        .sort(
          (a, b) =>
            Number(!a.ai) - Number(!b.ai) ||
            (b.ai?.calls ?? 0) - (a.ai?.calls ?? 0) ||
            Number(a.status === "done") - Number(b.status === "done") ||
            (b.completedAt ?? "").localeCompare(a.completedAt ?? ""),
        )
        .slice(0, perProject),
    }))
    .sort((a, b) => b.aiTasks - a.aiTasks || b.tasks - a.tasks);
  return { projects, total };
}
