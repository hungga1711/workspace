import type { PoolClient } from "pg";

/**
 * A step's activity: what the agent does while the step
 * runs, a line at a time, kept in `task_agent_run_events` and read by the pipeline as it grows.
 *
 *   start    the step begins an attempt (the engine); a command step's line is the command
 *   say      what the agent wrote between two actions
 *   tool     an action: `tool` its name as the agent calls it (Read, Bash, "server › tool"), `text` what it acts on
 *   result   how the last action ended; `detail` what it printed, when that is worth keeping
 *   error    an action, or the step, failed
 *   note     a line from whoever drives the step (the runner, the engine)
 *   draft    the answer as it is being written: one per step, replaced as it grows, gone when the step ends
 *
 * Who writes: a runner with every report of the step in progress (reportLocalStep), the ai module for a step of the
 * company's AI (noteServerStep), the engine for starts and failures.
 */
export const ACTIVITY_KINDS = ["start", "say", "tool", "result", "error", "note", "draft"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
export interface ActivityInput {
  kind: ActivityKind;
  tool?: string | undefined;
  text?: string | undefined;
  detail?: string | undefined;
}

export const ACTIVITY_TEXT = 400;
export const ACTIVITY_DETAIL = 2000;
/** The latest lines kept per step: enough for a long coding session, small enough to read back in one go. */
export const STEP_MAX = 1500;
const PAGE = 400;
const TIMELINE_PAGE = 1000;

// Postgres text holds no NUL, and a process's output may.
const clean = (s: string | undefined, n: number) => {
  const t = (s ?? "").replaceAll("\u0000", "");
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** Adds lines to a step's activity, in order. A draft replaces the step's earlier draft. */
export async function addActivity(c: PoolClient, runId: string, step: number, events: ActivityInput[]): Promise<void> {
  if (!events.length) return;
  const lastDraft = events.filter((e) => e.kind === "draft").at(-1);
  const rows = events.filter((e) => e.kind !== "draft" || e === lastDraft);
  if (lastDraft) await clearDraft(c, runId, step);
  await c.query(
    `INSERT INTO task_agent_run_events (run_id, step, kind, tool, text, detail)
     SELECT $1, $2, e.kind, e.tool, e.text, e.detail
       FROM unnest($3::text[], $4::text[], $5::text[], $6::text[]) WITH ORDINALITY AS e(kind, tool, text, detail, n)
      ORDER BY e.n`,
    [
      runId,
      step,
      rows.map((e) => e.kind),
      rows.map((e) => clean(e.tool, 120) || null),
      rows.map((e) => clean(e.text, ACTIVITY_TEXT)),
      rows.map((e) => clean(e.detail, ACTIVITY_DETAIL) || null),
    ],
  );
  await c.query(
    `DELETE FROM task_agent_run_events
      WHERE run_id = $1 AND step = $2
        AND id <= (SELECT id FROM task_agent_run_events WHERE run_id = $1 AND step = $2 ORDER BY id DESC OFFSET $3 LIMIT 1)`,
    [runId, step, STEP_MAX],
  );
}

/** The step's answer is in: what was shown of it being written goes. */
export async function clearDraft(c: PoolClient, runId: string, step: number): Promise<void> {
  await c.query("DELETE FROM task_agent_run_events WHERE run_id = $1 AND step = $2 AND kind = 'draft'", [runId, step]);
}

interface EventRow {
  id: string;
  run_id: string;
  step: number;
  at: Date;
  kind: ActivityKind;
  tool: string | null;
  text: string;
  detail: string | null;
}
const dto = (r: EventRow) => ({ id: Number(r.id), step: r.step, at: r.at, kind: r.kind, tool: r.tool, text: r.text, ...(r.detail ? { detail: r.detail } : {}) });
export type ActivityEvent = ReturnType<typeof dto>;

/**
 * A step's lines, oldest first. Without `after`: the latest page (a long step opens at its end). With it: the lines
 * since that one, which is how the pipeline follows a step at work; a draft that was replaced comes back with a new id.
 */
export async function readActivity(c: PoolClient, runId: string, step: number, after?: number): Promise<{ events: ActivityEvent[]; more: boolean }> {
  if (after !== undefined) {
    const r = await c.query<EventRow>("SELECT * FROM task_agent_run_events WHERE run_id = $1 AND step = $2 AND id > $3 ORDER BY id LIMIT $4", [runId, step, after, PAGE + 1]);
    return { events: r.rows.slice(0, PAGE).map(dto), more: r.rows.length > PAGE };
  }
  const r = await c.query<EventRow>("SELECT * FROM task_agent_run_events WHERE run_id = $1 AND step = $2 ORDER BY id DESC LIMIT $3", [runId, step, PAGE + 1]);
  return { events: r.rows.slice(0, PAGE).reverse().map(dto), more: r.rows.length > PAGE };
}

/**
 * A whole run's lines across its steps, in the order they happened, a page at a time (`after`: the last id read). For
 * the run's timeline, which replays the run from its start. The answer being written ("draft") is not history.
 */
export async function readRunActivity(c: PoolClient, runId: string, after = 0): Promise<{ events: ActivityEvent[]; more: boolean }> {
  const r = await c.query<EventRow>("SELECT * FROM task_agent_run_events WHERE run_id = $1 AND id > $2 AND kind <> 'draft' ORDER BY id LIMIT $3", [
    runId,
    after,
    TIMELINE_PAGE + 1,
  ]);
  return { events: r.rows.slice(0, TIMELINE_PAGE).map(dto), more: r.rows.length > TIMELINE_PAGE };
}

/** What each run's step at work is doing right now: its latest action, words or draft (by run id). */
export async function latestActivity(c: PoolClient, at: { runId: string; step: number }[]): Promise<Map<string, ActivityEvent>> {
  if (!at.length) return new Map();
  const r = await c.query<EventRow>(
    `SELECT DISTINCT ON (e.run_id) e.*
       FROM task_agent_run_events e
       JOIN unnest($1::text[], $2::int[]) AS w(run_id, step) ON w.run_id = e.run_id AND w.step = e.step
      WHERE e.kind IN ('tool', 'say', 'draft')
        -- Of the attempt in progress only: a step sent back does not show what its first try was doing.
        AND e.id > COALESCE((SELECT max(s.id) FROM task_agent_run_events s WHERE s.run_id = e.run_id AND s.step = e.step AND s.kind = 'start'), 0)
      ORDER BY e.run_id, e.id DESC`,
    [at.map((x) => x.runId), at.map((x) => x.step)],
  );
  return new Map(r.rows.map((row) => [row.run_id, dto(row)]));
}
