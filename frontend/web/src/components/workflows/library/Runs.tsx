"use client";

import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/client";
import { useFormat, useT } from "@/lib/i18n/client";
import { taskHref } from "@/lib/links";
import { btn, btnSm, cx, iconBtn } from "@/lib/ui";
import { card } from "@/components/ui/Bento";
import { AllClear } from "@/components/ai-hub/Intro";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { Menu } from "@/components/ui/Menu";
import { useToast } from "@/components/ui/Toast";
import { ChevronDownIcon, MoreIcon, PlayIcon, StopIcon } from "@/components/app/icons";
import { ENV_ICON, PauseMark, RunStatusChip, StepBar } from "../bits";
import { GraphTrack, STATE_DOT, StageGraph } from "../Graph";
import { RunLogButton } from "../run/RunLogButton";
import { pausedAt, type RecentRun, type RunStatus, type WorkflowActivity } from "../types";
import { FilterChip } from "./shared";

/** The Runs tab's filter, shared with the figures at the top of the page (a figure is a filter). */
export type RunFilter = "all" | "running" | "waiting" | "failed" | "done";
export const RUN_FILTERS: RunFilter[] = ["all", "running", "waiting", "failed", "done"];
const MATCH: Record<Exclude<RunFilter, "all">, RunStatus[]> = {
  running: ["queued", "running", "paused"],
  waiting: ["waiting_approval", "waiting_input"],
  failed: ["failed"],
  done: ["done"],
};
export const runMatches = (f: RunFilter, s: RunStatus) => f === "all" || MATCH[f].includes(s);

/** The runs in progress first, then the latest; what waits for the reader stands out with its Approve or Answer link. */
export function Runs({ activity, filter, onFilter }: { activity: WorkflowActivity | null; filter: RunFilter; onFilter: (f: RunFilter) => void }) {
  const t = useT();
  // Pause, continue and stop answer with the run's new status: shown at once, the server stays the truth on reload.
  const [patched, setPatched] = useState<Record<string, RunStatus>>({});
  if (!activity)
    return (
      <section aria-label={t("workflows.runs.title")} className={cx(card, "rounded-xl p-5 max-sm:p-4")}>
        <LoadFailed what={t("workflows.runs.what")} />
      </section>
    );
  const runs = activity.runs.map((r) => (patched[r.id] ? { ...r, status: patched[r.id]! } : r));
  const shown = runs.filter((r) => runMatches(filter, r.status));
  return (
    <section aria-label={t("workflows.runs.title")} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
      <div role="group" aria-label={t("workflows.library.runFilter.label")} className="-mx-1 flex min-w-0 gap-1.5 overflow-x-auto px-1 py-1 [scrollbar-width:none]">
        {RUN_FILTERS.map((k) => (
          <FilterChip key={k} active={filter === k} onClick={() => onFilter(k)} n={k === "all" ? undefined : runs.filter((r) => runMatches(k, r.status)).length}>
            {t(`workflows.library.runFilter.${k}`)}
          </FilterChip>
        ))}
      </div>
      <div className={cx(card, "@container/runs min-w-0 rounded-xl p-3 max-sm:p-2")}>
        {shown.length ? (
          <ul className="m-0 grid list-none gap-1 p-0">
            {shown.map((r) => (
              <RunRow key={r.id} r={r} onStatus={(s) => setPatched((x) => ({ ...x, [r.id]: s }))} />
            ))}
          </ul>
        ) : (
          <div className="px-2 py-1">
            <AllClear>{t(runs.length ? "workflows.library.runFilter.none" : "workflows.runs.empty")}</AllClear>
          </div>
        )}
      </div>
    </section>
  );
}

function RunRow({ r, onStatus }: { r: RecentRun; onStatus: (s: RunStatus) => void }) {
  const t = useT();
  const f = useFormat();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const done = r.steps.filter((s) => s.state === "done").length;
  // Waiting for people: an approval, or answers to the AI's questions (both stand out).
  const waiting = r.status === "waiting_approval" || r.status === "waiting_input";
  const href = taskHref({ id: r.taskId, code: r.taskCode });
  // The stage the run is at: the one working, waiting or failed; a finished run shows its last.
  const at = r.steps.findIndex((s) => s.state === "running" || s.state === "waiting" || s.state === "failed");
  // A paused run is at the stage it holds before.
  const now = r.steps[r.status === "paused" ? (pausedAt(r) ?? r.currentStep) : at >= 0 ? at : r.status === "queued" ? 0 : r.steps.length - 1];
  const panel = `run-${r.id}`;
  const env = r.environment ?? (r.runner === "local" ? "computer" : "assistant");
  const act = async (verb: "pause" | "resume" | "cancel") => {
    setBusy(true);
    try {
      const x = await api<{ status: RunStatus }>(`work/runs/${r.id}/${verb}`, { method: "POST" });
      onStatus(x.status);
    } catch {
      toast({ message: t("common.actionFailed") });
    } finally {
      setBusy(false);
    }
  };
  const live = r.status === "queued" || r.status === "running" || r.status === "paused" || waiting;
  const controls = r.canControl && live && !busy;
  return (
    <li className={cx("min-w-0 rounded-lg transition-colors", waiting ? "bg-warn-wash/60 ring-warn/15 ring-1 ring-inset" : open && "bg-ground")}>
      <div
        className={cx(
          "group/run relative grid min-w-0 items-center gap-x-4 gap-y-2 rounded-lg px-2 py-2.5 transition-colors",
          "grid-cols-[auto_minmax(0,1fr)_auto] [grid-template-areas:'s_._w'_'t_t_t'_'b_b_a']",
          "@[36rem]/runs:grid-cols-[9rem_minmax(0,1fr)_6rem_auto] @[36rem]/runs:[grid-template-areas:'s_t_w_a'_'._b_._.']",
          "@[56rem]/runs:grid-cols-[9rem_minmax(0,1fr)_12rem_5.5rem_auto] @[56rem]/runs:[grid-template-areas:'s_t_b_w_a']",
          waiting ? "hover:bg-warn-wash" : "hover:bg-hover",
        )}
      >
        <span className="[grid-area:s]">
          <RunStatusChip status={r.status} />
        </span>
        <span className="min-w-0 leading-[1.35] [grid-area:t]">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="text-ink-2 shrink-0 font-mono text-xs">{r.taskCode}</span>
            <span className="text-ink truncate text-sm font-medium">{r.taskTitle}</span>
          </span>
          <span className="text-ink-2 flex min-w-0 items-center gap-1.5 text-xs [&_svg]:size-3.5 [&_svg]:shrink-0" title={t(`workflows.env.${env}`)}>
            <span aria-hidden="true" className="contents">
              {ENV_ICON[env]}
            </span>
            <span className="sr-only">{t(`workflows.env.${env}`)}</span>
            <span className="truncate">{r.workflowName}</span>
          </span>
        </span>
        {/* The run as a mini pipeline: a segment per stage in its state, the stage it is at named under it. */}
        <span className="@[36rem]/runs:max-w-72 @[56rem]/runs:max-w-none grid min-w-0 gap-1 [grid-area:b]" title={t("workflows.runs.progress", { done, total: r.steps.length })}>
          <span className="flex min-w-0 items-center gap-2">
            <StepBar steps={r.steps} className="flex-1" />
            <span className="text-ink-2 shrink-0 text-xs tabular-nums">
              {done}/{r.steps.length}
            </span>
          </span>
          {now ? (
            <span className="text-ink-2 flex min-w-0 items-center gap-1.5 text-xs">
              <span aria-hidden="true" className={cx("size-1.5 shrink-0 rounded-full", STATE_DOT[now.state])} />
              {/* A run that has ended is not "now" at anything: its last step, by name only. */}
              <span className="truncate">{["done", "failed", "cancelled"].includes(r.status) ? now.title : t("workflows.runs.now", { title: now.title })}</span>
            </span>
          ) : null}
        </span>
        <span className="text-ink-2 truncate text-right text-xs [grid-area:w]" suppressHydrationWarning>
          {f.ago(r.updatedAt)}
        </span>
        <span className="relative z-[2] flex items-center justify-end gap-1 [grid-area:a]">
          {r.status === "waiting_input" && r.canAnswer ? (
            <Link href={`/app/chat/ask/${r.id}`} className={cx(btn, btnSm, "no-underline")}>
              {t("workflows.runs.answer")}
            </Link>
          ) : null}
          {r.status === "waiting_approval" && r.canApprove ? (
            <Link href={`/app/chat/ask/${r.id}`} className={cx(btn, btnSm, "no-underline")}>
              {t("workflows.runs.approve")}
            </Link>
          ) : null}
          <RunLogButton taskId={r.taskId} runId={r.id} compact />
          {controls ? (
            <Menu
              label={t("workflows.library.runActions", { code: r.taskCode })}
              align="right"
              items={[
                ...(r.status === "queued" || r.status === "running" ? [{ label: t("workflows.library.pause"), icon: <PauseMark />, onSelect: () => void act("pause") }] : []),
                ...(r.status === "paused" ? [{ label: t("workflows.library.resume"), icon: <PlayIcon />, onSelect: () => void act("resume") }] : []),
                { label: t("workflows.library.stop"), icon: <StopIcon />, danger: true, onSelect: () => void act("cancel") },
              ]}
              trigger={
                <span className={cx(iconBtn, "text-ink-2")}>
                  <MoreIcon className="size-4" />
                </span>
              }
            />
          ) : null}
          <button
            type="button"
            aria-expanded={open}
            aria-controls={panel}
            aria-label={t("workflows.runs.expand", { code: r.taskCode })}
            title={t("workflows.runs.expand", { code: r.taskCode })}
            className={cx(iconBtn, "text-ink-2")}
            onClick={() => setOpen((o) => !o)}
          >
            <ChevronDownIcon className={cx("size-4 transition-transform", open && "rotate-180")} />
          </button>
        </span>
        <Link href={href} aria-label={t("workflows.runs.open", { code: r.taskCode })} className="absolute inset-0 z-[1] rounded-[inherit]" />
      </div>
      {open ? (
        <div id={panel} className="animate-rise px-2 pb-3">
          <GraphTrack className="px-3 py-3">
            <StageGraph steps={r.steps} size="md" runner={r.runner} vertical pausedAt={pausedAt(r)} />
          </GraphTrack>
        </div>
      ) : null}
    </li>
  );
}
