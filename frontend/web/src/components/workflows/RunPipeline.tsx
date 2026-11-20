"use client";

import * as m from "motion/react-m";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import { useFormat, useT } from "@/lib/i18n/client";
import { Markdown } from "@/lib/markdown";
import { useDirectory } from "@/lib/people";
import { btn, btnDanger, btnGhost, btnSm, cx } from "@/lib/ui";
import { useDialog } from "@/components/app/useDialog";
import { Portal } from "@/components/ui/Portal";
import { Picker } from "@/components/ui/Picker";
import { Ring } from "@/components/ui/Bento";
import { CheckIcon, ClockIcon, CloseIcon, CopyIcon, ListIcon, PlayIcon, RefreshIcon, StopIcon } from "@/components/app/icons";
import { AskHistory } from "./AskHistory";
import { ENV_ICON, EnvBadge, PauseMark, Quoted, RunStatusChip, StepNode } from "./bits";
import { duration, useKindLabel } from "./Graph";
import { ENV_STAGE, PipelineTrack } from "./PipelineTrack";
import { RunWaiting, useNow, workedFor } from "./RunSteps";
import { StepLog, stepLogText } from "./StepLog";
import { useApproverLabel } from "./run/approver";
import { CheckVerdict } from "./run/CheckVerdict";
import { checkedStep, failureKind, redone, type TaskRun } from "./run/helpers";
import { RunArtifacts } from "./run/RunArtifacts";
import { RunEnvironment } from "./run/RunEnvironment";
import { RunLog } from "./run/RunLog";
import { RunUsage } from "./run/RunUsage";
import { StepActivityFeed, activityText, useStepActivity } from "./run/StepActivity";
import { RunEta, useDuration } from "./run/eta";
import { ACTIVE, pausedAt, type RunStep } from "./types";

type Run = TaskRun;
// The run's timeline and its playback: read only when someone opens it.
const RunReplay = dynamic(() => import("./run/RunReplay"), { ssr: false });
/** The stage a run is at: the environment while its runner prepares it, else the current step. */
const stageOf = (r: Run) => (r.env && r.env.state !== "ready" && r.currentStep === 0 && r.steps[0]?.state === "pending" ? ENV_STAGE : Math.min(r.currentStep, r.steps.length - 1));

const span = (from?: string | null, to?: string | null) => (from ? duration(((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 1000) : "");

/**
 * A run as a pipeline: a head with how far the run is (a ring), the
 * stages as one track across the dialog (PipelineTrack), then the chosen stage: its result (Markdown), log and input,
 * with its facts (time, model, tokens, tools) in a side column. What waits for people is one line that opens the run's
 * conversation, where questions are answered and approvals made. Earlier runs are one pick away; a live run refreshes
 * every few seconds and follows the stage that is working.
 *
 * It also shows the harness at work: the environment a runner prepared as the first stage,
 * a check's verdict and the work it sent back, time and tokens against the run's limits, what a finished run delivered,
 * and a failed run's way back in ("Run again from this step").
 *
 * A stage at work shows what the agent is doing, a line per action as it happens (run/StepActivity.tsx);
 * the same lines stay in the stage's Log afterwards. "Timeline" swaps the stages' detail for the whole run as one
 * timeline that can be played back (run/RunReplay.tsx); a link to a moment opens it there (`run`, `replayAt`).
 */
export function RunPipeline({
  taskId,
  initial,
  step: startStep,
  run: startRun,
  replayAt,
  view,
  onClose,
  onChanged,
}: {
  taskId: string;
  initial: Run[];
  /** The stage to open on (picked on the task's inline graph); else the one at work. */
  step?: number | undefined;
  /** The run to open on, and a moment of it (its real time in ms) to show on the timeline: from a link. */
  run?: string | undefined;
  replayAt?: number | undefined;
  /** "log": open on the whole run's log (the "View log" buttons). */
  view?: "log" | undefined;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const t = useT();
  const { ago, dayLabel, time } = useFormat();
  const dir = useDirectory();
  const kind = useKindLabel();
  const ref = useDialog<HTMLDivElement>(onClose);
  const [runs, setRuns] = useState(initial);
  const [runId, setRunId] = useState((startRun && initial.find((r) => r.id === startRun)?.id) || (initial[0]?.id ?? ""));
  const [replay, setReplay] = useState(replayAt !== undefined);
  const [whole, setWhole] = useState(view === "log" && replayAt === undefined);
  const [jump, setJump] = useState<{ step: number; n: number } | undefined>(undefined);
  const run = runs.find((r) => r.id === runId) ?? runs[0];
  const [sel, setSel] = useState<number>(() => startStep ?? (run ? stageOf(run) : 0));
  const [tab, setTab] = useState<"output" | "log" | "input">("output");
  const [follow, setFollow] = useState(startStep === undefined);
  const [busy, setBusy] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [, tick] = useState(0);
  const logEnd = useRef<HTMLDivElement>(null);
  const active = !!run && ACTIVE.includes(run.status);

  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(async () => {
      tick((n) => n + 1);
      const r = await api<{ runs: Run[] }>(`work/tasks/${taskId}/runs`).catch(() => null);
      if (!r) return;
      setRuns(r.runs);
      const now = r.runs.find((x) => x.id === runId);
      if (now && follow) setSel(stageOf(now));
      if (now && !ACTIVE.includes(now.status)) onChanged?.();
    }, 2500);
    return () => window.clearInterval(id);
  }, [active, taskId, runId, follow, onChanged]);
  const shownLog = run?.steps[sel]?.log;
  useEffect(() => {
    logEnd.current?.scrollIntoView({ block: "end" });
  }, [shownLog, tab]);
  // What the agent does in the chosen stage; followed live while that stage is the one at work.
  const working = active && !!run && sel === run.currentStep && run.steps[sel]?.state === "running";
  const activity = useStepActivity(run?.id, sel, working);

  if (!run) return null;
  const step = sel === ENV_STAGE ? undefined : run.steps[sel];
  const onEnv = sel === ENV_STAGE && !!run.env;
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    await fn().catch(() => undefined);
    const r = await api<{ runs: Run[] }>(`work/tasks/${taskId}/runs`).catch(() => null);
    if (r) setRuns(r.runs);
    setBusy(false);
    onChanged?.();
  };
  const pick = (i: number) => {
    setSel(i);
    setWhole(false);
    setFollow(false);
    // On the timeline a stage is a place to go to.
    if (replay) setJump((j) => ({ step: i, n: (j?.n ?? 0) + 1 }));
    const s = i === ENV_STAGE ? undefined : run.steps[i];
    setTab(s?.output ? "output" : s?.log || s?.history?.length ? "log" : "input");
  };
  const doneCount = run.steps.filter((s) => s.state === "done").length;
  const attempts = step?.history?.filter((e) => e.kind === "attempt").length ?? 0;
  const hasTabs = step?.kind === "ai" || step?.kind === "command";
  const given = step?.input || step?.prompt || step?.command;
  // The input tab shows the whole message: the system prompt the server sent with it, then it.
  const body = !hasTabs
    ? undefined
    : tab === "output"
      ? step?.output
      : tab === "log"
        ? step && [activityText(activity.events), stepLogText(step, dir.name)].filter(Boolean).join("\n\n")
        : step?.ran?.system && given
          ? `SYSTEM\n${step.ran.system}\n\nUSER\n${given}`
          : given;
  // An approval is about the last result before it: shown under the step, as in the run's conversation.
  const fail = failureKind(run.error);
  const failedAt = run.status === "failed" ? run.steps[run.currentStep] : undefined;
  const judged = step?.kind === "check" ? checkedStep(run.steps, sel) : undefined;
  const runInputs = Object.entries(run.inputs ?? {});
  const labelOf = (key: string) => run.config?.inputs.find((f) => f.key === key)?.label ?? key;
  const inputsBlock = runInputs.length ? (
    <details className="group min-w-0">
      <summary className="text-ink-2 hover:text-ink cursor-pointer text-xs font-medium">{t("workflows.run.inputs")}</summary>
      <dl className="m-0 mt-2 grid min-w-0 gap-2">
        {runInputs.map(([k, v]) => (
          <div key={k} className="grid min-w-0 gap-0.5">
            <dt className="text-ink-2 text-xs">{labelOf(k)}</dt>
            <dd className="text-ink m-0 whitespace-pre-wrap break-words text-[13px]">{v}</dd>
          </div>
        ))}
      </dl>
    </details>
  ) : null;
  const reviewed =
    step?.kind === "approval"
      ? run.steps
          .slice(0, sel)
          .reverse()
          .find((x) => x.output)
      : undefined;

  return (
    <Portal>
      <m.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.15 }}
        className="fixed inset-0 z-[70] grid place-items-center bg-black/50 p-4 max-sm:p-0"
        onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      >
        <div
          ref={ref}
          role="dialog"
          aria-modal="true"
          aria-label={run.workflowName}
          className="bg-surface shadow-popover border-hairline flex h-[min(820px,92dvh)] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border max-sm:h-dvh max-sm:rounded-none"
        >
          {/* Header: the run, its state, who started it, how long; switch to an earlier run; pause, stop, close. */}
          <header className="border-hairline flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-5 py-3 max-sm:px-4">
            <Ring pct={(doneCount / Math.max(1, run.steps.length)) * 100} className="order-1 size-11 shrink-0">
              <span className="text-ink text-[11px] font-semibold tabular-nums" title={t("workflows.runs.progress", { done: doneCount, total: run.steps.length })}>
                {doneCount}/{run.steps.length}
              </span>
            </Ring>
            <div className="order-1 min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <h2 className="text-ink m-0 truncate text-[15px] font-semibold tracking-[-0.01em]">{run.workflowName}</h2>
                <RunStatusChip status={run.status} />
              </div>
              <p className="text-ink-2 m-0 mt-0.5 truncate text-xs tabular-nums">
                {dir.name(run.startedBy)} · {ago(run.createdAt)} · {span(run.createdAt, run.finishedAt)} ·{" "}
                {run.config ? t(`workflows.env.${run.config.environment.kind}`) : t(run.runner === "local" ? "workflows.runner.local" : "workflows.runner.server")}
                {run.claimedBy ? ` · ${run.claimedBy}` : ""}
              </p>
              {/* How much longer, and when to come back: for long jobs. */}
              <RunEta run={run} className="mt-0.5" />
            </div>
            {/* Time and tokens against the run's limits; under the title on phones. */}
            <RunUsage run={run} className="order-4 w-full sm:order-2 sm:w-auto sm:min-w-56 sm:flex-nowrap" />
            <div className="order-3 flex min-w-0 items-center gap-1.5 empty:hidden max-sm:w-full sm:order-2">
              <button
                type="button"
                className={cx(whole ? btn : btnGhost, btnSm)}
                aria-pressed={whole}
                onClick={() => {
                  setWhole((v) => !v);
                  setReplay(false);
                }}
                title={t("workflows.log.hint")}
              >
                <ListIcon />
                {t("workflows.log.button")}
              </button>
              <button
                type="button"
                className={cx(replay ? btn : btnGhost, btnSm)}
                aria-pressed={replay}
                onClick={() => {
                  setReplay((v) => !v);
                  setWhole(false);
                }}
                title={t("workflows.replay.hint")}
              >
                <ClockIcon />
                {t("workflows.replay.title")}
              </button>
              {runs.length > 1 ? (
                <Picker
                  variant="button"
                  label={t("workflows.pipeline.runs")}
                  value={run.id}
                  onChange={(v) => {
                    setRunId(v);
                    const r = runs.find((x) => x.id === v);
                    setSel(r ? Math.min(r.currentStep, r.steps.length - 1) : 0);
                    setFollow(true);
                  }}
                  options={runs.map((r, i) => ({
                    value: r.id,
                    label: `#${runs.length - i} · ${dayLabel(r.createdAt)} ${time(r.createdAt)} · ${t(`workflows.status.${r.status}`)}`,
                  }))}
                />
              ) : null}
              {run.status === "failed" && run.canRetry && failedAt ? (
                <button
                  type="button"
                  className={cx(btn, btnSm, "min-w-0")}
                  disabled={busy}
                  title={t("workflows.run.retry", { step: failedAt.title })}
                  onClick={() => void act(() => api(`work/runs/${run.id}/retry`, { method: "POST" }))}
                >
                  <RefreshIcon />
                  <span className="truncate">{t("workflows.run.retryShort")}</span>
                </button>
              ) : null}
              {active && run.canControl !== false && (run.status === "queued" || run.status === "running" || run.status === "paused") ? (
                <button
                  type="button"
                  className={cx(btn, btnSm)}
                  disabled={busy}
                  onClick={() => void act(() => api(`work/runs/${run.id}/${run.status === "paused" ? "resume" : "pause"}`, { method: "POST" }))}
                >
                  {run.status === "paused" ? <PlayIcon /> : <PauseMark className="h-3" />}
                  {t(run.status === "paused" ? "workflows.agent.resume" : "workflows.agent.pause")}
                </button>
              ) : null}
              {active && run.canControl !== false ? (
                confirmStop ? (
                  <span className="flex items-center gap-1.5" role="alertdialog" aria-label={t("workflows.agent.stopConfirm")}>
                    <button
                      type="button"
                      className={cx(btnDanger, btnSm)}
                      disabled={busy}
                      title={t("workflows.agent.stopConfirm")}
                      onClick={() =>
                        void act(async () => {
                          await api(`work/runs/${run.id}/cancel`, { method: "POST" });
                          setConfirmStop(false);
                        })
                      }
                    >
                      {t("workflows.agent.stopYes")}
                    </button>
                    <button type="button" className={cx(btnGhost, btnSm)} onClick={() => setConfirmStop(false)} autoFocus>
                      {t("workflows.agent.keep")}
                    </button>
                  </span>
                ) : (
                  <button type="button" className={cx(btnGhost, btnSm)} disabled={busy} onClick={() => setConfirmStop(true)}>
                    <StopIcon />
                    {t("workflows.agent.stop")}
                  </button>
                )
              ) : null}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label={t("common.close")}
              className="text-ink-2 hover:bg-hover hover:text-ink order-2 grid size-8 shrink-0 place-items-center self-start rounded-md sm:order-3 sm:self-center"
            >
              <CloseIcon />
            </button>
          </header>

          {/* The stages as one track: where the run is, and the way to pick a stage. */}
          <div className="border-hairline bg-ground/60 border-b">
            <PipelineTrack
              run={run}
              selected={sel}
              onPick={pick}
              label={t("workflows.pipeline.steps")}
              pausedAt={pausedAt(run)}
              env={run.env}
              envKind={run.config?.environment.kind}
            />
          </div>
          {/* What a finished run handed over. */}
          <RunArtifacts run={run} className="border-hairline border-b px-5 py-2 max-sm:px-4" />

          {replay ? <RunReplay key={run.id} run={run} at={run.id === startRun || !startRun ? replayAt : undefined} jump={jump} onStep={setSel} /> : null}

          {whole && !replay ? <RunLog key={run.id} run={run} /> : null}

          {onEnv && !replay && !whole ? (
            <section aria-labelledby="pipe-env-h" className="min-h-0 flex-1 overflow-auto">
              <div className="animate-rise grid gap-4 px-5 py-4 max-sm:px-4">
                <div className="flex min-w-0 items-center gap-3">
                  <span
                    aria-hidden="true"
                    className="bg-sky-wash text-sky-text ring-current/15 grid size-10 shrink-0 place-items-center rounded-full ring-1 ring-inset [&_svg]:size-[18px]"
                  >
                    {ENV_ICON[run.config?.environment.kind ?? "sandbox"]}
                  </span>
                  <div className="grid min-w-0 flex-1 justify-items-start gap-1">
                    <h3 id="pipe-env-h" className="text-ink m-0 text-base font-semibold tracking-[-0.01em]">
                      {t("workflows.run.env.stage")}
                    </h3>
                    {run.config ? <EnvBadge env={run.config.environment} /> : null}
                  </div>
                </div>
                <RunEnvironment env={run.env!} asked={run.config?.environment} device={run.claimedBy} />
                {inputsBlock}
              </div>
            </section>
          ) : null}

          {/* The chosen stage: what it produced, what it printed, what it was given; its facts in a side column. */}
          {step && !replay && !whole ? (
            <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(0,1fr)_15.5rem]">
              <section aria-labelledby="pipe-step-h" className="flex min-h-0 min-w-0 flex-col">
                <div className="grid gap-3 px-5 pb-3 pt-4 max-sm:px-4">
                  <div className="flex min-w-0 items-center gap-3">
                    <StepNode kind={step.kind} size="lg" />
                    <div className="min-w-0 flex-1">
                      <p className="text-ink-2 m-0 truncate text-xs font-medium tabular-nums">
                        {t("workflows.pipeline.stepOf", { n: sel + 1, count: run.steps.length })} · {kind(step, run.runner)}
                      </p>
                      <h3 id="pipe-step-h" className="text-ink m-0 mt-0.5 truncate text-base font-semibold tracking-[-0.01em]">
                        {step.title}
                      </h3>
                    </div>
                    <StepStatePill step={step} className="md:hidden" />
                  </div>
                  <div className={cx("flex items-center gap-2", !hasTabs && "hidden")}>
                    <div role="tablist" aria-label={step.title} className="bg-hover flex gap-0.5 rounded-lg p-0.5">
                      {(["output", "log", "input"] as const).map((k) => (
                        <button
                          key={k}
                          type="button"
                          role="tab"
                          aria-selected={tab === k}
                          onClick={() => setTab(k)}
                          className={cx("h-7 rounded-md px-2.5 text-xs font-medium", tab === k ? "bg-surface text-ink shadow-raised" : "text-ink-2 hover:text-ink")}
                        >
                          {t(`workflows.pipeline.tab.${k}`)}
                          {k === "log" && attempts > 1 ? <span className="text-ink-2 ml-1 tabular-nums">{attempts}</span> : null}
                        </button>
                      ))}
                    </div>
                    {body ? <CopyButton text={body} /> : null}
                  </div>
                </div>
                <div className="min-h-0 flex-1 overflow-auto">
                  <div key={`${run.id}:${sel}`} className="animate-rise grid gap-4 px-5 pb-5 pt-1 max-sm:px-4">
                    {/* What waits for people at this step: one line to the run's conversation. */}
                    {sel === run.currentStep ? <RunWaiting run={run} /> : null}
                    {run.error && sel === run.currentStep ? (
                      // A limit or a check stopping the run is the harness working, said as that; anything else is the error as it came.
                      <div className={cx("grid gap-1 rounded-lg px-3 py-2 text-sm", fail ? "bg-warn-wash text-warn" : "bg-block-wash text-block")} role="alert">
                        {fail ? <p className="m-0 font-medium">{t(`workflows.run.fail.${fail}`)}</p> : null}
                        <p className={cx("m-0", fail && "text-ink-soft text-[13px]")}>{run.error}</p>
                        {fail === "time" || fail === "tokens" ? <p className="text-ink-2 m-0 text-xs">{t(`workflows.run.fail.${fail}Hint`)}</p> : null}
                      </div>
                    ) : null}
                    {/* This step's result was sent back: by which check (or person), and what to change. */}
                    {step.rework ? (
                      <div className="bg-rose-wash/40 ring-rose-text/15 grid min-w-0 gap-1 rounded-lg px-3 py-2 ring-1 ring-inset">
                        <p className="text-rose-text m-0 text-xs font-medium">
                          {step.rework.by && step.rework.by !== "check"
                            ? t("workflows.run.check.redoneByPerson", { name: dir.name(step.rework.by) })
                            : step.rework.check
                              ? t("workflows.run.check.redoneBy", { check: step.rework.check })
                              : t("workflows.run.history.sentBackPlain")}
                          {redone(step) > 1 ? (
                            <span className="text-ink-2 ml-1.5 font-normal tabular-nums">· {t("workflows.run.check.redone", { count: redone(step) })}</span>
                          ) : null}
                        </p>
                        <p className="text-ink m-0 whitespace-pre-wrap break-words text-[13px]/5">{step.rework.note}</p>
                      </div>
                    ) : null}
                    {step.retried ? <p className="text-warn m-0 text-xs">{t("workflows.run.check.retried", { count: step.retried })}</p> : null}
                    {step.kind === "check" ? (
                      <>
                        <CheckVerdict step={step} from={judged?.title} />
                        {step.history?.length || step.log ? (
                          <details className="group">
                            <summary className="text-ink-2 hover:text-ink cursor-pointer text-xs font-medium">{t("workflows.pipeline.tab.log")}</summary>
                            <div className="mt-2 grid gap-3">
                              <StepActivityFeed events={activity.events} earlier={activity.earlier} live={working} />
                              <StepLog step={step} live={active && sel === run.currentStep} />
                            </div>
                          </details>
                        ) : null}
                      </>
                    ) : null}
                    {/* The step's closed rounds of questions, with their answers. */}
                    {run.asks?.some((a) => a.stepIndex === sel && a.closedAt) ? (
                      <div className="grid gap-2">
                        <p className="text-ink-2 m-0 text-xs font-medium">{t("workflows.pipeline.asked")}</p>
                        <AskHistory rounds={run.asks.filter((a) => a.stepIndex === sel && a.closedAt)} />
                      </div>
                    ) : null}
                    {reviewed?.output ? (
                      <div className="grid gap-2">
                        <p className="text-ink-2 m-0 text-xs font-medium">
                          <Quoted text={t("workflows.pipeline.reviewed", { step: reviewed.title })} />
                        </p>
                        <div className="text-ink ring-hairline min-w-0 max-w-3xl rounded-xl px-4 py-1 text-sm/6 ring-1 ring-inset">
                          <Markdown source={reviewed.output} copyCode={{ label: t("aiw.chat.copyCode"), done: t("aiw.chat.copiedCode") }} />
                        </div>
                      </div>
                    ) : null}
                    {tab === "log" && hasTabs ? (
                      <>
                        {activity.events.length ? (
                          <div className="grid gap-2">
                            <p className="text-ink-2 m-0 text-xs font-medium">{t("workflows.activity.title")}</p>
                            <StepActivityFeed events={activity.events} earlier={activity.earlier} live={working} />
                          </div>
                        ) : null}
                        <StepLog step={step} live={active && sel === run.currentStep} />
                        <div ref={logEnd} />
                      </>
                    ) : tab === "output" && working && hasTabs && activity.events.some((e) => e.kind !== "start") ? (
                      // At work: what the agent is doing right now takes the result's place until there is one.
                      <StepActivityFeed events={activity.events} earlier={activity.earlier} live className="max-w-3xl" />
                    ) : body ? (
                      tab === "output" ? (
                        <div className="text-ink min-w-0 max-w-3xl text-sm/6">
                          <Markdown source={body} copyCode={{ label: t("aiw.chat.copyCode"), done: t("aiw.chat.copiedCode") }} />
                        </div>
                      ) : (
                        <pre className="text-ink-soft bg-ground ring-hairline m-0 whitespace-pre-wrap break-words rounded-xl px-4 py-3 font-mono text-[12.5px]/5 ring-1 ring-inset">
                          {body}
                          <div ref={logEnd} />
                        </pre>
                      )
                    ) : step.state === "running" ? (
                      <Working label={t("workflows.pipeline.working")} given={hasTabs ? given : undefined} givenLabel={t("workflows.pipeline.tab.input")} />
                    ) : (step.state === "waiting" && sel === run.currentStep) || !hasTabs ? null : (
                      <p className="text-ink-2 m-0 text-sm">{t(`workflows.pipeline.empty.${tab}`)}</p>
                    )}
                    {/* Phones have no side column: the stage's facts close the page. */}
                    <div className="border-divider grid gap-4 border-t pt-4 md:hidden">
                      <Facts step={step} usual={run.estimate?.steps?.[step.key]} />
                      {inputsBlock}
                    </div>
                  </div>
                </div>
              </section>
              <aside
                aria-label={t("workflows.pipeline.facts.title")}
                className="border-hairline bg-ground/40 grid min-h-0 content-start gap-4 overflow-y-auto border-l px-4 py-4 max-md:hidden"
              >
                <Facts step={step} usual={run.estimate?.steps?.[step.key]} />
                {inputsBlock ? <div className="border-divider border-t pt-3">{inputsBlock}</div> : null}
              </aside>
            </div>
          ) : null}
        </div>
      </m.div>
    </Portal>
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

function StepStatePill({ step, className }: { step: Pick<RunStep, "kind" | "state">; className?: string }) {
  const t = useT();
  return (
    <span className={cx("inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 text-xs font-medium", STATE_TONE[step.state], className)}>
      {step.state === "running" ? <span className="size-1.5 rounded-full bg-current motion-safe:animate-pulse" aria-hidden="true" /> : null}
      {step.state === "waiting" && step.kind === "ai" ? t("workflows.status.waiting_input") : t(`workflows.pipeline.state.${step.state}`)}
    </span>
  );
}

/** Copy, which says so for a moment. */
function CopyButton({ text }: { text: string }) {
  const t = useT();
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const id = window.setTimeout(() => setDone(false), 1600);
    return () => window.clearTimeout(id);
  }, [done]);
  return (
    <button type="button" className={cx(btnGhost, btnSm, "ml-auto")} onClick={() => void navigator.clipboard.writeText(text).then(() => setDone(true))}>
      {done ? <CheckIcon className="text-ok" /> : <CopyIcon />}
      {t("workflows.pipeline.copy")}
    </button>
  );
}

/** A stage at work with nothing to show yet: the result's place, sweeping, so the page reads as alive rather than empty. */
function Working({ label, given, givenLabel }: { label: string; given?: string | undefined; givenLabel: string }) {
  return (
    <div role="status" className="grid max-w-3xl gap-4">
      <p className="text-accent-text m-0 flex items-center gap-2 text-sm font-medium">
        <span className="relative grid size-2.5 place-items-center" aria-hidden="true">
          <span className="bg-accent/40 absolute inset-0 rounded-full motion-safe:animate-ping" />
          <span className="bg-accent relative size-2 rounded-full" />
        </span>
        {label}
      </p>
      <div aria-hidden="true" className="grid gap-2.5">
        <span className="shimmer h-3 w-11/12 rounded-full" />
        <span className="shimmer h-3 w-4/5 rounded-full" />
        <span className="shimmer h-3 w-3/5 rounded-full" />
        <span className="shimmer mt-2 h-3 w-10/12 rounded-full" />
        <span className="shimmer h-3 w-2/5 rounded-full" />
      </div>
      {/* What it is working from, so the wait has something to read. */}
      {given ? (
        <div className="mt-2 grid gap-1.5">
          <p className="text-ink-2 m-0 text-xs font-medium">{givenLabel}</p>
          <pre
            className={cx(
              "text-ink-soft bg-ground ring-hairline m-0 max-h-44 overflow-hidden whitespace-pre-wrap break-words rounded-xl px-4 py-3 font-mono text-[12.5px]/5 ring-1 ring-inset",
              // A long instruction fades out at the foot; the Input tab has all of it.
              given.length > 400 && "[mask-image:linear-gradient(to_bottom,black_60%,transparent)]",
            )}
          >
            {given}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A stage's facts, properties-style: its state, when it ran and for how long (less the waits for people), and for an
 * AI stage the model that answered, its tokens (asked against answered) and the tools it called.
 */
function Facts({ step, usual }: { step: RunStep; usual?: number | undefined }) {
  const t = useT();
  const words = useDuration();
  const f = useFormat();
  const now = useNow(step.state === "running");
  const worked = workedFor(step, now);
  const ran = step.kind === "ai" ? step.ran : undefined;
  const input = ran?.inputTokens ?? 0;
  const output = ran?.outputTokens ?? 0;
  const approver = useApproverLabel();
  const dt = "text-ink-2 text-xs";
  const dd = "text-ink m-0 min-w-0 text-[13px] tabular-nums";
  return (
    <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-3.5 md:grid-cols-1">
      <div className="grid justify-items-start gap-1 max-md:hidden">
        <dt className={dt}>{t("workflows.pipeline.facts.state")}</dt>
        <dd className="m-0">
          <StepStatePill step={step} />
        </dd>
      </div>
      {step.startedAt ? (
        <div className="grid gap-0.5">
          <dt className={dt}>{t("workflows.pipeline.facts.started")}</dt>
          <dd className={dd}>
            {f.shortDate(step.startedAt)} · {f.time(step.startedAt)}
          </dd>
        </div>
      ) : null}
      {step.finishedAt ? (
        <div className="grid gap-0.5">
          <dt className={dt}>{t("workflows.pipeline.facts.finished")}</dt>
          <dd className={dd}>
            {f.shortDate(step.finishedAt)} · {f.time(step.finishedAt)}
          </dd>
        </div>
      ) : null}
      {worked ? (
        <div className="grid gap-0.5">
          <dt className={dt}>{t(step.kind === "approval" ? "workflows.pipeline.facts.waited" : "workflows.pipeline.facts.took")}</dt>
          <dd className={cx(dd, "font-display text-lg/6 font-semibold tracking-[-0.02em]")}>{worked}</dd>
        </div>
      ) : null}
      {step.waitedMs ? (
        <div className="grid gap-0.5">
          <dt className={dt}>{t("workflows.pipeline.facts.waited")}</dt>
          <dd className={dd}>{duration(step.waitedMs / 1000)}</dd>
        </div>
      ) : null}
      {usual && usual > 0 ? (
        <div className="grid gap-0.5">
          <dt className={dt}>{t("workflows.run.eta.stepUsually")}</dt>
          <dd className={dd}>{t("workflows.run.eta.about", { d: words(usual) })}</dd>
        </div>
      ) : null}
      {step.kind === "approval" ? (
        <div className="col-span-full grid gap-0.5">
          <dt className={dt}>{t("workflows.run.approver.label")}</dt>
          <dd className={cx(dd, "break-words")}>{approver(step)}</dd>
        </div>
      ) : null}
      {ran?.model ? (
        <div className="col-span-full grid gap-0.5">
          <dt className={dt}>{t("workflows.bp.model")}</dt>
          <dd className="m-0 min-w-0">
            <code className="bg-violet-wash text-violet-text inline-block max-w-full truncate rounded-sm px-1.5 py-0.5 align-top font-mono text-xs" title={ran.model}>
              {ran.model}
            </code>
          </dd>
        </div>
      ) : null}
      {input + output ? (
        <div className="col-span-full grid gap-1">
          <dt className={dt}>{t("workflows.pipeline.facts.tokens")}</dt>
          <dd className={dd}>
            <span className="font-display text-lg/6 font-semibold tracking-[-0.02em]">{f.number(input + output)}</span>
            {/* Asked against answered, as one bar. */}
            <span aria-hidden="true" className="bg-progress-track mt-1.5 flex h-1.5 gap-0.5 overflow-hidden rounded-full">
              <span className="bg-sky rounded-full" style={{ width: `${(input / (input + output)) * 100}%` }} />
              <span className="bg-violet flex-1 rounded-full" />
            </span>
            <span className="text-ink-2 mt-1 block text-xs">{t("workflows.ran.tokens", { input: f.number(input), output: f.number(output) })}</span>
          </dd>
        </div>
      ) : null}
      {ran?.tools?.length ? (
        <div className="col-span-full grid gap-1">
          <dt className={dt}>{t("workflows.pipeline.facts.tools")}</dt>
          <dd className="m-0 flex min-w-0 flex-wrap gap-1">
            {ran.tools.map((x, i) => (
              <span
                key={i}
                className={cx("inline-flex h-6 max-w-full items-center rounded-md px-1.5 text-xs", x.outcome === "ok" ? "bg-hover text-ink-soft" : "bg-block-wash text-block")}
                title={`${x.server} › ${x.tool}${x.outcome === "ok" ? "" : ` (${x.outcome})`}`}
              >
                <span className="truncate">
                  {x.server} › {x.tool}
                </span>
              </span>
            ))}
          </dd>
        </div>
      ) : null}
    </dl>
  );
}
