"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { btn, btnPrimary, btnSm, cx } from "@/lib/ui";
import { ApprovalIcon, BotIcon, CheckIcon } from "@/components/app/icons";
import { Quoted } from "./bits";
import { duration, useKindLabel } from "./Graph";
import { useApproverWait } from "./run/approver";
import { redone, type TaskRun } from "./run/helpers";
import { useDoingLine } from "./run/doing";
import type { Run, RunStep } from "./types";

type Timed = Pick<RunStep, "startedAt" | "finishedAt" | "waitedMs" | "waitingSince">;
/**
 * How long a step has worked: its time less the waits for people's answers, so a step waiting on
 * questions does not count up. `now` is null on the server and the first paint: a step still going shows its time only
 * once mounted, so the server's HTML and the browser's agree (React #418).
 */
export const workedFor = (s: Timed, now: number | null) => {
  if (!s.startedAt || s.waitingSince) return "";
  if (!s.finishedAt && now === null) return "";
  const end = s.finishedAt ? Date.parse(s.finishedAt) : now!;
  return duration(Math.max(0, end - Date.parse(s.startedAt) - (s.waitedMs ?? 0)) / 1000);
};

/** The time, ticking every few seconds while a step is going; null until mounted. */
export function useNow(live: boolean) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    if (!live) return;
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, [live]);
  return now;
}

/** A step's state as a round mark on the timeline: its number while pending, a tick, a cross, a pulse, a pause. */
export function StateMark({ state, n }: { state: RunStep["state"]; n: number }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        "relative z-[1] grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold tabular-nums",
        state === "done" && "bg-ok-fill text-on-brand",
        state === "failed" && "bg-block text-on-brand",
        state === "running" && "bg-surface ring-accent ring-[1.5px]",
        state === "waiting" && "bg-warn-wash text-warn ring-warn/60 ring-[1.5px]",
        (state === "pending" || state === "skipped") && "bg-surface text-ink-2 ring-edge ring-1",
      )}
    >
      {state === "done" ? (
        <CheckIcon className="size-3" />
      ) : state === "failed" ? (
        "✕"
      ) : state === "running" ? (
        <span className="bg-accent size-2 rounded-full motion-safe:animate-pulse" />
      ) : state === "waiting" ? (
        <span className="bg-warn-fill size-2 rounded-full" />
      ) : (
        n
      )}
    </span>
  );
}

/**
 * A run's steps as a vertical timeline: state mark on a thin rail, title, what kind of step, and how
 * long it took or has been going. The step at work reads strongest; a picked one sits on the hover wash. One list
 * for the task's side card (`sm`) and the pipeline's left column (`md`).
 */
export function RunSteps({
  run,
  selected,
  onPick,
  size = "md",
  label,
}: {
  run: Pick<Run, "status" | "currentStep" | "runner" | "doing"> & {
    steps: (Pick<RunStep, "title" | "kind" | "status" | "state" | "startedAt" | "finishedAt" | "waitedMs" | "waitingSince"> & Pick<Partial<RunStep>, "history" | "verdict">)[];
  };
  selected?: number | undefined;
  onPick?: (i: number) => void;
  size?: "sm" | "md";
  label: string;
}) {
  const t = useT();
  const kind = useKindLabel();
  const now = useNow(run.steps.some((s) => s.state === "running"));
  const doing = useDoingLine();
  const stateText = (s: Pick<RunStep, "kind" | "state">) =>
    s.state === "waiting" && s.kind === "ai" ? t("workflows.status.waiting_input") : t(`workflows.pipeline.state.${s.state}`);
  return (
    <ol aria-label={label} className="m-0 grid list-none p-0">
      {run.steps.map((s, i) => {
        const current = (s.state === "running" || s.state === "waiting") && i === run.currentStep;
        const body = (
          <>
            <StateMark state={s.state} n={i + 1} />
            <span className="grid min-w-0 gap-0.5">
              <span
                className={cx(
                  "min-w-0 truncate text-[13px]/5",
                  current ? "text-ink font-semibold" : s.state === "pending" || s.state === "skipped" ? "text-ink-2" : "text-ink font-medium",
                )}
              >
                {s.title}
              </span>
              <span className={cx("min-w-0 truncate text-xs/4", current ? (s.state === "waiting" ? "text-warn" : "text-accent-text") : "text-ink-2")}>
                {/* The step at work says what it is doing right now, when its agent tells. */}
                {s.state === "running" && current && run.doing?.step === i
                  ? doing(run.doing) || stateText(s)
                  : current || s.state === "failed"
                    ? stateText(s)
                    : s.kind === "check" && s.verdict
                      ? t(s.verdict.pass ? "workflows.run.check.passed" : "workflows.run.check.failed")
                      : kind(s, run.runner)}
                {/* A step a check or an approver sent back: how many times it was redone. */}
                {redone(s) ? (
                  <span className="text-rose-text ml-1.5 tabular-nums" title={t("workflows.run.check.redone", { count: redone(s) })}>
                    ↺ {redone(s)}
                  </span>
                ) : null}
              </span>
            </span>
            <span className="text-ink-2 self-start pt-0.5 text-xs tabular-nums">{workedFor(s, now)}</span>
            <span className="sr-only">{stateText(s)}</span>
          </>
        );
        const cls = cx(
          "relative grid w-full min-w-0 grid-cols-[20px_minmax(0,1fr)_auto] items-start gap-x-2.5 rounded-md text-left",
          size === "sm" ? "px-1.5 py-1.5" : "px-2 py-2",
          onPick && "hover:bg-hover transition-colors",
          selected === i && "bg-hover",
        );
        return (
          <li key={i} className="relative">
            {/* The rail between marks; green once the step above is done. */}
            {i < run.steps.length - 1 ? (
              <span
                aria-hidden="true"
                className={cx(
                  "absolute w-px",
                  size === "sm" ? "bottom-[-6px] left-[15.5px] top-[26px]" : "bottom-[-8px] left-[17.5px] top-[28px]",
                  s.state === "done" ? "bg-ok-fill/50" : "bg-hairline",
                )}
              />
            ) : null}
            {onPick ? (
              <button type="button" className={cls} aria-current={selected === i ? "step" : undefined} onClick={() => onPick(i)}>
                {body}
              </button>
            ) : (
              <div className={cls}>{body}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * What a waiting run needs from people, as one line with the way to give it: questions are answered and approvals
 * made in the run's conversation (/app/chat/ask/<run>), the same place the sidebar's "Waiting for you" opens.
 */
export function RunWaiting({
  run,
  compact,
  className,
}: {
  run: Pick<TaskRun, "id" | "status" | "steps" | "currentStep" | "asks" | "canApprove" | "startedBy">;
  /** A narrow column (the task's side card): text over a full-width button, no mark. */
  compact?: boolean;
  className?: string;
}) {
  const t = useT();
  const waitsFor = useApproverWait();
  if (run.status !== "waiting_input" && run.status !== "waiting_approval") return null;
  const ask = run.status === "waiting_input" ? run.asks?.find((a) => !a.closedAt) : undefined;
  const step = run.steps[ask?.stepIndex ?? run.currentStep]?.title ?? "";
  const approval = run.status === "waiting_approval";
  // An approval that is someone else's to give: who it waits for, and the conversation only to read.
  const others = approval && run.canApprove === false;
  return (
    <div
      className={cx(
        "bg-warn-wash/50 ring-warn/20 min-w-0 rounded-lg px-3 py-2.5 ring-1 ring-inset",
        compact ? "grid gap-2" : "flex flex-wrap items-center gap-x-3 gap-y-2",
        className,
      )}
    >
      {compact ? null : (
        <span aria-hidden="true" className="bg-surface text-warn ring-warn/25 grid size-7 shrink-0 place-items-center rounded-full ring-1 ring-inset [&_svg]:size-3.5">
          {approval ? <ApprovalIcon /> : <BotIcon />}
        </span>
      )}
      <span className={cx("grid min-w-0 gap-0.5", !compact && "flex-1 basis-40")}>
        <span className="text-ink text-[13px]/5 font-medium">
          <Quoted text={approval ? t("workflows.pipeline.approvalWaiting", { step }) : t("workflows.pipeline.askWaiting", { count: ask?.questions.length ?? 1, step })} />
        </span>
        <span className="text-ink-2 text-xs">
          {others ? waitsFor(run.steps[run.currentStep], run.startedBy) : t(approval ? "workflows.pipeline.approvalHint" : "workflows.pipeline.askHint")}
        </span>
      </span>
      <Link href={`/app/chat/ask/${run.id}`} className={cx(others ? btn : btnPrimary, btnSm, "shrink-0 no-underline", compact && "w-full")}>
        {t(others ? "workflows.ask.open" : approval ? "workflows.pipeline.review" : "workflows.pipeline.answer")}
      </Link>
    </div>
  );
}
