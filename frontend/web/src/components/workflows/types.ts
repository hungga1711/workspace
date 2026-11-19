/**
 * Agent workflows as the work module returns them (backend/server/src/modules/work/workflows/model.ts). A workflow is a harness around the AI: inputs asked at Run, the environment the steps run in, the
 * resources every AI step reads, the steps (with automatic checks), guardrails, and where the result goes.
 */
export type StepKind = "ai" | "command" | "check" | "approval" | "status";
/** How a run is driven: by the server (the company's AI) or by a runner that claims it (a sandbox, a computer). */
export type Runner = "server" | "local";
export const CATEGORIES = ["coding", "product", "marketing", "sales", "support", "hr", "finance", "legal", "operations", "creative", "research", "other"] as const;
export type Category = (typeof CATEGORIES)[number];
export type Approver = "editors" | "owner" | "assignee" | "starter" | "person";
export interface WorkflowStep {
  key: string;
  title: string;
  kind: StepKind;
  /** ai: the instruction. Placeholders: {{task}} {{previous}} {{steps.<key>}} {{input.<key>}} {{inputs}} {{resources}} {{answers}}. */
  prompt?: string;
  /** command: a shell command (runner only). check: the same, its exit code is the verdict. */
  command?: string;
  status?: string;
  /**
   * ai, check: which model answers. Server: "" the company's main model, "fast" its fast one, else a "provider:model"
   * route from the model list. Runner: the coding agent's model ("opus", "sonnet"…), "" its own default.
   */
  model?: string;
  /** ai: who the model is for this step, added to its system prompt. */
  role?: string;
  /** ai, server: false keeps the company's connected tools out of this step. */
  tools?: boolean;
  /** ai: false leaves the workflow's resources out of this step. */
  resources?: boolean;
  /** ai: false, this step never stops to ask people. */
  ask?: boolean;
  /** ai, server: the longest result in tokens (1000–8000, default 2000). */
  maxOutput?: number;
  /** ai, command, check: minutes before the step is stopped (default: the guardrail's stepMinutes). */
  timeoutMin?: number;
  /** ai, command: run again on failure this many times (0–3). */
  retries?: number;
  /** check: what the result must satisfy, one requirement per line (an AI judges). */
  criteria?: string;
  /** check: how many times a failed check sends the work back (0–5, default 2). */
  attempts?: number;
  /** check: after the last failed attempt: "stop" fails the run, "continue" goes on with the issues on record. */
  onFail?: "stop" | "continue";
  /** approval: who approves ("editors": anyone who may edit the task), and the person for "person". */
  approver?: Approver;
  approverId?: string;
}

export type InputType = "text" | "long" | "choice" | "number" | "date";
/** One field of the form shown when a run starts; its value fills {{input.<key>}}. */
export interface InputField {
  key: string;
  label: string;
  type: InputType;
  options?: string[];
  required?: boolean;
  placeholder?: string;
  default?: string;
}
export type EnvKind = "assistant" | "sandbox" | "computer";
/**
 * Where the steps run. "assistant": the company's AI on the server (no commands). "sandbox": a fresh working folder
 * per run on a runner, in a Docker container when `isolation` is "container". "computer": the assignee's own folder.
 */
export interface Environment {
  kind: EnvKind;
  /** sandbox: whose runner: a computer of whoever starts the run, or a runner the company keeps. */
  host?: "person" | "company";
  isolation?: "container" | "folder";
  image?: string;
  network?: "on" | "off";
  cpus?: number;
  memoryMb?: number;
  /** container: the agent's command inside the image; without it AI steps use the runner's agent in the folder. */
  agent?: string;
  repo?: string;
  branch?: string;
  /** sandbox: a command run once before the first step. */
  setup?: string;
  /** container: names of the runner's environment variables passed in (never values). */
  env?: string[];
  keep?: boolean;
}
export interface ResourceFile {
  id: string;
  name: string;
  size: number;
  contentType: string;
}
export interface Resources {
  /** The playbook every AI step reads (Markdown). */
  notes: string;
  /** Pages of the workspace's Docs. */
  docs: { id: string; title: string }[];
  /** Files uploaded for this workflow. */
  files: ResourceFile[];
  /** Files already in the workspace's Drive (`id` is the Drive item). Read as whoever starts the run. */
  drive: { id: string; name: string }[];
  /** Other tasks to learn from (their brief and latest comments). */
  tasks: { id: string; code: string; title: string }[];
  /**
   * Links: a web page, or a Google Docs / Sheets / Slides / Drive file shared as "anyone with the link". Their text is
   * read when a run starts; one that cannot be read is still listed for steps with tools to open it.
   */
  links: { url: string; title: string }[];
  /** The task's own context (project, subtasks, comments, files, similar tasks). */
  taskContext: boolean;
  /** Runner: also download the task's attachments into the run's assets folder. */
  taskFiles: boolean;
}
export interface Guardrails {
  /** The run's working time in minutes (waiting for people does not count). */
  maxMinutes: number;
  stepMinutes: number;
  /** Server: tokens the whole run may spend; 0 = no cap. */
  maxTokens: number;
  ask: "allowed" | "never";
}
export interface Output {
  comment: boolean;
  /** Save the final result as a page in Docs. */
  doc: boolean;
  /** Runner: attach files written to the run's `out` folder to the task. */
  files: boolean;
  /** Checklist lines in the final result become subtasks. */
  subtasks: boolean;
  /** Move the task here when the run finishes; "" leaves it. */
  status: string;
}
export interface WorkflowConfig {
  inputs: InputField[];
  environment: Environment;
  resources: Resources;
  guardrails: Guardrails;
  output: Output;
  /** Start a run as soon as the workflow is put on a task (assistant, or a sandbox on a company runner). */
  autoStart: boolean;
  /** Show how long a run should take, each step and the whole (default on). */
  estimate: boolean;
  /** When the workflow starts by itself (server work/workflows/triggers.ts); absent on older rows. */
  triggers?: Trigger[];
  /** The person a run started by a trigger acts as (set by the server on save). */
  runAs?: string;
}
/**
 * A way a workflow starts by itself: a task created or moved, a schedule (a new task is made for each run), a post
 * from another system to the workflow's secret address (a new task too), or linked work that was opened or merged.
 */
export type Trigger =
  | { id: string; kind: "task"; on: "created" | "status"; status?: string; projects: string[]; labels: string[] }
  | { id: string; kind: "schedule"; every: "day" | "week"; days: number[]; time: string; projectId: string; title: string }
  | { id: string; kind: "hook"; projectId: string; title: string }
  | { id: string; kind: "linked"; on: "opened" | "merged"; projects: string[] };
export type TriggerKind = Trigger["kind"];
/** GET work/workflows/:id/triggers: how the workflow has started by itself lately. */
export interface TriggerActivity {
  runAs: string | null;
  limits: { perHour: number };
  hooks: { triggerId: string; hint: string; createdAt: string; lastUsedAt: string | null }[];
  fires: {
    id: string;
    triggerId: string;
    kind: TriggerKind;
    status: "pending" | "started" | "refused";
    reason: string | null;
    detail: string | null;
    runId: string | null;
    task: { id: string; code: string; title: string } | null;
    at: string;
  }[];
}
/** POST work/workflows/links/check: can a run read this link? */
export type LinkKind = "gdoc" | "gsheet" | "gslides" | "gdrive" | "gfolder" | "web";
export type LinkCheck =
  | { ok: true; kind: LinkKind; chars: number; sample: string }
  | { ok: false; kind: LinkKind; problem: "private" | "folder" | "unreachable" | "unreadable" | "refused" };
/**
 * How long a run should take. On a workflow (GET work/workflows/:id/estimate): `totalSec`, each step's seconds by key
 * and how many earlier runs it is drawn from (0 = typical times). On a run, also what is left and when it should be
 * done (`finishAt` is null while it waits for people or is over).
 */
export interface Estimate {
  totalSec: number;
  steps: Record<string, number>;
  basedOn: number;
  remainingSec?: number;
  finishAt?: string | null;
}
/** The server's limits and defaults (model.ts LIMITS), mirrored for the editor. */
export const LIMITS = { steps: 24, inputs: 12, docs: 12, files: 20, drive: 20, tasks: 10, links: 12, notes: 12_000, prompt: 12_000, maxMinutes: 1440, stepMinutes: 240 } as const;
export const DEFAULT_IMAGE = "node:22-slim";
export const defaultConfig = (kind: EnvKind = "assistant"): WorkflowConfig => ({
  inputs: [],
  environment: kind === "sandbox" ? { kind, host: "person", isolation: "folder" } : { kind },
  resources: { notes: "", docs: [], files: [], drive: [], tasks: [], links: [], taskContext: true, taskFiles: false },
  guardrails: { maxMinutes: 60, stepMinutes: 10, maxTokens: 0, ask: "allowed" },
  output: { comment: true, doc: false, files: false, subtasks: false, status: "" },
  autoStart: false,
  estimate: true,
  triggers: [],
});
export const runnerOf = (e: Pick<Environment, "kind">): Runner => (e.kind === "assistant" ? "server" : "local");
/** A runner seen lately (GET work/workflows `runners`): which computers can take sandbox and computer runs. */
export interface RunnerInfo {
  id: string;
  device: string;
  /** A company runner: takes sandbox runs anyone starts. */
  shared: boolean;
  mine: boolean;
  online: boolean;
  docker: boolean;
  /** The agent it drives ("claude -p", …). */
  agent: string;
  lastSeenAt: string;
}
/** What actually ran for an AI step: the model that answered, its tokens, the tools it called, the system prompt. */
export interface StepRan {
  model: string;
  provider?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  tools?: { server: string; tool: string; outcome: string; ms: number }[];
  system?: string;
  ms?: number;
}
/** GET /api/ai/workflows/models: the models a step may pick and what the step's model is told. */
export interface CatalogModel {
  route: string;
  vendor: string;
  label: string;
  model: string;
  tier: "fast" | "smart";
}
export interface ModelCatalog {
  models: CatalogModel[];
  /** What "default" and "fast" point at today; null without a connected model. */
  defaults: { fast: { label: string; model: string; route: string }; smart: { label: string; model: string; route: string } } | null;
  /** The system prompt every server AI step gets (before its role). */
  system: string;
  /** Added to the system prompt when the step may use the company's tools. */
  toolRules: string;
}
/** GET /api/work/workflows `prompting`: how {{task}} and {{previous}} are filled and what ends every instruction. */
export interface Prompting {
  limits: { description: number; context: number; previous: number; resources: number };
  hints: { ask: string; decide: string; check: string };
}
export interface Workflow {
  id: string;
  name: string;
  description: string;
  category: Category;
  /** Derived from `config.environment` (assistant → server, sandbox and computer → local). */
  runner: Runner;
  steps: WorkflowStep[];
  config: WorkflowConfig;
  template: string | null;
  createdBy: string;
  updatedAt: string;
  canEdit: boolean;
}
export interface WorkflowTemplate {
  key: string;
  category: Category;
  runner: Runner;
  name: string;
  description: string;
  steps: WorkflowStep[];
  config: WorkflowConfig;
  /** What the template is for, in a line each: when to use it, what to put in the task. */
  uses?: string[];
}
/** waiting_input: the current AI step asked the people on the task something (docs/architecture/agent-questions.md). */
/** paused: held by someone; the step in progress finishes, then it waits for Continue. */
export type RunStatus = "queued" | "running" | "waiting_approval" | "waiting_input" | "paused" | "done" | "failed" | "cancelled";
export interface RunStep extends WorkflowStep {
  state: "pending" | "running" | "done" | "failed" | "waiting" | "skipped";
  input?: string;
  output?: string;
  log?: string;
  startedAt?: string;
  finishedAt?: string;
  /** Time the step waited for people's answers (ms), and since when it waits now: its duration leaves both out. */
  waitedMs?: number;
  waitingSince?: string;
  ran?: StepRan;
  /** The step's log (server work/workflows.ts StepEntry): each time it ran and what people did on it. */
  history?: StepEntry[];
  /** check: the latest verdict. `round` counts the times this check has judged the work. */
  verdict?: { pass: boolean; issues: string[]; round: number; at: string };
  /** A check (or an approver) sent this step's result back: what to change. */
  rework?: { note: string; by: string; at: string; check?: string };
  /** How many times the step was run again after failing (its `retries`). */
  retried?: number;
}
/**
 * One line of what the agent did inside a step, as it happened (server work/workflows/activity.ts): the step starting
 * an attempt ("start"; a command step's text is its command), the agent's own words ("say"), an action ("tool": its
 * name and what it acts on), how the action ended ("result", "error"), a line from whoever drives the step ("note"),
 * and the answer being written ("draft", in `detail`; one per step, only while it runs).
 */
export interface StepActivity {
  id: number;
  step: number;
  at: string;
  kind: "start" | "say" | "tool" | "result" | "error" | "note" | "draft";
  tool: string | null;
  text: string;
  detail?: string;
}
/** One line of a step's log: an attempt (what it was given, what came back) or what a person did. */
export interface StepEntry {
  at: string;
  /**
   * "checked": a check's verdict (text: the issues; outcome "done" passed, "failed" did not). "sent_back": a check sent
   * this step's result back. "retry": it failed and runs again. "requeued": its runner went away, the run was queued again.
   */
  kind: "attempt" | "answered" | "skipped" | "rework" | "approved" | "checked" | "sent_back" | "retry" | "requeued";
  /** attempt: how it ended; absent while it runs. */
  outcome?: "done" | "asked" | "decide" | "failed" | "cancelled" | "timeout";
  end?: string;
  input?: string;
  output?: string;
  ran?: StepRan;
  by?: string;
  text?: string;
}
export interface Run {
  id: string;
  taskId: string;
  workflowId: string | null;
  workflowName: string;
  runner: Runner;
  status: RunStatus;
  currentStep: number;
  steps: RunStep[];
  error: string | null;
  startedBy: string;
  claimedBy: string | null;
  createdAt: string;
  finishedAt: string | null;
  /** What the person starting the run filled in (by input key). */
  inputs?: Record<string, string>;
  /** The workflow's config as it was when the run started. */
  config?: WorkflowConfig;
  /** A runner's preparation of the environment (sandbox folder, container, repository, assets, setup command). */
  env?: RunEnv | null;
  /** Files the run handed back (attached to the task) and the page it saved. */
  artifacts?: RunArtifact[];
  /** Tokens spent so far and the run's working time (ms), against its guardrails. */
  usage?: { inputTokens: number; outputTokens: number; workMs: number };
  /** How long the run should take and what is left; null when the workflow leaves estimates out. */
  estimate?: Estimate | null;
  /** A failed run can be run again from the step that failed. */
  canRetry?: boolean;
  /** The run waits for an approval that is the reader's to give (the step's `approver` rule, applied by the server). */
  canApprove?: boolean;
  host?: "person" | "company";
  /** Every round of questions the run's AI steps asked (GET tasks/:ref/runs). */
  asks?: AskRound[];
  canAnswer?: boolean;
  /** Pause, continue and stop: the starter, the assignee, editors of the task. */
  canControl?: boolean;
  /** What started the run when it was not a person pressing Run. */
  trigger?: { kind: TriggerKind; id: string; detail?: string } | null;
  /** What the step at work is doing right now: its latest action, words or draft (GET tasks/:ref/runs). */
  doing?: StepActivity;
}
export interface RunEnv {
  state: "preparing" | "ready" | "failed";
  device?: string;
  /** What the runner actually gave: "container" (Docker), "folder" (a fresh folder), "computer" (the person's folder). */
  isolation?: "container" | "folder" | "computer";
  image?: string;
  network?: "on" | "off";
  /** Where AI steps run: inside the container, or with the runner's agent in the folder. */
  agentIn?: "container" | "host";
  assets?: number;
  log?: string;
  startedAt?: string;
  finishedAt?: string;
}
export interface RunArtifact {
  kind: "file" | "doc" | "subtasks";
  /** file: the file's id (work/files/<id>/download); doc: the page's id. */
  id?: string;
  name: string;
  size?: number;
  count?: number;
}
export const ACTIVE: RunStatus[] = ["queued", "running", "waiting_approval", "waiting_input", "paused"];

/** One question of an AI step: free text, or a choice among options (free text still allowed). */
export interface AskQuestion {
  id: string;
  text: string;
  kind: "text" | "choice";
  options?: string[];
  required?: boolean;
  /** The AI's best guess from the task's context: the form starts with it filled in. */
  default?: string;
}
/** A round of questions on one step; open while `closedAt` is null. */
export interface AskRound {
  id: string;
  runId: string;
  stepIndex: number;
  round: number;
  questions: AskQuestion[];
  answers: Record<string, string> | null;
  outcome: "answered" | "skipped" | "cancelled" | null;
  askedAt: string;
  answeredBy: string | null;
  answeredAt: string | null;
  closedAt: string | null;
}
/** A task's open round as its detail returns it (`agentAsks`). */
export interface TaskAsk extends AskRound {
  workflowName: string;
  stepTitle: string | null;
  runner: Runner;
  canAnswer: boolean;
}
/** GET work/agent-questions/open: what waits for my answer (the chat sidebar's temporary items). */
export interface OpenAsk {
  /** "ask": the AI's questions; "approval": a step waiting for the reader to approve. Both open the same conversation. */
  kind: "ask" | "approval";
  id: string;
  runId: string;
  taskId: string;
  taskCode: string;
  taskTitle: string;
  workflowName: string;
  stepTitle: string | null;
  round: number;
  count: number;
  askedAt: string;
}
/** GET work/runs/:id/questions: one run's rounds for the temporary conversation. */
export interface AskThread {
  run: {
    id: string;
    status: RunStatus;
    workflowName: string;
    runner: Runner;
    currentStep: number;
    startedBy: string;
    /** Why a failed run stopped. */
    error?: string | null;
    /** An approval step also has what it is about (`review`, made by the step `reviewFrom`) and, once approved, the note given. */
    steps: {
      title: string;
      kind: StepKind;
      /** status: where the task moves. */
      status?: string;
      state: RunStep["state"];
      startedAt?: string;
      finishedAt?: string;
      waitedMs?: number;
      waitingSince?: string;
      /** This AI step's result was sent back with what to change: by an approver (their id) or by a check ("check"). */
      rework?: { note: string; by: string; at: string; check?: string };
      /** check: its latest verdict. */
      verdict?: { pass: boolean; issues: string[]; round: number; at: string };
      /** approval: who approves, and what the checks before it found and let through. */
      approver?: Approver;
      approverId?: string;
      issues?: string[];
      review?: string;
      reviewFrom?: string;
      note?: string;
    }[];
  };
  task: { id: string; code: string; title: string };
  rounds: AskRound[];
  canAnswer: boolean;
  canApprove?: boolean;
}
/** Rounds one step may ask (work/agent-ask.ts MAX_STEP_ROUNDS): shown as "round n of 3". */
export const MAX_ASK_ROUNDS = 3;

/** GET /api/work/workflows/activity: only runs and tasks the reader may open are counted or listed. */
export interface WorkflowUsage {
  tasks: number;
  runs30d: number;
  done30d: number;
  failed30d: number;
  lastRunAt: string | null;
  /** Each step's last 30 days, by step key. `sentBack`: times a check or an approver sent its result back. */
  steps?: Record<string, { done: number; failed: number; avgSec: number | null; sentBack?: number }>;
  /** Average tokens and working seconds of the finished runs of the last 30 days. */
  avgTokens?: number | null;
  avgSec?: number | null;
}
export interface RecentRun {
  id: string;
  taskId: string;
  taskCode: string;
  taskTitle: string;
  workflowId: string | null;
  workflowName: string;
  runner: Runner;
  status: RunStatus;
  currentStep: number;
  steps: Pick<RunStep, "title" | "kind" | "state" | "status" | "startedAt" | "finishedAt">[];
  environment?: EnvKind;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  canApprove: boolean;
  canAnswer?: boolean;
  canControl?: boolean;
}
export interface WorkflowActivity {
  stats: { runs30d: number; done30d: number; failed30d: number; active: number; waiting: number; asking?: number; paused?: number };
  usage: Record<string, WorkflowUsage>;
  runs: RecentRun[];
}

/** The stage a paused run holds before: the next one, or the one after a step still finishing. */
export const pausedAt = (r: { status: RunStatus; currentStep: number; steps: { state: RunStep["state"] }[] }) =>
  r.status !== "paused" ? undefined : r.steps[r.currentStep]?.state === "running" ? r.currentStep + 1 : r.currentStep;
