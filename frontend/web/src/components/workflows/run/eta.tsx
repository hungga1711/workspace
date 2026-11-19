"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";
import { useFormat, useT } from "@/lib/i18n/client";
import { cx } from "@/lib/ui";
import { ClockIcon } from "@/components/app/icons";
import type { Estimate, Run } from "../types";
import { durationParts } from "./helpers";

/** "6 min", "45 s", "1 h 10 min": a length of time in words, for the estimate lines. */
export function useDuration() {
  const t = useT();
  return useCallback(
    (sec: number) => {
      const p = durationParts(sec);
      if (p.unit === "sec") return t("workflows.run.eta.sec", { n: p.n });
      if (p.unit === "min") return t("workflows.run.eta.min", { n: p.n });
      return p.m ? t("workflows.run.eta.hour", { h: p.h, m: p.m }) : t("workflows.run.eta.hourOnly", { h: p.h });
    },
    [t],
  );
}

/**
 * How long a run of a workflow usually takes, read once when something on screen needs it (the Run dialog, the card
 * before a run, the workflow's page). Quiet on failure: the line is simply not shown.
 */
export function useWorkflowEstimate(workflowId: string | null | undefined, enabled = true) {
  const [got, setGot] = useState<{ id: string; estimate: Estimate } | null>(null);
  useEffect(() => {
    if (!workflowId || !enabled) return;
    let live = true;
    api<Estimate>(`work/workflows/${workflowId}/estimate`)
      .then((e) => live && e && typeof e.totalSec === "number" && setGot({ id: workflowId, estimate: e }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [workflowId, enabled]);
  return enabled && got && got.id === workflowId ? got.estimate : null;
}

/** "Usually takes about 6 min", with "a rough guess" until the workflow has runs of its own to average. */
export function UsualTime({ estimate, className }: { estimate: Estimate | null; className?: string }) {
  const t = useT();
  const words = useDuration();
  if (!estimate || !(estimate.totalSec > 0)) return null;
  return (
    <span className={cx("text-ink-2 inline-flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs", className)}>
      <ClockIcon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="tabular-nums">{t("workflows.run.eta.usually", { d: words(estimate.totalSec) })}</span>
      {estimate.basedOn === 0 ? <span>· {t("workflows.run.eta.rough")}</span> : null}
    </span>
  );
}

type EtaRun = Pick<Run, "status" | "estimate" | "steps" | "currentStep">;

/**
 * What is left of a run, in words. While it works: "About 4 min left · done around 14:32", counted down between polls
 * from the finish time the server gave. Waiting for people: the work left after they answer. Past its estimate and
 * still going: "Taking longer than usual" (never zero or a negative time on something that is working).
 */
export function useRunEta(run: EtaRun | null | undefined): { text: string; late: boolean } | null {
  const t = useT();
  const f = useFormat();
  const words = useDuration();
  const e = run?.estimate;
  const finishAt = e?.finishAt ?? null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!finishAt) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(id);
  }, [finishAt]);
  if (!run || !e) return null;
  if (run.status === "queued" || run.status === "running") {
    if (!finishAt) return null;
    const current = run.steps[run.currentStep];
    const stepSec = current ? (e.steps?.[current.key] ?? 0) : 0;
    const began = current?.state === "running" ? ([...(current.history ?? [])].reverse().find((h) => h.kind === "attempt" && !h.outcome)?.at ?? current.startedAt) : undefined;
    // A step past its own estimate: say so, with what the steps after it should still take.
    if (began && stepSec > 0 && (now - Date.parse(began)) / 1000 > stepSec) {
      const after = run.steps.slice(run.currentStep + 1).reduce((n, x) => n + (x.state === "done" || x.state === "skipped" ? 0 : (e.steps?.[x.key] ?? 0)), 0);
      return { text: after > 0 ? t("workflows.run.eta.lateThen", { d: words(after) }) : t("workflows.run.eta.late"), late: true };
    }
    const left = Math.max(5, (Date.parse(finishAt) - now) / 1000);
    return { text: t("workflows.run.eta.left", { d: words(left), time: f.time(new Date(Math.max(now, Date.parse(finishAt)))) }), late: false };
  }
  const left = e.remainingSec ?? 0;
  if (left <= 0) return null;
  const d = words(left);
  if (run.status === "waiting_approval") return { text: t("workflows.run.eta.afterApproval", { d }), late: false };
  if (run.status === "waiting_input") return { text: t("workflows.run.eta.afterAnswers", { d }), late: false };
  if (run.status === "paused") return { text: t("workflows.run.eta.leftOnly", { d }), late: false };
  return null;
}

/** The run's remaining time as one quiet line; nothing when the workflow leaves estimates out or the run is over. */
export function RunEta({ run, className }: { run: EtaRun | null | undefined; className?: string }) {
  const eta = useRunEta(run);
  if (!eta) return null;
  return (
    <p role="status" className={cx("m-0 flex min-w-0 items-center gap-1.5 text-xs tabular-nums", eta.late ? "text-warn" : "text-ink-2", className)}>
      <ClockIcon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0">{eta.text}</span>
    </p>
  );
}
