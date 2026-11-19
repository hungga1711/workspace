import { makesResult, stepKeys, type Section } from "../analyze";
import { defaultConfig, runnerOf, type Category, type EnvKind, type Environment, type Workflow, type WorkflowConfig, type WorkflowStep, type WorkflowTemplate } from "../types";

/** A workflow as the studio edits it: what the server stores, before it is saved. */
export interface Draft {
  id?: string;
  name: string;
  description: string;
  category: Category;
  steps: WorkflowStep[];
  config: WorkflowConfig;
  template?: string | null;
}

export const SECTIONS: Section[] = ["overview", "inputs", "environment", "resources", "steps", "guardrails", "output", "start"];

/** A stored config with every part present (a row from before the rebuild may lack some). */
export function fullConfig(c: Partial<WorkflowConfig> | null | undefined, kind: EnvKind = "assistant"): WorkflowConfig {
  const d = defaultConfig(c?.environment?.kind ?? kind);
  return {
    inputs: c?.inputs ?? [],
    environment: c?.environment ?? d.environment,
    resources: { ...d.resources, ...c?.resources },
    guardrails: { ...d.guardrails, ...c?.guardrails },
    output: { ...d.output, ...c?.output },
    autoStart: c?.autoStart ?? false,
    estimate: c?.estimate !== false,
    triggers: c?.triggers ?? [],
    ...(c?.runAs ? { runAs: c.runAs } : {}),
  };
}

export const blankDraft = (): Draft => ({ name: "", description: "", category: "other", steps: [], config: defaultConfig() });
export const draftOf = (w: Workflow): Draft => ({
  id: w.id,
  name: w.name,
  description: w.description,
  category: w.category,
  steps: w.steps,
  config: fullConfig(w.config, w.runner === "local" ? "computer" : "assistant"),
  template: w.template,
});
/** A copy of a workflow: the same harness, a new name, no id. Its files stay listed (the server checks them on save). */
export const copyOf = (w: Workflow, name: string): Draft => ({ ...draftOf(w), id: undefined, name, template: w.template }) as Draft;
export const draftFromTemplate = (tp: WorkflowTemplate): Draft => ({
  name: tp.name,
  description: tp.description,
  category: tp.category,
  steps: tp.steps,
  config: fullConfig(tp.config, tp.runner === "local" ? "computer" : "assistant"),
  template: tp.key,
});

export const saveBody = (d: Draft) => ({ name: d.name.trim(), description: d.description, category: d.category, steps: d.steps, config: d.config, template: d.template ?? null });

/** The steps left when the workflow moves to the company's AI: commands go, and checks a command decided. */
export function withoutCommands(steps: WorkflowStep[]): WorkflowStep[] {
  return steps
    .filter((s) => s.kind !== "command" && !(s.kind === "check" && s.command?.trim() && !s.criteria?.trim()))
    .map((s) => (s.kind === "check" ? { ...s, command: undefined } : s));
}
export const commandCount = (steps: WorkflowStep[]) => steps.length - withoutCommands(steps).length;

/** Changing the environment keeps what still applies and drops what cannot run there. */
export function withEnvironment(d: Draft, environment: Environment): Draft {
  const server = environment.kind === "assistant";
  return {
    ...d,
    steps: server ? withoutCommands(d.steps) : d.steps,
    config: {
      ...d.config,
      environment,
      output: { ...d.config.output, files: server ? false : d.config.output.files },
      resources: { ...d.config.resources, taskFiles: server ? false : d.config.resources.taskFiles },
      autoStart: d.config.autoStart && (server || (environment.kind === "sandbox" && environment.host === "company")),
    },
  };
}

export const mayAutoStart = (e: Environment) => e.kind === "assistant" || (e.kind === "sandbox" && e.host === "company");

export interface Insertable {
  /** The text between the braces: "task", "steps.plan", "input.tone". */
  name: string;
  group: "base" | "step" | "input";
  /** step: the step's number and title; input: the field's label. */
  label?: string;
}
/** Every placeholder that is filled at step `i`: the fixed ones, each earlier result by key, each input. */
export function insertables(d: Draft, i: number): Insertable[] {
  const keys = stepKeys(d.steps);
  const inputKeys = stepKeys(
    d.config.inputs.map((f) => ({ key: f.key, title: f.label })),
    "field",
  );
  return [
    { name: "task", group: "base" },
    ...(d.steps.slice(0, i).some(makesResult) ? [{ name: "previous", group: "base" as const }] : []),
    { name: "resources", group: "base" },
    { name: "answers", group: "base" },
    ...(d.config.inputs.length ? [{ name: "inputs", group: "base" as const }] : []),
    ...d.steps.flatMap((s, j) => (j < i && makesResult(s) ? [{ name: `steps.${keys[j]}`, group: "step" as const, label: `${j + 1} · ${s.title}` }] : [])),
    ...d.config.inputs.map((f, j) => ({ name: `input.${inputKeys[j]}`, group: "input" as const, label: f.label })),
  ];
}

export { runnerOf };
