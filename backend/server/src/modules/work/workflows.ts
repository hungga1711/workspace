import type { Pool, PoolClient } from "pg";
import { newId, recordAudit, runWithContext, withTransaction, type Principal } from "@workspace/shared";
import { logger, type ObjectStorage, type ServiceClient } from "@workspace/service-kit";
import { activity, allowedAny, emit, requireAny } from "./common.js";
import { answersText, cleanAnswers, composePrompt, mayAskInRun, normalizeQuestions, parseAsk, partialAnswers, type AskQuestion, type AskRound } from "./agent-ask.js";
import { createDoc, shareDoc } from "./documents.js";
import { Conflict, Forbidden, Invalid, NotFound } from "./errors.js";
import { confirmUpload, requestUpload } from "./files.js";
import { canReadTask, createTask, getTask, insertComment, taskResources, TASK_COLS, updateTask, type TaskRow } from "./tasks.js";
import { taskContext } from "./workflow-context.js";
import {
  cleanInputs,
  inputsSatisfied,
  normalizeConfig,
  runnerOf,
  typicalSeconds,
  validateWorkflow,
  type Category,
  type Runner,
  type WorkflowConfig,
  type WorkflowStep,
} from "./workflows/model.js";
import {
  checkPrompt,
  checklistItems,
  commandIssues,
  issuesText,
  lastResult,
  parseVerdict,
  renderPrompt,
  commandWithInputs,
  reworkText,
  resultTitle,
  runnerNote,
  unfence,
  type Verdict,
} from "./workflows/render.js";
import { adoptFiles, driveFiles, readResources, workflowFiles } from "./workflows/resources.js";
import { linkTarget, readLink } from "./workflows/links.js";
import { payloadBlock, withOrigin, type RunTrigger } from "./workflows/triggers.js";
import { addActivity, clearDraft, latestActivity, readActivity, readRunActivity, type ActivityInput } from "./workflows/activity.js";

export * from "./workflows/model.js";
export { DESCRIPTION_MAX, PREVIOUS_MAX, RESOURCES_MAX, CHECK_HINT, unfence, renderPrompt, reworkText } from "./workflows/render.js";
export { TEMPLATES, templatesFor } from "./workflows/templates.js";
export { ACTIVITY_KINDS } from "./workflows/activity.js";

/**
 * Agent workflows (a harness, see workflows/model.ts): a task handed to a pipeline
 * of steps. A step asks the AI ("ai"), runs a command ("command", runner only), checks the last result and sends it
 * back when it falls short ("check"), waits for a person ("approval") or moves the task ("status").
 *
 * Two ways a run is driven. "server": the company's AI (the ai module, as the person who pressed Run, so their budget
 * and policy apply), driven by this process and picked up again after a restart. "local": a runner (a person's
 * computer or one the company keeps) claims the run and asks this server for one step at a time; the server renders
 * every instruction, so a step reads the same wherever it runs, and the runner only executes and reports.
 *
 * Every run keeps its own copy of the steps and of the workflow's config with their state, output and log, so editing
 * a workflow never rewrites history.
 */

/** What the engine needs besides the database: the ai module, file storage, and a person's principal by id. */
export interface Engine {
  pool: Pool;
  ai: Pick<ServiceClient, "request">;
  storage: ObjectStorage | null;
  /** The principal of a member (identity module), for work done on their behalf with nobody's request at hand. */
  resolve: (userId: string) => Promise<Principal>;
}

/** What actually ran for an AI step: the model that answered, its tokens, the tools it called. */
export interface StepRan {
  model: string;
  provider?: string | null | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  tools?: { server: string; tool: string; outcome: string; ms: number }[] | undefined;
  /** The system prompt sent with the step's instruction (server runner). */
  system?: string | undefined;
  ms?: number | undefined;
}
export interface WorkflowRow {
  id: string;
  name: string;
  description: string;
  category: Category;
  runner: Runner;
  steps: WorkflowStep[];
  config: unknown;
  template: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  archived: boolean;
}
/**
 * waiting_input: the current AI step asked the people on the task something (agent-ask.ts).
 * paused: someone held the run; the step in progress finishes, then nothing runs until Continue.
 */
export type RunStatus = "queued" | "running" | "waiting_approval" | "waiting_input" | "paused" | "done" | "failed" | "cancelled";
export interface RunStep extends WorkflowStep {
  /** "waiting": for a person, an approval or (the run is waiting_input) answers to the step's questions. */
  state: "pending" | "running" | "done" | "failed" | "waiting" | "skipped";
  /** What the step was given (the instruction with every placeholder filled in). */
  input?: string | undefined;
  output?: string | undefined;
  log?: string | undefined;
  startedAt?: string | undefined;
  finishedAt?: string | undefined;
  /** This step's result was sent back (by an approver, or by a check): what to change and the result it replaces. */
  rework?: { note: string; previous: string; by: string; at: string; check?: string | undefined } | undefined;
  /** The step asked although it may not ask (any more): it runs again told to decide for itself. */
  decide?: boolean | undefined;
  /** Time the step spent waiting for people's answers (ms) and since when it waits: its duration leaves both out. */
  waitedMs?: number | undefined;
  waitingSince?: string | undefined;
  ran?: StepRan | undefined;
  /** The step's log: every time it ran and what people did on it, oldest first (logAttempt, logNote). */
  history?: StepEntry[] | undefined;
  /** check: the latest verdict; `round` counts how many times this check has judged. */
  verdict?: (Verdict & { round: number; at: string }) | undefined;
  /** check: how many times it has sent the work back. */
  sentBack?: number | undefined;
  /** How many times the step ran again after failing (its `retries`). */
  retried?: number | undefined;
  /** approval: the wait in progress (a step waits again after its work was sent back); notices and quick actions name it. */
  waitId?: string | undefined;
}
/**
 * One line of a step's log. An "attempt" is one time the step ran: what it was given, what came back, the model and
 * how long. The other kinds are what happened to it: people's answers and decisions, a check's verdict ("checked"),
 * its result sent back by a check ("sent_back"), a failed attempt run again ("retry"), a runner that went away
 * ("requeued").
 */
export interface StepEntry {
  at: string;
  kind: "attempt" | "answered" | "skipped" | "rework" | "approved" | "checked" | "sent_back" | "retry" | "requeued";
  /** attempt: how it ended; absent while it runs. checked: "done" passed, "failed" did not. */
  outcome?: "done" | "asked" | "decide" | "failed" | "cancelled" | "timeout" | undefined;
  end?: string | undefined;
  input?: string | undefined;
  output?: string | undefined;
  ran?: StepRan | undefined;
  by?: string | undefined;
  text?: string | undefined;
}
/** What a runner prepared for the run (a sandbox folder, a container), as it reported it. */
export interface RunEnv {
  state: "preparing" | "ready" | "failed";
  device?: string | undefined;
  isolation?: "container" | "folder" | "computer" | undefined;
  image?: string | undefined;
  network?: "on" | "off" | undefined;
  agentIn?: "container" | "host" | undefined;
  assets?: number | undefined;
  log?: string | undefined;
  startedAt?: string | undefined;
  finishedAt?: string | undefined;
  /** The runner has handed back the files of the run's `out` folder. */
  collected?: boolean | undefined;
}
export interface RunArtifact {
  kind: "file" | "doc" | "subtasks";
  id?: string | undefined;
  name: string;
  size?: number | undefined;
  count?: number | undefined;
}
export interface RunRow {
  id: string;
  task_id: string;
  workflow_id: string | null;
  workflow_name: string;
  runner: Runner;
  status: RunStatus;
  current_step: number;
  steps: RunStep[];
  error: string | null;
  started_by: string;
  claimed_by: string | null;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
  inputs: Record<string, string>;
  config: unknown;
  env: RunEnv | null;
  artifacts: RunArtifact[];
  usage: { inputTokens?: number; outputTokens?: number; estimate?: RunEstimate };
  host: "person" | "company";
  heartbeat_at: Date | null;
  requeues: number;
  /** What started the run when it was not a person pressing Run (workflows/triggers.ts). */
  trigger: RunTrigger | null;
}

/** How long each step should take (seconds, by step key), and how many earlier runs that is drawn from. */
export interface RunEstimate {
  steps: Record<string, number>;
  basedOn: number;
}

/**
 * What a run of these steps should take: each step's average over the workflow's latest finished runs (its working
 * time, never the waits for people), and a typical time for a step that has not run yet.
 */
export async function estimateFor(c: PoolClient, workflowId: string | null, steps: WorkflowStep[], conf: WorkflowConfig): Promise<RunEstimate> {
  const past = workflowId
    ? (await c.query<{ steps: RunStep[] }>("SELECT steps FROM task_agent_runs WHERE workflow_id = $1 AND status = 'done' ORDER BY created_at DESC LIMIT 20", [workflowId])).rows
    : [];
  const seen: Record<string, { ms: number; n: number }> = {};
  for (const r of past)
    for (const s of r.steps) {
      if (s.state !== "done" || s.kind === "approval" || s.kind === "status") continue;
      const ms = workMs({ steps: [s] });
      if (ms <= 0) continue;
      const k = (seen[s.key] ??= { ms: 0, n: 0 });
      k.ms += ms;
      k.n++;
    }
  return {
    steps: Object.fromEntries(steps.map((s) => [s.key, seen[s.key] ? Math.max(1, Math.round(seen[s.key]!.ms / seen[s.key]!.n / 1000)) : typicalSeconds(s, conf.environment)])),
    basedOn: past.length,
  };
}

/**
 * The estimate as a run shows it: the whole, what is left (a running step counts what it has not used yet; a step
 * that was sent back counts again) and when it should be done. No finish time while the run waits for people.
 */
function estimateDto(r: RunRow, now = Date.now()) {
  const e = r.usage?.estimate;
  if (!e) return null;
  const of = (s: RunStep) => e.steps[s.key] ?? 0;
  let left = 0;
  r.steps.forEach((s, i) => {
    if (i < r.current_step || s.state === "done" || s.state === "skipped") return;
    const open = [...(s.history ?? [])].reverse().find((h) => h.kind === "attempt" && !h.outcome);
    const used = s.state === "running" && open ? (now - Date.parse(open.at)) / 1000 : 0;
    // Over its estimate and still going: a little more, never "0 seconds left" on a step that is working.
    left += s.state === "running" ? Math.max(Math.min(of(s), 10), of(s) - used) : of(s);
  });
  const active = r.status === "queued" || r.status === "running";
  const over = r.status === "done" || r.status === "failed" || r.status === "cancelled";
  return {
    totalSec: Object.values(e.steps).reduce((a, b) => a + b, 0),
    remainingSec: over ? 0 : Math.round(left),
    finishAt: active ? new Date(now + left * 1000).toISOString() : null,
    steps: e.steps,
    basedOn: e.basedOn,
  };
}

export const configOf = (w: Pick<WorkflowRow, "config" | "runner">) => normalizeConfig(w.config, w.runner);
const cfg = (r: Pick<RunRow, "config" | "runner">) => normalizeConfig(r.config, r.runner);

export const workflowDto = (w: WorkflowRow, p: Principal) => ({
  id: w.id,
  name: w.name,
  description: w.description,
  category: w.category,
  runner: w.runner,
  steps: w.steps,
  config: configOf(w),
  template: w.template,
  createdBy: w.created_by,
  updatedAt: w.updated_at,
  canEdit: canEditWorkflow(p, w),
});

/** A run's working time so far: every attempt of its steps, never the waits for people. */
export function workMs(r: Pick<RunRow, "steps">, now = Date.now()): number {
  let ms = 0;
  for (const s of r.steps) {
    const attempts = (s.history ?? []).filter((h) => h.kind === "attempt");
    if (attempts.length) for (const a of attempts) ms += Math.max(0, (a.end ? Date.parse(a.end) : s.state === "running" ? now : Date.parse(a.at)) - Date.parse(a.at));
    else if (s.startedAt && s.kind !== "approval")
      ms += Math.max(0, (s.finishedAt ? Date.parse(s.finishedAt) : s.state === "running" ? now : Date.parse(s.startedAt)) - Date.parse(s.startedAt) - (s.waitedMs ?? 0));
  }
  return ms;
}

export const runDto = (r: RunRow) => ({
  id: r.id,
  taskId: r.task_id,
  workflowId: r.workflow_id,
  workflowName: r.workflow_name,
  runner: r.runner,
  status: r.status,
  currentStep: r.current_step,
  steps: r.steps,
  error: r.error,
  startedBy: r.started_by,
  claimedBy: r.claimed_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  finishedAt: r.finished_at,
  inputs: r.inputs ?? {},
  config: cfg(r),
  env: r.env,
  artifacts: r.artifacts ?? [],
  usage: { inputTokens: r.usage?.inputTokens ?? 0, outputTokens: r.usage?.outputTokens ?? 0, workMs: workMs(r) },
  estimate: estimateDto(r),
  host: r.host,
  // What started it, when a trigger did; what an outside system posted stays with the run's steps.
  trigger: r.trigger ? { kind: r.trigger.kind, id: r.trigger.id, ...(r.trigger.detail ? { detail: r.trigger.detail } : {}) } : null,
  canRetry: r.status === "failed" && r.current_step < r.steps.length,
});

/** The creator edits their workflow; people who manage the company's AI agents edit any. */
export const canEditWorkflow = (p: Principal, w: Pick<WorkflowRow, "created_by">) => w.created_by === p.id || allowedAny(p, "ai.agent.manage", [{}]);

// ── Workflows ────────────────────────────────────────────────────────────────────────────────────────

/** The steps as stored for an environment given by its runner alone (callers from before the config existed, tests). */
export const validSteps = (steps: WorkflowStep[], runner: Runner) => validateWorkflow(steps, undefined, runner).steps;

export async function listWorkflows(c: PoolClient, p: Principal) {
  const r = await c.query<WorkflowRow>("SELECT * FROM agent_workflows WHERE NOT archived ORDER BY category, name");
  return r.rows.map((w) => workflowDto(w, p));
}

export async function getWorkflow(c: PoolClient, id: string): Promise<WorkflowRow> {
  const r = await c.query<WorkflowRow>("SELECT * FROM agent_workflows WHERE id = $1", [id]);
  if (!r.rows[0]) throw new NotFound("workflow not found");
  return r.rows[0];
}

export interface WorkflowInput {
  name: string;
  description: string;
  category: Category;
  /** Older workflows only say where they run; still accepted when `config` is absent. */
  runner?: Runner | undefined;
  steps: WorkflowStep[];
  config?: unknown;
  template?: string | null | undefined;
}

export async function saveWorkflow(c: PoolClient, p: Principal, id: string | null, b: WorkflowInput) {
  const v = validateWorkflow(b.steps, b.config, b.runner);
  // Pages a workflow reads must be readable by whoever lists them; a run reads them again as its starter.
  const wid = id ?? newId();
  if (id) {
    const w = await getWorkflow(c, id);
    if (!canEditWorkflow(p, w)) throw new Forbidden("only its creator or an AI admin can edit this workflow");
  } else {
    await c.query("INSERT INTO agent_workflows (id, name, description, category, runner, steps, config, template, created_by) VALUES ($1,$2,$3,$4,$5,'[]','{}',$6,$7)", [
      wid,
      b.name,
      b.description,
      b.category,
      v.runner,
      b.template ?? null,
      p.id,
    ]);
  }
  // Runs a trigger starts act as a real person. Whoever sets triggers up puts them under their own name; only someone
  // who manages the company's AI may name another person (or keep the one already there), so nobody borrows a
  // colleague's access by editing a workflow.
  const before = id ? configOf(await getWorkflow(c, wid)) : null;
  const asked = v.config.runAs;
  const admin = allowedAny(p, "ai.agent.manage", [{}]);
  const runAs = !v.config.triggers.length ? "" : asked && asked !== p.id && (admin || asked === before?.runAs) ? asked : p.id;
  const config: WorkflowConfig = { ...v.config, runAs, resources: { ...v.config.resources, files: await adoptFiles(c, p, wid, v.config.resources.files) } };
  await c.query("UPDATE agent_workflows SET name=$2, description=$3, category=$4, runner=$5, steps=$6, config=$7, triggered=$8, updated_at=now() WHERE id=$1", [
    wid,
    b.name,
    b.description,
    b.category,
    v.runner,
    JSON.stringify(v.steps),
    JSON.stringify(config),
    config.triggers.length > 0,
  ]);
  // The secret address of a trigger that is gone stops working with it.
  await c.query("DELETE FROM workflow_hooks WHERE workflow_id = $1 AND NOT (trigger_id = ANY($2))", [wid, config.triggers.filter((t) => t.kind === "hook").map((t) => t.id)]);
  return workflowDto(await getWorkflow(c, wid), p);
}

/** How long a run of this workflow should take, before anyone starts one (the Run dialog, the workflow's page). */
export async function workflowEstimate(c: PoolClient, id: string) {
  const w = await getWorkflow(c, id);
  const e = await estimateFor(c, w.id, w.steps, configOf(w));
  return { totalSec: Object.values(e.steps).reduce((a, b) => a + b, 0), steps: e.steps, basedOn: e.basedOn };
}

/** A copy to change freely: same steps and config, without the original's files (they stay with it). */
export async function duplicateWorkflow(c: PoolClient, p: Principal, id: string, name?: string) {
  const w = await getWorkflow(c, id);
  if (w.archived) throw new NotFound("workflow not found");
  const config = configOf(w);
  return saveWorkflow(c, p, null, {
    name: (name?.trim() || `${w.name} (copy)`).slice(0, 120),
    description: w.description,
    category: w.category,
    steps: w.steps,
    config: { ...config, resources: { ...config.resources, files: [] } },
    template: w.template,
  });
}

export async function archiveWorkflow(c: PoolClient, p: Principal, id: string) {
  const w = await getWorkflow(c, id);
  if (!canEditWorkflow(p, w)) throw new Forbidden("only its creator or an AI admin can remove this workflow");
  await c.query("UPDATE agent_workflows SET archived = true, updated_at = now() WHERE id = $1", [id]);
  await c.query("UPDATE tasks SET workflow_id = NULL WHERE workflow_id = $1", [id]);
}

/**
 * Puts a workflow on a task. A workflow set to start by itself does so here, as the person who put it there, when it
 * needs nothing from them (no required input without a default) and they may start it; a start that is refused never
 * undoes the assignment.
 */
export async function setTaskWorkflow(c: PoolClient, p: Principal, taskId: string, workflowId: string | null): Promise<{ workflowId: string | null; run: RunRow | null }> {
  const t = await getTask(c, p, taskId);
  requireAny(p, "task.edit", taskResources(t));
  let auto = false;
  if (workflowId) {
    const w = await getWorkflow(c, workflowId);
    if (w.archived) throw new Invalid("this workflow was removed");
    const conf = configOf(w);
    auto = conf.autoStart && inputsSatisfied(conf.inputs) && t.workflow_id !== workflowId;
  }
  await c.query("UPDATE tasks SET workflow_id = $2 WHERE id = $1", [t.id, workflowId]);
  await activity(c, "task", t.id, "workflow_set", { workflowId });
  let run: RunRow | null = null;
  if (auto) {
    try {
      await c.query("SAVEPOINT wf_auto");
      run = await startRun(c, p, t.id, {});
      await c.query("RELEASE SAVEPOINT wf_auto");
    } catch {
      await c.query("ROLLBACK TO SAVEPOINT wf_auto").catch(() => undefined);
    }
  }
  return { workflowId, run };
}

/**
 * Whether a link's content can be read by a run (the editor asks as a link is added): what it is (a Google document,
 * a sheet, a web page), how much text it has, or why it cannot be read.
 */
export async function checkLink(url: string) {
  const r = await readLink(url, true);
  return r.ok
    ? { ok: true as const, kind: r.kind, chars: r.text.length, sample: r.text.replace(/\s+/g, " ").slice(0, 160) }
    : { ok: false as const, kind: linkTarget(url).kind, problem: r.problem };
}

// ── Runners ──────────────────────────────────────────────────────────────────────────────────────────

/** A runner counts as connected while it has asked for work in the last 45 seconds (it asks every 5). */
const ONLINE_SECONDS = 45;

/** The runners the reader may count on: their own computers and the company's, seen in the last week. */
export async function listRunners(c: PoolClient, p: Principal) {
  const r = await c.query<{ id: string; user_id: string; device: string; shared: boolean; docker: boolean; agent: string; last_seen_at: Date; online: boolean }>(
    `SELECT id, user_id, device, shared, docker, agent, last_seen_at, last_seen_at > now() - interval '${ONLINE_SECONDS} seconds' AS online
       FROM agent_runners WHERE (user_id = $1 OR shared) AND last_seen_at > now() - interval '7 days' ORDER BY last_seen_at DESC LIMIT 50`,
    [p.id],
  );
  return r.rows.map((x) => ({
    id: x.id,
    device: x.device,
    shared: x.shared,
    mine: x.user_id === p.id,
    online: x.online,
    docker: x.docker,
    agent: x.agent,
    lastSeenAt: x.last_seen_at,
  }));
}

async function touchRunner(c: PoolClient, p: Principal, b: { device: string; shared: boolean; docker: boolean; agent: string; os: string; version: string }) {
  // Asked every few seconds: the row is rewritten only when it has gone stale or what the runner can do changed.
  await c.query(
    `INSERT INTO agent_runners (id, user_id, device, shared, docker, agent, os, version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (user_id, device, shared) DO UPDATE SET docker = EXCLUDED.docker, agent = EXCLUDED.agent, os = EXCLUDED.os, version = EXCLUDED.version, last_seen_at = now()
       WHERE agent_runners.last_seen_at < now() - interval '15 seconds' OR agent_runners.docker <> EXCLUDED.docker OR agent_runners.agent <> EXCLUDED.agent`,
    [newId(), p.id, b.device, b.shared, b.docker, b.agent.slice(0, 200), b.os.slice(0, 40), b.version.slice(0, 20)],
  );
}

// ── Runs ─────────────────────────────────────────────────────────────────────────────────────────────

export async function listRuns(c: PoolClient, p: Principal, taskId: string) {
  const t = await getTask(c, p, taskId);
  const r = await c.query<RunRow>("SELECT * FROM task_agent_runs WHERE task_id = $1 ORDER BY created_at DESC LIMIT 20", [t.id]);
  // Each run's rounds of questions (few: capped per step and per run), so the pipeline shows what was asked.
  const qs = await c.query<QuestionRow>("SELECT * FROM task_agent_run_questions WHERE run_id = ANY($1) ORDER BY step_index, round", [r.rows.map((x) => x.id)]);
  // What the step at work is doing right now (workflows/activity.ts), for the track and the task's card.
  const doing = await latestActivity(
    c,
    r.rows.filter((x) => x.status === "running" && x.steps[x.current_step]?.state === "running").map((x) => ({ runId: x.id, step: x.current_step })),
  );
  return r.rows.map((x) => ({
    ...runDto(x),
    ...(doing.has(x.id) ? { doing: doing.get(x.id) } : {}),
    asks: qs.rows.filter((q) => q.run_id === x.id).map(askDto),
    canAnswer: canAnswer(p, x, t),
    canControl: canControl(p, x, t),
    canApprove: x.status === "waiting_approval" && canApprove(p, x, t),
  }));
}

/** One run, for whoever may read its task: the same picture as an entry of the task's list. */
export async function oneRun(c: PoolClient, p: Principal, runId: string) {
  const x = await getRun(c, runId);
  const t = await getTask(c, p, x.task_id);
  const qs = await c.query<QuestionRow>("SELECT * FROM task_agent_run_questions WHERE run_id = $1 ORDER BY step_index, round", [x.id]);
  const doing = x.status === "running" && x.steps[x.current_step]?.state === "running" ? (await latestActivity(c, [{ runId: x.id, step: x.current_step }])).get(x.id) : undefined;
  return {
    ...runDto(x),
    ...(doing ? { doing } : {}),
    asks: qs.rows.map(askDto),
    canAnswer: canAnswer(p, x, t),
    canControl: canControl(p, x, t),
    canApprove: x.status === "waiting_approval" && canApprove(p, x, t),
  };
}

/** A task's visibility fields, so a run is only counted or shown to people who may read its task. */
type Visible = { owner_id: string; assignee_id: string | null; team_id: string | null; project_id: string | null };

/**
 * The Workflow page's live picture: headline figures, each workflow's use and the latest runs. Every
 * run and task is filtered with the same rule as a task read (`canReadTask`), so nobody learns of a task they cannot
 * open, even as a count. Three reads: tasks handed to a workflow, runs of the last 30 days (and any still active, and
 * the latest per workflow for "last run"), and the latest runs with their steps' states only (never their outputs).
 */
export async function workflowActivity(c: PoolClient, p: Principal, limit = 40) {
  const tasks = await c.query<Visible & { workflow_id: string }>("SELECT workflow_id, owner_id, assignee_id, team_id, project_id FROM tasks WHERE workflow_id IS NOT NULL");
  // A recent run also brings its steps' keys, states and times (never their text) for each step's figures.
  type StepLite = Pick<RunStep, "key" | "state" | "startedAt" | "finishedAt"> & { sentBack?: number };
  const runs = await c.query<
    Visible & { workflow_id: string | null; status: RunStatus; created_at: Date; finished_at: Date | null; recent: boolean; steps: StepLite[] | null; tokens: number | null }
  >(
    `SELECT r.workflow_id, r.status, r.created_at, r.finished_at, r.created_at > now() - interval '30 days' AS recent, t.owner_id, t.assignee_id, t.team_id, t.project_id,
            COALESCE((r.usage->>'inputTokens')::bigint, 0) + COALESCE((r.usage->>'outputTokens')::bigint, 0) AS tokens,
            CASE WHEN r.created_at > now() - interval '30 days' THEN
              (SELECT jsonb_agg(jsonb_build_object('key', s->>'key', 'state', s->>'state', 'startedAt', s->>'startedAt', 'finishedAt', s->>'finishedAt',
                        'sentBack', jsonb_array_length(jsonb_path_query_array(COALESCE(s->'history', '[]'::jsonb), '$[*] ? (@.kind == "sent_back" || @.kind == "rework")'))))
                 FROM jsonb_array_elements(r.steps) s)
            END AS steps
       FROM task_agent_runs r JOIN tasks t ON t.id = r.task_id
      WHERE r.created_at > now() - interval '90 days' OR r.status = ANY($1)
      ORDER BY r.created_at DESC LIMIT 5000`,
    [ACTIVE],
  );
  const latest = await c.query<
    Visible &
      Pick<RunRow, "id" | "task_id" | "workflow_id" | "workflow_name" | "runner" | "status" | "current_step" | "started_by" | "created_at" | "updated_at" | "finished_at"> & {
        code: string;
        title: string;
        environment: string | null;
        steps: Pick<RunStep, "title" | "kind" | "state" | "status" | "startedAt" | "finishedAt" | "approver" | "approverId">[];
      }
  >(
    `SELECT r.id, r.task_id, r.workflow_id, r.workflow_name, r.runner, r.status, r.current_step, r.started_by, r.created_at, r.updated_at, r.finished_at,
            r.config->'environment'->>'kind' AS environment,
            t.code, t.title, t.owner_id, t.assignee_id, t.team_id, t.project_id,
            COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('title', s->>'title', 'kind', s->>'kind', 'state', s->>'state', 'status', s->>'status', 'startedAt', s->>'startedAt', 'finishedAt', s->>'finishedAt', 'approver', s->>'approver', 'approverId', s->>'approverId')) ORDER BY i)
                        FROM jsonb_array_elements(r.steps) WITH ORDINALITY AS x(s, i)), '[]'::jsonb) AS steps
       FROM task_agent_runs r JOIN tasks t ON t.id = r.task_id
      ORDER BY (r.status = ANY($1)) DESC, r.updated_at DESC LIMIT 200`,
    [ACTIVE],
  );

  type StepUse = { done: number; failed: number; timed: number; totalSec: number; sentBack: number };
  type Use = {
    tasks: number;
    runs30d: number;
    done30d: number;
    failed30d: number;
    lastRunAt: Date | null;
    steps: Record<string, StepUse>;
    tokens: number;
    sec: number;
    finished: number;
  };
  const usage: Record<string, Use> = {};
  const use = (id: string) => (usage[id] ??= { tasks: 0, runs30d: 0, done30d: 0, failed30d: 0, lastRunAt: null, steps: {}, tokens: 0, sec: 0, finished: 0 });
  for (const t of tasks.rows) if (canReadTask(p, t)) use(t.workflow_id).tasks++;
  const stats = { runs30d: 0, done30d: 0, failed30d: 0, active: 0, waiting: 0, asking: 0, paused: 0 };
  for (const r of runs.rows) {
    if (!canReadTask(p, r)) continue;
    if (r.status === "waiting_approval") stats.waiting++;
    else if (r.status === "waiting_input") stats.asking++;
    else if (r.status === "paused") stats.paused++;
    else if (ACTIVE.includes(r.status)) stats.active++;
    const u = r.workflow_id ? use(r.workflow_id) : null;
    if (u && (!u.lastRunAt || r.created_at > u.lastRunAt)) u.lastRunAt = r.created_at;
    if (!r.recent) continue;
    stats.runs30d++;
    if (u) {
      u.runs30d++;
      // Each step's figures over the last 30 days, by key, so an edited workflow keeps its steps' history.
      for (const st of r.steps ?? []) {
        if (!st.key) continue;
        const k = (u.steps[st.key] ??= { done: 0, failed: 0, timed: 0, totalSec: 0, sentBack: 0 });
        if (st.state === "done") k.done++;
        if (st.state === "failed") k.failed++;
        k.sentBack += st.sentBack ?? 0;
        if (st.state === "done" && st.startedAt && st.finishedAt) {
          const sec = (Date.parse(st.finishedAt) - Date.parse(st.startedAt)) / 1000;
          if (sec >= 0) {
            k.timed++;
            k.totalSec += sec;
          }
        }
      }
    }
    if (r.status === "done") {
      stats.done30d++;
      if (u) {
        u.done30d++;
        u.finished++;
        u.tokens += Number(r.tokens ?? 0);
        if (r.finished_at) u.sec += Math.max(0, (r.finished_at.getTime() - r.created_at.getTime()) / 1000);
      }
    } else if (r.status === "failed") {
      stats.failed30d++;
      if (u) u.failed30d++;
    }
  }
  // Each step's average time is over the runs that timed it; a workflow's averages are over its finished runs.
  const out = Object.fromEntries(
    Object.entries(usage).map(([id, u]) => [
      id,
      {
        tasks: u.tasks,
        runs30d: u.runs30d,
        done30d: u.done30d,
        failed30d: u.failed30d,
        lastRunAt: u.lastRunAt,
        avgTokens: u.finished && u.tokens ? Math.round(u.tokens / u.finished) : null,
        avgSec: u.finished ? Math.round(u.sec / u.finished) : null,
        steps: Object.fromEntries(
          Object.entries(u.steps).map(([key, k]) => [key, { done: k.done, failed: k.failed, avgSec: k.timed ? Math.round(k.totalSec / k.timed) : null, sentBack: k.sentBack }]),
        ),
      },
    ]),
  );
  const recent = latest.rows
    .filter((r) => canReadTask(p, r))
    .slice(0, limit)
    .map((r) => ({
      id: r.id,
      taskId: r.task_id,
      taskCode: r.code,
      taskTitle: r.title,
      workflowId: r.workflow_id,
      workflowName: r.workflow_name,
      runner: r.runner,
      environment: r.environment ?? (r.runner === "server" ? "assistant" : "computer"),
      status: r.status,
      currentStep: r.current_step,
      steps: r.steps.map(({ approver: _a, approverId: _i, ...s }) => s),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      finishedAt: r.finished_at,
      canApprove: r.status === "waiting_approval" && canApprove(p, r, r),
      // Answering the AI's questions: whoever started it, the assignee, or anyone who may edit the task (answerRun).
      canAnswer: r.status === "waiting_input" && canAnswer(p, r, r),
      // Pause, continue and stop (pauseRun, resumeRun, cancelRun).
      canControl: ACTIVE.includes(r.status) && canControl(p, r, r),
    }));
  return { stats, usage: out, runs: recent };
}

async function getRun(c: PoolClient, id: string, lock = false): Promise<RunRow> {
  const r = await c.query<RunRow>(`SELECT * FROM task_agent_runs WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [id]);
  if (!r.rows[0]) throw new NotFound("run not found");
  return r.rows[0];
}

async function saveRun(c: PoolClient, r: RunRow) {
  await c.query(
    `UPDATE task_agent_runs SET status=$2, current_step=$3, steps=$4, error=$5, claimed_by=$6, updated_at=now(), finished_at=$7, env=$8, artifacts=$9, usage=$10, requeues=$11
      WHERE id=$1`,
    [
      r.id,
      r.status,
      r.current_step,
      JSON.stringify(r.steps),
      r.error,
      r.claimed_by,
      r.finished_at,
      r.env ? JSON.stringify(r.env) : null,
      JSON.stringify(r.artifacts ?? []),
      JSON.stringify(r.usage ?? {}),
      r.requeues ?? 0,
    ],
  );
}

const ACTIVE: RunStatus[] = ["queued", "running", "waiting_approval", "waiting_input", "paused"];

/**
 * Starts the task's workflow with what the person filled in. Who may: on the assignee's own computer, only the
 * assignee (it runs with their tools and credentials); anywhere else, whoever may edit the task (the AI acts as the
 * person who started it; a sandbox run on a person's runner waits for the starter's own computer).
 */
export async function startRun(c: PoolClient, p: Principal, taskId: string, inputs: unknown, by?: RunTrigger): Promise<RunRow> {
  const t = await c.query<TaskRow>(`SELECT ${TASK_COLS} FROM tasks WHERE id = $1 FOR UPDATE`, [(await getTask(c, p, taskId)).id]).then((r) => r.rows[0]!);
  if (!t.workflow_id) throw new Invalid("this task has no workflow");
  const w = await getWorkflow(c, t.workflow_id);
  const conf = configOf(w);
  const env = conf.environment;
  if (env.kind === "computer" && t.assignee_id !== p.id) throw new Forbidden("only the assignee can start a workflow that runs on their computer");
  if (env.kind !== "computer") requireAny(p, "task.edit", taskResources(t));
  const busy = await c.query("SELECT 1 FROM task_agent_runs WHERE task_id = $1 AND status = ANY($2)", [t.id, ACTIVE]);
  if (busy.rowCount) throw new Invalid("a run is already in progress for this task");
  const values = cleanInputs(conf.inputs, inputs);
  const id = newId();
  const steps: RunStep[] = w.steps.map((s) => ({ ...s, state: "pending" }));
  // The estimate is fixed when the run starts, so "about 6 minutes" does not move under the person watching it.
  const usage = conf.estimate ? { estimate: await estimateFor(c, w.id, w.steps, conf) } : {};
  await c.query(
    `INSERT INTO task_agent_runs (id, task_id, workflow_id, workflow_name, runner, status, steps, started_by, inputs, config, host, usage, trigger)
     VALUES ($1,$2,$3,$4,$5,'queued',$6,$7,$8,$9,$10,$11,$12)`,
    [
      id,
      t.id,
      w.id,
      w.name,
      w.runner,
      JSON.stringify(steps),
      p.id,
      JSON.stringify(values),
      JSON.stringify(conf),
      env.kind === "sandbox" && env.host === "company" ? "company" : "person",
      JSON.stringify(usage),
      by ? JSON.stringify(by) : null,
    ],
  );
  await activity(c, "task", t.id, "agent_run_started", {
    runId: id,
    workflow: w.name,
    runner: w.runner,
    environment: env.kind,
    ...(by ? { trigger: by.kind, ...(by.detail ? { detail: by.detail } : {}) } : {}),
  });
  const run = await getRun(c, id);
  await emit(c, "work.run.started.v1", "work.run", id, await runEvent(c, run));
  await auditRun(c, run, "started");
  return run;
}

/** Stop: the run ends as cancelled; a runner sees it at its next status check and stops the step in progress. */
export async function cancelRun(c: PoolClient, p: Principal, runId: string) {
  const r = await getRun(c, runId, true);
  const t = await getTask(c, p, r.task_id);
  if (!canControl(p, r, t)) throw new Forbidden("only the person who started the run, the assignee or an editor of the task can stop it");
  if (!ACTIVE.includes(r.status)) throw new Conflict(`this run is already ${r.status}`);
  if (r.status === "waiting_approval") await approvalClosed(c, r, r.steps[r.current_step]?.waitId, "cancelled");
  r.status = "cancelled";
  r.finished_at = new Date();
  r.steps = r.steps.map((s) => (s.state === "running" ? { ...endAttempt(s, "cancelled"), state: "skipped" } : s.state === "waiting" ? { ...s, state: "skipped" } : s));
  await saveRun(c, r);
  await closeOpenAsks(c, r, "cancelled");
  await activity(c, "task", r.task_id, "agent_run_cancelled", { runId });
  await emit(c, "work.run.cancelled.v1", "work.run", r.id, await runEvent(c, r));
  await auditRun(c, r, "cancelled");
  return runDto(r);
}

/**
 * Pause: a queued or running run holds. The step in progress is not cut off: a server AI call or a runner's step
 * finishes and its result is kept, then nothing more runs until Continue. A runner keeps its claim until that step's
 * result comes in.
 */
export async function pauseRun(c: PoolClient, p: Principal, runId: string) {
  const r = await getRun(c, runId, true);
  const t = await getTask(c, p, r.task_id);
  if (!canControl(p, r, t)) throw new Forbidden("only the person who started the run, the assignee or an editor of the task can pause it");
  if (r.status !== "queued" && r.status !== "running") throw new Conflict(`a run that is ${r.status} cannot be paused`);
  r.status = "paused";
  await saveRun(c, r);
  await activity(c, "task", r.task_id, "agent_run_paused", { runId });
  await emit(c, "work.run.paused.v1", "work.run", r.id, await runEvent(c, r));
  await auditRun(c, r, "paused");
  return runDto(r);
}

/**
 * Continue a paused run from the next step. When the step that was in progress at the pause is still going (the AI
 * call or the runner has not answered yet), its worker simply carries on.
 */
export async function resumeRun(c: PoolClient, p: Principal, runId: string) {
  const r = await getRun(c, runId, true);
  const t = await getTask(c, p, r.task_id);
  if (!canControl(p, r, t)) throw new Forbidden("only the person who started the run, the assignee or an editor of the task can continue it");
  if (r.status !== "paused") throw new Conflict(`a run that is ${r.status} cannot be continued`);
  const inFlight = r.steps[r.current_step]?.state === "running";
  if (r.runner === "server") r.status = "running";
  else if (inFlight && r.claimed_by) r.status = "running";
  else {
    r.status = "queued";
    r.claimed_by = null;
  }
  await saveRun(c, r);
  await activity(c, "task", r.task_id, "agent_run_resumed", { runId });
  await emit(c, "work.run.resumed.v1", "work.run", r.id, await runEvent(c, r));
  await auditRun(c, r, "resumed");
  return { run: r, kick: r.runner === "server" };
}

/** Back in line: a server run goes on in this process (the caller kicks it), a local one waits for its runner. */
function requeue(r: RunRow) {
  r.status = r.runner === "local" ? "queued" : "running";
  r.claimed_by = null;
}

/** A person lets a waiting run go on; their note (a choice, a correction) becomes that step's output. */
/** A wait for approval closed: the notices that asked for it are settled (home), whoever acted. */
async function approvalClosed(c: PoolClient, r: RunRow, waitId: string | undefined, outcome: "approved" | "sent_back" | "cancelled") {
  if (waitId) await emit(c, "work.run.decided.v1", "work.run", r.id, { ...(await runEvent(c, r)), waitId, outcome });
}

/**
 * Who is told that a run waits for approval: the people who can give it. A step that names someone means that one
 * person; "anyone who may edit the task" cannot be listed, so it is the people on the task (who started the run, the
 * owner, the assignee) who may edit it. Somebody else who may edit still finds it under "Waiting for you" on the task.
 */
async function approvalRecipients(e: Engine, r: RunRow, t: TaskRow): Promise<string[]> {
  const s = r.steps[r.current_step];
  const named = s?.approver === "person" ? s.approverId : null;
  const out: string[] = [];
  for (const id of new Set([named, r.started_by, t.owner_id, t.assignee_id].filter((x): x is string => !!x))) {
    const who = await e.resolve(id).catch(() => null);
    if (who && canApprove(who, r, t)) out.push(id);
  }
  return out;
}

export async function approveRun(c: PoolClient, p: Principal, runId: string, note: string) {
  const r = await getRun(c, runId, true);
  const t = await getTask(c, p, r.task_id);
  if (r.status !== "waiting_approval") throw new Invalid("this run is not waiting for approval");
  if (!canApprove(p, r, t)) throw new Forbidden("this step is for someone else to approve");
  const s = r.steps[r.current_step]!;
  await approvalClosed(c, r, s.waitId, "approved");
  r.steps[r.current_step] = { ...logNote(s, "approved", p.id, note), state: "done", output: note.trim() || undefined, finishedAt: new Date().toISOString() };
  r.current_step += 1;
  requeue(r);
  await saveRun(c, r);
  await activity(c, "task", r.task_id, "agent_run_approved", { runId });
  await auditRun(c, r, "approved");
  return r;
}

/** A step back to "not run yet": what it is stays, what it did goes, its log (and a check's count) is kept. */
function reset(x: RunStep): RunStep {
  const { input: _i, output: _o, startedAt: _s, finishedAt: _f, rework: _r, decide: _d, waitedMs: _w, waitingSince: _ws, ran: _ran, retried: _rt, ...keep } = x;
  return { ...keep, state: "pending" };
}

/** The AI step whose result is under review at step `index`: the last one before it with a result. */
function authorOf(r: RunRow, index: number): number {
  for (let i = index - 1; i >= 0; i--) if (r.steps[i]!.kind === "ai" && r.steps[i]!.output) return i;
  return -1;
}

/**
 * Sends the run back to the AI step `at`: it runs again with the request and its previous result, and every step
 * after it up to the current one runs again too (commands, checks, the approval).
 */
function sendBack(r: RunRow, at: number, note: string, by: string, check?: string) {
  const s = r.steps[at]!;
  const text = note.trim().slice(0, 4000);
  r.steps[at] = {
    ...reset(logNote(s, check ? "sent_back" : "rework", by, text)),
    rework: { note: text, previous: (s.output ?? "").slice(0, 12_000), by, at: new Date().toISOString(), ...(check ? { check } : {}) },
  };
  for (let i = at + 1; i <= r.current_step && i < r.steps.length; i++) r.steps[i] = reset(r.steps[i]!);
  r.current_step = at;
}

/**
 * The approver asked for changes instead of approving: the run goes back to the AI step whose result was under review
 * and runs it again with the request; every step after it, the approval included, runs again too. A note is required,
 * it is the whole point.
 */
export async function reworkRun(c: PoolClient, p: Principal, runId: string, note: string) {
  const r = await getRun(c, runId, true);
  const t = await getTask(c, p, r.task_id);
  if (r.status !== "waiting_approval") throw new Invalid("this run is not waiting for approval");
  if (!canApprove(p, r, t)) throw new Forbidden("this step is for someone else to approve");
  if (!note.trim()) throw new Invalid("say what should change");
  const at = authorOf(r, r.current_step);
  if (at < 0) throw new Invalid("there is no AI result to send back");
  await approvalClosed(c, r, r.steps[r.current_step]?.waitId, "sent_back");
  sendBack(r, at, note, p.id);
  requeue(r);
  await saveRun(c, r);
  await activity(c, "task", r.task_id, "agent_run_rework", { runId });
  return r;
}

/**
 * A failed run goes again from the step that failed: everything made before it is kept. The step's own retries and
 * a check's count start over, so a person's "try again" is a real second chance.
 */
export async function retryRun(c: PoolClient, p: Principal, runId: string) {
  const r = await getRun(c, runId, true);
  const t = await getTask(c, p, r.task_id);
  if (!canControl(p, r, t)) throw new Forbidden("only the person who started the run, the assignee or an editor of the task can run it again");
  if (r.status !== "failed" || r.current_step >= r.steps.length) throw new Conflict("only a failed run can be run again from where it stopped");
  const busy = await c.query("SELECT 1 FROM task_agent_runs WHERE task_id = $1 AND status = ANY($2) AND id <> $3", [r.task_id, ACTIVE, r.id]);
  if (busy.rowCount) throw new Invalid("a run is already in progress for this task");
  const s = r.steps[r.current_step]!;
  const { sentBack: _sb, verdict: _v, ...again } = reset(logNote(s, "retry", p.id));
  r.steps[r.current_step] = again;
  r.error = null;
  r.finished_at = null;
  r.requeues = 0;
  requeue(r);
  await saveRun(c, r);
  await activity(c, "task", r.task_id, "agent_run_retried", { runId });
  return r;
}

// ── Step log ─────────────────────────────────────────────────────────────────────────────────────────
// Kept in the run's steps (JSONB) and sent with every poll of the pipeline, so it is capped: the latest entries, each
// text clipped. The step's own `input`/`output` still hold the latest attempt in full.
export const LOG_ENTRIES = 12;
const LOG_INPUT = 4000;
const LOG_OUTPUT = 6000;
const clipLog = (text: string | undefined, n: number) => (text && text.length > n ? `${text.slice(0, n)}\n…` : text || undefined);
const pushLog = (s: RunStep, e: StepEntry): RunStep => ({ ...s, history: [...(s.history ?? []), e].slice(-LOG_ENTRIES) });

/** The step starts running: a new attempt opens with what it was given. */
export const logAttempt = (s: RunStep, input: string | undefined, ran?: StepRan): RunStep =>
  pushLog(s, { at: new Date().toISOString(), kind: "attempt", input: clipLog(input, LOG_INPUT), ...(ran ? { ran } : {}) });

/**
 * The open attempt ends. A step running without one (a run from before the log existed) gets one; a step whose attempt
 * already ended (it asked, then the run failed) is left as it is.
 */
export function endAttempt(
  s: RunStep,
  outcome: NonNullable<StepEntry["outcome"]>,
  b: { output?: string | undefined; ran?: StepRan | undefined; text?: string | undefined } = {},
): RunStep {
  const history = [...(s.history ?? [])];
  let i = history.length - 1;
  while (i >= 0 && !(history[i]!.kind === "attempt" && !history[i]!.outcome)) i--;
  const now = new Date().toISOString();
  if (i < 0 && s.state !== "running") return s;
  const open = i >= 0 ? history[i]! : { at: s.startedAt ?? now, kind: "attempt" as const };
  const done: StepEntry = {
    ...open,
    outcome,
    end: now,
    ...(b.output ? { output: clipLog(b.output, LOG_OUTPUT) } : {}),
    ...(b.ran ? { ran: b.ran } : {}),
    ...(b.text ? { text: b.text.slice(0, 2000) } : {}),
  };
  if (i >= 0) history[i] = done;
  else history.push(done);
  return { ...s, history: history.slice(-LOG_ENTRIES) };
}

/** What happened to the step besides running: a person's answer or decision, a check's verdict, a retry. */
export const logNote = (s: RunStep, kind: Exclude<StepEntry["kind"], "attempt">, by: string, text?: string, outcome?: StepEntry["outcome"]): RunStep =>
  pushLog(s, { at: new Date().toISOString(), kind, by, ...(text?.trim() ? { text: clipLog(text.trim(), LOG_OUTPUT) } : {}), ...(outcome ? { outcome } : {}) });

// ── The engine ───────────────────────────────────────────────────────────────────────────────────────

/** What a driver (this process, or a runner) is handed to execute. */
export interface Exec {
  index: number;
  key: string;
  title: string;
  kind: "ai" | "command" | "check";
  taskId: string;
  /** ai, an AI-judged check: the whole instruction. */
  input?: string | undefined;
  /** command, a command check. */
  command?: string | undefined;
  /** command: the answers given at Run, as environment variables (INPUT_<KEY>). */
  env?: Record<string, string> | undefined;
  model?: string | undefined;
  role?: string | undefined;
  tools?: boolean | undefined;
  maxOutput?: number | undefined;
  timeoutMin: number;
}
/** The run is over on a runner but for the files of its `out` folder. */
export type Next = { exec: Exec } | { collect: true } | null;

const JUDGE_ROLE = "A strict reviewer. You judge the result against the requirements; you never rewrite it.";

/** Why a run may not go on, or null: its working time or its tokens are over the workflow's limits. */
function overLimit(r: RunRow, conf: WorkflowConfig): string | null {
  const g = conf.guardrails;
  if (workMs(r) > g.maxMinutes * 60_000) return `over the time limit: this workflow allows ${g.maxMinutes} minutes of work per run`;
  const used = (r.usage?.inputTokens ?? 0) + (r.usage?.outputTokens ?? 0);
  if (g.maxTokens > 0 && used >= g.maxTokens) return `over the token budget: ${used.toLocaleString("en")} of ${g.maxTokens.toLocaleString("en")} tokens used`;
  return null;
}

/** Where a task change made by this run comes from, for workflows that start by themselves. */
const originOf = (r: Pick<RunRow, "workflow_id" | "trigger">) => ({ workflowId: r.workflow_id ?? "", depth: r.trigger?.depth ?? 0 });

/** A status step, done by the server for either runner: the task moves as the person the run acts for. */
async function applyStatus(c: PoolClient, p: Principal, r: RunRow, status: TaskRow["status"] | "" | undefined) {
  const t = await getTask(c, p, r.task_id);
  if (!status || t.status === status) return;
  // The normal path (permission, activity, events, Follow-up), at the version just read. The move is the workflow's
  // own doing: it carries where it came from, so it never starts this workflow again (workflows/triggers.ts).
  await withOrigin(originOf(r), () => updateTask(c, p, t.id, { expectedVersion: t.version, status }));
}

/**
 * Moves the run forward through everything the server does itself (task moves, parking for an approval, finishing)
 * and returns the next thing to execute, marked as running, or null when the run now waits or is over. `actor` is the
 * person the run acts for: who started it (or, on the server, who let it go on).
 */
export async function advance(e: Engine, c: PoolClient, actor: Principal, r: RunRow): Promise<Next> {
  const conf = cfg(r);
  for (let guard = 0; guard < 80; guard++) {
    if (r.status !== "queued" && r.status !== "running") return null;
    const over = overLimit(r, conf);
    if (over) {
      await fail(c, r, over);
      return null;
    }
    if (r.current_step >= r.steps.length) {
      // A runner first hands back what the run wrote to its out folder; the result is delivered after.
      if (r.runner === "local" && conf.output.files && r.env && !r.env.collected) {
        r.status = "running";
        await saveRun(c, r);
        return { collect: true };
      }
      await finish(c, actor, r, conf);
      return null;
    }
    const index = r.current_step;
    const s = r.steps[index]!;
    const now = new Date().toISOString();
    r.status = "running";
    if (s.kind === "approval") {
      r.status = "waiting_approval";
      // A runner lets go while people decide; the run comes back to its queue (and to the same computer, see claim).
      r.claimed_by = null;
      const waitId = `${r.id}.${index}.${Date.now().toString(36)}`;
      r.steps[index] = { ...s, state: "waiting", startedAt: now, waitId };
      await saveRun(c, r);
      const wt = await c.query<TaskRow>(`SELECT ${TASK_COLS} FROM tasks WHERE id = $1`, [r.task_id]).then((x) => x.rows[0]!);
      await emit(c, "work.run.waiting.v1", "work.run", r.id, {
        ...(await runEvent(c, r)),
        reason: "approval",
        step: s.title,
        waitId,
        title: wt.title,
        recipientIds: await approvalRecipients(e, r, wt),
      });
      return null;
    }
    if (s.kind === "status") {
      await applyStatus(c, actor, r, s.status);
      r.steps[index] = { ...s, state: "done", startedAt: now, finishedAt: now };
      r.current_step += 1;
      continue;
    }
    if ((s.kind === "command" || (s.kind === "check" && s.command)) && r.runner !== "local") {
      await fail(c, r, `step "${s.title}" runs a command: it needs a sandbox or a computer`);
      return null;
    }
    const t = await getTask(c, actor, r.task_id);
    const timeoutMin = s.timeoutMin ?? conf.guardrails.stepMinutes;
    const base = { index, key: s.key, title: s.title, taskId: t.id, timeoutMin };
    let exec: Exec;
    if (s.kind === "command") exec = { ...base, kind: "command", ...commandWithInputs(s.command!, r.inputs ?? {}) };
    else if (s.kind === "check") {
      const last = lastResult(r.steps, index);
      if (!last) {
        // Nothing was made before it (the steps were edited since): there is nothing to judge.
        r.steps[index] = { ...logNote(s, "checked", "check", "nothing to check", "done"), state: "done", startedAt: now, finishedAt: now };
        r.current_step += 1;
        continue;
      }
      if (s.command) exec = { ...base, kind: "check", ...commandWithInputs(s.command, r.inputs ?? {}) };
      else {
        // The requirements may name what the run was started with ({{input.<key>}}) or an earlier result; the judge
        // also reads the workflow's reference material unless the step leaves it out.
        const criteria = renderPrompt(s.criteria ?? "", { task: t, context: "", steps: r.steps, index, fields: conf.inputs, inputs: r.inputs ?? {}, resources: "" });
        const reference = s.resources === false ? "" : await readResources(c, e.storage, actor, r.workflow_id, conf.resources, r.runner === "local");
        const input = checkPrompt(criteria, last.text, r.steps[last.from]!.title, `${t.code} · ${t.title}\n\n${(t.description || "").slice(0, 2000)}`.trim(), reference);
        exec = { ...base, kind: "check", input, model: s.model ?? (r.runner === "server" ? "fast" : ""), role: JUDGE_ROLE, tools: false, maxOutput: 1000 };
      }
    } else {
      // The run's rounds of questions and their answers (agent-ask.ts): every step reads them, a step may ask within
      // the caps unless the workflow or the step says never, and a step that asked anyway runs again told to decide.
      const rounds = await runRounds(c, r.id);
      const may = mayAsk(conf, s, rounds, index);
      const rendered = renderPrompt(s.prompt ?? "", {
        task: t,
        context: [conf.resources.taskContext ? await taskContext(c, actor, t) : "", r.trigger?.payload ? payloadBlock(r.trigger.payload) : ""].filter(Boolean).join("\n\n"),
        steps: r.steps,
        index,
        fields: conf.inputs,
        inputs: r.inputs ?? {},
        resources: s.resources === false ? "" : await readResources(c, e.storage, actor, r.workflow_id, conf.resources, r.runner === "local"),
      });
      const note =
        r.runner === "local" ? runnerNote({ assets: conf.resources.files.length + conf.resources.drive.length > 0 || conf.resources.taskFiles, out: conf.output.files }) : "";
      const body = [rendered, s.rework ? reworkText(s.rework) : "", note].filter(Boolean).join("\n\n");
      const prompt = composePrompt(body, rounds, may);
      // A coding agent has no system prompt to set: on a runner the role opens the instruction.
      const input = r.runner === "local" && s.role?.trim() ? `Your role for this step:\n${s.role.trim()}\n\n${prompt}` : prompt;
      exec = { ...base, kind: "ai", input, model: s.model, role: s.role, tools: s.tools, maxOutput: s.maxOutput };
    }
    const shown = exec.input ?? `$ ${exec.command}`;
    r.steps[index] = { ...logAttempt(s, shown), state: "running", input: shown.slice(0, 20_000), startedAt: s.startedAt ?? now, finishedAt: undefined };
    await saveRun(c, r);
    await addActivity(c, r.id, index, [{ kind: "start", text: exec.command ? `$ ${exec.command}` : "" }]);
    return { exec };
  }
  await fail(c, r, "the run kept going back and forth between its steps");
  return null;
}

const mayAsk = (conf: WorkflowConfig, s: RunStep, rounds: AskRound[], index: number) =>
  conf.guardrails.ask !== "never" && s.ask !== false && !s.decide && mayAskInRun(rounds, index);

export interface StepResult {
  ok: boolean;
  output: string;
  ran?: StepRan | undefined;
  /** The step ran out of time. */
  timeout?: boolean | undefined;
  exitCode?: number | undefined;
  /** Why it failed, in words for the run's error (server: the AI's reason). */
  reason?: string | undefined;
}

/**
 * Takes the result of the step in progress: a result moves the run on, questions park it for people, a check's
 * verdict passes or sends the work back, a failure is tried again while the step has retries left and fails the run
 * after. The caller has locked the run and checked that `index` is still its current, running step.
 */
export async function completeStep(c: PoolClient, r: RunRow, index: number, res: StepResult): Promise<void> {
  const conf = cfg(r);
  const s = r.steps[index]!;
  const now = new Date().toISOString();
  if (res.ran)
    r.usage = { ...r.usage, inputTokens: (r.usage?.inputTokens ?? 0) + (res.ran.inputTokens ?? 0), outputTokens: (r.usage?.outputTokens ?? 0) + (res.ran.outputTokens ?? 0) };
  // Paused while the step ran: its result counts, then the run holds (a runner lets go of it).
  const held = r.status === "paused";
  await clearDraft(c, r.id, index);

  let verdict: Verdict | null = null;
  if (s.kind === "check") {
    if (s.command) verdict = res.ok ? { pass: true, issues: [] } : res.timeout ? null : { pass: false, issues: [commandIssues(res.output, res.exitCode)] };
    else verdict = res.ok ? parseVerdict(res.output) : null;
  }
  const failed = s.kind === "check" ? !verdict : !res.ok;
  if (failed) {
    const why = res.reason ?? (res.timeout ? `step "${s.title}" ran out of time` : s.kind === "check" && res.ok ? `the check "${s.title}" gave no verdict` : "");
    await addActivity(c, r.id, index, [
      { kind: "error", text: why || (res.exitCode !== undefined ? `exit code ${res.exitCode}` : "the step failed"), detail: res.output.trim().slice(-1500) },
    ]);
    // A check that could not be read is asked once more before the run fails over it.
    const allowed = s.kind === "check" ? Math.max(1, s.retries ?? 0) : (s.retries ?? 0);
    if ((s.retried ?? 0) < allowed) {
      const ended = endAttempt(s, res.timeout ? "timeout" : "failed", { output: res.output, ran: res.ran, text: why });
      r.steps[index] = { ...logNote(ended, "retry", "system", why), state: "pending", retried: (s.retried ?? 0) + 1 };
      if (held) r.claimed_by = null;
      await saveRun(c, r);
      return;
    }
    // Marked failed here, with how the attempt ended, so `fail` does not open a second entry for it.
    r.steps[index] = {
      ...endAttempt(s, res.timeout ? "timeout" : "failed", { output: res.output, ran: res.ran, text: why }),
      state: "failed",
      output: res.output ? res.output.slice(0, 20_000) : undefined,
    };
    await fail(c, r, why || res.output.trim().slice(-500) || `step "${s.title}" failed`);
    return;
  }

  if (s.kind === "check") {
    await applyVerdict(c, r, index, verdict!, res);
    if (held && r.status === "paused") {
      r.claimed_by = null;
      await saveRun(c, r);
    }
    return;
  }

  if (s.kind === "ai") {
    // The AI asks before it acts: the run waits for answers (or the step runs again told to decide).
    const questions = parseAsk(res.output);
    if (questions) {
      const rounds = await runRounds(c, r.id);
      await askPeople(c, r, questions, rounds, res.output, res.ran, mayAsk(conf, s, rounds, index));
      return;
    }
  }
  const output = s.kind === "ai" ? unfence(res.output) : res.output;
  r.steps[index] = { ...endAttempt(s, "done", { output: res.output, ran: res.ran }), state: "done", output: output.slice(0, 20_000), ran: res.ran ?? s.ran, finishedAt: now };
  r.current_step += 1;
  if (held) r.claimed_by = null;
  await saveRun(c, r);
}

/**
 * A check has judged. Passed: the run goes on. Not passed: the work goes back to the AI step that made it, with the
 * issues, while the check has attempts left; after that the run stops, or goes on with the issues on record when the
 * workflow says so (a person's approval usually follows).
 */
async function applyVerdict(c: PoolClient, r: RunRow, index: number, verdict: Verdict, res: StepResult) {
  const s = r.steps[index]!;
  const now = new Date().toISOString();
  const v = { ...verdict, round: (s.verdict?.round ?? 0) + 1, at: now };
  const judged = logNote(
    endAttempt(s, "done", { output: res.output, ran: res.ran }),
    "checked",
    "check",
    verdict.pass ? "" : issuesText(verdict.issues),
    verdict.pass ? "done" : "failed",
  );
  if (verdict.pass) {
    r.steps[index] = { ...judged, state: "done", verdict: v, ran: res.ran ?? s.ran, finishedAt: now };
    r.current_step += 1;
    await saveRun(c, r);
    return;
  }
  const sent = s.sentBack ?? 0;
  const author = authorOf(r, index);
  if (sent < (s.attempts ?? 2) && author >= 0) {
    r.steps[index] = { ...judged, verdict: v, sentBack: sent + 1 };
    sendBack(r, author, issuesText(verdict.issues), "check", s.title);
    await saveRun(c, r);
    return;
  }
  if (s.onFail === "continue") {
    r.steps[index] = { ...judged, state: "done", verdict: v, ran: res.ran ?? s.ran, finishedAt: now };
    r.current_step += 1;
    await saveRun(c, r);
    return;
  }
  r.steps[index] = { ...judged, state: "failed", verdict: v };
  await fail(c, r, `the check "${s.title}" did not pass: ${verdict.issues[0] ?? "see its issues"}`);
}

/**
 * The run is over: its last result is delivered where the workflow says (a comment on the task, a page in Docs,
 * subtasks from its checklist, a task move). Each delivery stands alone: one that fails is noted on the run, the
 * others still happen and the run is still done.
 */
async function finish(c: PoolClient, p: Principal, r: RunRow, conf: WorkflowConfig) {
  r.status = "done";
  r.finished_at = new Date();
  r.claimed_by = null;
  const out = lastResult(r.steps, r.steps.length)?.text ?? "";
  const o = conf.output;
  const t = await getTask(c, p, r.task_id);
  const problems: string[] = [];
  const attempt = async (what: string, fn: () => Promise<void>) => {
    try {
      await c.query("SAVEPOINT wf_deliver");
      await fn();
      await c.query("RELEASE SAVEPOINT wf_deliver");
    } catch (err) {
      await c.query("ROLLBACK TO SAVEPOINT wf_deliver").catch(() => undefined);
      problems.push(`${what}: ${(err as Error).message}`);
    }
  };
  let page: { id: string; title: string } | null = null;
  if (o.doc && out)
    await attempt("could not save the page", async () => {
      const title = resultTitle(out, `${t.code} · ${r.workflow_name}`);
      const d = await createDoc(c, p, { title, content: out, projectId: t.project_id, format: "markdown" });
      // The people on the task read what was made for it.
      const readers = [...new Set([t.owner_id, t.assignee_id, r.started_by].filter((x): x is string => !!x && x !== p.id))];
      if (readers.length) await shareDoc(c, p, d.id, readers, undefined);
      page = { id: d.id, title };
      r.artifacts = [...(r.artifacts ?? []), { kind: "doc", id: d.id, name: title }];
    });
  if (o.subtasks && out) {
    const items = checklistItems(out);
    if (items.length)
      await attempt("could not create the subtasks", async () => {
        for (const title of items)
          await createTask(c, p, {
            title,
            description: "",
            assigneeId: null,
            projectId: t.project_id,
            priority: t.priority,
            dueAt: null,
            labels: [],
            customFields: {},
            parentId: t.id,
            source: { type: "workflow", runId: r.id },
          });
        r.artifacts = [...(r.artifacts ?? []), { kind: "subtasks", name: r.workflow_name, count: items.length }];
      });
  }
  if (o.comment)
    await attempt("could not post the result", async () => {
      const link = page ? `\n\n[${(page as { title: string }).title.replace(/[[\]]/g, "")}](/app/work/docs/${(page as { id: string }).id})` : "";
      // Under the workflow's name (migration work/010), not as if the person who pressed Run wrote it.
      await insertComment(c, p, t, `${out ? out.slice(0, 9500 - link.length) : "✓"}${link}`, r.workflow_name);
    });
  if (o.status) await attempt("could not move the task", () => applyStatus(c, p, r, o.status));
  if (problems.length) r.error = problems.join("; ").slice(0, 2000);
  await saveRun(c, r);
  await activity(c, "task", r.task_id, "agent_run_done", { runId: r.id });
  await emit(c, "work.run.finished.v1", "work.run", r.id, { ...(await runEvent(c, r)), status: "done", error: null });
  await auditRun(c, r, "finished");
}

async function fail(c: PoolClient, r: RunRow, message: string) {
  r.status = "failed";
  r.error = message.slice(0, 2000);
  r.finished_at = new Date();
  r.claimed_by = null;
  const cur = r.steps[r.current_step];
  if (cur) r.steps[r.current_step] = { ...endAttempt(cur, "failed", { text: r.error }), state: "failed", finishedAt: new Date().toISOString() };
  await saveRun(c, r);
  await activity(c, "task", r.task_id, "agent_run_failed", { runId: r.id, error: r.error });
  await emit(c, "work.run.finished.v1", "work.run", r.id, { ...(await runEvent(c, r)), status: "failed", error: r.error });
  await auditRun(c, r, "finished", true);
}

// ── The server's driver ──────────────────────────────────────────────────────────────────────────────

/** Runs this process is driving, and those asked to go on while their driver was still winding down. */
const driving = new Set<string>();
const again = new Map<string, Principal>();

const timeoutAfter = (ms: number) =>
  new Promise<never>((_, reject) => {
    setTimeout(() => reject(Object.assign(new Error("timeout"), { name: "TimeoutError" })), ms).unref();
  });

/**
 * Drives a server run until it ends or waits for a person. AI steps go to the ai module as `p` (the person who
 * started it or let it go on), one step per transaction, so the page sees progress while the model works.
 */
export async function driveServerRun(e: Engine, p: Principal, runId: string): Promise<void> {
  if (driving.has(runId)) {
    again.set(runId, p);
    return;
  }
  driving.add(runId);
  try {
    for (let guard = 0; guard < 200; guard++) {
      const next = await withTransaction(e.pool, async (c) => {
        const r = await getRun(c, runId, true);
        if (r.runner !== "server") return null;
        return advance(e, c, p, r);
      });
      if (!next || !("exec" in next)) return;
      const x = next.exec;
      let res: StepResult;
      try {
        const body = { prompt: x.input, taskId: x.taskId, model: x.model, role: x.role, tools: x.tools, maxTokens: x.maxOutput, runId, step: x.index };
        const r = await Promise.race([e.ai.request<{ text: string; ran?: StepRan }>("POST", "/workflows/step", body, p), timeoutAfter(x.timeoutMin * 60_000)]);
        res = { ok: true, output: r.text ?? "", ran: r.ran };
      } catch (err) {
        const er = err as { status?: number; body?: { error?: string; message?: string }; name?: string };
        const timeout = er.name === "TimeoutError" || er.name === "AbortError";
        res = {
          ok: false,
          output: "",
          timeout,
          reason: er.body?.message ?? er.body?.error ?? (timeout ? "the AI took too long to answer" : er.status ? `the AI step failed (${er.status})` : "the AI step failed"),
        };
      }
      const stop = await withTransaction(e.pool, async (c) => {
        const r = await getRun(c, runId, true);
        // Cancelled while the model was working: keep the cancellation. Paused: the step's result counts, then it holds.
        if ((r.status !== "running" && r.status !== "paused") || r.current_step !== x.index || r.steps[x.index]?.state !== "running") return true;
        await completeStep(c, r, x.index, res);
        return r.status !== "running";
      });
      if (stop) return;
    }
  } finally {
    driving.delete(runId);
    const who = again.get(runId);
    if (who) {
      again.delete(runId);
      void driveServerRun(e, who, runId).catch(() => undefined);
    }
  }
}

/** Starts driving a server run without holding the request (the page polls the run). */
export function kickServerRun(e: Engine, p: Principal, runId: string, requestId: string) {
  void runWithContext({ actorId: p.id, requestId }, () => driveServerRun(e, p, runId)).catch((err: unknown) => {
    // The run records its own failure; this is only for what the engine itself got wrong.
    logger.warn({ err, runId }, "agent run driver stopped");
  });
}

/**
 * Picks up server runs nobody is driving (this process restarted mid-run, or a driver died): the step that was in
 * progress goes back to "not run yet" and the run goes on as the person who started it. Runs at start and every
 * minute; a run touched in the last `quietSeconds` is left alone (its driver is between two writes).
 */
export async function resumeServerRuns(e: Engine, quietSeconds = 45): Promise<number> {
  const rows = (
    await e.pool.query<{ id: string; started_by: string }>(
      `SELECT id, started_by FROM task_agent_runs WHERE runner = 'server' AND status IN ('queued','running') AND updated_at < now() - make_interval(secs => $1) LIMIT 50`,
      [quietSeconds],
    )
  ).rows.filter((r) => !driving.has(r.id));
  for (const row of rows) {
    try {
      const p = await e.resolve(row.started_by);
      await withTransaction(e.pool, async (c) => {
        const r = await getRun(c, row.id, true);
        if (r.status !== "queued" && r.status !== "running") return;
        r.steps = r.steps.map((s) => (s.state === "running" ? { ...endAttempt(s, "cancelled", { text: "interrupted: the server restarted" }), state: "pending" as const } : s));
        await saveRun(c, r);
      });
      kickServerRun(e, p, row.id, newId());
    } catch (err) {
      // Whoever started it is gone (left the workspace): the run cannot act for them any more.
      logger.warn({ err, runId: row.id }, "could not resume an agent run");
      await withTransaction(e.pool, async (c) =>
        runWithContext({ actorId: row.started_by, requestId: newId() }, async () =>
          fail(c, await getRun(c, row.id, true), "interrupted: the server restarted and the run could not be resumed"),
        ),
      ).catch(() => undefined);
    }
  }
  // A server run paused mid-step lost that AI call with the process: the step goes back to pending for Continue.
  await e.pool.query(
    `UPDATE task_agent_runs SET
            steps = (SELECT jsonb_agg(CASE WHEN s->>'state' = 'running' THEN s || '{"state":"pending"}'::jsonb ELSE s END ORDER BY i) FROM jsonb_array_elements(steps) WITH ORDINALITY AS x(s, i))
      WHERE runner = 'server' AND status = 'paused' AND steps @> '[{"state":"running"}]'::jsonb AND updated_at < now() - make_interval(secs => $1)`,
    [Math.max(quietSeconds, 15 * 60)],
  );
  return rows.length;
}

/** How long a runner may stay silent on a run it claimed before the run is taken back. */
const RUNNER_SILENCE_SECONDS = 150;
const MAX_REQUEUES = 2;

/**
 * A runner that claimed a run and went away (the computer slept, the process was killed): the run goes back in the
 * queue with the step in progress to run again, twice at most, then it fails and says so.
 */
export async function reclaimSilentRuns(pool: Pool): Promise<number> {
  const rows = (
    await pool.query<{ id: string; started_by: string }>(
      `SELECT id, started_by FROM task_agent_runs
        WHERE runner = 'local' AND status = 'running' AND claimed_by IS NOT NULL AND COALESCE(heartbeat_at, updated_at) < now() - make_interval(secs => $1) LIMIT 50`,
      [RUNNER_SILENCE_SECONDS],
    )
  ).rows;
  for (const row of rows)
    await runWithContext({ actorId: row.started_by, requestId: newId() }, () =>
      withTransaction(pool, async (c) => {
        const r = await getRun(c, row.id, true);
        if (r.status !== "running" || !r.claimed_by) return;
        if ((r.requeues ?? 0) >= MAX_REQUEUES) {
          await fail(c, r, `the runner (${r.claimed_by}) stopped answering`);
          return;
        }
        const device = r.claimed_by;
        r.steps = r.steps.map((s) =>
          s.state === "running" ? { ...logNote(endAttempt(s, "cancelled", { text: "the runner stopped answering" }), "requeued", "system", device), state: "pending" as const } : s,
        );
        r.status = "queued";
        r.claimed_by = null;
        r.requeues = (r.requeues ?? 0) + 1;
        // Another computer may take it: whatever the first one prepared is gone with it.
        r.env = null;
        await saveRun(c, r);
      }),
    ).catch((err: unknown) => logger.warn({ err, runId: row.id }, "could not take back a silent run"));
  return rows.length;
}

/** The minute's watch over runs in flight: pick up server runs nobody drives, take back runs whose runner went away. */
export async function watchRuns(e: Engine) {
  await resumeServerRuns(e);
  await reclaimSilentRuns(e.pool);
}

// ── Runners ──────────────────────────────────────────────────────────────────────────────────────────

/** A runner's protocol version this server speaks (the runner script sends it with every claim). */
export const RUNNER_PROTOCOL = 2;
/** The newest runner script (frontend/web/public/runner/workspace-runner.mjs VERSION): an older one is told to update. */
export const RUNNER_VERSION = 3;

const mayServeCompany = (p: Principal) => allowedAny(p, "ai.agent.manage", [{}]);
const serves = (p: Principal, r: Pick<RunRow, "started_by" | "host">) => r.started_by === p.id || (r.host === "company" && mayServeCompany(p));

/** A runner's run, and the person it acts for: its own key's owner, or (a company runner) whoever started the run. */
async function runnerRun(e: Engine, c: PoolClient, p: Principal, runId: string, lock = true): Promise<{ r: RunRow; actor: () => Promise<Principal> }> {
  const r = await getRun(c, runId, lock);
  if (r.runner !== "local" || !serves(p, r)) throw new Forbidden("not your run");
  // The runner is only the hands of the run: what it reads and hands back is done as the person who started the run,
  // with their own permissions. The key of Connect this computer carries only a few task
  // permissions, so acting as the key refused every file a sandbox handed back and every attachment it downloaded.
  // Looked up only by the calls that act (a step's log lines do not).
  let actor: Promise<Principal> | undefined;
  return { r, actor: () => (actor ??= e.resolve(r.started_by)) };
}

/**
 * The runner asks for work: the next queued run it may take (its owner's own, and, as a company runner, runs set to
 * the company's runners), now claimed by that device. A run that already has a sandbox on another computer waits for
 * that computer. Back: what to prepare (the environment, the files to download), never a step: steps come from `next`.
 */
export async function claimLocalRun(
  e: Engine,
  c: PoolClient,
  p: Principal,
  b: {
    device: string;
    protocol?: number | undefined;
    shared?: boolean | undefined;
    docker?: boolean | undefined;
    agent?: string | undefined;
    os?: string | undefined;
    version?: string | undefined;
  },
) {
  const device = b.device.slice(0, 80) || "runner";
  const shared = !!b.shared && mayServeCompany(p);
  await touchRunner(c, p, { device, shared, docker: !!b.docker, agent: b.agent ?? "", os: b.os ?? "", version: b.version ?? "" });
  // An older runner script cannot run checks or sandboxes: it gets nothing until it updates (it does so when it starts).
  if ((b.protocol ?? 1) < RUNNER_PROTOCOL) return { next: null, upgrade: true };
  // Same protocol, older script (it still works): it says so to whoever watches it, the next start fetches the new one.
  const behind = Number(b.version) > 0 && Number(b.version) < RUNNER_VERSION ? { latest: String(RUNNER_VERSION) } : {};
  const q = await c.query<RunRow>(
    `SELECT * FROM task_agent_runs
      WHERE runner = 'local' AND status = 'queued'
        AND ((host = 'person' AND started_by = $1) OR ($2 AND host = 'company' AND ($3 OR config->'environment'->>'isolation' IS DISTINCT FROM 'container')))
        AND (env->>'device' IS NULL OR env->>'device' = $4)
      ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
    [p.id, shared, !!b.docker, device],
  );
  const run = q.rows[0];
  if (!run) return { next: null, ...behind };
  // As the person who started the run, with their own permissions (see runnerRun): the Drive files they may read.
  const actor = await e.resolve(run.started_by);
  const conf = cfg(run);
  run.status = "running";
  run.claimed_by = device;
  // Coming back after an approval or an answer, the folder it prepared is still there: it only checks it.
  const resumed = run.env?.state === "ready" && run.env.device === device;
  if (!resumed) run.env = { state: "preparing", device, startedAt: new Date().toISOString() };
  await saveRun(c, run);
  await c.query("UPDATE task_agent_runs SET heartbeat_at = now() WHERE id = $1", [run.id]);
  const t = await getTask(c, actor, run.task_id);
  const assets: { name: string; url: string; size: number; from: "workflow" | "drive" | "task" }[] = [];
  if (e.storage && !resumed) {
    for (const f of await workflowFiles(c, run.workflow_id, conf.resources.files))
      assets.push({ name: f.name, size: f.size, from: "workflow", url: await e.storage.presignGet(f.key, 15 * 60, f.name) });
    // The Drive files the starter may read, like the workflow's own.
    for (const f of (await driveFiles(c, actor, conf.resources.drive)).files)
      assets.push({ name: f.name, size: f.size, from: "drive", url: await e.storage.presignGet(f.key, 15 * 60, f.name) });
    if (conf.resources.taskFiles) {
      const tf = await c.query<{ object_key: string; name: string; size: string }>(
        "SELECT object_key, name, size FROM files WHERE attached_type = 'task' AND attached_id = $1 AND status = 'active' ORDER BY created_at LIMIT 30",
        [t.id],
      );
      for (const f of tf.rows) assets.push({ name: f.name, size: Number(f.size), from: "task", url: await e.storage.presignGet(f.object_key, 15 * 60, f.name) });
    }
  }
  return {
    ...behind,
    next: {
      run: { id: run.id, workflowName: run.workflow_name, taskCode: t.code, taskTitle: t.title },
      environment: conf.environment,
      resumed,
      assets,
      collect: conf.output.files,
      limits: { stepMinutes: conf.guardrails.stepMinutes },
    },
  };
}

/** The runner says what it prepared (or that it could not): a folder, a container, the files it downloaded. */
export async function reportEnv(
  e: Engine,
  c: PoolClient,
  p: Principal,
  runId: string,
  b: {
    state: "preparing" | "ready" | "failed";
    isolation?: RunEnv["isolation"];
    image?: string | undefined;
    network?: "on" | "off" | undefined;
    agentIn?: RunEnv["agentIn"];
    assets?: number | undefined;
    log?: string | undefined;
  },
) {
  const { r } = await runnerRun(e, c, p, runId);
  if (r.status !== "running" && r.status !== "paused") return { status: r.status };
  const log = b.log ? ((r.env?.log ?? "") + b.log).slice(-12_000) : r.env?.log;
  r.env = {
    ...(r.env ?? { state: "preparing" }),
    state: b.state,
    device: r.claimed_by ?? r.env?.device,
    ...(b.isolation ? { isolation: b.isolation } : {}),
    ...(b.image ? { image: b.image.slice(0, 200) } : {}),
    ...(b.network ? { network: b.network } : {}),
    ...(b.agentIn ? { agentIn: b.agentIn } : {}),
    ...(b.assets !== undefined ? { assets: b.assets } : {}),
    ...(log ? { log } : {}),
    ...(b.state !== "preparing" ? { finishedAt: new Date().toISOString() } : {}),
  };
  if (b.state === "failed") {
    await fail(c, r, `the environment could not be prepared: ${(b.log ?? "").trim().slice(-400) || "see the log"}`);
    return { status: r.status };
  }
  await saveRun(c, r);
  return { status: r.status };
}

/** The runner asks what to do next: one step to execute, the files to hand back, or the run's status when it waits or is over. */
export async function nextLocalStep(e: Engine, c: PoolClient, p: Principal, runId: string) {
  const { r, actor } = await runnerRun(e, c, p, runId);
  if (r.status !== "running") return { status: r.status };
  const next = await advance(e, c, await actor(), r);
  if (!next) return { status: r.status };
  if ("collect" in next) return { status: r.status, collect: true };
  const x = next.exec;
  return {
    status: r.status,
    step: { index: x.index, key: x.key, title: x.title, kind: x.kind, input: x.input, command: x.command, env: x.env, model: x.model, timeoutMin: x.timeoutMin },
  };
}

/** The runner reports the step in progress: more of its log, or how it ended. */
export async function reportLocalStep(
  e: Engine,
  c: PoolClient,
  p: Principal,
  runId: string,
  b: {
    index: number;
    state: "log" | "done" | "failed" | "ask";
    output?: string | undefined;
    log?: string | undefined;
    /** What the agent did since the last report (workflows/activity.ts). */
    activity?: ActivityInput[] | undefined;
    questions?: unknown;
    /** The model (or agent command) the runner used for this step. */
    model?: string | undefined;
    exitCode?: number | undefined;
    timeout?: boolean | undefined;
  },
) {
  const { r } = await runnerRun(e, c, p, runId);
  // Paused while the runner was on a step: that step's result still counts (the runner holds the claim), then it holds.
  const held = r.status === "paused" && !!r.claimed_by;
  if (r.status !== "running" && !held) return { status: r.status };
  if (b.index !== r.current_step || r.steps[r.current_step]?.state !== "running") throw new Invalid("that is not the step in progress");
  const s = r.steps[r.current_step]!;
  if (b.log) r.steps[r.current_step] = { ...s, log: ((s.log ?? "") + b.log).slice(-20_000) };
  if (b.activity?.length) await addActivity(c, r.id, b.index, b.activity);
  const ran = b.model ? { model: b.model.slice(0, 200) } : undefined;
  if (b.state === "log") {
    // First the agent's command, then the model that really answered once the agent says it.
    if (ran) r.steps[r.current_step] = { ...r.steps[r.current_step]!, ran: { ...s.ran, ...ran } };
    await saveRun(c, r);
    return { status: r.status };
  }
  if (b.state === "ask") {
    // An explicit ask (the agent's own question tool), the same as a `workspace-ask` block in its output.
    const questions = normalizeQuestions(b.questions) ?? parseAsk(b.output ?? "");
    if (!questions) throw new Invalid("no questions to ask");
    const rounds = await runRounds(c, r.id);
    await askPeople(c, r, questions, rounds, b.output ?? "", ran, mayAsk(cfg(r), s, rounds, r.current_step));
    return { status: r.status };
  }
  await completeStep(c, r, b.index, { ok: b.state === "done", output: (b.output ?? "").slice(0, 40_000), ran, exitCode: b.exitCode, timeout: b.timeout });
  return { status: r.status };
}

/**
 * A step of the company's AI says what it is doing (the ai module, while it works on `/workflows/step`): the tools it
 * calls and the answer as it is written. Lines for a step that is no longer the one at work are dropped.
 */
export async function noteServerStep(c: PoolClient, runId: string, step: number, events: ActivityInput[]) {
  const r = await c
    .query<Pick<RunRow, "runner" | "status" | "current_step" | "steps">>("SELECT runner, status, current_step, steps FROM task_agent_runs WHERE id = $1", [runId])
    .then((x) => x.rows[0]);
  if (!r || r.runner !== "server" || (r.status !== "running" && r.status !== "paused") || r.current_step !== step || r.steps[step]?.state !== "running") return { ok: false };
  await addActivity(c, runId, step, events);
  return { ok: true };
}

/** A step's activity for the pipeline: to whoever may read the task. `after`: only the lines since that one. */
export async function runActivity(c: PoolClient, p: Principal, runId: string, step: number, after?: number) {
  const r = await getRun(c, runId);
  await getTask(c, p, r.task_id);
  return readActivity(c, r.id, step, after);
}

/** A run's activity across all its steps, in order, for its timeline: to whoever may read the task. */
export async function runTimeline(c: PoolClient, p: Principal, runId: string, after?: number) {
  const r = await getRun(c, runId);
  await getTask(c, p, r.task_id);
  return readRunActivity(c, r.id, after);
}

/** The runner hands back one file of the run's `out` folder: it is attached to the task, as the person the run acts for. */
export async function requestArtifact(e: Engine, c: PoolClient, p: Principal, runId: string, b: { name: string; contentType: string; size: number }) {
  const { r, actor } = await runnerRun(e, c, p, runId);
  if (!e.storage) throw new Invalid("file storage is not set up");
  if (r.status !== "running") throw new Conflict(`this run is ${r.status}`);
  if ((r.artifacts ?? []).filter((a) => a.kind === "file").length >= 30) throw new Invalid("a run hands back at most 30 files");
  return requestUpload(c, e.storage, await actor(), { ...b, attachTo: { type: "task", id: r.task_id } });
}

export async function confirmArtifact(e: Engine, c: PoolClient, p: Principal, runId: string, fileId: string) {
  const { r, actor } = await runnerRun(e, c, p, runId);
  if (!e.storage) throw new Invalid("file storage is not set up");
  await confirmUpload(c, e.storage, await actor(), fileId);
  const f = (await c.query<{ name: string; size: string }>("SELECT name, size FROM files WHERE id = $1 AND attached_type = 'task' AND attached_id = $2", [fileId, r.task_id]))
    .rows[0];
  if (!f) throw new NotFound("file not found");
  if (!(r.artifacts ?? []).some((a) => a.id === fileId)) r.artifacts = [...(r.artifacts ?? []), { kind: "file", id: fileId, name: f.name, size: Number(f.size) }];
  await saveRun(c, r);
  return { ok: true };
}

/** The runner has handed back everything (or there was nothing): the run can be delivered and finish. */
export async function collected(e: Engine, c: PoolClient, p: Principal, runId: string, b: { log?: string | undefined; missing?: { name: string; why: string }[] | undefined }) {
  const { r } = await runnerRun(e, c, p, runId);
  if (r.status !== "running") return { status: r.status };
  r.env = { ...(r.env ?? { state: "ready" }), collected: true, ...(b.log ? { log: ((r.env?.log ?? "") + b.log).slice(-12_000) } : {}) };
  // A file the run made that never reached the task fails the run with what and why: a run that says done while its
  // result was lost is worse than one that says it failed (the files that did arrive stay on the task).
  const missing = b.missing ?? missingInLog(b.log ?? "");
  if (missing.length) {
    const list = missing
      .slice(0, 5)
      .map((m) => `${m.name} (${m.why})`)
      .join("; ");
    await fail(
      c,
      r,
      `${missing.length} file${missing.length === 1 ? "" : "s"} of the out folder could not be handed back: ${list}${missing.length > 5 ? "; …" : ""}`.slice(0, 900),
    );
    return { status: r.status };
  }
  await saveRun(c, r);
  return { status: r.status };
}

/**
 * The files a runner of version 2 (which sends only its log) could not hand back: its `not handed back` lines, except
 * an empty file, which is nothing lost.
 */
export function missingInLog(log: string): { name: string; why: string }[] {
  const out: { name: string; why: string }[] = [];
  for (const line of log.split("\n")) {
    const refused = /^not handed back: (.+?): (.+)$/.exec(line);
    if (refused) out.push({ name: refused[1]!, why: refused[2]!.slice(0, 200) });
    const over = /^not handed back \((over [^)]+)\): (.+)$/.exec(line);
    if (over) out.push({ name: over[2]!, why: over[1]! });
  }
  return out;
}

/** The runner's check between steps and during a long one (stop on cancel, finish the step on pause); also its sign of life. */
export async function localRunStatus(c: PoolClient, p: Principal, runId: string) {
  const r = await getRun(c, runId);
  if (r.runner !== "local" || !serves(p, r)) throw new Forbidden("not your run");
  await c.query("UPDATE task_agent_runs SET heartbeat_at = now() WHERE id = $1 AND (heartbeat_at IS NULL OR heartbeat_at < now() - interval '15 seconds')", [r.id]);
  return { status: r.status, currentStep: r.current_step };
}

// ── Questions ───────────────────────────────────────────────────────────────────────────
// An AI step may ask the people on the task before it acts (agent-ask.ts holds the protocol). The run waits in
// waiting_input; the questions live in task_agent_run_questions with the run, never in chat. The chat sidebar's
// "AI is asking" item, the task's card and the conversation view are all read from here.

interface QuestionRow {
  id: string;
  run_id: string;
  task_id: string;
  step_index: number;
  round: number;
  questions: AskQuestion[];
  answers: Record<string, string> | null;
  outcome: AskRound["outcome"];
  asked_at: Date;
  answered_by: string | null;
  answered_at: Date | null;
  closed_at: Date | null;
}
const askDto = (q: QuestionRow) => ({
  id: q.id,
  runId: q.run_id,
  stepIndex: q.step_index,
  round: q.round,
  questions: q.questions,
  answers: q.answers,
  outcome: q.outcome,
  askedAt: q.asked_at,
  answeredBy: q.answered_by,
  answeredAt: q.answered_at,
  closedAt: q.closed_at,
});

/** Who answers, pauses, continues and stops a run: the person who started it, the assignee, and anyone who may edit the task. */
export const canAnswer = (p: Principal, r: Pick<RunRow, "started_by">, t: Visible) =>
  r.started_by === p.id || t.assignee_id === p.id || allowedAny(p, "task.edit", taskResources(t));
export const canControl = canAnswer;

/**
 * Who approves the step a run waits on: the step names them. "editors" (the default, and the rule before):
 * anyone who may edit the task. The task's owner, its assignee, whoever started the run, or one named person. A step
 * that names someone the task does not have (no assignee) falls back to the editors, so a run never waits on nobody.
 */
export function canApprove(p: Principal, r: Pick<RunRow, "started_by" | "current_step"> & { steps: Pick<RunStep, "approver" | "approverId">[] }, t: Visible): boolean {
  const s = r.steps[r.current_step];
  const who =
    s?.approver === "owner" ? t.owner_id : s?.approver === "assignee" ? t.assignee_id : s?.approver === "starter" ? r.started_by : s?.approver === "person" ? s.approverId : null;
  if (who) return who === p.id;
  return allowedAny(p, "task.edit", taskResources(t));
}

/**
 * One audit-trail entry for a run's lifecycle (ADR 0025): started, approved, paused, resumed, cancelled, finished
 * (failed = outcome "failure"). Answered rounds reach the trail from `work.run.answered.v1` (platform/audit/mapping).
 * Never the questions, answers or step text.
 */
async function auditRun(
  c: PoolClient,
  r: Pick<RunRow, "id" | "task_id" | "workflow_name" | "runner">,
  action: "started" | "approved" | "paused" | "resumed" | "cancelled" | "finished",
  failed = false,
) {
  const t = (await c.query<{ code: string; title: string }>("SELECT code, title FROM tasks WHERE id = $1", [r.task_id])).rows[0];
  await recordAudit(c, {
    action: `work.workflow.${action}`,
    targetType: "task",
    targetId: r.task_id,
    targetLabel: t ? `${t.code} · ${t.title}`.slice(0, 300) : null,
    outcome: failed ? "failure" : "success",
    meta: { runId: r.id, workflow: r.workflow_name, runner: r.runner },
  });
}

/** The fields every work.run.* event carries. */
async function runEvent(c: PoolClient, r: Pick<RunRow, "id" | "task_id" | "workflow_name" | "runner">) {
  const code = (await c.query<{ code: string }>("SELECT code FROM tasks WHERE id = $1", [r.task_id])).rows[0]?.code ?? "";
  return { runId: r.id, taskId: r.task_id, code, workflowName: r.workflow_name, runner: r.runner };
}

/** Every round of questions the run has asked, any step, oldest first. */
async function runRounds(c: PoolClient, runId: string): Promise<AskRound[]> {
  const r = await c.query<AskRound>("SELECT step_index AS step, questions, answers, outcome FROM task_agent_run_questions WHERE run_id = $1 ORDER BY asked_at, round", [runId]);
  return r.rows;
}

/**
 * The current step asked. While it may (`may`): a round opens, the run waits for answers and the people who should
 * answer hear about it. When it may not (the caps are reached, or the workflow or the step says never): the run does
 * not stop; the step runs again told to decide (`decide`), and if it still asks then, the run fails. Returns whether
 * the run now waits for people (or is over).
 */
async function askPeople(c: PoolClient, r: RunRow, questions: AskQuestion[], rounds: AskRound[], raw: string, ran: StepRan | undefined, may: boolean): Promise<boolean> {
  // The asking call ran a model too: its record stays on the step until the step runs again.
  const before = { ...r.steps[r.current_step]!, ...(ran ? { ran } : {}) };
  if (!may) {
    if (before.decide) {
      r.steps[r.current_step] = { ...endAttempt(before, "asked", { output: raw, ran }), state: "failed" };
      await fail(c, r, `the AI kept asking questions on "${before.title}" instead of deciding`);
      return true;
    }
    // The questions are not put to anyone: the step runs again told to decide.
    r.steps[r.current_step] = { ...endAttempt(before, "decide", { output: raw, ran }), state: "pending", decide: true, output: undefined };
    await saveRun(c, r);
    return false;
  }
  const id = newId();
  await c.query("INSERT INTO task_agent_run_questions (id, run_id, task_id, step_index, round, questions) VALUES ($1,$2,$3,$4,$5,$6)", [
    id,
    r.id,
    r.task_id,
    r.current_step,
    rounds.length + 1,
    JSON.stringify(questions),
  ]);
  r.status = "waiting_input";
  r.claimed_by = null;
  // What the model wrote stays readable in the step's log, as the attempt that asked.
  r.steps[r.current_step] = { ...endAttempt(before, "asked", { output: raw, ran }), state: "waiting", output: undefined, waitingSince: new Date().toISOString() };
  await saveRun(c, r);
  const t = (await c.query<Pick<TaskRow, "code" | "title" | "assignee_id">>("SELECT code, title, assignee_id FROM tasks WHERE id = $1", [r.task_id])).rows[0]!;
  await activity(c, "task", r.task_id, "agent_run_asked", { runId: r.id, questionId: id, count: questions.length });
  await emit(c, "work.run.asked.v1", "work.run", r.id, {
    ...(await runEvent(c, r)),
    questionId: id,
    title: t.title,
    recipientIds: [...new Set([r.started_by, t.assignee_id].filter((x): x is string => !!x))],
    count: questions.length,
  });
  return true;
}

async function closeOpenAsks(c: PoolClient, r: RunRow, outcome: "cancelled") {
  const closed = await c.query<{ id: string }>("UPDATE task_agent_run_questions SET outcome = $2, closed_at = now() WHERE run_id = $1 AND closed_at IS NULL RETURNING id", [
    r.id,
    outcome,
  ]);
  for (const q of closed.rows) await emit(c, "work.run.answered.v1", "work.run", r.id, { ...(await runEvent(c, r)), questionId: q.id, outcome });
}

/**
 * A person answers a round (or lets the AI decide, `skip`): the round closes and the step runs again with the answers.
 * A server run goes on at once (the caller kicks it, as the person who answered); a local one goes back in its
 * runner's queue.
 */
export async function answerRun(c: PoolClient, p: Principal, questionId: string, b: { answers?: Record<string, string> | undefined; skip?: boolean | undefined }) {
  const runId = (await c.query<{ run_id: string }>("SELECT run_id FROM task_agent_run_questions WHERE id = $1", [questionId])).rows[0]?.run_id;
  if (!runId) throw new NotFound("question not found");
  const r = await getRun(c, runId, true);
  const t = await getTask(c, p, r.task_id);
  if (!canAnswer(p, r, t)) throw new Forbidden("only the person who started the run, the assignee or an editor of the task can answer");
  const q = (await c.query<QuestionRow>("SELECT * FROM task_agent_run_questions WHERE id = $1 FOR UPDATE", [questionId])).rows[0]!;
  if (q.closed_at || r.status !== "waiting_input" || r.current_step !== q.step_index) throw new Conflict("these questions were already answered");
  // "Let the AI decide" keeps whatever was answered; the AI fills only the gaps.
  let answers: Record<string, string> | null = partialAnswers(q.questions, b.answers);
  if (!b.skip) {
    const ok = cleanAnswers(q.questions, b.answers ?? {});
    if (!ok.ok) throw new Invalid("answer every question, or let the AI decide");
    answers = ok.answers;
  }
  const outcome = b.skip ? "skipped" : "answered";
  await c.query("UPDATE task_agent_run_questions SET answers = $2, outcome = $3, answered_by = $4, answered_at = now(), closed_at = now() WHERE id = $1", [
    q.id,
    answers ? JSON.stringify(answers) : null,
    outcome,
    p.id,
  ]);
  const s = r.steps[r.current_step]!;
  // The wait for people is not the step's work: its duration leaves it out.
  const waited = s.waitingSince ? Math.max(0, Date.now() - new Date(s.waitingSince).getTime()) : 0;
  const said = q.questions.map((x) => `${x.text}\n→ ${answers?.[x.id] ?? "—"}`).join("\n");
  r.steps[r.current_step] = { ...logNote(s, b.skip ? "skipped" : "answered", p.id, said), state: "pending", waitingSince: undefined, waitedMs: (s.waitedMs ?? 0) + waited };
  requeue(r);
  await saveRun(c, r);
  await activity(c, "task", r.task_id, "agent_run_answered", { runId: r.id, questionId: q.id, skipped: !!b.skip });
  await emit(c, "work.run.answered.v1", "work.run", r.id, { ...(await runEvent(c, r)), questionId: q.id, outcome });
  return r;
}

type OpenRow = QuestionRow & Visible & { started_by: string; workflow_name: string; runner: Runner; step_title: string | null; code: string; title: string };

async function openRows(c: PoolClient, where: string, args: unknown[]) {
  return (
    await c.query<OpenRow>(
      `SELECT q.*, r.started_by, r.workflow_name, r.runner, r.steps->q.step_index->>'title' AS step_title,
              t.code, t.title, t.owner_id, t.assignee_id, t.team_id, t.project_id
         FROM task_agent_run_questions q JOIN task_agent_runs r ON r.id = q.run_id JOIN tasks t ON t.id = q.task_id
        WHERE q.closed_at IS NULL AND r.status = 'waiting_input'${where}
        ORDER BY q.asked_at DESC LIMIT 200`,
      args,
    )
  ).rows;
}

/**
 * The rounds waiting for the reader's answer, for the chat sidebar's "AI is asking" items: only on tasks they may
 * open and runs they may answer. Light on purpose (no question text): the sidebar asks for it every half minute.
 */
export async function openAsks(c: PoolClient, p: Principal) {
  return (await openRows(c, "", []))
    .filter((q) => canReadTask(p, q) && canAnswer(p, q, q))
    .map((q) => ({
      id: q.id,
      runId: q.run_id,
      taskId: q.task_id,
      taskCode: q.code,
      taskTitle: q.title,
      workflowName: q.workflow_name,
      stepTitle: q.step_title,
      round: q.round,
      count: q.questions.length,
      askedAt: q.asked_at,
    }));
}

/**
 * Runs waiting for an approval that is the reader's to give, for the same "waiting for you" items as the questions.
 * A step that names its approver waits for that person; one open to every editor of the task shows only to the people
 * closest to it (who started the run, the task's owner and assignee), so a workspace admin is not asked about every run.
 */
export async function openApprovals(c: PoolClient, p: Principal) {
  const rows = (
    await c.query<
      {
        id: string;
        task_id: string;
        workflow_name: string;
        step_title: string | null;
        approver: string | null;
        approver_id: string | null;
        started_by: string;
        current_step: number;
        updated_at: Date;
      } & Visible & {
          code: string;
          title: string;
        }
    >(
      `SELECT r.id, r.task_id, r.workflow_name, r.current_step, r.steps->r.current_step->>'title' AS step_title, r.steps->r.current_step->>'approver' AS approver,
              r.steps->r.current_step->>'approverId' AS approver_id, r.started_by, r.updated_at,
              t.code, t.title, t.owner_id, t.assignee_id, t.team_id, t.project_id
         FROM task_agent_runs r JOIN tasks t ON t.id = r.task_id
        WHERE r.status = 'waiting_approval'
          AND (r.started_by = $1 OR t.owner_id = $1 OR t.assignee_id = $1 OR r.steps->r.current_step->>'approverId' = $1)
        ORDER BY r.updated_at DESC LIMIT 100`,
      [p.id],
    )
  ).rows;
  return rows
    .filter((r) => {
      const steps: Pick<RunStep, "approver" | "approverId">[] = [];
      steps[r.current_step] = { approver: (r.approver as RunStep["approver"]) ?? undefined, approverId: r.approver_id ?? undefined };
      return (r.approver === "person" || canReadTask(p, r)) && canApprove(p, { started_by: r.started_by, current_step: r.current_step, steps }, r);
    })
    .map((r) => ({
      runId: r.id,
      taskId: r.task_id,
      taskCode: r.code,
      taskTitle: r.title,
      workflowName: r.workflow_name,
      stepTitle: r.step_title,
      waitingSince: r.updated_at.toISOString(),
    }));
}

/** A task's open rounds with their questions, for the card at the top of the task (whoever may read the task sees them). */
export async function taskAsks(c: PoolClient, p: Principal, t: TaskRow) {
  return (await openRows(c, " AND q.task_id = $1", [t.id])).map((q) => ({
    ...askDto(q),
    workflowName: q.workflow_name,
    stepTitle: q.step_title,
    runner: q.runner,
    canAnswer: canAnswer(p, q, t),
  }));
}

/** One run's questions and answers, every round, for the temporary conversation (/app/chat/ask/<run>). */
export async function askThread(c: PoolClient, p: Principal, runId: string) {
  const r = await getRun(c, runId);
  const t = await getTask(c, p, r.task_id);
  const qs = await c.query<QuestionRow>("SELECT * FROM task_agent_run_questions WHERE run_id = $1 ORDER BY step_index, round", [r.id]);
  return {
    run: {
      id: r.id,
      status: r.status,
      workflowName: r.workflow_name,
      runner: r.runner,
      currentStep: r.current_step,
      startedBy: r.started_by,
      error: r.error,
      // Every step's times draw the conversation's timeline. An approval step carries what it was asked to approve (the
      // last result before it, and the step that made it) and, once given, the note.
      steps: r.steps.map((s, i) => {
        const base = {
          title: s.title,
          kind: s.kind,
          status: s.status,
          state: s.state,
          startedAt: s.startedAt,
          finishedAt: s.finishedAt,
          // Time spent waiting for people's answers, and since when it waits now: the step's duration leaves them out.
          waitedMs: s.waitedMs,
          waitingSince: s.waitingSince,
          rework: s.rework ? { note: s.rework.note, by: s.rework.by, at: s.rework.at, check: s.rework.check } : undefined,
          verdict: s.verdict,
          approver: s.approver,
          approverId: s.approverId,
        };
        if (s.kind !== "approval" || (s.state !== "waiting" && s.state !== "done")) return base;
        const from = lastResult(r.steps, i);
        // What the checks before it found and let through, so the approver decides knowing it.
        const issues = r.steps
          .slice(from ? from.from + 1 : 0, i)
          .filter((x) => x.kind === "check" && x.verdict && !x.verdict.pass)
          .flatMap((x) => x.verdict!.issues);
        return {
          ...base,
          review: (from?.text ?? "").slice(0, 12_000),
          reviewFrom: from ? r.steps[from.from]!.title : undefined,
          issues: issues.length ? issues : undefined,
          note: s.state === "done" ? (s.output ?? "") : undefined,
        };
      }),
    },
    task: { id: t.id, code: t.code, title: t.title },
    rounds: qs.rows.map(askDto),
    canAnswer: canAnswer(p, r, t),
    canApprove: r.status === "waiting_approval" && canApprove(p, r, t),
  };
}

// Kept for callers that only need the answers' text (runner protocol 1 sent it with a claim).
export { answersText, runnerOf };
