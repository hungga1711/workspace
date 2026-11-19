import type { PoolClient } from "pg";
import type { Principal } from "@workspace/shared";
import { canReadTask } from "../tasks.js";

/**
 * How the workflows perform (AI › Workflows › Performance): what each one costs in tokens, how long it
 * takes and where the time goes (working against waiting for people), which steps fail or are sent back, which checks
 * send work back, and what to change. Everything is counted from the runs themselves (`task_agent_runs.steps`), by
 * rules; no model is asked.
 *
 * What is not known is said, never guessed: a step run by an agent on someone's computer reports no tokens, so its
 * tokens are "unknown", not zero. Money is not computed here: the ai module owns the prices, so the tokens are given
 * per model and the page asks it what they cost (ai `spend/quote`).
 *
 * Bounded like `workflowActivity`: one read of the runs in the window (newest first, at most RUNS_MAX), each step cut
 * down in SQL to its figures (never its text), and every run filtered by who may read its task.
 */
export const WINDOWS = [7, 30, 90] as const;
export const RUNS_MAX = 3000;

/** One step of one run, as the read cuts it down. */
export interface StepFacts {
  key?: string;
  title?: string;
  kind?: "ai" | "command" | "check" | "approval" | "status";
  state?: string;
  startedAt?: string;
  finishedAt?: string;
  waitedMs?: number;
  /** The model the workflow asks for: absent or "" is the company's main model, "fast" its fast one. */
  model?: string;
  outChars?: number;
  ranModel?: string;
  provider?: string;
  /** The step's log, each line as kind, outcome and the tokens of that attempt. */
  h?: { k: string; o?: string; i?: number; t?: number; m?: string }[];
}
export interface RunFacts {
  id: string;
  workflow_id: string | null;
  workflow_name: string;
  runner: "server" | "local";
  status: string;
  created_at: Date;
  finished_at: Date | null;
  steps: StepFacts[] | null;
}

export interface StepInsight {
  key: string;
  title: string;
  kind: NonNullable<StepFacts["kind"]>;
  /** Runs in which the step started. */
  runs: number;
  done: number;
  failed: number;
  /** ai, command: times its result was sent back (by a check or a person). check: times it sent work back. */
  sentBack: number;
  /** check: runs in which it did not pass at least once. */
  notPassed: number;
  retried: number;
  avgSec: number | null;
  /** Average wait for people at this step (an approval's whole time; an AI step's questions). */
  avgWaitSec: number | null;
  tokens: { input: number; output: number };
  /** Runs where the step worked with an AI and no token count came back. */
  tokensUnknown: number;
  avgOutputTokens: number | null;
  avgOutChars: number | null;
  /** The models that answered, most used first. */
  models: string[];
}
export interface Suggestion {
  rule: "check_sends_back" | "step_fails" | "fast_model" | "waits_for_people" | "step_reads_much" | "step_slow";
  stepKey?: string;
  step?: string;
  /** check_sends_back: the step whose result the check judges. */
  author?: string;
  pct?: number;
  minutes?: number;
}
export interface WorkflowInsight {
  id: string | null;
  name: string;
  runs: number;
  done: number;
  failed: number;
  cancelled: number;
  active: number;
  tokens: { input: number; output: number };
  /** Runs with at least one AI step whose tokens are not known. */
  tokensUnknownRuns: number;
  /** Tokens by the model that answered, for pricing. */
  models: { provider: string | null; model: string; input: number; output: number }[];
  /** Over finished runs: the whole run, the part spent working and the part spent waiting for people. */
  avgSec: number | null;
  avgWorkSec: number | null;
  avgWaitSec: number | null;
  sentBack: number;
  steps: StepInsight[];
  suggestions: Suggestion[];
}
export interface Insights {
  days: number;
  /** The window held more runs than are read: the figures are of the newest RUNS_MAX. */
  capped: boolean;
  totals: { runs: number; done: number; failed: number; tokens: { input: number; output: number }; tokensUnknownRuns: number; workSec: number; waitSec: number; sentBack: number };
  daily: { day: string; runs: number; failed: number; tokens: number }[];
  workflows: WorkflowInsight[];
}

const AI_KINDS = new Set(["ai", "check"]);
const sec = (from?: string, to?: string) => (from && to ? Math.max(0, (Date.parse(to) - Date.parse(from)) / 1000) : null);
const avg = (sum: number, n: number) => (n ? Math.round(sum / n) : null);

type StepAcc = StepInsight & {
  timed: number;
  totalSec: number;
  waited: number;
  waitSec: number;
  outN: number;
  outTok: number;
  outChars: number;
  charN: number;
  by: Map<string, number>;
};
type FlowAcc = Omit<WorkflowInsight, "steps" | "suggestions" | "models" | "avgSec" | "avgWorkSec" | "avgWaitSec"> & {
  steps: Map<string, StepAcc>;
  order: string[];
  models: Map<string, { provider: string | null; model: string; input: number; output: number }>;
  finished: number;
  totalSec: number;
  workSec: number;
  waitSec: number;
};

/** The runs as figures per workflow, most tokens first (then most runs). Pure: the read and the visibility filter are the caller's. */
export function summarize(runs: RunFacts[], days: number, capped = false): Insights {
  const flows = new Map<string, FlowAcc>();
  const daily = new Map<string, { day: string; runs: number; failed: number; tokens: number }>();
  const totals: Insights["totals"] = { runs: 0, done: 0, failed: 0, tokens: { input: 0, output: 0 }, tokensUnknownRuns: 0, workSec: 0, waitSec: 0, sentBack: 0 };

  for (const r of runs) {
    const id = r.workflow_id ?? `name:${r.workflow_name}`;
    let f = flows.get(id);
    if (!f) {
      f = {
        id: r.workflow_id,
        name: r.workflow_name,
        runs: 0,
        done: 0,
        failed: 0,
        cancelled: 0,
        active: 0,
        tokens: { input: 0, output: 0 },
        tokensUnknownRuns: 0,
        sentBack: 0,
        steps: new Map(),
        order: [],
        models: new Map(),
        finished: 0,
        totalSec: 0,
        workSec: 0,
        waitSec: 0,
      };
      flows.set(id, f);
    }
    f.runs++;
    totals.runs++;
    if (r.status === "done") f.done++;
    else if (r.status === "failed") f.failed++;
    else if (r.status === "cancelled") f.cancelled++;
    else f.active++;

    let runIn = 0;
    let runOut = 0;
    let unknown = false;
    let work = 0;
    let wait = 0;
    for (const s of r.steps ?? []) {
      if (!s.key || !s.kind || s.kind === "status") continue;
      const attempts = (s.h ?? []).filter((e) => e.k === "attempt");
      const started = !!s.startedAt || attempts.length > 0 || (s.state && s.state !== "pending");
      if (!started) continue;
      let a = f.steps.get(s.key);
      if (!a) {
        a = {
          key: s.key,
          title: s.title ?? s.key,
          kind: s.kind,
          runs: 0,
          done: 0,
          failed: 0,
          sentBack: 0,
          notPassed: 0,
          retried: 0,
          avgSec: null,
          avgWaitSec: null,
          tokens: { input: 0, output: 0 },
          tokensUnknown: 0,
          avgOutputTokens: null,
          avgOutChars: null,
          models: [],
          timed: 0,
          totalSec: 0,
          waited: 0,
          waitSec: 0,
          outN: 0,
          outTok: 0,
          outChars: 0,
          charN: 0,
          by: new Map(),
        };
        f.steps.set(s.key, a);
        f.order.push(s.key);
      }
      // The newest run is read first: its name for the step is the current one.
      a.runs++;
      if (s.state === "done") a.done++;
      if (s.state === "failed") a.failed++;
      const h = s.h ?? [];
      const back = h.filter((e) => e.k === "sent_back" || e.k === "rework").length;
      const judgedBad = h.filter((e) => e.k === "checked" && e.o === "failed").length;
      a.retried += h.filter((e) => e.k === "retry").length;
      if (s.kind === "check") {
        // A check's own count of the work it sent back is not in its log; each failed verdict but a final stop is one.
        a.sentBack += judgedBad;
        if (judgedBad) a.notPassed++;
      } else {
        a.sentBack += back;
        f.sentBack += back;
        totals.sentBack += back;
      }

      const waitedSec = (s.waitedMs ?? 0) / 1000;
      const took = sec(s.startedAt, s.finishedAt);
      if (s.kind === "approval") {
        if (took !== null) {
          a.waited++;
          a.waitSec += took;
          wait += took;
        }
      } else {
        if (took !== null && s.state === "done") {
          a.timed++;
          a.totalSec += Math.max(0, took - waitedSec);
        }
        if (took !== null) work += Math.max(0, took - waitedSec);
        if (waitedSec > 0) {
          a.waited++;
          a.waitSec += waitedSec;
          wait += waitedSec;
        }
      }

      if (AI_KINDS.has(s.kind) && !(s.kind === "check" && !attempts.some((e) => e.m) && !s.ranModel)) {
        let counted = false;
        for (const e of attempts) {
          if (e.i === undefined && e.t === undefined) continue;
          counted = true;
          const i = Number(e.i ?? 0);
          const o = Number(e.t ?? 0);
          a.tokens.input += i;
          a.tokens.output += o;
          runIn += i;
          runOut += o;
          const model = e.m ?? s.ranModel ?? "";
          if (model) {
            const mk = `${s.provider ?? ""}\u0000${model}`;
            const m = f.models.get(mk) ?? { provider: s.provider ?? null, model, input: 0, output: 0 };
            m.input += i;
            m.output += o;
            f.models.set(mk, m);
            a.by.set(model, (a.by.get(model) ?? 0) + 1);
          }
          if (e.o === "done" && o > 0) {
            a.outN++;
            a.outTok += o;
          }
        }
        // An attempt that came back with an answer and no count: the tokens exist, nobody told us. One that failed
        // before answering has nothing to count.
        if (!counted && attempts.some((e) => e.o === "done" || e.o === "asked" || e.o === "decide")) {
          a.tokensUnknown++;
          unknown = true;
        }
        if (s.kind === "ai" && s.state === "done" && typeof s.outChars === "number") {
          a.charN++;
          a.outChars += s.outChars;
        }
      }
    }
    f.tokens.input += runIn;
    f.tokens.output += runOut;
    totals.tokens.input += runIn;
    totals.tokens.output += runOut;
    if (unknown) {
      f.tokensUnknownRuns++;
      totals.tokensUnknownRuns++;
    }
    if (r.status === "done") totals.done++;
    if (r.status === "failed") totals.failed++;
    if ((r.status === "done" || r.status === "failed") && r.finished_at) {
      f.finished++;
      f.totalSec += Math.max(0, (r.finished_at.getTime() - r.created_at.getTime()) / 1000);
      f.workSec += work;
      f.waitSec += wait;
      totals.workSec += work;
      totals.waitSec += wait;
    }
    const day = r.created_at.toISOString().slice(0, 10);
    const d = daily.get(day) ?? { day, runs: 0, failed: 0, tokens: 0 };
    d.runs++;
    if (r.status === "failed") d.failed++;
    d.tokens += runIn + runOut;
    daily.set(day, d);
  }

  const workflows = [...flows.values()].map((f): WorkflowInsight => {
    const steps = f.order.map((key): StepInsight => {
      const a = f.steps.get(key)!;
      return {
        key: a.key,
        title: a.title,
        kind: a.kind,
        runs: a.runs,
        done: a.done,
        failed: a.failed,
        sentBack: a.sentBack,
        notPassed: a.notPassed,
        retried: a.retried,
        avgSec: avg(a.totalSec, a.timed),
        avgWaitSec: avg(a.waitSec, a.waited),
        tokens: a.tokens,
        tokensUnknown: a.tokensUnknown,
        avgOutputTokens: avg(a.outTok, a.outN),
        avgOutChars: avg(a.outChars, a.charN),
        models: [...a.by.entries()].sort((x, y) => y[1] - x[1]).map(([m]) => m),
      };
    });
    const w: WorkflowInsight = {
      id: f.id,
      name: f.name,
      runs: f.runs,
      done: f.done,
      failed: f.failed,
      cancelled: f.cancelled,
      active: f.active,
      tokens: f.tokens,
      tokensUnknownRuns: f.tokensUnknownRuns,
      models: [...f.models.values()].sort((x, y) => y.input + y.output - (x.input + x.output)),
      avgSec: avg(f.totalSec, f.finished),
      avgWorkSec: avg(f.workSec, f.finished),
      avgWaitSec: avg(f.waitSec, f.finished),
      sentBack: f.sentBack,
      steps,
      suggestions: [],
    };
    w.suggestions = suggest(w);
    return w;
  });
  workflows.sort((a, b) => b.tokens.input + b.tokens.output - (a.tokens.input + a.tokens.output) || b.runs - a.runs || a.name.localeCompare(b.name));
  return { days, capped, totals, daily: [...daily.values()].sort((a, b) => a.day.localeCompare(b.day)), workflows };
}

/**
 * The thresholds behind each suggestion. A rule needs enough runs to mean something (MIN_RUNS): two runs of a
 * workflow say nothing about it.
 */
export const RULES = {
  MIN_RUNS: 4,
  /** A check that did not pass in this share of the runs it judged. */
  CHECK_NOT_PASSED: 0.5,
  /** A step that failed in this share of the runs it started in (and at least twice). */
  STEP_FAILS: 0.3,
  /** An AI step on the main model whose answers are this short. */
  SHORT_OUTPUT_TOKENS: 300,
  SHORT_OUTPUT_CHARS: 1200,
  /** People's time is this many times the working time, and at least this long. */
  WAIT_TIMES: 2,
  WAIT_MIN_SEC: 600,
  /** One step takes this share of the tokens, with at least this many going in per run. */
  READS_SHARE: 0.7,
  READS_INPUT: 20_000,
  /** One step takes this share of the working time and at least this long. */
  SLOW_SHARE: 0.6,
  SLOW_MIN_SEC: 300,
} as const;

/** What to change in a workflow, most useful first: at most four, each a rule with the step it is about. */
export function suggest(w: Omit<WorkflowInsight, "suggestions">): Suggestion[] {
  const out: Suggestion[] = [];
  if (w.runs < RULES.MIN_RUNS) return out;
  const pct = (n: number, of: number) => Math.round((n / of) * 100);
  w.steps.forEach((s, i) => {
    if (s.runs < RULES.MIN_RUNS) return;
    if (s.kind === "check" && s.notPassed / s.runs >= RULES.CHECK_NOT_PASSED) {
      const author = [...w.steps.slice(0, i)].reverse().find((x) => x.kind === "ai" || x.kind === "command");
      out.push({ rule: "check_sends_back", stepKey: s.key, step: s.title, ...(author ? { author: author.title } : {}), pct: pct(s.notPassed, s.runs) });
    }
    if (s.kind !== "approval" && s.failed >= 2 && s.failed / s.runs >= RULES.STEP_FAILS && !(s.kind === "check" && s.notPassed >= s.failed))
      out.push({ rule: "step_fails", stepKey: s.key, step: s.title, pct: pct(s.failed, s.runs) });
  });
  if (w.avgWaitSec !== null && w.avgWorkSec !== null && w.avgWaitSec >= RULES.WAIT_MIN_SEC && w.avgWaitSec >= w.avgWorkSec * RULES.WAIT_TIMES)
    out.push({ rule: "waits_for_people", minutes: Math.round(w.avgWaitSec / 60) });
  const tokens = w.tokens.input + w.tokens.output;
  const work = w.steps.reduce((n, s) => n + (s.kind === "approval" ? 0 : (s.avgSec ?? 0)), 0);
  for (const s of w.steps) {
    if (s.runs < RULES.MIN_RUNS) continue;
    const mine = s.tokens.input + s.tokens.output;
    if (s.kind === "ai" && tokens > 0 && mine / tokens >= RULES.READS_SHARE && w.steps.filter((x) => x.kind === "ai").length > 1 && s.tokens.input / s.runs >= RULES.READS_INPUT)
      out.push({ rule: "step_reads_much", stepKey: s.key, step: s.title, pct: pct(mine, tokens) });
    if (
      s.kind !== "approval" &&
      work > 0 &&
      (s.avgSec ?? 0) >= RULES.SLOW_MIN_SEC &&
      (s.avgSec ?? 0) / work >= RULES.SLOW_SHARE &&
      w.steps.filter((x) => x.kind !== "approval").length > 1
    )
      out.push({ rule: "step_slow", stepKey: s.key, step: s.title, minutes: Math.round((s.avgSec ?? 0) / 60) });
  }
  return out.slice(0, 4);
}

/**
 * Steps of the company's AI that ask the main model for a short answer: the fast model may do. Needs what the
 * workflow asks for (each step's `model`), which the runs' figures do not carry, so it is added by the caller that has
 * the runs' steps (`fastModelSuggestions`).
 */
export function fastModelSuggestions(w: WorkflowInsight, asks: Map<string, string | undefined>, serverRuns: number): Suggestion[] {
  if (serverRuns < RULES.MIN_RUNS) return [];
  return w.steps
    .filter(
      (s) =>
        s.kind === "ai" &&
        s.runs >= RULES.MIN_RUNS &&
        !asks.get(s.key) &&
        s.sentBack === 0 &&
        s.avgOutputTokens !== null &&
        s.avgOutputTokens <= RULES.SHORT_OUTPUT_TOKENS &&
        (s.avgOutChars ?? 0) <= RULES.SHORT_OUTPUT_CHARS,
    )
    .map((s) => ({ rule: "fast_model" as const, stepKey: s.key, step: s.title }));
}

type Visible = { owner_id: string; assignee_id: string | null; team_id: string | null; project_id: string | null };

/** The figures for the reader: every run filtered with the rule of a task read, so no count tells of a hidden task. */
export async function workflowInsights(c: PoolClient, p: Principal, days: number, workflowId?: string): Promise<Insights> {
  const r = await c.query<RunFacts & Visible>(
    `SELECT r.id, r.workflow_id, r.workflow_name, r.runner, r.status, r.created_at, r.finished_at, t.owner_id, t.assignee_id, t.team_id, t.project_id,
            (SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                      'key', s->>'key', 'title', s->>'title', 'kind', s->>'kind', 'state', s->>'state',
                      'startedAt', s->>'startedAt', 'finishedAt', s->>'finishedAt', 'waitedMs', s->'waitedMs',
                      'model', s->>'model', 'outChars', length(s->>'output'),
                      'ranModel', s->'ran'->>'model', 'provider', s->'ran'->>'provider',
                      'h', (SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('k', h->>'kind', 'o', h->>'outcome', 'i', h->'ran'->'inputTokens', 't', h->'ran'->'outputTokens', 'm', h->'ran'->>'model')))
                              FROM jsonb_array_elements(COALESCE(s->'history', '[]'::jsonb)) h))) ORDER BY i)
               FROM jsonb_array_elements(r.steps) WITH ORDINALITY AS x(s, i)) AS steps
       FROM task_agent_runs r JOIN tasks t ON t.id = r.task_id
      WHERE r.created_at > now() - make_interval(days => $1::int) AND ($2::text IS NULL OR r.workflow_id = $2)
      ORDER BY r.created_at DESC LIMIT $3`,
    [days, workflowId ?? null, RUNS_MAX + 1],
  );
  const capped = r.rows.length > RUNS_MAX;
  const seen = r.rows.slice(0, RUNS_MAX).filter((x) => canReadTask(p, x));
  const out = summarize(seen, days, capped);
  // What each step asks for (its model) is read from the newest run of each workflow, for the fast-model rule.
  for (const w of out.workflows) {
    const mine = seen.filter((x) => (w.id ? x.workflow_id === w.id : !x.workflow_id && x.workflow_name === w.name));
    const asks = new Map((mine[0]?.steps ?? []).map((s) => [s.key ?? "", s.model]));
    const serverRuns = mine.filter((x) => x.runner === "server").length;
    w.suggestions = [...w.suggestions, ...fastModelSuggestions(w, asks, serverRuns)].slice(0, 4);
  }
  return out;
}
