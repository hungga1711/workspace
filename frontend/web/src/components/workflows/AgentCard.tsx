"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import { useFormat, useT } from "@/lib/i18n/client";
import { useDirectory } from "@/lib/people";
import { btn, btnDanger, btnGhost, btnPrimary, btnSm, cx } from "@/lib/ui";
import { Picker } from "@/components/ui/Picker";
import { useToast } from "@/components/ui/Toast";
import { ListIcon, PlayIcon, RefreshIcon, StopIcon, WorkflowIcon } from "@/components/app/icons";
import { CATEGORY, EnvBadge, PauseMark, RunStatusChip, RunnerBadge } from "./bits";
import { RunSteps, RunWaiting } from "./RunSteps";
import { CheckVerdict } from "./run/CheckVerdict";
import { checkedStep, failureKind, type TaskRun } from "./run/helpers";
import { RunArtifacts } from "./run/RunArtifacts";
import { RunnerLine, useEnvFacts } from "./run/RunEnvironment";
import { RunUsage } from "./run/RunUsage";
import { RunEta, UsualTime, useWorkflowEstimate } from "./run/eta";
import { ACTIVE, type RunnerInfo, type Workflow } from "./types";

type Run = TaskRun;

// The run dialog (a workflow that asks for inputs) and the pipeline view load when someone opens them.
const RunDialog = dynamic(() => import("./run/RunDialog").then((m) => m.RunDialog), { ssr: false });
const RunPipeline = dynamic(() => import("./RunPipeline").then((m) => m.RunPipeline), { ssr: false });

/**
 * A task's agent: which workflow it is handed to, a Run button, and the latest run as a step timeline (what waits
 * for people links to the run's conversation; the pipeline opens on a step). A local workflow runs on the assignee's computer, so only they can start it; a running run is
 * polled every few seconds and the page refreshes when it ends (the result lands as a comment).
 *
 * Start opens a short form when the workflow asks for inputs; the card says where the run goes (the
 * company's AI, a sandbox, a computer, and which runner is online to take it), shows a failed check's issues, what the
 * run spent against its limits and what it delivered, and lets a failed run go again from the step that failed.
 */
export function AgentCard({
  taskId,
  workflowId: initialWorkflow,
  assigneeId,
  canEdit,
  onFinished,
}: {
  taskId: string;
  workflowId: string | null;
  assigneeId: string | null;
  canEdit: boolean;
  onFinished?: () => void;
}) {
  const t = useT();
  const { ago } = useFormat();
  const dir = useDirectory();
  const toast = useToast();
  const [workflows, setWorkflows] = useState<Workflow[] | null>(null);
  const [workflowId, setWorkflowId] = useState(initialWorkflow);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [pipelineStep, setPipelineStep] = useState<number | undefined>(undefined);
  // A link to a moment of a run (the timeline's "Copy link"): the pipeline opens on it once the runs are read.
  const [linked, setLinked] = useState<{ run: string; at: number } | undefined>(undefined);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const at = Number(q.get("at"));
    if (q.get("run") && Number.isFinite(at) && at > 0) {
      setLinked({ run: q.get("run")!, at });
      setPipeline(true);
    }
  }, []);
  const [confirmStop, setConfirmStop] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [pipeline, setPipeline] = useState(false);
  const [logView, setLogView] = useState(false);
  const [runners, setRunners] = useState<RunnerInfo[] | undefined>(undefined);
  const [dialog, setDialog] = useState(false);
  const envFacts = useEnvFacts();
  // The latest run's status as last seen, so the page re-reads the task only when it changes.
  const seen = useRef<Run["status"] | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const [w, r] = await Promise.all([api<{ workflows: Workflow[]; runners?: RunnerInfo[] }>("work/workflows"), api<{ runs: Run[] }>(`work/tasks/${taskId}/runs`)]);
      setWorkflows(w.workflows);
      setRunners(w.runners);
      setRuns(r.runs);
      seen.current = r.runs[0]?.status;
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [taskId]);
  useEffect(() => void load(), [load]);

  const last = runs?.[0] ?? null;
  const active = !!last && ACTIVE.includes(last.status);
  // Poll while something is happening; when it ends, or starts asking, the task (status, the result comment, the
  // questions card at its top) is re-read. Waiting for answers is slow by nature: a slower poll then.
  const asking = last?.status === "waiting_input";
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(
      async () => {
        if (document.visibilityState !== "visible") return;
        const r = await api<{ runs: Run[] }>(`work/tasks/${taskId}/runs`).catch(() => null);
        if (!r) return;
        setRuns(r.runs);
        const now = r.runs[0]?.status;
        if (now && now !== seen.current && (!ACTIVE.includes(now) || now === "waiting_input")) onFinished?.();
        seen.current = now;
      },
      asking ? 8000 : 2500,
    );
    return () => window.clearInterval(id);
  }, [active, asking, taskId, onFinished]);

  const wf = workflows?.find((w) => w.id === workflowId) ?? null;
  // How long it usually takes, shown under Start while nothing runs (read once per workflow; a quiet miss).
  const usual = useWorkflowEstimate(wf?.id, !!wf && !active && wf.config?.estimate !== false);
  // Only a run in the assignee's own code folder is theirs alone to start (the server's rule, startRun): a sandbox
  // works on the computer of whoever starts it, or on the company's.
  const env = wf?.config?.environment;
  const mustBeAssignee = wf?.runner === "local" && (env ? env.kind === "computer" : true) && assigneeId !== dir.me;
  const start = (inputs?: Record<string, string>) => api(`work/tasks/${taskId}/runs`, { method: "POST", body: inputs ? { inputs } : {} });
  const failedStep = last?.status === "failed" ? last.steps[last.currentStep] : undefined;
  const fail = failureKind(last?.error);
  // The check that last failed and has not passed since: its issues are why the run is where it is.
  const failedCheck = last
    ? last.steps.findIndex((s, i) => s.kind === "check" && s.verdict && !s.verdict.pass && i >= last.currentStep && (ACTIVE.includes(last.status) || last.status === "failed"))
    : -1;
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (e) {
      toast({ message: (e as { body?: { message?: string } }).body?.message ?? t("common.actionFailed") });
    }
    setBusy(false);
  };

  if (failed)
    return (
      <p className="text-ink-2 m-0 text-sm">
        {t("ui.loadFailed.body")}{" "}
        <button type="button" className="text-ink underline" onClick={() => void load()}>
          {t("common.retry")}
        </button>
      </p>
    );
  if (!workflows || !runs) return <div className="bg-hover h-20 animate-pulse rounded-lg" aria-hidden="true" />;

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
      <Picker
        variant="field"
        label={t("workflows.agent.pick")}
        placeholder={t("workflows.agent.none")}
        value={workflowId ?? ""}
        disabled={!canEdit || active}
        onChange={(v) =>
          void act(async () => {
            await api(`work/tasks/${taskId}/workflow`, { method: "PUT", body: { workflowId: v || null } });
            setWorkflowId(v || null);
          })
        }
        options={[
          { value: "", label: t("workflows.agent.none") },
          ...workflows.map((w) => ({ value: w.id, label: w.name, icon: <span className="text-ink-2 [&_svg]:size-4">{CATEGORY[w.category].icon}</span> })),
        ]}
        footer={
          <Link href="/app/ai/workflows" className="text-ink-2 hover:text-ink border-hairline block border-t px-3 py-2 text-sm no-underline">
            {t("workflows.agent.manage")}
          </Link>
        }
      />
      {wf && !active ? (
        // Start sits right under the picked workflow: hand the task over, then press it (no other step).
        <div className="grid gap-2">
          <button
            type="button"
            className={cx(btnPrimary, "min-h-9 w-full")}
            disabled={busy || mustBeAssignee}
            title={mustBeAssignee ? t("workflows.agent.assigneeOnly") : undefined}
            onClick={() => (wf.config?.inputs.length ? setDialog(true) : void act(() => start()))}
          >
            <PlayIcon />
            {last?.status === "failed" ? t("workflows.run.startOver") : t("workflows.agent.start")}
          </button>
          {last?.status === "failed" && last.canRetry && failedStep ? (
            <button
              type="button"
              className={cx(btn, "h-auto min-h-9 w-full min-w-0 whitespace-normal py-1.5 text-left")}
              disabled={busy}
              title={t("workflows.run.retry", { step: failedStep.title })}
              onClick={() => void act(() => api(`work/runs/${last.id}/retry`, { method: "POST" }))}
            >
              <RefreshIcon />
              <span className="min-w-0 break-words">{t("workflows.run.retry", { step: failedStep.title })}</span>
            </button>
          ) : null}
          {wf.config ? <EnvBadge env={wf.config.environment} className="max-w-full" /> : <RunnerBadge runner={wf.runner} />}
          {mustBeAssignee ? null : <RunnerLine workflow={wf} runners={runners} />}
          <UsualTime estimate={usual} />
        </div>
      ) : !wf && !workflows.length ? (
        <p className="text-ink-2 m-0 text-xs">
          {t("workflows.agent.noneYet")}{" "}
          <Link href="/app/ai/workflows" className="text-accent-text">
            {t("workflows.agent.create")}
          </Link>
        </p>
      ) : null}
      {mustBeAssignee && !active ? <p className="text-ink-2 m-0 text-xs">{t("workflows.agent.assigneeOnly")}</p> : null}

      {last ? (
        <section aria-label={t("workflows.agent.lastRun")} className="border-hairline grid min-w-0 grid-cols-[minmax(0,1fr)] rounded-lg border">
          <header className="flex min-w-0 items-start gap-2 px-3 pb-1.5 pt-2.5">
            <div className="min-w-0 flex-1">
              <p className="text-ink m-0 truncate text-[13px] font-medium" title={last.workflowName}>
                {last.workflowName}
              </p>
              <p className="text-ink-2 m-0 truncate text-xs tabular-nums">
                {dir.name(last.startedBy)} · {ago(last.createdAt)}
              </p>
            </div>
            <RunStatusChip status={last.status} />
          </header>
          {/* The run's steps as a timeline; a step opens the pipeline on it. */}
          <div className="px-1.5 pb-1.5">
            <RunSteps
              run={last}
              size="sm"
              label={t("workflows.pipeline.steps")}
              onPick={(i) => {
                setPipelineStep(i);
                setPipeline(true);
              }}
            />
          </div>
          {last.runner === "local" && last.status === "queued" && !last.env ? (
            <p className="text-ink-2 m-0 px-3 pb-2.5 text-xs" role="status">
              {t("workflows.run.runner.waiting")}
            </p>
          ) : null}
          {/* The environment the runner gave the run, in one line; the pipeline has the log. */}
          {last.env ? (
            <p className={cx("m-0 px-3 pb-2.5 text-xs", last.env.state === "failed" ? "text-block" : "text-ink-2")}>
              {last.env.state === "ready" ? "" : `${t(`workflows.run.env.${last.env.state}`)} · `}
              {envFacts(last.env, last.claimedBy).join(" · ")}
            </p>
          ) : null}
          {failedCheck >= 0 ? (
            <div className="mx-2 mb-2">
              <CheckVerdict step={last.steps[failedCheck]!} from={checkedStep(last.steps, failedCheck)?.title} compact />
            </div>
          ) : null}
          {last.status === "paused" ? (
            <p className="text-ink-2 m-0 px-3 pb-2.5 text-xs" role="status">
              {last.steps[last.currentStep]?.state === "running" ? t("workflows.agent.pausing") : t("workflows.agent.pausedNote")}
            </p>
          ) : null}
          {last.error ? (
            <p className={cx("mx-3 mb-2.5 mt-0 rounded-md px-2.5 py-1.5 text-xs", fail ? "bg-warn-wash text-warn" : "bg-block-wash text-block")}>
              {fail ? t(`workflows.run.fail.${fail}`) : last.error}
            </p>
          ) : null}
          <RunEta run={last} className="px-3 pb-2.5" />
          <RunUsage run={last} className="px-3 pb-2.5" />
          <RunArtifacts run={last} className="px-3 pb-2.5" />
          {/* Questions and approvals are given in the run's conversation, like everything that waits for people. */}
          <RunWaiting run={last} compact className="mx-2 mb-2" />
          {confirmStop && active ? (
            <div role="alertdialog" aria-labelledby={`stop-${last.id}`} className="border-hairline grid gap-2 border-t px-3 py-2.5">
              <p id={`stop-${last.id}`} className="text-ink m-0 text-xs">
                {t("workflows.agent.stopConfirm")}
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={cx(btnDanger, btnSm)}
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await api(`work/runs/${last.id}/cancel`, { method: "POST" });
                      setConfirmStop(false);
                    })
                  }
                >
                  <StopIcon />
                  {t("workflows.agent.stopYes")}
                </button>
                <button type="button" className={cx(btn, btnSm)} onClick={() => setConfirmStop(false)} autoFocus>
                  {t("workflows.agent.keep")}
                </button>
              </div>
            </div>
          ) : null}
          {/* Pause / Continue / Stop, and the pipeline large. */}
          <div className="border-hairline flex items-center gap-0.5 whitespace-nowrap border-t px-1.5 py-1.5" role="group" aria-label={t("workflows.agent.controls")}>
            {active && last.canControl !== false ? (
              <>
                {last.status === "paused" ? (
                  <button type="button" className={cx(btnGhost, btnSm)} disabled={busy} onClick={() => void act(() => api(`work/runs/${last.id}/resume`, { method: "POST" }))}>
                    <PlayIcon />
                    {t("workflows.agent.resume")}
                  </button>
                ) : last.status === "queued" || last.status === "running" ? (
                  <button type="button" className={cx(btnGhost, btnSm)} disabled={busy} onClick={() => void act(() => api(`work/runs/${last.id}/pause`, { method: "POST" }))}>
                    <PauseMark className="h-3" />
                    {t("workflows.agent.pause")}
                  </button>
                ) : null}
                <button type="button" className={cx(btnGhost, btnSm)} disabled={busy || confirmStop} onClick={() => setConfirmStop(true)}>
                  <StopIcon />
                  {t("workflows.agent.stop")}
                </button>
              </>
            ) : null}
            <button
              type="button"
              className={cx(btnGhost, btnSm, "ml-auto")}
              title={t("workflows.log.hint")}
              onClick={() => {
                setPipelineStep(undefined);
                setLogView(true);
                setPipeline(true);
              }}
            >
              <ListIcon />
              {t("workflows.log.view")}
            </button>
            <button
              type="button"
              className={cx(btnGhost, btnSm, "text-accent-text")}
              onClick={() => {
                setPipelineStep(undefined);
                setLogView(false);
                setPipeline(true);
              }}
            >
              {t("workflows.pipeline.open")}
            </button>
          </div>
        </section>
      ) : wf ? (
        <p className="text-ink-2 m-0 flex items-center gap-1.5 text-xs [&_svg]:size-3.5">
          <WorkflowIcon />
          {t("workflows.agent.neverRun")}
        </p>
      ) : null}
      {dialog && wf ? (
        <RunDialog
          workflow={wf}
          runners={runners}
          onClose={() => setDialog(false)}
          onRun={async (inputs) => {
            await start(inputs);
            setDialog(false);
            await load();
          }}
        />
      ) : null}
      {pipeline && runs.length ? (
        <RunPipeline
          taskId={taskId}
          initial={runs}
          step={pipelineStep}
          view={logView ? "log" : undefined}
          run={linked?.run}
          replayAt={linked?.at}
          onClose={() => {
            setPipeline(false);
            setLogView(false);
            setLinked(undefined);
            void load();
          }}
          onChanged={onFinished}
        />
      ) : null}
    </div>
  );
}
