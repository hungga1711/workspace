"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { api } from "@/lib/client";
import { useT } from "@/lib/i18n/client";
import { btnGhost, btnSm, cx } from "@/lib/ui";
import { ListIcon } from "@/components/app/icons";
import type { TaskRun } from "./helpers";

const RunPipeline = dynamic(() => import("../RunPipeline").then((m) => m.RunPipeline), { ssr: false });

/**
 * "View log" wherever a run shows up without its pipeline (the approval conversation, the runs list): reads the task's
 * runs when pressed and opens the pipeline on the run's whole log.
 */
export function RunLogButton({ taskId, runId, className, compact }: { taskId: string; runId: string; className?: string; compact?: boolean }) {
  const t = useT();
  const [runs, setRuns] = useState<TaskRun[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const open = async () => {
    setBusy(true);
    setFailed(false);
    const r = await api<{ runs: TaskRun[] }>(`work/tasks/${taskId}/runs`).catch(() => null);
    setBusy(false);
    if (r?.runs.length) setRuns(r.runs);
    else setFailed(true);
  };
  return (
    <>
      <button
        type="button"
        className={cx(btnGhost, btnSm, compact && "px-2", failed && "text-block", className)}
        disabled={busy}
        aria-label={compact ? t("workflows.log.view") : undefined}
        title={failed ? t("workflows.log.failed") : t("workflows.log.hint")}
        onClick={() => void open()}
      >
        <ListIcon />
        {compact ? null : <span className="max-sm:sr-only">{failed ? t("workflows.log.failed") : t("workflows.log.view")}</span>}
      </button>
      {runs ? <RunPipeline taskId={taskId} initial={runs} run={runId} view="log" onClose={() => setRuns(null)} /> : null}
    </>
  );
}
