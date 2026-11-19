"use client";

import { useEffect, useState } from "react";
import { useFormat, useT } from "@/lib/i18n/client";
import { useDirectory } from "@/lib/people";
import { btnGhost, btnSm, cx } from "@/lib/ui";
import { CheckIcon, ChevronDownIcon, CopyIcon, DownloadIcon } from "@/components/app/icons";
import { StepNode } from "../bits";
import { duration } from "../Graph";
import { StepLog, stepLogText } from "../StepLog";
import { ACTIVE, type RunStep } from "../types";
import type { TaskRun } from "./helpers";
import { StepActivityFeed, useStepActivity } from "./StepActivity";

/**
 * The whole run's log on one page: what it was given, then every
 * step in order with each time it ran, what it was given and what came back, what people and checks did, and what the
 * computer printed. Copy or download it as text. A step that never ran is one quiet line.
 */
export function RunLog({ run }: { run: TaskRun }) {
  const t = useT();
  const { dayLabel, time } = useFormat();
  const dir = useDirectory();
  const live = ACTIVE.includes(run.status);
  const text = runLogText(run, dir.name);
  const inputs = Object.entries(run.inputs ?? {});
  const labelOf = (key: string) => run.config?.inputs.find((f) => f.key === key)?.label ?? key;
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${run.workflowName.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "run"}-${run.createdAt.slice(0, 10)}.log.txt`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <section aria-labelledby="run-log-h" className="min-h-0 flex-1 overflow-auto">
      <div className="animate-rise grid gap-4 px-5 py-4 max-sm:px-4">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1">
            <h3 id="run-log-h" className="text-ink m-0 text-base font-semibold tracking-[-0.01em]">
              {t("workflows.log.title")}
            </h3>
            <p className="text-ink-2 m-0 mt-0.5 text-xs tabular-nums">
              {t("workflows.log.started", { name: dir.name(run.startedBy), when: `${dayLabel(run.createdAt)} ${time(run.createdAt)}` })}
              {run.finishedAt ? ` · ${t("workflows.log.ended", { when: time(run.finishedAt) })}` : ""}
            </p>
          </div>
          <CopyAll text={text} />
          <button type="button" className={cx(btnGhost, btnSm)} onClick={download}>
            <DownloadIcon />
            {t("workflows.log.download")}
          </button>
        </div>
        {run.error ? (
          <p className="bg-block-wash text-block m-0 whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm" role="alert">
            {run.error}
          </p>
        ) : null}
        {inputs.length ? (
          <dl className="ring-hairline m-0 grid min-w-0 gap-2 rounded-xl p-3 ring-1 ring-inset">
            <p className="text-ink-2 m-0 text-xs font-medium">{t("workflows.run.inputs")}</p>
            {inputs.map(([k, v]) => (
              <div key={k} className="grid min-w-0 gap-0.5">
                <dt className="text-ink-2 text-xs">{labelOf(k)}</dt>
                <dd className="text-ink m-0 whitespace-pre-wrap break-words text-[13px]">{v}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        <ol className="m-0 grid list-none gap-3 p-0">
          {run.steps.map((s, i) => (
            <StepBlock key={i} run={run} step={s} index={i} live={live && i === run.currentStep} />
          ))}
        </ol>
      </div>
    </section>
  );
}

function StepBlock({ run, step, index, live }: { run: TaskRun; step: RunStep; index: number; live: boolean }) {
  const t = useT();
  const { time } = useFormat();
  const ran = !!(step.history?.length || step.log || step.output || step.startedAt);
  // What ran (or is running) is open; steps that never ran are a line.
  const [open, setOpen] = useState(ran && (live || step.state !== "skipped"));
  useEffect(() => {
    if (live) setOpen(true);
  }, [live]);
  const secs = step.startedAt ? ((step.finishedAt ? Date.parse(step.finishedAt) : Date.now()) - Date.parse(step.startedAt) - (step.waitedMs ?? 0)) / 1000 : 0;
  return (
    <li className="ring-hairline min-w-0 rounded-xl ring-1 ring-inset">
      <button
        type="button"
        aria-expanded={open}
        disabled={!ran}
        onClick={() => setOpen((o) => !o)}
        className="hover:bg-hover flex w-full min-w-0 items-center gap-3 rounded-xl px-3 py-2.5 text-left disabled:cursor-default disabled:hover:bg-transparent"
      >
        <StepNode kind={step.kind} size="sm" />
        <span className="min-w-0 flex-1">
          <span className="text-ink-2 block text-[11px] font-medium tabular-nums">{t("workflows.pipeline.stepOf", { n: index + 1, count: run.steps.length })}</span>
          <span className="text-ink block truncate text-sm font-medium">{step.title}</span>
        </span>
        <span className="text-ink-2 shrink-0 text-xs tabular-nums max-sm:hidden">
          {step.startedAt ? time(step.startedAt) : ""}
          {secs > 1 ? ` · ${duration(secs)}` : ""}
        </span>
        <span className={cx("shrink-0 rounded-full px-2 py-0.5 text-xs font-medium", STATE_TONE[step.state])}>{t(`workflows.pipeline.state.${step.state}`)}</span>
        {ran ? <ChevronDownIcon className={cx("text-ink-2 size-4 shrink-0 transition-transform", open && "rotate-180")} /> : null}
      </button>
      {open ? <StepBody run={run} step={step} index={index} live={live} /> : null}
    </li>
  );
}

function StepBody({ run, step, index, live }: { run: TaskRun; step: RunStep; index: number; live: boolean }) {
  const t = useT();
  const activity = useStepActivity(run.id, index, live);
  return (
    <div className="border-divider grid min-w-0 gap-3 border-t px-3 pb-3 pt-3">
      {step.rework ? <p className="text-rose-text m-0 whitespace-pre-wrap break-words text-[13px]">{step.rework.note}</p> : null}
      {step.verdict && !step.verdict.pass && step.verdict.issues.length ? (
        <ul className="text-rose-text m-0 grid gap-0.5 pl-4 text-[13px]">
          {step.verdict.issues.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      ) : null}
      {activity.events.length ? (
        <div className="grid gap-2">
          <p className="text-ink-2 m-0 text-xs font-medium">{t("workflows.activity.title")}</p>
          <StepActivityFeed events={activity.events} earlier={activity.earlier} live={live} />
        </div>
      ) : null}
      <StepLog step={step} live={live} />
      {step.output && !(step.history ?? []).some((e) => e.output) ? (
        <details>
          <summary className="text-ink-2 hover:text-ink cursor-pointer text-xs font-medium">{t("workflows.pipeline.tab.output")}</summary>
          <pre className="text-ink-soft bg-ground ring-hairline m-0 mt-1.5 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg px-3 py-2 font-mono text-[12px]/5 ring-1 ring-inset">
            {step.output}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

const STATE_TONE: Record<RunStep["state"], string> = {
  pending: "bg-hover text-ink-soft",
  skipped: "bg-hover text-ink-2",
  running: "bg-accent-wash text-accent-text",
  waiting: "bg-warn-wash text-warn",
  done: "bg-ok-wash text-ok",
  failed: "bg-block-wash text-block",
};

function CopyAll({ text }: { text: string }) {
  const t = useT();
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const id = window.setTimeout(() => setDone(false), 1600);
    return () => window.clearTimeout(id);
  }, [done]);
  return (
    <button type="button" className={cx(btnGhost, btnSm)} onClick={() => void navigator.clipboard.writeText(text).then(() => setDone(true))}>
      {done ? <CheckIcon className="text-ok" /> : <CopyIcon />}
      {t("workflows.pipeline.copy")}
    </button>
  );
}

/** The whole run as plain text: for Copy and Download. */
export function runLogText(run: TaskRun, name: (id: string) => string): string {
  const head = [
    `${run.workflowName} · ${run.status}`,
    `started ${run.createdAt} by ${name(run.startedBy)}${run.finishedAt ? ` · ended ${run.finishedAt}` : ""}`,
    run.error ? `error: ${run.error}` : "",
    ...Object.entries(run.inputs ?? {}).map(([k, v]) => `input ${k}: ${v}`),
  ].filter(Boolean);
  const steps = run.steps.map((s, i) => {
    const body = stepLogText(s, name) || (s.output ? `## output\n${s.output}` : "");
    return [`=== ${i + 1}. ${s.title} (${s.kind}) · ${s.state}`, body].filter(Boolean).join("\n");
  });
  return [head.join("\n"), ...steps].join("\n\n");
}
