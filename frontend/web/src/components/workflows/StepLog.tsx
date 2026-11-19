"use client";

import { useFormat, useT } from "@/lib/i18n/client";
import { useDirectory } from "@/lib/people";
import { cx } from "@/lib/ui";
import { duration } from "./Graph";
import type { RunStep, StepEntry } from "./types";

const OUTCOME_TONE: Record<NonNullable<StepEntry["outcome"]>, string> = {
  done: "bg-ok-wash text-ok",
  asked: "bg-violet-wash text-violet-text",
  decide: "bg-warn-wash text-warn",
  failed: "bg-block-wash text-block",
  cancelled: "bg-hover text-ink-2",
  timeout: "bg-warn-wash text-warn",
};

/** A log line that is not an attempt, in words: what a person, a check or the engine did on the step. */
export function useEntryLabel() {
  const t = useT();
  const dir = useDirectory();
  return (e: StepEntry, step: Pick<RunStep, "rework">) => {
    const person = e.by && e.by !== "check" ? dir.name(e.by) : "";
    if (e.kind === "checked") return t(e.outcome === "done" ? "workflows.run.history.checkedPass" : "workflows.run.history.checkedFail");
    if (e.kind === "sent_back" || (e.kind === "rework" && !person))
      return person
        ? t("workflows.pipeline.history.rework", { name: person })
        : step.rework?.check
          ? t("workflows.run.history.sentBack", { check: step.rework.check })
          : t("workflows.run.history.sentBackPlain");
    if (e.kind === "retry") return t("workflows.run.history.retry");
    if (e.kind === "requeued") return t("workflows.run.history.requeued");
    if (e.kind === "attempt") return "";
    return t(`workflows.pipeline.history.${e.kind}`, { name: person });
  };
}
const ENTRY_TONE: Partial<Record<StepEntry["kind"], string>> = { sent_back: "text-rose-text", retry: "text-warn", requeued: "text-warn" };

const pre = "text-ink-soft bg-ground ring-hairline m-0 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg px-3 py-2 font-mono text-[12px]/5 ring-1 ring-inset";

/**
 * A step's log: each time it ran, oldest first, with what it was given and what came back, the model,
 * tokens and time, and what happened in between: people's answers, a send-back or an approval, a check's verdict, a
 * retry after a failure, the run queued again when its runner went away. Then what a runner printed. Steps from before the log show only the runner's output.
 */
export function StepLog({ step, live }: { step: RunStep; live: boolean }) {
  const t = useT();
  const { time, number } = useFormat();
  const label = useEntryLabel();
  const entries = step.history ?? [];
  if (!entries.length && !step.log) return <p className="text-ink-2 m-0 text-sm">{t("workflows.pipeline.empty.log")}</p>;
  let n = 0;
  return (
    <div className="grid gap-3">
      {entries.length ? (
        <ol className="m-0 grid list-none gap-2 p-0">
          {entries.map((e, i) => {
            if (e.kind !== "attempt")
              return (
                <li key={i} className="text-ink-2 flex min-w-0 items-baseline gap-2 px-1 text-[13px]">
                  <span className="text-ink-soft shrink-0 tabular-nums">{time(e.at)}</span>
                  <span className="min-w-0">
                    <span className={cx("font-medium", e.kind === "checked" ? (e.outcome === "done" ? "text-ok" : "text-rose-text") : (ENTRY_TONE[e.kind] ?? "text-ink"))}>
                      {label(e, step)}
                    </span>
                    {e.text ? <span className="mt-0.5 block whitespace-pre-wrap break-words">{e.text}</span> : null}
                  </span>
                </li>
              );
            n += 1;
            const running = !e.outcome;
            const secs = (Date.parse(e.end ?? (live ? new Date().toISOString() : e.at)) - Date.parse(e.at)) / 1000;
            const tokens = (e.ran?.inputTokens ?? 0) + (e.ran?.outputTokens ?? 0);
            return (
              <li key={i} className="ring-hairline grid gap-2 rounded-xl p-3 ring-1 ring-inset">
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                  <span className="text-ink font-semibold">{t("workflows.pipeline.history.attempt", { n })}</span>
                  <span className={cx("rounded px-1.5 py-0.5 font-medium", running ? "bg-accent-wash text-accent-text" : OUTCOME_TONE[e.outcome!])}>
                    {running ? t("workflows.pipeline.history.running") : t(`workflows.pipeline.history.outcome.${e.outcome!}`)}
                  </span>
                  <span className="text-ink-2 tabular-nums">
                    {time(e.at)}
                    {e.end ? ` → ${time(e.end)}` : ""}
                    {secs > 0 ? ` · ${duration(secs)}` : ""}
                  </span>
                  {e.ran?.model ? <code className="text-ink-2 font-mono text-[11.5px]">{e.ran.model}</code> : null}
                  {tokens ? (
                    <span className="text-ink-2 tabular-nums">
                      {t("workflows.ran.tokens", { input: number(e.ran?.inputTokens ?? 0), output: number(e.ran?.outputTokens ?? 0) })}
                    </span>
                  ) : null}
                  {e.ran?.tools?.length ? (
                    <span className="text-ink-2">
                      {t("workflows.ran.tools", { list: e.ran.tools.map((x) => `${x.server} › ${x.tool}${x.outcome === "ok" ? "" : ` (${x.outcome})`}`).join(", ") })}
                    </span>
                  ) : null}
                </div>
                {e.text ? <p className="text-block m-0 text-[13px]">{e.text}</p> : null}
                {e.input ? (
                  <details className="group">
                    <summary className="text-ink-2 hover:text-ink cursor-pointer text-xs font-medium">{t("workflows.pipeline.history.input")}</summary>
                    <pre className={cx(pre, "mt-1.5")}>{e.input}</pre>
                  </details>
                ) : null}
                {e.output ? (
                  <details open={e.outcome !== "done"}>
                    <summary className="text-ink-2 hover:text-ink cursor-pointer text-xs font-medium">{t("workflows.pipeline.history.output")}</summary>
                    <pre className={cx(pre, "mt-1.5")}>{e.output}</pre>
                  </details>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : null}
      {step.log ? (
        <div className="grid gap-1.5">
          {entries.length ? <p className="text-ink-2 m-0 text-xs font-medium">{t("workflows.pipeline.history.runner")}</p> : null}
          <pre className={cx(pre, "max-h-none text-[12.5px]")}>{step.log}</pre>
        </div>
      ) : null}
    </div>
  );
}

/** The step's log as plain text, for Copy. */
export function stepLogText(step: RunStep, name: (id: string) => string): string {
  const lines = (step.history ?? []).map((e) =>
    e.kind === "attempt"
      ? [
          `# ${e.at} → ${e.end ?? "…"} ${e.outcome ?? "running"}${e.ran?.model ? ` · ${e.ran.model}` : ""}`,
          e.text,
          e.input && `## input\n${e.input}`,
          e.output && `## output\n${e.output}`,
        ]
          .filter(Boolean)
          .join("\n")
      : `# ${e.at} ${e.kind} · ${name(e.by ?? "")}${e.text ? `\n${e.text}` : ""}`,
  );
  return [...lines, step.log ?? ""].filter(Boolean).join("\n\n");
}
