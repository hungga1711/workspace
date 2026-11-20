"use client";

import { useEffect, useRef } from "react";
import { useT } from "@/lib/i18n/client";
import { cx } from "@/lib/ui";
import { CheckIcon, CloseIcon } from "@/components/app/icons";
import { ENV_ICON, PauseMark, STEP_ICON } from "./bits";
import { useKindLabel } from "./Graph";
import { useNow, workedFor } from "./RunSteps";
import { useDuration } from "./run/eta";
import { redone } from "./run/helpers";
import type { EnvKind, Run, RunEnv, RunStep } from "./types";

/** A stage's node on the track: its kind's icon until it ends, then a tick or a cross; the one at work carries a halo. */
function Node({ s, icon }: { s: Pick<RunStep, "kind" | "state">; icon?: React.ReactNode }) {
  return (
    <span className="relative grid size-9 shrink-0 place-items-center">
      {s.state === "running" ? <span aria-hidden="true" className="bg-accent/30 absolute inset-0 rounded-full motion-safe:animate-ping" /> : null}
      <span
        aria-hidden="true"
        className={cx(
          "relative grid size-9 place-items-center rounded-full transition-colors [&_svg]:size-4",
          s.state === "done" && "bg-ok-fill text-on-brand",
          s.state === "failed" && "bg-block text-on-brand",
          s.state === "running" && "bg-surface text-accent-text ring-accent ring-2 ring-inset",
          s.state === "waiting" && "bg-warn-wash text-warn ring-warn/60 ring-[1.5px] ring-inset",
          s.state === "pending" && "bg-surface text-ink-2 ring-edge ring-1 ring-inset",
          s.state === "skipped" && "bg-surface text-ink-2 ring-edge opacity-60 ring-1 ring-inset",
        )}
      >
        {s.state === "done" ? <CheckIcon /> : s.state === "failed" ? <CloseIcon /> : (icon ?? STEP_ICON[s.kind])}
      </span>
    </span>
  );
}

/**
 * A run's stages as one track across the pipeline dialog: round nodes joined by
 * a line that turns green as stages finish, a signal travelling out of the stage at work, each stage's name and time
 * under its node. The track is also how a stage is picked: the chosen one is underlined, like a tab. It scrolls
 * sideways when the stages do not fit (phones, long pipelines) and keeps the chosen stage in view.
 *
 * A run on a runner opens with one more stage, "Environment" (index -1): the sandbox or folder the runner prepared.
 * A stage a check or an approver sent back carries "↺ n", the times it was redone.
 */
export const ENV_STAGE = -1;
export function PipelineTrack({
  run,
  selected,
  onPick,
  label,
  pausedAt,
  env,
  envKind,
}: {
  run: Pick<Run, "currentStep" | "runner" | "estimate"> & { steps: RunStep[] };
  selected: number;
  onPick: (i: number) => void;
  label: string;
  /** A paused run: the stage it holds before (a pause badge on the line into it). */
  pausedAt?: number | undefined;
  /** The runner's preparation of the environment, drawn as the first stage. */
  env?: RunEnv | null | undefined;
  envKind?: EnvKind | undefined;
}) {
  const t = useT();
  const kind = useKindLabel();
  const words = useDuration();
  // What each stage should take, when the workflow shows estimates: under a stage still to run, beside one at work.
  const usual = (s: RunStep) => {
    const sec = run.estimate?.steps?.[s.key] ?? 0;
    return sec > 0 ? t("workflows.run.eta.short", { d: words(sec) }) : "";
  };
  const now = useNow(run.steps.some((s) => s.state === "running"));
  const picked = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    picked.current?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [selected]);
  const stateText = (s: Pick<RunStep, "kind" | "state">) =>
    s.state === "waiting" && s.kind === "ai" ? t("workflows.status.waiting_input") : t(`workflows.pipeline.state.${s.state}`);
  const envState: RunStep["state"] = env?.state === "ready" ? "done" : env?.state === "failed" ? "failed" : "running";
  const envOn = selected === ENV_STAGE;
  return (
    <ol aria-label={label} className="no-scrollbar m-0 flex list-none overflow-x-auto px-3 py-0 max-sm:px-1">
      {env ? (
        <li className="relative min-w-[6.75rem] flex-1">
          <span
            aria-hidden="true"
            className={cx(
              "absolute left-[calc(50%+1.375rem)] right-[calc(-50%+1.375rem)] top-[1.6875rem] h-0.5 overflow-hidden rounded-full",
              envState === "done" ? "bg-ok-fill/70" : "bg-edge",
            )}
          >
            {envState === "running" ? <span className="bg-accent animate-travel absolute top-0 h-full w-5 -translate-x-1/2 rounded-full motion-reduce:hidden" /> : null}
          </span>
          <button
            ref={envOn ? picked : undefined}
            type="button"
            aria-current={envOn ? "step" : undefined}
            onClick={() => onPick(ENV_STAGE)}
            className="group relative flex w-full flex-col items-center gap-1.5 px-1.5 pb-3 pt-2.5 text-center"
          >
            <span className="transition-transform duration-150 group-hover:scale-105">
              <Node s={{ kind: "command", state: envState }} icon={ENV_ICON[envKind ?? "sandbox"]} />
            </span>
            <span className="grid min-w-0 max-w-full gap-0.5">
              <span className={cx("line-clamp-2 break-words text-[13px]/[1.3]", envOn ? "text-ink font-semibold" : "text-ink-soft group-hover:text-ink font-medium")}>
                {t("workflows.run.env.stage")}
              </span>
              <span className={cx("truncate text-xs", envState === "running" ? "text-accent-text" : envState === "failed" ? "text-block" : "text-ink-2")}>
                {t(`workflows.run.env.${env.state}`)}
              </span>
            </span>
            <span aria-hidden="true" className={cx("absolute inset-x-4 bottom-0 h-0.5 rounded-full transition-colors", envOn ? "bg-ink" : "group-hover:bg-edge bg-transparent")} />
          </button>
        </li>
      ) : null}
      {run.steps.map((s, i) => {
        const again = redone(s);
        const on = selected === i;
        const worked = workedFor(s, now);
        return (
          <li key={i} className="relative min-w-[6.75rem] flex-1">
            {/* The line to the next stage, between the two nodes' edges. */}
            {i < run.steps.length - 1 ? (
              <span
                aria-hidden="true"
                className={cx(
                  "absolute left-[calc(50%+1.375rem)] right-[calc(-50%+1.375rem)] top-[1.6875rem] h-0.5 overflow-hidden rounded-full",
                  s.state === "done" ? "bg-ok-fill/70" : "bg-edge",
                )}
              >
                {s.state === "running" ? <span className="bg-accent animate-travel absolute top-0 h-full w-5 -translate-x-1/2 rounded-full motion-reduce:hidden" /> : null}
              </span>
            ) : null}
            {pausedAt === i + 1 ? (
              <span
                aria-hidden="true"
                className="bg-surface ring-edge text-ink-soft absolute left-full top-7 z-[1] grid size-4 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full ring-1"
              >
                <PauseMark className="h-2 [&>span]:w-[2px]" />
              </span>
            ) : null}
            <button
              ref={on ? picked : undefined}
              type="button"
              aria-current={on ? "step" : undefined}
              onClick={() => onPick(i)}
              className="group relative flex w-full flex-col items-center gap-1.5 px-1.5 pb-3 pt-2.5 text-center"
            >
              <span className="relative transition-transform duration-150 group-hover:scale-105">
                <Node s={s} />
                {again ? (
                  <span
                    className="bg-surface text-rose-text ring-rose-text/25 absolute -right-2.5 -top-1 z-[1] inline-flex h-4 items-center rounded-full px-1 text-[10.5px] font-semibold tabular-nums ring-1"
                    title={t("workflows.run.check.redone", { count: again })}
                  >
                    <span aria-hidden="true">↺ {again}</span>
                    <span className="sr-only">{t("workflows.run.check.redone", { count: again })}</span>
                  </span>
                ) : null}
              </span>
              <span className="grid min-w-0 max-w-full gap-0.5">
                <span
                  className={cx(
                    "line-clamp-2 break-words text-[13px]/[1.3]",
                    on
                      ? "text-ink font-semibold"
                      : s.state === "pending" || s.state === "skipped"
                        ? "text-ink-2 group-hover:text-ink"
                        : "text-ink-soft group-hover:text-ink font-medium",
                  )}
                  title={s.title}
                >
                  {s.title}
                </span>
                <span
                  className={cx(
                    "truncate text-xs tabular-nums",
                    s.state === "running" ? "text-accent-text" : s.state === "waiting" ? "text-warn" : s.state === "failed" ? "text-block" : "text-ink-2",
                  )}
                >
                  {s.state === "running" ? (
                    <>
                      {stateText(s)}
                      {worked ? ` · ${worked}` : ""}
                      {usual(s) ? <span className="text-ink-2"> / {usual(s)}</span> : null}
                    </>
                  ) : s.state === "waiting" || s.state === "failed" || s.state === "skipped" ? (
                    stateText(s)
                  ) : s.kind === "check" && s.verdict ? (
                    <span className={s.verdict.pass ? "text-ok" : "text-rose-text"}>{t(s.verdict.pass ? "workflows.run.check.passed" : "workflows.run.check.failed")}</span>
                  ) : s.state === "done" && worked ? (
                    worked
                  ) : s.state === "pending" && usual(s) ? (
                    usual(s)
                  ) : (
                    kind(s, run.runner)
                  )}
                </span>
              </span>
              <span className="sr-only">{stateText(s)}</span>
              {/* The chosen stage is underlined on the band's lower edge, like a tab. */}
              <span aria-hidden="true" className={cx("absolute inset-x-4 bottom-0 h-0.5 rounded-full transition-colors", on ? "bg-ink" : "group-hover:bg-edge bg-transparent")} />
            </button>
          </li>
        );
      })}
    </ol>
  );
}
