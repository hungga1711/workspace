import type { ModelCatalog, Runner, RunnerInfo, WorkflowConfig, WorkflowStep } from "./types";

/*
 * A workflow read the way the server runs it (backend work/workflows/render.ts and runs.ts), so the page can draw what
 * each step is given and where its result goes, and point out what will go wrong before anyone presses Run. Pure,
 * unit-tested.
 *
 * The server's rules this mirrors: {{task}} is the task and its workspace context; {{previous}} the last result before
 * the step (an AI step's or a command's; approvals and checks make none) followed by any approver notes since;
 * {{steps.<key>}} an earlier AI step's or command's result; {{input.<key>}} and {{inputs}} what was filled in at Run;
 * {{resources}} the workflow's playbook, pages, files and links (added before the instruction when the step does not
 * place it, unless the step turned resources off); {{answers}} the answers to the run's questions. A check judges the
 * last result before it and sends it back to the AI step that made it; when the run ends, the last result is the one
 * delivered (comment, page, subtasks).
 */

export const PLACEHOLDERS = ["task", "previous", "answers", "resources", "inputs"] as const;
/** A placeholder: a plain name, or `steps.<key>` / `input.<key>`. */
export const PH = /\{\{\s*([a-zA-Z_][\w.-]*)\s*\}\}/g;

/** Which placeholders a prompt uses, and any the server does not fill (they reach the model as written). */
export function placeholders(prompt: string) {
  const used = new Set<string>();
  for (const m of prompt.matchAll(PH)) used.add(m[1]!);
  const names = [...used];
  const keyed = (prefix: string) => names.filter((x) => x.startsWith(prefix) && x.length > prefix.length).map((x) => x.slice(prefix.length));
  return {
    task: used.has("task"),
    previous: used.has("previous"),
    answers: used.has("answers"),
    resources: used.has("resources"),
    inputs: used.has("inputs"),
    /** Keys read as {{steps.<key>}} and {{input.<key>}}. */
    steps: keyed("steps."),
    input: keyed("input."),
    unknown: names.filter((x) => !(PLACEHOLDERS as readonly string[]).includes(x) && !/^(steps|input)\.[\w-]+$/.test(x)),
  };
}

/** A step makes a result the next ones can read: an AI step's answer or a command's output. */
export const makesResult = (s: Pick<WorkflowStep, "kind">) => s.kind === "ai" || s.kind === "command";

/** The key the server gives a label (model.ts slug): lowercase letters, digits, "-" and "_". */
export const slug = (s: string, fallback: string) =>
  (s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || fallback;

/** Each step's key as the server will store it (model.ts uniqueKeys): typable, and unique in the workflow. */
export function stepKeys(steps: Pick<WorkflowStep, "key" | "title">[], prefix = "s"): string[] {
  const seen = new Set<string>();
  return steps.map((s, i) => {
    const base = slug(s.key || s.title, `${prefix}${i + 1}`);
    let key = base;
    for (let n = 2; seen.has(key); n++) key = `${base.slice(0, 36)}-${n}`;
    seen.add(key);
    return key;
  });
}

export interface StepFlow {
  task: boolean;
  previous: boolean;
  answers: boolean;
  /** The step reads the workflow's resources: placed with {{resources}}, or added before the instruction. */
  resources: boolean;
  /** Input keys the step reads ({{input.<key>}}); `allInputs` when it uses {{inputs}}. */
  input: string[];
  allInputs: boolean;
  /** Placeholders the server does not fill. */
  unknown: string[];
  /** Earlier steps read by key ({{steps.<key>}}). */
  reads: number[];
  /** The step whose result {{previous}} carries here (for a check or an approval: the result it looks at); null when none. */
  previousFrom: number | null;
  /** Approvals between that step and this one: their notes follow the result in {{previous}}. */
  notesFrom: number[];
  /** Steps that read this step's result, through {{previous}} or by key. */
  readBy: number[];
  /** The first approval that shows this step's result to a person (and can send it back). */
  reviewedBy: number | null;
  /** Checks that judge this step's result. */
  checkedBy: number[];
  /** check: the AI step a failed check sends the work back to; null when there is none (the check can only stop or go on). */
  sendsBackTo: number | null;
  /** This step's result is the one delivered when the run ends. */
  final: boolean;
  /** This step may stop to ask the people on the task. */
  mayAsk: boolean;
}

export type Severity = "error" | "warn" | "info";
export type Section = "overview" | "inputs" | "environment" | "resources" | "steps" | "guardrails" | "output" | "start";
export type FindingCode =
  | "noSteps"
  | "noAi"
  | "previousEmpty"
  | "unknownPlaceholder"
  | "unknownStep"
  | "laterStep"
  | "unknownInput"
  | "resultUnused"
  | "shortPrompt"
  | "modelMissing"
  | "approvalNothing"
  | "approvalTwice"
  | "approverMissing"
  | "checkNothing"
  | "checkEmpty"
  | "checkNoSendBack"
  | "commandOnAssistant"
  | "commandEmpty"
  | "finalUnreviewed"
  | "afterApproval"
  | "filesNoRunner"
  | "agentNoNetwork"
  | "noCompanyRunner"
  | "noDocker"
  | "autoStartInput"
  | "stepOverRun"
  | "stepLimitOverRun"
  | "overTime";
export interface Finding {
  /** The step it is about (0-based), null for the whole workflow. */
  step: number | null;
  severity: Severity;
  code: FindingCode;
  /** Where to fix it. */
  section: Section;
  params?: Record<string, string | number>;
}

export type ModelKind = "default" | "fast" | "picked" | "missing" | "none" | "agent" | "agentDefault";
export interface ModelInfo {
  kind: ModelKind;
  /** The connection or vendor ("Claude", "Company OpenRouter"). */
  label?: string | undefined;
  model?: string | undefined;
}

/** What model a step runs on, in the terms the page shows: the company's default, its fast one, a picked one. */
export function describeModel(s: Pick<WorkflowStep, "model">, runner: Runner, catalog: Pick<ModelCatalog, "models" | "defaults"> | null): ModelInfo {
  const m = (s.model ?? "").trim();
  if (runner === "local") return m ? { kind: "agent", model: m } : { kind: "agentDefault" };
  const d = catalog?.defaults ?? null;
  if (m === "fast") return d ? { kind: "fast", label: d.fast.label, model: d.fast.model } : { kind: "none" };
  if (m.includes(":")) {
    const hit = catalog?.models.find((x) => x.route === m);
    return hit ? { kind: "picked", label: hit.label, model: hit.model } : { kind: "missing", model: m.slice(m.indexOf(":") + 1) };
  }
  return d ? { kind: "default", label: d.smart.label, model: d.smart.model } : { kind: "none" };
}

/** A check judged by an AI (its criteria), not by a command's exit code. */
export const aiCheck = (s: Pick<WorkflowStep, "kind" | "command">, runner: Runner) => s.kind === "check" && !(runner === "local" && s.command?.trim());

export interface AnalyzeOptions {
  /** The workflow's config: without it only the steps are read (a list card, an old caller). */
  config?: WorkflowConfig | null;
  /** The runners seen lately; undefined when they could not be read (nothing is said about them). */
  runners?: RunnerInfo[] | null;
}

export function analyze(steps: WorkflowStep[], runner: Runner, catalog: Pick<ModelCatalog, "models" | "defaults"> | null, opts: AnalyzeOptions = {}) {
  const cfg = opts.config ?? null;
  const findings: Finding[] = [];
  const add = (step: number | null, severity: Severity, code: FindingCode, section: Section, params?: Record<string, string | number>) =>
    findings.push({ step, severity, code, section, ...(params ? { params } : {}) });
  const keys = stepKeys(steps);
  const lastResult = steps.reduce((at, s, i) => (makesResult(s) ? i : at), -1);
  const hasResources = !!cfg && (!!cfg.resources.notes.trim() || cfg.resources.docs.length + cfg.resources.files.length + cfg.resources.links.length > 0);
  const inputKeys = cfg
    ? stepKeys(
        cfg.inputs.map((f) => ({ key: f.key, title: f.label })),
        "field",
      )
    : [];

  const flows: StepFlow[] = steps.map((s, i) => {
    const ph = placeholders(s.kind === "ai" ? (s.prompt ?? "") : "");
    let from: number | null = null;
    for (let j = i - 1; j >= 0; j--)
      if (makesResult(steps[j]!)) {
        from = j;
        break;
      }
    let back: number | null = null;
    if (s.kind === "check")
      for (let j = i - 1; j >= 0; j--)
        if (steps[j]!.kind === "ai") {
          back = j;
          break;
        }
    const notesFrom = steps.map((x, j) => (x.kind === "approval" && j > (from ?? -1) && j < i ? j : -1)).filter((j) => j >= 0);
    const reads = ph.steps.map((k) => keys.indexOf(k)).filter((j) => j >= 0 && j < i && makesResult(steps[j]!));
    return {
      task: ph.task,
      previous: ph.previous,
      answers: ph.answers,
      resources: s.kind === "ai" && s.resources !== false && (ph.resources || hasResources),
      input: ph.input,
      allInputs: ph.inputs,
      unknown: ph.unknown,
      reads,
      previousFrom: from,
      notesFrom,
      readBy: [],
      reviewedBy: null,
      checkedBy: [],
      sendsBackTo: back,
      final: i === lastResult,
      mayAsk: s.kind === "ai" && s.ask !== false && cfg?.guardrails.ask !== "never",
    };
  });
  steps.forEach((s, i) => {
    const f = flows[i]!;
    if (s.kind === "ai") {
      const readers = new Set<number>(f.reads);
      if (f.previous && f.previousFrom !== null) readers.add(f.previousFrom);
      for (const j of readers) flows[j]!.readBy.push(i);
    }
    // An approval shows the last result before it; the first approval after a step is the one that reviews it.
    if (s.kind === "approval" && f.previousFrom !== null && flows[f.previousFrom]!.reviewedBy === null) flows[f.previousFrom]!.reviewedBy = i;
    if (s.kind === "check" && f.previousFrom !== null) flows[f.previousFrom]!.checkedBy.push(i);
  });

  if (!steps.length) add(null, "error", "noSteps", "steps");
  const aiSteps = steps.filter((s) => s.kind === "ai").length;
  const judged = steps.filter((s) => aiCheck(s, runner)).length;
  if (runner === "server" && aiSteps + judged > 0 && !catalog?.defaults) add(null, "error", "noAi", "environment");

  steps.forEach((s, i) => {
    const f = flows[i]!;
    if (s.kind === "ai") {
      const ph = placeholders(s.prompt ?? "");
      // An instruction that places neither the task nor an earlier result is given the task by the engine (render.ts),
      // and what was answered at Run travels with the task: nothing to point out for either.
      if (f.previous && f.previousFrom === null) add(i, "warn", "previousEmpty", "steps");
      for (const name of f.unknown) add(i, "error", "unknownPlaceholder", "steps", { name: `{{${name}}}` });
      for (const k of ph.steps) {
        const at = keys.indexOf(k);
        if (at < 0 || !makesResult(steps[at]!)) add(i, "error", "unknownStep", "steps", { name: `{{steps.${k}}}` });
        else if (at >= i) add(i, "error", "laterStep", "steps", { name: `{{steps.${k}}}`, n: at + 1 });
      }
      for (const k of f.input) {
        if (cfg && !inputKeys.includes(k)) add(i, "error", "unknownInput", "steps", { name: `{{input.${k}}}` });
      }
      const bare = (s.prompt ?? "").replace(PH, "").trim();
      if (bare.length < 15) add(i, "warn", "shortPrompt", "steps");
      if (describeModel(s, runner, catalog).kind === "missing") add(i, "warn", "modelMissing", "steps", { model: s.model ?? "" });
      // A result nobody reads, nobody reviews and that is not the final one only shows in the run's log. A coding
      // agent's steps work on the folder, so there it is only worth a note.
      if (!f.readBy.length && f.reviewedBy === null && !f.checkedBy.length && !f.final) add(i, runner === "local" ? "info" : "warn", "resultUnused", "steps", { n: i + 1 });
    }
    if (s.kind === "command" && runner === "server") add(i, "error", "commandOnAssistant", "steps");
    // The server refuses a command step without a command: say so before Save does.
    else if (s.kind === "command" && !s.command?.trim()) add(i, "error", "commandEmpty", "steps");
    if (s.kind === "approval") {
      if (f.previousFrom === null) add(i, "warn", "approvalNothing", "steps");
      else if (steps[i - 1]?.kind === "approval") add(i, "warn", "approvalTwice", "steps");
      if (s.approver === "person" && !s.approverId) add(i, "error", "approverMissing", "steps");
    }
    if (s.kind === "check") {
      const byCommand = runner === "local" && !!s.command?.trim();
      if (f.previousFrom === null) add(i, "error", "checkNothing", "steps");
      if (!byCommand && !s.criteria?.trim()) add(i, "error", "checkEmpty", "steps");
      else if (runner === "server" && s.command?.trim() && !s.criteria?.trim()) add(i, "error", "commandOnAssistant", "steps");
      // Nothing to send back to: the result came from a command with no AI step before it.
      if (f.previousFrom !== null && f.sendsBackTo === null && (s.attempts ?? 2) > 0) add(i, "info", "checkNoSendBack", "steps");
    }
    const limit = s.timeoutMin ?? 0;
    if (cfg && limit > cfg.guardrails.maxMinutes) add(i, "warn", "stepOverRun", "steps", { step: limit, run: cfg.guardrails.maxMinutes });
  });

  // The final AI result: delivered as it is unless a check or an approval comes after it.
  const gates = steps.map((s, i) => (s.kind === "approval" || s.kind === "check" ? i : -1)).filter((i) => i >= 0);
  const lastGate = gates.length ? gates[gates.length - 1]! : -1;
  if (lastResult >= 0 && steps[lastResult]!.kind === "ai") {
    if (lastGate === -1) add(lastResult, "info", "finalUnreviewed", "steps");
    else if (lastResult > lastGate) add(lastResult, "warn", "afterApproval", "steps", { n: lastGate + 1 });
  }

  if (cfg) {
    const env = cfg.environment;
    if (cfg.output.files && runner === "server") add(null, "error", "filesNoRunner", "output");
    if (env.kind === "sandbox" && env.isolation === "container" && env.network === "off" && env.agent?.trim() && aiSteps + judged > 0)
      add(null, "warn", "agentNoNetwork", "environment");
    if (env.kind === "sandbox" && opts.runners) {
      const online = opts.runners.filter((r) => r.online && (env.host === "company" ? r.shared : r.mine));
      if (env.host === "company" && !online.length) add(null, "info", "noCompanyRunner", "environment");
      else if (env.isolation === "container" && online.length && !online.some((r) => r.docker)) add(null, "warn", "noDocker", "environment");
    }
    // Nobody is there to answer when a run starts by itself (put on a task, or by one of its triggers).
    if (cfg.autoStart || cfg.triggers?.length)
      for (const field of cfg.inputs) if (field.required && !field.default) add(null, "error", "autoStartInput", "start", { name: field.label });
    // One step allowed longer than the whole run: the run's limit stops it first.
    if (cfg.guardrails.stepMinutes > cfg.guardrails.maxMinutes)
      add(null, "warn", "stepLimitOverRun", "guardrails", { step: cfg.guardrails.stepMinutes, run: cfg.guardrails.maxMinutes });
    const explicit = steps.reduce((n, s) => n + (s.timeoutMin ?? 0), 0);
    if (explicit > cfg.guardrails.maxMinutes) add(null, "info", "overTime", "guardrails", { steps: explicit, run: cfg.guardrails.maxMinutes });
  }

  const tools = runner === "server" && steps.some((s) => s.kind === "ai" && s.tools !== false);
  const models = new Map<string, ModelInfo>();
  for (const s of steps)
    if (s.kind === "ai" || aiCheck(s, runner)) {
      const m = describeModel(s.kind === "check" && !s.model ? { model: runner === "server" ? "fast" : "" } : s, runner, catalog);
      models.set(`${m.kind}:${m.label ?? ""}:${m.model ?? ""}`, m);
    }
  return {
    flows,
    keys,
    inputKeys,
    findings,
    summary: {
      steps: steps.length,
      ai: aiSteps,
      checks: steps.filter((s) => s.kind === "check").length,
      approvals: steps.filter((s) => s.kind === "approval").length,
      commands: steps.filter((s) => s.kind === "command").length,
      // One model call per AI step and per judged check; a step with tools may take up to 6 turns (ai/mcp/loop.ts
      // MAX_TURNS) and one more. Send-backs and retries add to it.
      calls: { min: aiSteps + judged, max: (tools ? steps.filter((s) => s.kind === "ai").reduce((n, s) => n + (s.tools === false ? 1 : 7), 0) : aiSteps) + judged },
      models: [...models.values()],
      final: lastResult,
      errors: findings.filter((x) => x.severity === "error").length,
      warnings: findings.filter((x) => x.severity === "warn").length,
    },
  };
}
export type Analysis = ReturnType<typeof analyze>;

const ORDER: Severity[] = ["error", "warn", "info"];
/** Errors first, then warnings, then notes; the order within each is the pipeline's. */
export const bySeverity = (findings: Finding[]) => [...findings].sort((x, y) => ORDER.indexOf(x.severity) - ORDER.indexOf(y.severity));
