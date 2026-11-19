import type { Run, RunnerInfo, RunStep, Workflow, WorkflowStep } from "../types";

/** A run as the task's runs list returns it: whether the reader may give the approval it waits for. */
export type TaskRun = Run & { canApprove?: boolean };

/** How many times a step's result was sent back and redone (by a check or an approver). */
export const redone = (s: Pick<RunStep, "history">) => (s.history ?? []).filter((e) => e.kind === "sent_back" || e.kind === "rework").length;

/** Why a run failed, when it is one of the engine's own stops (a limit, a check) rather than an error. */
export function failureKind(error: string | null | undefined): "time" | "tokens" | "check" | null {
  const e = (error ?? "").toLowerCase();
  if (!e) return null;
  if (e.includes("time limit")) return "time";
  if (e.includes("token budget")) return "tokens";
  if (e.includes("did not pass")) return "check";
  return null;
}

/** 1.2 MB, 340 KB: a file's size in the unit people read. */
export function fileSize(n: number | undefined): string {
  if (!n || n < 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/**
 * Which runner will take a run of this workflow: the reader's own online computer, a company runner, or none (the run
 * still queues). A container workflow needs a runner with Docker. null for the company's AI (no runner involved).
 */
export function runnerFor(
  w: Pick<Workflow, "config" | "runner">,
  runners: RunnerInfo[] | undefined,
): { kind: "mine" | "company" | "none" | "noneCompany" | "needsDocker"; device?: string } | null {
  const env = w.config?.environment;
  if (!env ? w.runner !== "local" : env.kind === "assistant") return null;
  const company = env?.kind === "sandbox" && env.host === "company";
  const online = (runners ?? []).filter((r) => r.online && (company ? r.shared : r.mine));
  const docker = env?.kind === "sandbox" && env.isolation === "container";
  const fit = online.find((r) => !docker || r.docker);
  if (fit) return { kind: company ? "company" : "mine", device: fit.device };
  if (online.length && docker) return { kind: "needsDocker" };
  return { kind: company ? "noneCompany" : "none" };
}

/** The check before which a step's work is judged: the step whose result a check at `index` reads. */
export const checkedStep = (steps: Pick<WorkflowStep, "kind" | "title">[], index: number) =>
  steps
    .slice(0, index)
    .reverse()
    .find((s) => s.kind === "ai" || s.kind === "command");

/**
 * A length of time in the unit people plan by: seconds to the nearest five under a minute, whole minutes up to an
 * hour and a half, then hours and minutes to the nearest five. The parts are for the i18n strings (run/eta.tsx).
 */
export function durationParts(sec: number): { unit: "sec"; n: number } | { unit: "min"; n: number } | { unit: "hour"; h: number; m: number } {
  const s = Math.max(0, sec);
  if (s < 55) return { unit: "sec", n: Math.max(5, Math.round(s / 5) * 5) };
  const min = Math.round(s / 60);
  if (min < 90) return { unit: "min", n: Math.max(1, min) };
  const rounded = Math.round(min / 5) * 5;
  return { unit: "hour", h: Math.floor(rounded / 60), m: rounded % 60 };
}
