import type { TaskStatus } from "../tasks.js";
import { Invalid } from "../errors.js";
import { normalizeTriggers, type Trigger } from "./triggers.js";

/**
 * Agent workflows, the model. A workflow is a harness around the AI, not only a list of prompts:
 *
 *   inputs       what the person starting a run is asked for (a short form), filled in at {{input.<key>}}
 *   environment  where the steps run: the company's AI on the server ("assistant"), an isolated working folder or
 *                container on a runner ("sandbox"), or the assignee's own working folder ("computer")
 *   resources    what every AI step may read: a playbook, workspace pages, uploaded files, links, the task's context
 *   steps        the pipeline: AI work, commands, automatic checks that send work back, people's approvals, task moves
 *   guardrails   time and token limits, whether the AI may stop to ask
 *   output       where the result goes: a comment, a page, files, subtasks, a task status
 *
 * Everything here is pure (no database): normalization and validation are unit-tested in model.test.ts. The run engine
 * is runs.ts; prompts are assembled in render.ts for both runners, so a step reads the same on the server and on a
 * computer.
 */

export type StepKind = "ai" | "command" | "check" | "approval" | "status";
export const STEP_KINDS: StepKind[] = ["ai", "command", "check", "approval", "status"];

/** Who may approve an approval step. "editors": anyone who may edit the task (the default). */
export type Approver = "editors" | "owner" | "assignee" | "starter" | "person";

export interface WorkflowStep {
  key: string;
  title: string;
  kind: StepKind;
  /**
   * ai: the instruction. Placeholders (render.ts): {{task}}, {{previous}}, {{steps.<key>}}, {{input.<key>}},
   * {{inputs}}, {{resources}}, {{answers}}.
   */
  prompt?: string | undefined;
  /** command: a shell command in the run's working folder (runner only). check: the same, its exit code is the verdict. */
  command?: string | undefined;
  /** status: where the task moves. */
  status?: TaskStatus | undefined;
  /**
   * ai, check: which model. Server: "" the company's main model, "fast" its fast one, else a "provider:model" route.
   * Runner: passed to the coding agent (`claude -p --model <model>`), "" its own default.
   */
  model?: string | undefined;
  /** ai: who the model is for this step (an editor, a lawyer…), added to the system prompt. */
  role?: string | undefined;
  /** ai, server: false keeps the company's connected tools (MCP) out of this step. Default on. */
  tools?: boolean | undefined;
  /** ai: false leaves the workflow's resources out of this step (a cheap formatting step does not need them). */
  resources?: boolean | undefined;
  /** ai: false, this step never stops to ask people (the guardrail can turn asking off for the whole run). */
  ask?: boolean | undefined;
  /** ai, server: the longest result in tokens (1000–8000). Default 2000. */
  maxOutput?: number | undefined;
  /** ai, command, check: stop the step after this many minutes. Default: the guardrail's stepMinutes. */
  timeoutMin?: number | undefined;
  /** ai, command: run the step again when it fails (a model error, a non-zero exit), this many times (0–3). */
  retries?: number | undefined;
  /** check: what the result under review must satisfy, one requirement per line; an AI judges it. */
  criteria?: string | undefined;
  /** check: how many times a failed check sends the work back to the step that made it (0–5). Default 2. */
  attempts?: number | undefined;
  /** check: after the last attempt still fails: "stop" fails the run, "continue" goes on with the issues on record. */
  onFail?: "stop" | "continue" | undefined;
  /** approval: who approves, and the person when `approver` is "person". */
  approver?: Approver | undefined;
  approverId?: string | undefined;
}

export type InputType = "text" | "long" | "choice" | "number" | "date";
export interface InputField {
  key: string;
  label: string;
  type: InputType;
  options?: string[] | undefined;
  required?: boolean | undefined;
  placeholder?: string | undefined;
  default?: string | undefined;
}

export type EnvKind = "assistant" | "sandbox" | "computer";
export interface Environment {
  kind: EnvKind;
  /** sandbox: whose runner. "person": a computer of whoever starts the run. "company": a runner the company keeps. */
  host?: "person" | "company" | undefined;
  /** sandbox: "container" needs Docker on the runner (never downgraded silently); "folder" is a fresh folder per run. */
  isolation?: "container" | "folder" | undefined;
  /** container: the image, e.g. "python:3.12-slim". */
  image?: string | undefined;
  /** container: "off" starts it without a network. */
  network?: "on" | "off" | undefined;
  cpus?: number | undefined;
  memoryMb?: number | undefined;
  /** container: the agent's command inside the image; without it AI steps run with the runner's agent in the folder. */
  agent?: string | undefined;
  /** sandbox: a git repository cloned into the working folder, and the branch. */
  repo?: string | undefined;
  branch?: string | undefined;
  /** sandbox: a command run once before the first step (install dependencies, unpack data). */
  setup?: string | undefined;
  /** container: names of the runner's environment variables passed into the container (never their values). */
  env?: string[] | undefined;
  /** sandbox: keep the folder after the run (default: removed when the run ends). */
  keep?: boolean | undefined;
}

export interface ResourceDoc {
  id: string;
  title: string;
}
export interface ResourceFile {
  id: string;
  name: string;
  size: number;
  contentType: string;
}
export interface ResourceLink {
  url: string;
  title: string;
}
/** A file kept in the workspace's Drive (`drive_items.id`), read as whoever starts the run. */
export interface ResourceDriveFile {
  id: string;
  name: string;
}
/** Another task whose brief and discussion the steps may read (a past campaign, a similar contract). */
export interface ResourceTask {
  id: string;
  code: string;
  title: string;
}
export interface Resources {
  /** The playbook: standing knowledge and rules every AI step reads (tone, policy, definitions). Markdown. */
  notes: string;
  /** Pages of the workspace's Docs. */
  docs: ResourceDoc[];
  /** Files uploaded for this workflow. */
  files: ResourceFile[];
  /** Files already in the workspace's Drive. */
  drive: ResourceDriveFile[];
  /** Other tasks to learn from. */
  tasks: ResourceTask[];
  /**
   * Links: a web page, or a Google Docs / Sheets / Slides / Drive file shared as "anyone with the link". Their text is
   * read when a run starts (links.ts); one that cannot be read is still listed for steps that have tools to open it.
   */
  links: ResourceLink[];
  /** The task's own context: project, parent, subtasks, comments, files, similar tasks (workflow-context.ts). */
  taskContext: boolean;
  /** Runner: also download the task's attachments into the run's assets folder. */
  taskFiles: boolean;
}

export interface Guardrails {
  /** The run's working time in minutes (waiting for people does not count). */
  maxMinutes: number;
  /** One step's time in minutes unless the step sets its own. */
  stepMinutes: number;
  /** Server: tokens the whole run may spend; 0 = no cap beyond the company's AI budgets. */
  maxTokens: number;
  /** "never": no AI step stops to ask people; each decides and says what it assumed. */
  ask: "allowed" | "never";
}

export interface Output {
  /** Post the final result on the task as a comment, under the workflow's name. */
  comment: boolean;
  /** Save the final result as a page in Docs, linked from the comment. */
  doc: boolean;
  /** Runner: attach the files the run wrote to its `out` folder to the task. */
  files: boolean;
  /** Checklist lines ("- [ ] …") in the final result become subtasks. */
  subtasks: boolean;
  /** Move the task here when the run finishes; "" leaves it. */
  status: TaskStatus | "";
}

export interface WorkflowConfig {
  inputs: InputField[];
  environment: Environment;
  resources: Resources;
  guardrails: Guardrails;
  output: Output;
  /** Start a run as soon as the workflow is put on a task (never for a run that needs the assignee's own computer). */
  autoStart: boolean;
  /**
   * Show how long a run should take, each step and the whole: from how long this workflow's steps took
   * before, or typical times until it has run. For long jobs, so people know when to come back.
   */
  estimate: boolean;
  /**
   * When the workflow starts by itself (triggers.ts): a task moved or created, a schedule, a post from a
   * system outside, linked work that changed. Never for a run that needs a person's own computer.
   */
  triggers: Trigger[];
  /** The person a run started by a trigger acts as; "" is the workflow's creator. Set by saveWorkflow, never trusted from the editor. */
  runAs: string;
}

/**
 * Whether a run of this environment may start with nobody at a computer: the company's AI, or a sandbox on a
 * computer the company keeps. A person's own computer only works when that person presses Run.
 */
export const startsByItself = (e: Environment): boolean => e.kind === "assistant" || (e.kind === "sandbox" && e.host === "company");

/** How a run is driven: by this process ("server") or by a runner that claims it ("local"). Derived from the environment. */
export type Runner = "server" | "local";
export const runnerOf = (e: Pick<Environment, "kind">): Runner => (e.kind === "assistant" ? "server" : "local");

export const CATEGORIES = ["coding", "product", "marketing", "sales", "support", "hr", "finance", "legal", "operations", "creative", "research", "other"] as const;
export type Category = (typeof CATEGORIES)[number];

export const LIMITS = {
  steps: 24,
  inputs: 12,
  docs: 12,
  files: 20,
  drive: 20,
  tasks: 10,
  links: 12,
  notes: 12_000,
  prompt: 12_000,
  maxMinutes: [1, 24 * 60],
  stepMinutes: [1, 240],
  maxTokens: 5_000_000,
} as const;

export const DEFAULT_GUARDRAILS: Guardrails = { maxMinutes: 60, stepMinutes: 10, maxTokens: 0, ask: "allowed" };
export const DEFAULT_OUTPUT: Output = { comment: true, doc: false, files: false, subtasks: false, status: "" };
export const DEFAULT_RESOURCES: Resources = { notes: "", docs: [], files: [], drive: [], tasks: [], links: [], taskContext: true, taskFiles: false };
export const DEFAULT_IMAGE = "node:22-slim";

/** A stored workflow's config with every part present (older rows have `{}` and a `runner`). */
export function defaultConfig(runner: Runner = "server"): WorkflowConfig {
  return {
    inputs: [],
    environment: runner === "server" ? { kind: "assistant" } : { kind: "computer" },
    resources: { ...DEFAULT_RESOURCES },
    guardrails: { ...DEFAULT_GUARDRAILS },
    output: { ...DEFAULT_OUTPUT },
    autoStart: false,
    estimate: true,
    triggers: [],
    runAs: "",
  };
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const int = (v: unknown, min: number, max: number, dflt: number) => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : dflt;
};
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** A key people can type in a placeholder: lowercase letters, digits, "-" and "_". */
export const slug = (s: string, fallback: string) =>
  (s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || fallback;

function uniqueKeys<T extends { key: string }>(items: T[], prefix: string): T[] {
  const seen = new Set<string>();
  return items.map((it, i) => {
    let key = slug(it.key, `${prefix}${i + 1}`);
    for (let n = 2; seen.has(key); n++) key = `${slug(it.key, `${prefix}${i + 1}`).slice(0, 36)}-${n}`;
    seen.add(key);
    return { ...it, key };
  });
}

const IMAGE = /^[a-z0-9][a-z0-9._/:@-]{0,199}$/i;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** A git source a runner may clone: https or ssh, never a local path or an option. */
const REPO = /^(https:\/\/|ssh:\/\/|git@)[^\s'"`;|&$<>]{3,300}$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,120}$/;

/**
 * Whatever was stored or sent, as a complete config: unknown values fall back to safe defaults, lists are capped.
 * Never throws; `validateWorkflow` is where a save is refused.
 */
export function normalizeConfig(raw: unknown, runner: Runner = "server"): WorkflowConfig {
  const x = obj(raw);
  const base = defaultConfig(runner);
  const e = obj(x.environment);
  const kind: EnvKind = e.kind === "assistant" || e.kind === "sandbox" || e.kind === "computer" ? e.kind : base.environment.kind;
  let environment: Environment = { kind };
  if (kind === "sandbox") {
    const isolation = e.isolation === "container" ? "container" : "folder";
    environment = {
      kind,
      host: e.host === "company" ? "company" : "person",
      isolation,
      ...(isolation === "container"
        ? {
            image: str(e.image, 200) || DEFAULT_IMAGE,
            network: e.network === "off" ? "off" : "on",
            ...(e.cpus ? { cpus: Math.min(16, Math.max(0.25, Number(e.cpus) || 1)) } : {}),
            ...(e.memoryMb ? { memoryMb: int(e.memoryMb, 128, 65_536, 2048) } : {}),
            ...(str(e.agent, 400) ? { agent: str(e.agent, 400) } : {}),
            ...(list(e.env).length
              ? {
                  env: [
                    ...new Set(
                      list(e.env)
                        .map((n) => str(n, 64))
                        .filter((n) => ENV_NAME.test(n)),
                    ),
                  ].slice(0, 20),
                }
              : {}),
          }
        : {}),
      ...(str(e.repo, 300) ? { repo: str(e.repo, 300) } : {}),
      ...(str(e.branch, 120) ? { branch: str(e.branch, 120) } : {}),
      ...(str(e.setup, 2000) ? { setup: str(e.setup, 2000) } : {}),
      ...(e.keep === true ? { keep: true } : {}),
    };
  }
  const r = obj(x.resources);
  const resources: Resources = {
    notes: typeof r.notes === "string" ? r.notes.slice(0, LIMITS.notes) : "",
    docs: list(r.docs)
      .map((d) => ({ id: str(obj(d).id, 40), title: str(obj(d).title, 300) }))
      .filter((d) => d.id)
      .slice(0, LIMITS.docs),
    files: list(r.files)
      .map((f) => ({ id: str(obj(f).id, 40), name: str(obj(f).name, 300), size: int(obj(f).size, 0, 1e12, 0), contentType: str(obj(f).contentType, 200) }))
      .filter((f) => f.id && f.name)
      .slice(0, LIMITS.files),
    drive: list(r.drive)
      .map((f) => ({ id: str(obj(f).id, 40), name: str(obj(f).name, 300) }))
      .filter((f) => f.id)
      .slice(0, LIMITS.drive),
    tasks: list(r.tasks)
      .map((t) => ({ id: str(obj(t).id, 40), code: str(obj(t).code, 40), title: str(obj(t).title, 300) }))
      .filter((t) => t.id)
      .slice(0, LIMITS.tasks),
    links: list(r.links)
      .map((l) => ({ url: str(obj(l).url, 1000), title: str(obj(l).title, 200) }))
      .filter((l) => /^https?:\/\/\S+$/i.test(l.url))
      .slice(0, LIMITS.links),
    taskContext: r.taskContext !== false,
    taskFiles: r.taskFiles === true,
  };
  const g = obj(x.guardrails);
  const guardrails: Guardrails = {
    maxMinutes: int(g.maxMinutes, LIMITS.maxMinutes[0], LIMITS.maxMinutes[1], DEFAULT_GUARDRAILS.maxMinutes),
    stepMinutes: int(g.stepMinutes, LIMITS.stepMinutes[0], LIMITS.stepMinutes[1], DEFAULT_GUARDRAILS.stepMinutes),
    maxTokens: int(g.maxTokens, 0, LIMITS.maxTokens, 0),
    ask: g.ask === "never" ? "never" : "allowed",
  };
  const o = obj(x.output);
  const STATUSES = ["todo", "in_progress", "review", "done", "cancelled"];
  const output: Output = {
    comment: o.comment !== false,
    doc: o.doc === true,
    files: o.files === true && kind !== "assistant",
    subtasks: o.subtasks === true,
    status: typeof o.status === "string" && STATUSES.includes(o.status) ? (o.status as TaskStatus) : "",
  };
  const TYPES: InputType[] = ["text", "long", "choice", "number", "date"];
  const inputs = uniqueKeys(
    list(x.inputs)
      .map((f) => {
        const i = obj(f);
        const type = TYPES.includes(i.type as InputType) ? (i.type as InputType) : "text";
        const options = [
          ...new Set(
            list(i.options)
              .map((v) => str(v, 120))
              .filter(Boolean),
          ),
        ].slice(0, 12);
        const label = str(i.label, 80);
        return {
          key: str(i.key, 40) || label,
          label,
          type,
          ...(type === "choice" ? { options } : {}),
          ...(i.required === true ? { required: true } : {}),
          ...(str(i.placeholder, 200) ? { placeholder: str(i.placeholder, 200) } : {}),
          ...(str(i.default, 2000) ? { default: str(i.default, 2000) } : {}),
        } satisfies InputField;
      })
      .filter((f) => f.label)
      .slice(0, LIMITS.inputs),
    "field",
  );
  return {
    inputs,
    environment,
    resources,
    guardrails,
    output,
    // A run on a person's own computer starts when that person presses Run, never by itself.
    autoStart: x.autoStart === true && startsByItself(environment),
    estimate: x.estimate !== false,
    triggers: startsByItself(environment) ? normalizeTriggers(x.triggers) : [],
    runAs: str(x.runAs, 60),
  };
}

/** The steps as they are stored: each kind keeps only its own fields, keys are unique and typable. */
export function normalizeSteps(steps: WorkflowStep[], env: Environment): WorkflowStep[] {
  const server = env.kind === "assistant";
  return uniqueKeys(
    steps.map((s) => {
      const base = { key: s.key || s.title, title: s.title.trim(), kind: s.kind };
      const timeout = s.timeoutMin ? { timeoutMin: int(s.timeoutMin, 1, LIMITS.stepMinutes[1], 10) } : {};
      const retries = s.retries ? { retries: int(s.retries, 0, 3, 0) } : {};
      const model = s.model?.trim() ? { model: s.model.trim() } : {};
      if (s.kind === "ai")
        return {
          ...base,
          prompt: s.prompt ?? "",
          ...model,
          ...(s.role?.trim() ? { role: s.role.trim() } : {}),
          ...(server && s.tools === false ? { tools: false } : {}),
          ...(s.resources === false ? { resources: false } : {}),
          ...(s.ask === false ? { ask: false } : {}),
          ...(server && s.maxOutput ? { maxOutput: int(s.maxOutput, 1000, 8000, 2000) } : {}),
          ...timeout,
          ...retries,
        };
      if (s.kind === "command") return { ...base, command: (s.command ?? "").trim(), ...timeout, ...retries };
      if (s.kind === "check") {
        const command = !server && s.command?.trim() ? { command: s.command.trim() } : {};
        return {
          ...base,
          ...command,
          ...(!("command" in command) ? { criteria: (s.criteria ?? "").trim(), ...model, ...(s.resources === false ? { resources: false } : {}) } : {}),
          attempts: int(s.attempts, 0, 5, 2),
          onFail: s.onFail === "continue" ? ("continue" as const) : ("stop" as const),
          ...timeout,
        };
      }
      if (s.kind === "approval") {
        const approver: Approver = s.approver && ["owner", "assignee", "starter", "person"].includes(s.approver) ? s.approver : "editors";
        return { ...base, ...(approver !== "editors" ? { approver } : {}), ...(approver === "person" && s.approverId ? { approverId: s.approverId } : {}) };
      }
      return { ...base, status: s.status };
    }),
    "s",
  );
}

/** Refuses a workflow that could not run; the message names the step. Returns the normalized steps and config. */
export function validateWorkflow(rawSteps: WorkflowStep[], rawConfig: unknown, runner?: Runner): { steps: WorkflowStep[]; config: WorkflowConfig; runner: Runner } {
  const config = normalizeConfig(rawConfig, runner);
  const env = config.environment;
  const server = env.kind === "assistant";
  if (!rawSteps.length) throw new Invalid("a workflow needs at least one step");
  if (rawSteps.length > LIMITS.steps) throw new Invalid(`a workflow has at most ${LIMITS.steps} steps`);
  for (const s of rawSteps) {
    if (!s.title?.trim()) throw new Invalid("every step needs a name");
    if (s.kind === "ai" && !s.prompt?.trim()) throw new Invalid(`step "${s.title}" needs an instruction`);
    if (s.kind === "command" && server) throw new Invalid("commands only run in a sandbox or on a computer");
    if (s.kind === "command" && !s.command?.trim()) throw new Invalid(`step "${s.title}" needs a command`);
    if (s.kind === "status" && !s.status) throw new Invalid(`step "${s.title}" needs a status`);
    if (s.kind === "check" && !(s.criteria?.trim() || (!server && s.command?.trim()))) throw new Invalid(`check "${s.title}" needs what to check`);
    if (s.kind === "approval" && s.approver === "person" && !s.approverId) throw new Invalid(`approval "${s.title}" needs a person`);
  }
  const steps = normalizeSteps(rawSteps, env);
  // A check needs something to check: a result made before it.
  steps.forEach((s, i) => {
    if (s.kind === "check" && !steps.slice(0, i).some((x) => x.kind === "ai" || x.kind === "command")) throw new Invalid(`check "${s.title}" has nothing before it to check`);
  });
  if (env.kind === "sandbox") {
    if (env.isolation === "container" && !IMAGE.test(env.image ?? "")) throw new Invalid("the container image name is not valid");
    if (env.repo && !REPO.test(env.repo)) throw new Invalid("the repository must be an https or ssh git address");
    if (env.branch && !BRANCH.test(env.branch)) throw new Invalid("the branch name is not valid");
  }
  for (const f of config.inputs) if (f.type === "choice" && (f.options?.length ?? 0) < 2) throw new Invalid(`input "${f.label}" needs at least two options`);
  // Nobody is there to fill in a form when a run starts by itself.
  const asks = config.inputs.find((f) => f.required && !f.default);
  if (config.triggers.length && asks) throw new Invalid(`a workflow that starts by itself cannot require "${asks.label}" without a default value`);
  return { steps, config, runner: runnerOf(env) };
}

/** The values for a run's inputs: trimmed, typed, required ones present. Unknown keys are dropped. */
export function cleanInputs(fields: InputField[], raw: unknown): Record<string, string> {
  const given = obj(raw);
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = given[f.key];
    let text = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
    if (!text && f.default) text = f.default;
    if (!text) {
      if (f.required) throw new Invalid(`"${f.label}" is required`);
      continue;
    }
    if (f.type === "number" && !Number.isFinite(Number(text))) throw new Invalid(`"${f.label}" must be a number`);
    if (f.type === "date" && Number.isNaN(Date.parse(text))) throw new Invalid(`"${f.label}" must be a date`);
    if (f.type === "choice" && f.options?.length && !f.options.includes(text)) throw new Invalid(`"${f.label}" must be one of its options`);
    out[f.key] = text.slice(0, f.type === "long" ? 8000 : 500);
  }
  return out;
}

/** Whether every required input has a value without asking anyone (so a run may start by itself). */
export const inputsSatisfied = (fields: InputField[]) => fields.every((f) => !f.required || !!f.default);

/**
 * How long a step usually takes when this workflow has not run it yet, in seconds: a guess by what the step is and
 * where it runs, replaced by the step's own average as soon as there is one (workflows.ts estimateFor).
 */
export function typicalSeconds(s: Pick<WorkflowStep, "kind" | "model" | "command" | "maxOutput">, env: Pick<Environment, "kind">): number {
  const server = env.kind === "assistant";
  if (s.kind === "approval" || s.kind === "status") return 0;
  if (s.kind === "command" || (s.kind === "check" && s.command)) return 45;
  if (s.kind === "check") return server ? 15 : 60;
  // A coding agent reads and edits files; the company's AI writes one answer, longer when asked for a long one.
  if (!server) return 240;
  return s.model === "fast" ? 20 : (s.maxOutput ?? 2000) > 2000 ? 90 : 45;
}
