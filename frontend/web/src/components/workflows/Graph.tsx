"use client";

import { useFormat, useT } from "@/lib/i18n/client";
import { cx } from "@/lib/ui";
import { TONE } from "@/components/ui/Bento";
import { PauseMark, STEP_ICON, STEP_TONE } from "./bits";
import type { RunStep, Runner, StepKind } from "./types";

/*
 * The pipeline graph: each step a compact stage box (its kind's tinted
 * tile, a short kind label, the title on up to two lines) joined by connectors with a chevron. An approval is a gate:
 * a dashed connector with an orange diamond leads into it. A status step is the end cap (a rounded green capsule). A
 * run's graph adds each stage's state (its ring, a dot, the state and the time). One component for the workflow cards,
 * the template previews, the hero, a run's stages here and on the task (RunPipeline), so they all read the same.
 * Semantics: an ordered list of steps; connectors are decoration.
 */

export interface GraphStep {
  key?: string;
  title: string;
  kind: StepKind;
  status?: string | undefined;
  state?: RunStep["state"] | undefined;
  startedAt?: string | undefined;
  finishedAt?: string | undefined;
  waitedMs?: number | undefined;
  waitingSince?: string | undefined;
}
export type GraphSize = "sm" | "md" | "lg";

/** A stage's ring and wash by state; undefined (a definition, not a run) draws the quiet ring. */
const STATE_RING: Record<RunStep["state"], string> = {
  pending: "ring-hairline",
  skipped: "ring-hairline opacity-60",
  running: "ring-accent/60 bg-accent-wash/40 shadow-[0_0_0_3px_var(--accent-wash)]",
  waiting: "ring-warn/45 bg-warn-wash/50",
  done: "ring-ok/35",
  failed: "ring-block/45 bg-block-wash/40",
};
export const STATE_DOT: Record<RunStep["state"], string> = {
  pending: "bg-edge",
  skipped: "bg-edge",
  running: "bg-accent motion-safe:animate-pulse",
  waiting: "bg-warn-fill",
  done: "bg-ok-fill",
  failed: "bg-block",
};

/** "41s", "2m 05s", "3h 12m", "2d 4h": a step waiting on people for a day must not read "1565m 01s". */
export function duration(sec: number) {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86_400)}d ${Math.floor((s % 86_400) / 3600)}h`;
}

/** The kind in a few words: "AI · công ty", "Lệnh", "Duyệt · người", "Chuyển → Đang duyệt". */
export function useKindLabel() {
  const t = useT();
  const f = useFormat();
  return (s: Pick<GraphStep, "kind" | "status">, runner?: Runner) =>
    s.kind === "ai"
      ? t(runner === "local" ? "workflows.stage.aiLocal" : runner === "server" ? "workflows.stage.aiServer" : "workflows.stage.ai")
      : s.kind === "status"
        ? t("workflows.stage.status", { status: f.status(s.status ?? "review") ?? s.status ?? "" })
        : t(`workflows.stage.${s.kind}`);
}

/** The line between two stages, ending in a chevron; dashed with a diamond before an approval gate. */
function Connector({ gate, done, size, vertical, paused }: { gate: boolean; done: boolean; size: GraphSize; vertical: boolean; paused?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        "relative flex shrink-0 items-center justify-center",
        size === "sm" ? "w-5" : "w-7",
        done ? "text-ok-fill/70" : "text-ink-2/45",
        vertical && "max-sm:h-6 max-sm:w-full",
      )}
    >
      <svg viewBox="0 0 28 10" className={cx("h-2.5 w-full overflow-visible", vertical && "max-sm:w-6 max-sm:rotate-90")} fill="none">
        <path d="M0 5H26" stroke="currentColor" strokeWidth="1.25" strokeDasharray={gate ? "2.5 2.5" : undefined} />
        <path d="M22.5 1.5 26 5l-3.5 3.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {paused ? (
        // A paused run holds here: a small pause badge on the line into the next stage.
        <span className="bg-surface ring-edge text-ink-soft absolute left-1/2 top-1/2 grid size-4 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full ring-1">
          <PauseMark className="h-2 [&>span]:w-[2px]" />
        </span>
      ) : gate ? (
        <span
          className={cx(
            "border-tangerine bg-tangerine-wash absolute left-[38%] top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-[2px] border",
            vertical && "max-sm:left-1/2 max-sm:top-[38%]",
          )}
        />
      ) : null}
    </span>
  );
}

/** One stage box. */
export function Stage({
  s,
  size = "md",
  runner,
  stats,
  selected,
  onPick,
  vertical,
}: {
  s: GraphStep;
  size?: GraphSize;
  runner?: Runner | undefined;
  /** The step's last 30 days (workflow detail). */
  stats?: { done: number; failed: number; avgSec: number | null } | undefined;
  selected?: boolean;
  onPick?: () => void;
  vertical?: boolean;
}) {
  const t = useT();
  const kind = useKindLabel();
  const end = s.kind === "status";
  const cls = cx(
    "bg-surface relative flex shrink-0 flex-col text-left ring-1 ring-inset",
    size === "sm" ? "w-[5.5rem] gap-1 px-2 py-1.5" : size === "md" ? "w-[8.75rem] gap-1.5 px-2.5 py-2" : "w-[12.5rem] gap-2 px-3 py-2.5",
    vertical && "max-sm:w-full",
    // The end cap: a status step closes the pipeline as a rounded green capsule.
    end ? (size === "sm" ? "rounded-[0.9rem]" : "rounded-[1.1rem]") : "rounded-lg",
    s.state ? STATE_RING[s.state] : end ? "ring-ok/30" : s.kind === "approval" ? "ring-tangerine/35" : "ring-hairline",
    onPick && "hover:shadow-lift cursor-pointer transition-shadow",
    selected && "outline-ink outline outline-2 outline-offset-2",
  );
  const body = (
    <>
      <span className="flex min-w-0 items-center gap-1.5">
        <span
          aria-hidden="true"
          className={cx(
            "ring-current/15 grid shrink-0 place-items-center ring-1 ring-inset",
            TONE[STEP_TONE[s.kind]],
            size === "sm" ? "size-[18px] rounded-[5px] [&_svg]:size-[11px]" : "size-5 rounded-md [&_svg]:size-3",
          )}
        >
          {STEP_ICON[s.kind]}
        </span>
        {size === "sm" ? null : <span className="text-ink-2 min-w-0 truncate text-xs">{kind(s, runner)}</span>}
        {s.state ? <span aria-hidden="true" className={cx("ml-auto size-1.5 shrink-0 rounded-full", STATE_DOT[s.state])} /> : null}
      </span>
      <span className={cx("text-ink line-clamp-2 break-words font-medium", size === "sm" ? "text-xs/[1.3]" : "text-[13px]/[1.3]")} title={s.title}>
        {s.title}
      </span>
      {s.state && size !== "sm" ? (
        <span className="text-ink-2 flex items-center gap-1.5 text-xs tabular-nums">
          {s.state === "waiting" && s.kind === "ai" ? t("workflows.status.waiting_input") : t(`workflows.pipeline.state.${s.state}`)}
          {s.startedAt && !s.waitingSince ? (
            <span className="ml-auto" suppressHydrationWarning>
              {duration(Math.max(0, (s.finishedAt ? Date.parse(s.finishedAt) : Date.now()) - Date.parse(s.startedAt) - (s.waitedMs ?? 0)) / 1000)}
            </span>
          ) : null}
        </span>
      ) : null}
      {stats ? (
        <span className="text-ink-2 flex flex-wrap items-center gap-x-2 text-xs tabular-nums">
          <span className="text-ok">✓ {stats.done}</span>
          {stats.failed ? <span className="text-block">✕ {stats.failed}</span> : null}
          {stats.avgSec !== null ? <span>~{duration(stats.avgSec)}</span> : null}
        </span>
      ) : null}
      {s.state ? (
        <span className="sr-only">{s.state === "waiting" && s.kind === "ai" ? t("workflows.status.waiting_input") : t(`workflows.pipeline.state.${s.state}`)}</span>
      ) : null}
    </>
  );
  return onPick ? (
    <button type="button" onClick={onPick} aria-pressed={selected} className={cls}>
      {body}
    </button>
  ) : (
    <span className={cls}>{body}</span>
  );
}

/**
 * The graph: a start dot (the task), the stages joined left to right, an end dot. `vertical` stacks it on phones
 * (detail views); otherwise it scrolls sideways inside its track (`GraphTrack`).
 */
export function StageGraph({
  steps,
  size = "md",
  runner,
  stats,
  selected,
  onPick,
  vertical = false,
  caps = true,
  label,
  pausedAt,
}: {
  steps: GraphStep[];
  size?: GraphSize;
  runner?: Runner | undefined;
  stats?: Record<string, { done: number; failed: number; avgSec: number | null }> | undefined;
  selected?: number;
  onPick?: (i: number) => void;
  vertical?: boolean;
  /** The start (the task) and end dots; off where room is tight (the hero). */
  caps?: boolean;
  label?: string;
  /** A paused run: the stage it holds before (a pause badge on the line into it). */
  pausedAt?: number | undefined;
}) {
  const t = useT();
  const cap = size === "sm" ? "size-2" : "size-2.5";
  return (
    <ol aria-label={label ?? t("workflows.steps")} className={cx("m-0 flex w-max list-none items-center p-0", vertical && "max-sm:w-full max-sm:flex-col max-sm:items-stretch")}>
      {caps ? (
        <li aria-hidden="true" className={cx("flex items-center", vertical && "max-sm:flex-col")}>
          <span className={cx("ring-edge bg-surface shrink-0 rounded-full ring-2 ring-inset", cap, vertical && "max-sm:mx-auto")} />
        </li>
      ) : null}
      {steps.map((s, i) => (
        <li key={i} className={cx("flex items-center", vertical && "max-sm:flex-col max-sm:items-stretch")}>
          {caps || i ? <Connector gate={s.kind === "approval"} done={i > 0 && steps[i - 1]!.state === "done"} size={size} vertical={vertical} paused={pausedAt === i} /> : null}
          {pausedAt === i ? <span className="sr-only">{t("workflows.pipeline.pausedHere")}</span> : null}
          <Stage
            s={s}
            size={size}
            runner={runner}
            stats={s.key ? stats?.[s.key] : undefined}
            selected={selected === i}
            onPick={onPick ? () => onPick(i) : undefined}
            vertical={vertical}
          />
        </li>
      ))}
      {caps ? (
        <li aria-hidden="true" className={cx("flex items-center", vertical && "max-sm:flex-col")}>
          <Connector gate={false} done={steps.at(-1)?.state === "done"} size={size} vertical={vertical} />
          <span className={cx("bg-edge shrink-0 rounded-full", cap, vertical && "max-sm:mx-auto", steps.at(-1)?.state === "done" && "bg-ok-fill")} />
        </li>
      ) : null}
    </ol>
  );
}

/** A graph's own scrolling track: sideways scroll with soft faded edges, never truncating a stage. */
export function GraphTrack({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cx(
        "overflow-x-auto overscroll-x-contain [mask-image:linear-gradient(to_right,transparent,black_14px,black_calc(100%-14px),transparent)] [scrollbar-width:thin]",
        className,
      )}
    >
      {children}
    </div>
  );
}
