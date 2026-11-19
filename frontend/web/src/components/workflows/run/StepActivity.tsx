"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import { useFormat, useT } from "@/lib/i18n/client";
import { cx } from "@/lib/ui";
import { BotIcon, CheckIcon, FileIcon, GlobeIcon, InfoIcon, PencilIcon, SearchIcon, SparkleIcon, TerminalIcon, UsersIcon, ChecklistIcon } from "@/components/app/icons";
import type { StepActivity as Line } from "../types";
import { TOOL_VERBS, useToolName, type ToolVerb } from "./doing";

const ICONS: Record<ToolVerb, React.ReactNode> = {
  read: <FileIcon />,
  write: <PencilIcon />,
  edit: <PencilIcon />,
  run: <TerminalIcon />,
  search: <SearchIcon />,
  open: <GlobeIcon />,
  web: <GlobeIcon />,
  helper: <UsersIcon />,
  plan: <ChecklistIcon />,
};

/** An action in words and its mark: what it does (or the tool's own name). */
function useToolLabel() {
  const name = useToolName();
  return (tool: string | null) => {
    const verb = tool ? TOOL_VERBS[tool] : undefined;
    return { name: name(tool), icon: verb ? ICONS[verb] : <SparkleIcon /> };
  };
}

/**
 * A step's activity from the server: all of it once, then, while the step works, the lines after the last one every
 * couple of seconds. A draft (the answer as it is written) replaces the one before it. A failed read leaves what is
 * shown and tries again on the next turn: the feed is a view of the step, never a reason for the page to fail.
 */
export function useStepActivity(runId: string | undefined, step: number, live: boolean) {
  const key = runId && step >= 0 ? `${runId}:${step}` : "";
  const [state, setState] = useState<{ key: string; events: Line[]; earlier: boolean }>({ key: "", events: [], earlier: false });
  useEffect(() => {
    if (!key) return;
    let stop = false;
    let timer = 0;
    let last = 0;
    const load = async () => {
      const r = await api<{ events: Line[]; more: boolean }>(`work/runs/${runId}/activity?step=${step}${last ? `&after=${last}` : ""}`).catch(() => null);
      if (stop) return;
      if (r) {
        const first = !last;
        if (r.events.length) last = r.events[r.events.length - 1]!.id;
        const redraft = r.events.some((e) => e.kind === "draft");
        setState((prev) =>
          first || prev.key !== key
            ? { key, events: r.events, earlier: first && r.more }
            : r.events.length
              ? { ...prev, events: [...prev.events.filter((e) => !redraft || e.kind !== "draft"), ...r.events].slice(-1500) }
              : prev,
        );
      }
      if (live) timer = window.setTimeout(() => void load(), r?.more && last ? 200 : 2000);
    };
    void load();
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, [key, runId, step, live]);
  return state.key === key ? state : { key, events: [] as Line[], earlier: false };
}

type Row = { line: Line; end?: Line };
/** An action and how it ended are one row: the result (or the error) that follows a tool belongs to it. */
function rows(events: Line[], live: boolean): Row[] {
  const out: Row[] = [];
  for (const e of events) {
    // The answer being written only means something while the step works.
    if (e.kind === "draft" && !live) continue;
    const prev = out[out.length - 1];
    if ((e.kind === "result" || e.kind === "error") && prev && prev.line.kind === "tool" && !prev.end && (!e.tool || e.tool === prev.line.tool)) prev.end = e;
    else if (e.kind !== "result") out.push({ line: e });
  }
  return out;
}

const mono = "font-mono text-[12px]/5";
const box = "text-ink-soft bg-ground ring-hairline m-0 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg px-3 py-2 ring-1 ring-inset";

/**
 * What the agent did in a step, a line per action:
 * the files it reads and changes, the commands it runs and what they printed, what it searches, the company tools it
 * calls, its own words in between, and, for the company's AI, the answer as it is written. Each attempt of the step
 * opens with a line; while the step works the feed grows and stays at its end unless the reader scrolled up.
 */
export function StepActivityFeed({
  events,
  live,
  earlier,
  className,
  untimed,
}: {
  events: Line[];
  live: boolean;
  earlier?: boolean;
  className?: string;
  /** The rows sit in a list that already says the time (the run's timeline). */
  untimed?: boolean;
}) {
  const t = useT();
  const { time } = useFormat();
  const label = useToolLabel();
  const end = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const list = rows(events, live);
  useEffect(() => {
    const el = end.current;
    if (!el) return;
    const io = new IntersectionObserver(([x]) => (atEnd.current = !!x?.isIntersecting), { threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const lastId = events[events.length - 1]?.id;
  useEffect(() => {
    if (live && atEnd.current) end.current?.scrollIntoView({ block: "nearest" });
  }, [lastId, live]);
  if (!list.length) return null;
  let attempt = 0;
  let shown = "";
  const starts = list.filter((r) => r.line.kind === "start").length;
  return (
    <div className={cx("grid min-w-0", className)}>
      {earlier ? <p className="text-ink-2 m-0 pb-2 text-xs">{t("workflows.activity.earlier")}</p> : null}
      <ol aria-label={t("workflows.activity.title")} className="m-0 grid min-w-0 list-none gap-0.5 p-0">
        {list.map(({ line: e, end: res }) => {
          // The time once per minute: a column of the same figure says nothing.
          const at = time(e.at);
          const stamp = untimed || at === shown ? "" : (shown = at);
          const failed = res?.kind === "error";
          if (e.kind === "start") {
            attempt += 1;
            return (
              <li key={e.id} className={cx("flex min-w-0 items-center gap-2 pb-1 text-xs", attempt > 1 && "border-divider mt-2 border-t pt-3")}>
                <span className="text-ink-2 font-medium">{starts > 1 ? t("workflows.pipeline.history.attempt", { n: attempt }) : t("workflows.activity.started")}</span>
                <span className="text-ink-2 tabular-nums">{at}</span>
                {e.text ? <code className={cx(mono, "text-ink-soft min-w-0 truncate")}>{e.text}</code> : null}
              </li>
            );
          }
          if (e.kind === "draft")
            return (
              <li key="draft" className="grid min-w-0 grid-cols-[2.75rem_1.25rem_minmax(0,1fr)] items-start gap-x-2 py-1 max-sm:grid-cols-[1.25rem_minmax(0,1fr)]">
                <span className="text-ink-2 pt-px text-[11px]/5 tabular-nums max-sm:hidden">{stamp}</span>
                <Mark tone="accent">
                  <PencilIcon />
                </Mark>
                <div className="grid min-w-0 gap-1.5">
                  <span className="text-accent-text text-[13px]/5 font-medium">{t("workflows.activity.writing")}</span>
                  {/* The latest of it, fading in from above: it reads as text arriving, not as a result to rely on. */}
                  <p className="text-ink-soft m-0 max-h-40 overflow-hidden whitespace-pre-wrap break-words text-[13px]/5 [mask-image:linear-gradient(to_bottom,transparent,black_35%)]">
                    {(e.detail ?? e.text).slice(-600)}
                  </p>
                </div>
              </li>
            );
          if (e.kind === "tool") {
            const tool = label(e.tool);
            // What adds to the line itself: the whole command when it was cut, what it printed, the error.
            const more = [e.detail, res?.detail].filter((x) => x && x.trim() !== e.text.trim() && x.trim() !== res?.text.trim());
            const head = (
              <>
                <span className="text-ink shrink-0 text-[13px]/5 font-medium">{tool.name}</span>
                {e.text ? <code className={cx(mono, "text-ink-soft min-w-0 truncate")}>{e.text}</code> : null}
                {res ? (
                  <span className={cx("ml-auto flex min-w-0 shrink items-center gap-1 pl-2 text-xs", failed ? "text-block" : "text-ink-2")}>
                    {failed ? <span aria-hidden="true">✕</span> : <CheckIcon className="text-ok size-3 shrink-0" />}
                    <span className={cx("truncate", !failed && "max-sm:hidden")}>{failed ? res.text || t("workflows.pipeline.state.failed") : res.text}</span>
                  </span>
                ) : live ? (
                  <span className="bg-accent ml-auto size-1.5 shrink-0 rounded-full motion-safe:animate-pulse" aria-hidden="true" />
                ) : null}
              </>
            );
            return (
              <li key={e.id} className="grid min-w-0 grid-cols-[2.75rem_1.25rem_minmax(0,1fr)] items-start gap-x-2 py-1 max-sm:grid-cols-[1.25rem_minmax(0,1fr)]">
                <span className="text-ink-2 pt-px text-[11px]/5 tabular-nums max-sm:hidden">{stamp}</span>
                <Mark tone={failed ? "block" : "plain"}>{tool.icon}</Mark>
                {more.length ? (
                  <details className="group min-w-0">
                    <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden" title={e.text}>
                      {head}
                    </summary>
                    <div className="mt-1.5 grid gap-1.5 pb-1">
                      {more.map((x, i) => (
                        <pre key={i} className={cx(box, mono)}>
                          {x}
                        </pre>
                      ))}
                    </div>
                  </details>
                ) : (
                  <div className="flex min-w-0 items-center gap-2" title={e.text}>
                    {head}
                  </div>
                )}
              </li>
            );
          }
          const error = e.kind === "error";
          return (
            <li key={e.id} className="grid min-w-0 grid-cols-[2.75rem_1.25rem_minmax(0,1fr)] items-start gap-x-2 py-1 max-sm:grid-cols-[1.25rem_minmax(0,1fr)]">
              <span className="text-ink-2 pt-px text-[11px]/5 tabular-nums max-sm:hidden">{stamp}</span>
              <Mark tone={error ? "block" : e.kind === "say" ? "violet" : "plain"}>{error ? <span>✕</span> : e.kind === "say" ? <BotIcon /> : <InfoIcon />}</Mark>
              <div className="grid min-w-0 gap-1.5">
                <p className={cx("m-0 whitespace-pre-wrap break-words text-[13px]/5", error ? "text-block" : e.kind === "say" ? "text-ink" : "text-ink-2")}>
                  {e.tool && error ? <span className="font-medium">{label(e.tool).name}: </span> : null}
                  {e.text}
                </p>
                {e.detail && e.detail.trim() !== e.text.trim() ? (
                  <details>
                    <summary className="text-ink-2 hover:text-ink cursor-pointer text-xs font-medium">{t("workflows.activity.details")}</summary>
                    <pre className={cx(box, mono, "mt-1.5")}>{e.detail}</pre>
                  </details>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      {live ? (
        <p role="status" className="text-accent-text m-0 flex items-center gap-2 pl-[3.25rem] pt-2 text-xs font-medium max-sm:pl-0">
          <span className="relative grid size-2.5 place-items-center" aria-hidden="true">
            <span className="bg-accent/40 absolute inset-0 rounded-full motion-safe:animate-ping" />
            <span className="bg-accent relative size-1.5 rounded-full" />
          </span>
          {t("workflows.activity.live")}
        </p>
      ) : null}
      <div ref={end} />
    </div>
  );
}

function Mark({ tone, children }: { tone: "plain" | "accent" | "violet" | "block"; children: React.ReactNode }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        "grid size-5 shrink-0 place-items-center rounded-md text-[11px] font-semibold [&_svg]:size-3",
        tone === "plain" && "bg-hover text-ink-soft",
        tone === "accent" && "bg-accent-wash text-accent-text",
        tone === "violet" && "bg-violet-wash text-violet-text",
        tone === "block" && "bg-block-wash text-block",
      )}
    >
      {children}
    </span>
  );
}

/** The activity as plain text, for Copy. */
export function activityText(events: Line[]): string {
  return events
    .filter((e) => e.kind !== "draft")
    .map((e) => [e.at, e.kind, e.tool, e.text, e.detail && `\n${e.detail}`].filter(Boolean).join(" "))
    .join("\n");
}
