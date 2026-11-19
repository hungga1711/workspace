"use client";

import { useT } from "@/lib/i18n/client";
import { cx } from "@/lib/ui";
import { TONE, type Tone } from "@/components/ui/Bento";
import {
  BotIcon,
  CartIcon,
  CashIcon,
  ChatIcon,
  CheckIcon,
  CodeIcon,
  FlagIcon,
  MegaphoneIcon,
  SearchIcon,
  SettingsIcon,
  ShieldIcon,
  SparkleIcon,
  TerminalIcon,
  UsersIcon,
  WorkflowIcon,
} from "@/components/app/icons";
import type { Category, EnvKind, Environment, RunStatus, RunStep, Runner, StepKind } from "./types";

/** Each category's icon and tint: identity only, never status. */
export const CATEGORY: Record<Category, { icon: React.ReactNode; tile: string }> = {
  coding: { icon: <CodeIcon />, tile: "bg-sky-wash text-sky-text" },
  product: { icon: <FlagIcon />, tile: "bg-violet-wash text-violet-text" },
  marketing: { icon: <MegaphoneIcon />, tile: "bg-tangerine-wash text-tangerine-text" },
  sales: { icon: <CartIcon />, tile: "bg-ok-wash text-ok" },
  support: { icon: <ChatIcon />, tile: "bg-sky-wash text-sky-text" },
  hr: { icon: <UsersIcon />, tile: "bg-rose-wash text-rose-text" },
  finance: { icon: <CashIcon />, tile: "bg-ok-wash text-ok" },
  legal: { icon: <ShieldIcon />, tile: "bg-hover text-ink-soft" },
  operations: { icon: <SettingsIcon />, tile: "bg-tangerine-wash text-tangerine-text" },
  creative: { icon: <SparkleIcon />, tile: "bg-violet-wash text-violet-text" },
  research: { icon: <SearchIcon />, tile: "bg-rose-wash text-rose-text" },
  other: { icon: <WorkflowIcon />, tile: "bg-hover text-ink-2" },
};
export const STEP_ICON: Record<StepKind, React.ReactNode> = {
  ai: <BotIcon />,
  command: <TerminalIcon />,
  check: <ShieldIcon />,
  approval: <UsersIcon />,
  status: <CheckIcon />,
};

export function CategoryTile({ category, size = "md" }: { category: Category; size?: "sm" | "md" }) {
  const c = CATEGORY[category] ?? CATEGORY.other;
  return (
    <span
      aria-hidden="true"
      className={cx(
        "ring-current/10 grid shrink-0 place-items-center ring-1 ring-inset",
        c.tile,
        size === "sm" ? "size-8 rounded-[9px] [&_svg]:size-4" : "size-10 rounded-[11px] [&_svg]:size-5",
      )}
    >
      {c.icon}
    </span>
  );
}

/** Where it runs, in words people know: the company's AI, or my computer. */
export function RunnerBadge({ runner }: { runner: Runner }) {
  const t = useT();
  return (
    <span className="bg-hover text-ink-soft inline-flex h-6 items-center gap-1.5 justify-self-start rounded-full px-2 text-xs font-medium [&_svg]:size-3.5">
      {runner === "local" ? <TerminalIcon /> : <BotIcon />}
      {t(runner === "local" ? "workflows.runner.local" : "workflows.runner.server")}
    </span>
  );
}

/** The three environments' icons: the company's AI, a sandbox, a person's computer. */
export const ENV_ICON: Record<EnvKind, React.ReactNode> = { assistant: <BotIcon />, sandbox: <ShieldIcon />, computer: <TerminalIcon /> };

/**
 * Where a workflow runs, with what matters about it: "Company AI", "Sandbox · container · no network",
 * "Assignee's computer". `detail` false keeps only the name.
 */
export function EnvBadge({ env, detail = true, className }: { env: Pick<Environment, "kind" | "isolation" | "network" | "host">; detail?: boolean; className?: string }) {
  const t = useT();
  const parts = [t(`workflows.env.${env.kind}`)];
  if (detail && env.kind === "sandbox") {
    parts.push(t(env.isolation === "container" ? "workflows.env.container" : "workflows.env.folder"));
    if (env.isolation === "container" && env.network === "off") parts.push(t("workflows.env.noNetwork"));
    if (env.host === "company") parts.push(t("workflows.env.companyRunner"));
  }
  return (
    <span
      className={cx(
        "bg-hover text-ink-soft inline-flex h-6 min-w-0 items-center gap-1.5 justify-self-start rounded-full px-2 text-xs font-medium [&_svg]:size-3.5 [&_svg]:shrink-0",
        className,
      )}
    >
      {ENV_ICON[env.kind]}
      <span className="truncate">{parts.join(" · ")}</span>
    </span>
  );
}

/** The steps as a chain of small pills, so a pipeline reads at a glance. */
export function StepChain({ steps }: { steps: { title: string; kind: StepKind }[] }) {
  return (
    <ol className="m-0 flex list-none flex-wrap items-center gap-1 p-0">
      {steps.map((s, i) => (
        <li key={i} className="flex items-center gap-1">
          {i ? (
            <span className="text-ink-2 text-xs" aria-hidden="true">
              →
            </span>
          ) : null}
          <span className="bg-ground ring-hairline text-ink-soft inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs ring-1 ring-inset [&_svg]:size-3">
            {STEP_ICON[s.kind]}
            {s.title}
          </span>
        </li>
      ))}
    </ol>
  );
}

export const RUN_TONE: Record<RunStatus, string> = {
  queued: "bg-hover text-ink-soft",
  running: "bg-accent-wash text-accent-text",
  waiting_approval: "bg-warn-wash text-warn",
  // Waiting for people too (their answers), so the same tone; the chip's label and the bot mark tell it apart.
  waiting_input: "bg-warn-wash text-warn",
  paused: "bg-selected text-ink-soft",
  done: "bg-ok-wash text-ok",
  failed: "bg-block-wash text-block",
  cancelled: "bg-hover text-ink-2",
};

export function RunStatusChip({ status }: { status: RunStatus }) {
  const t = useT();
  return (
    <span className={cx("inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 text-xs font-medium", RUN_TONE[status])}>
      {status === "running" ? <span className="size-1.5 animate-pulse rounded-full bg-current" aria-hidden="true" /> : null}
      {status === "waiting_input" ? <BotIcon className="size-3.5" aria-hidden="true" /> : null}
      {status === "paused" ? <PauseMark /> : null}
      {t(`workflows.status.${status}`)}
    </span>
  );
}

/** Two short bars: a paused run, or the stage it holds before. */
export function PauseMark({ className }: { className?: string }) {
  return (
    <span aria-hidden="true" className={cx("inline-flex h-2.5 gap-[2px]", className)}>
      <span className="w-[3px] rounded-[1px] bg-current" />
      <span className="w-[3px] rounded-[1px] bg-current" />
    </span>
  );
}

/** A step's state as a small round mark: empty, pulsing, ticked, crossed, paused. */
export function StepMark({ state }: { state: RunStep["state"] }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        "grid size-5 shrink-0 place-items-center rounded-full border text-[11px] font-bold",
        state === "done" && "bg-ok border-ok text-on-brand",
        state === "failed" && "bg-block border-block text-on-brand",
        state === "running" && "border-accent bg-accent-wash",
        state === "waiting" && "border-warn bg-warn-wash text-warn",
        (state === "pending" || state === "skipped") && "border-hairline bg-surface",
      )}
    >
      {state === "done" ? (
        "✓"
      ) : state === "failed" ? (
        "✕"
      ) : state === "waiting" ? (
        "‖"
      ) : state === "running" ? (
        <span className="bg-accent size-2 animate-pulse rounded-full" />
      ) : null}
    </span>
  );
}

/** Each step kind's tint (identity, like the category's): the AI violet, a command sky, a person orange, a move green. */
export const STEP_TONE: Record<StepKind, Tone> = { ai: "violet", command: "sky", check: "rose", approval: "tangerine", status: "green" };

/** A step as a round tinted node with its kind's icon. */
export function StepNode({ kind, size = "md", className }: { kind: StepKind; size?: "sm" | "md" | "lg"; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        "ring-current/15 relative z-[1] grid shrink-0 place-items-center rounded-full ring-1 ring-inset",
        TONE[STEP_TONE[kind]],
        size === "sm" ? "size-6 [&_svg]:size-3" : size === "lg" ? "size-10 [&_svg]:size-[18px]" : "size-9 [&_svg]:size-4",
        className,
      )}
    >
      {STEP_ICON[kind]}
    </span>
  );
}

const SEGMENT: Record<RunStep["state"], string> = {
  done: "bg-ok-fill",
  running: "bg-accent motion-safe:animate-pulse",
  waiting: "bg-warn-fill",
  failed: "bg-block",
  pending: "bg-progress-track",
  skipped: "bg-progress-track",
};

/** A run's steps as one segmented bar: done green, the running one blue (pulsing), waiting orange, failed red. */
export function StepBar({ steps, className }: { steps: Pick<RunStep, "state" | "title">[]; className?: string }) {
  return (
    <span aria-hidden="true" className={cx("flex h-1.5 min-w-0 gap-0.5", className)}>
      {steps.map((s, i) => (
        <span key={i} title={s.title} className={cx("min-w-1 flex-1 rounded-full", SEGMENT[s.state] ?? SEGMENT.pending)} />
      ))}
    </span>
  );
}

/**
 * A message whose «…» parts name a pipeline step: each is drawn as a bold tinted chip instead of the guillemets, so
 * "Mình đã làm xong «Check»" reads with the step standing out.
 */
export function Quoted({ text }: { text: string }) {
  const parts = text.split(/«([^»]+)»/g);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 ? (
          <span key={i} className="bg-violet-wash text-violet-text mx-0.5 inline-block rounded-md px-1.5 font-semibold leading-snug">
            {p}
          </span>
        ) : (
          p
        ),
      )}
    </>
  );
}
