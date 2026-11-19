"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/client";
import { useFormat, useT } from "@/lib/i18n/client";
import { Markdown } from "@/lib/markdown";
import { useDirectory } from "@/lib/people";
import { btn, btnGhost, btnSm, cx } from "@/lib/ui";
import { ApprovalIcon, BotIcon, CheckIcon, ClockIcon, LinkIcon, PlayIcon, UsersIcon } from "@/components/app/icons";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { AskHistory } from "../AskHistory";
import { ENV_ICON, PauseMark, RunStatusChip, StepNode } from "../bits";
import { duration, useKindLabel } from "../Graph";
import { useEntryLabel } from "../StepLog";
import type { StepActivity } from "../types";
import { useDuration } from "./eta";
import type { TaskRun } from "./helpers";
import { RunArtifacts } from "./RunArtifacts";
import { useEnvFacts } from "./RunEnvironment";
import { StepActivityFeed } from "./StepActivity";
import { buildTimeline, momentAt, momentFor, playClock, type Moment } from "./timeline";

const SPEEDS = [1, 2, 4] as const;
/** The time is said once per minute down the list. */
const minute = (ms: number) => Math.floor(ms / 60_000);
const TICK = 100;
/** Pages of the run's activity read for one timeline (1,000 lines each): a run longer than this opens on its start. */
const MAX_PAGES = 12;
const OUTCOME_TONE: Record<string, string> = {
  done: "bg-ok-wash text-ok",
  asked: "bg-violet-wash text-violet-text",
  decide: "bg-warn-wash text-warn",
  failed: "bg-block-wash text-block",
  cancelled: "bg-hover text-ink-2",
  timeout: "bg-warn-wash text-warn",
};

/**
 * A run from start to finish as one timeline: who started it and with what, the
 * environment, each step's attempts with what the agent did, the checks' verdicts and what they sent back, the
 * questions and people's answers, approvals, retries, and what was delivered. It reads top to bottom as it is; Play
 * walks through it at the run's own pace with the long waits cut short, and the bar moves to any moment. A moment has
 * a link, so "look at this step" can be sent to someone. For teaching how a workflow goes and for answering "why did
 * the result come out like this".
 *
 * Loaded on demand from the pipeline (RunPipeline): it adds nothing to the pipeline's first paint.
 */
export default function RunReplay({
  run,
  at,
  jump,
  onStep,
}: {
  run: TaskRun;
  /** The moment to open on (the run's real time in ms), from a link. */
  at?: number | undefined;
  /** A stage picked on the pipeline's track: the timeline moves to its first moment. `n` changes on every pick. */
  jump?: { step: number; n: number } | undefined;
  /** Playback reached another step: the track follows. */
  onStep?: ((step: number) => void) | undefined;
}) {
  const t = useT();
  const { time, shortDate } = useFormat();
  const [events, setEvents] = useState<StepActivity[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [cut, setCut] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const all: StepActivity[] = [];
      let more = true;
      for (let page = 0; more && page < MAX_PAGES; page++) {
        const last = all[all.length - 1]?.id;
        const r = await api<{ events: StepActivity[]; more: boolean }>(`work/runs/${run.id}/timeline${last ? `?after=${last}` : ""}`);
        all.push(...r.events);
        more = r.more && r.events.length > 0;
      }
      setCut(more);
      setEvents(all);
    } catch {
      setFailed(true);
    }
    // The run's state is what changes while it works: the lines are read again when it moves on.
  }, [run.id]);
  useEffect(() => void load(), [load, run.status, run.currentStep]);

  const moments = useMemo(() => buildTimeline(run, events ?? []), [run, events]);
  const clock = useMemo(() => playClock(moments), [moments]);
  // Where playback is, on its own clock; null until someone plays or picks a moment: the whole run is simply shown.
  const [pos, setPos] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const cur = pos === null ? moments.length - 1 : momentAt(clock, pos);
  const rows = useRef(new Map<number, HTMLLIElement>());

  const go = useCallback(
    (i: number) => {
      setPlaying(false);
      setPos(clock.at[Math.max(0, Math.min(i, moments.length - 1))] ?? 0);
    },
    [clock, moments.length],
  );
  // A link's moment, once the run's lines are in.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || at === undefined || !events) return;
    opened.current = true;
    go(momentFor(moments, at));
  }, [at, events, moments, go]);
  // A stage picked on the track.
  const jumped = useRef(jump?.n);
  useEffect(() => {
    if (!jump || jump.n === jumped.current) return;
    jumped.current = jump.n;
    const i = moments.findIndex((m) => m.step === jump.step);
    if (i >= 0) go(i);
  }, [jump, moments, go]);

  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      setPos((p) => {
        const next = (p ?? 0) + TICK * speed;
        if (next >= clock.total) {
          setPlaying(false);
          return clock.total;
        }
        return next;
      });
    }, TICK);
    return () => window.clearInterval(id);
  }, [playing, speed, clock.total]);
  useEffect(() => {
    if (pos === null) return;
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    rows.current.get(cur)?.scrollIntoView({ block: "center", behavior: calm || playing ? "auto" : "smooth" });
    // Only when the moment changes, not on every tick of the clock.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur, pos === null]);

  const atStep = pos === null ? undefined : moments[cur]?.step;
  useEffect(() => {
    if (atStep !== undefined && atStep >= 0) onStep?.(atStep);
  }, [atStep, onStep]);

  const play = () => {
    if (pos === null || pos >= clock.total) setPos(0);
    setPlaying(true);
  };
  const copy = () => {
    const m = moments[cur];
    if (!m) return;
    const url = new URL(window.location.href);
    url.searchParams.set("run", run.id);
    url.searchParams.set("at", String(m.at));
    void navigator.clipboard.writeText(url.toString()).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  };

  if (failed && !events) return <LoadFailed what={t("workflows.replay.title")} className="px-5 py-6" onRetry={() => void load()} />;
  const now = moments[cur];
  const stepTitle = now && now.step >= 0 ? run.steps[now.step]?.title : "";
  return (
    <section aria-label={t("workflows.replay.title")} className="flex min-h-0 flex-1 flex-col">
      {/* Where playback is, and the way to any moment. */}
      <div className="border-hairline flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-5 py-2.5 max-sm:px-4">
        <div className="flex items-center gap-1.5 motion-reduce:hidden">
          <button type="button" className={cx(btn, btnSm)} onClick={() => (playing ? setPlaying(false) : play())} disabled={moments.length < 2}>
            {playing ? <PauseMark className="h-3" /> : <PlayIcon />}
            {t(playing ? "workflows.replay.pause" : "workflows.replay.play")}
          </button>
          <button
            type="button"
            className={cx(btnGhost, btnSm, "tabular-nums")}
            aria-label={t("workflows.replay.speed", { n: speed })}
            onClick={() => setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]!)}
          >
            {speed}×
          </button>
        </div>
        <input
          type="range"
          className="accent-accent h-1.5 min-w-32 flex-1 cursor-pointer"
          aria-label={t("workflows.replay.scrub")}
          aria-valuetext={now ? `${time(new Date(now.at).toISOString())}${stepTitle ? ` · ${stepTitle}` : ""}` : undefined}
          min={0}
          max={Math.max(1, clock.total)}
          step={50}
          value={pos ?? clock.total}
          onChange={(e) => {
            setPlaying(false);
            setPos(Number(e.target.value));
          }}
        />
        <p className="text-ink-2 m-0 min-w-0 truncate text-xs tabular-nums max-sm:order-last max-sm:w-full">
          {now ? (
            <>
              <span className="text-ink font-medium">{time(new Date(now.at).toISOString())}</span>
              {stepTitle ? ` · ${stepTitle}` : ""} · {t("workflows.replay.moment", { n: cur + 1, count: moments.length })}
            </>
          ) : null}
        </p>
        <button type="button" className={cx(btnGhost, btnSm)} onClick={copy} title={t("workflows.replay.linkHint")}>
          {copied ? <CheckIcon className="text-ok" /> : <LinkIcon />}
          {t(copied ? "workflows.replay.copied" : "workflows.replay.link")}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {events === null ? (
          <div aria-hidden="true" className="grid max-w-3xl gap-2.5 px-5 py-5 max-sm:px-4">
            <span className="shimmer h-3 w-2/5 rounded-full" />
            <span className="shimmer h-3 w-4/5 rounded-full" />
            <span className="shimmer h-3 w-3/5 rounded-full" />
          </div>
        ) : (
          <ol className="m-0 grid max-w-3xl list-none gap-0.5 px-5 pb-8 pt-3 max-sm:px-4">
            {moments.map((m, i) => {
              const head = m.step >= 0 && m.step !== moments[i - 1]?.step ? run.steps[m.step] : undefined;
              const day = i === 0 || new Date(m.at).toDateString() !== new Date(moments[i - 1]!.at).toDateString();
              return (
                <li
                  key={m.id}
                  ref={(el) => {
                    if (el) rows.current.set(i, el);
                    else rows.current.delete(i);
                  }}
                  aria-current={pos !== null && i === cur ? "step" : undefined}
                  className={cx("min-w-0 scroll-my-16 transition-opacity duration-200", pos !== null && i > cur && "opacity-30")}
                >
                  {day ? <p className="text-ink-2 m-0 pb-1 pt-2 text-xs font-medium">{shortDate(new Date(m.at).toISOString())}</p> : null}
                  {head ? <StepHead run={run} index={m.step} /> : null}
                  {/* A moment is picked by pressing it; what is inside (a link, a folded detail) keeps working. */}
                  <div
                    onClick={(e) => {
                      if ((e.target as HTMLElement).closest("a,button,summary,details")) return;
                      go(i);
                    }}
                    className={cx(
                      "-mx-2 min-w-0 cursor-pointer rounded-lg border-l-2 px-2 py-0.5 transition-colors",
                      pos !== null && i === cur ? "border-accent bg-accent-wash/40" : "hover:bg-hover/60 border-transparent",
                      m.step >= 0 && "ml-3",
                    )}
                  >
                    <MomentRow m={m} run={run} timed={i === 0 || day || minute(m.at) !== minute(moments[i - 1]!.at)} />
                  </div>
                </li>
              );
            })}
            {cut ? <li className="text-ink-2 pt-3 text-xs">{t("workflows.replay.cut")}</li> : null}
            {failed ? (
              <li className="pt-3">
                <LoadFailed what={t("workflows.replay.title")} onRetry={() => void load()} />
              </li>
            ) : null}
          </ol>
        )}
      </div>
    </section>
  );
}

/** A step's first moment opens with what the step is. */
function StepHead({ run, index }: { run: TaskRun; index: number }) {
  const t = useT();
  const kind = useKindLabel();
  const s = run.steps[index]!;
  return (
    <div className="flex min-w-0 items-center gap-2.5 pb-1 pt-4">
      <StepNode kind={s.kind} size="sm" />
      <p className="m-0 min-w-0 truncate text-[13px]">
        <span className="text-ink font-semibold">{s.title}</span>
        <span className="text-ink-2">
          {" "}
          · {t("workflows.pipeline.stepOf", { n: index + 1, count: run.steps.length })} · {kind(s, run.runner)}
        </span>
      </p>
    </div>
  );
}

const line = "grid min-w-0 grid-cols-[2.75rem_1.25rem_minmax(0,1fr)] items-start gap-x-2 py-1 max-sm:grid-cols-[1.25rem_minmax(0,1fr)]";
const stamp = "text-ink-2 pt-px text-[11px]/5 tabular-nums max-sm:hidden";
const mark = "grid size-5 shrink-0 place-items-center rounded-md text-[11px] font-semibold [&_svg]:size-3";
const pre = "text-ink-soft bg-ground ring-hairline m-0 max-h-72 overflow-auto rounded-lg px-3 py-1 text-[13px]/5 ring-1 ring-inset";

/** One moment in words, with the pieces the pipeline already draws (the activity rows, a round of questions, what was delivered). */
function MomentRow({ m, run, timed }: { m: Moment; run: TaskRun; timed: boolean }) {
  const t = useT();
  const { time } = useFormat();
  const dir = useDirectory();
  const words = useDuration();
  const label = useEntryLabel();
  const envFacts = useEnvFacts();
  const at = time(new Date(m.at).toISOString());
  const step = m.step >= 0 ? run.steps[m.step] : undefined;

  if (m.kind === "activity") return <StepActivityFeed events={m.events} live={false} untimed={!timed} />;
  if (m.kind === "asked") return <AskHistory rounds={[m.round]} />;
  if (m.kind === "gap")
    return (
      <p className="text-ink-2 m-0 flex items-center gap-2 py-1.5 pl-[3.25rem] text-xs max-sm:pl-0">
        <span aria-hidden="true" className="bg-edge h-px w-6" />
        {m.people ? <UsersIcon className="size-3.5" /> : <ClockIcon className="size-3.5" />}
        {t(m.people ? "workflows.replay.gapPeople" : "workflows.replay.gap", { d: words(m.ms / 1000) })}
      </p>
    );

  let icon: React.ReactNode = <ClockIcon />;
  let tone = "bg-hover text-ink-soft";
  let body: React.ReactNode = null;
  if (m.kind === "started") {
    icon = <PlayIcon />;
    tone = "bg-accent-wash text-accent-text";
    body = (
      <>
        <p className="text-ink m-0 text-[13px]/5 font-medium">{t("workflows.replay.started", { name: dir.name(m.by), workflow: run.workflowName })}</p>
        {m.inputs.length ? (
          <dl className="m-0 mt-1 grid min-w-0 gap-1">
            {m.inputs.map(([k, v]) => (
              <div key={k} className="flex min-w-0 gap-2 text-[13px]/5">
                <dt className="text-ink-2 shrink-0">{k}</dt>
                <dd className="text-ink m-0 min-w-0 whitespace-pre-wrap break-words">{v}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </>
    );
  } else if (m.kind === "env" && run.env) {
    icon = ENV_ICON[run.config?.environment.kind ?? "sandbox"];
    tone = m.state === "failed" ? "bg-block-wash text-block" : "bg-sky-wash text-sky-text";
    body = (
      <p className={cx("m-0 text-[13px]/5", m.state === "failed" ? "text-block" : "text-ink")}>
        <span className="font-medium">{t(`workflows.run.env.${m.state}`)}</span>
        <span className="text-ink-2"> · {envFacts(run.env, run.claimedBy).join(" · ")}</span>
      </p>
    );
  } else if (m.kind === "attempt") {
    icon = step?.kind === "ai" || step?.kind === "check" ? <BotIcon /> : <PlayIcon />;
    body = (
      <p className="text-ink-2 m-0 flex min-w-0 items-center gap-2 text-xs/5 font-medium">
        {t("workflows.pipeline.history.attempt", { n: m.n })}
        {m.text ? <code className="text-ink-soft min-w-0 truncate font-mono text-[12px] font-normal">{m.text}</code> : null}
      </p>
    );
  } else if (m.kind === "ended") {
    const e = m.entry;
    const secs = e.end ? (Date.parse(e.end) - Date.parse(e.at)) / 1000 : 0;
    icon = e.outcome === "done" ? <CheckIcon /> : e.outcome === "asked" ? <UsersIcon /> : <span>✕</span>;
    tone = OUTCOME_TONE[e.outcome ?? "done"] ?? tone;
    body = (
      <>
        <p className="m-0 flex min-w-0 flex-wrap items-center gap-x-2 text-xs/5">
          <span className={cx("rounded px-1.5 font-medium", OUTCOME_TONE[e.outcome ?? "done"])}>{t(`workflows.pipeline.history.outcome.${e.outcome ?? "done"}`)}</span>
          <span className="text-ink-2 tabular-nums">
            {t("workflows.pipeline.history.attempt", { n: m.n })}
            {secs > 0 ? ` · ${duration(secs)}` : ""}
          </span>
          {e.ran?.model ? <code className="text-ink-2 font-mono text-[11.5px]">{e.ran.model}</code> : null}
        </p>
        {e.text ? <p className="text-block m-0 mt-0.5 text-[13px]/5">{e.text}</p> : null}
        {e.output && step?.kind !== "check" ? (
          <details className="mt-1" open={e.outcome !== "done"}>
            <summary className="text-ink-2 hover:text-ink cursor-pointer text-xs font-medium">{t("workflows.pipeline.history.output")}</summary>
            <div className={cx(pre, "mt-1.5")}>
              <Markdown source={e.output} />
            </div>
          </details>
        ) : null}
      </>
    );
  } else if (m.kind === "note") {
    const e = m.entry;
    const bad = e.kind === "sent_back" || e.kind === "rework" || (e.kind === "checked" && e.outcome !== "done");
    icon =
      e.kind === "approved" ? (
        <ApprovalIcon />
      ) : e.kind === "checked" && e.outcome === "done" ? (
        <CheckIcon />
      ) : e.kind === "answered" || e.kind === "skipped" ? (
        <UsersIcon />
      ) : (
        <span>↺</span>
      );
    tone = e.kind === "approved" || (e.kind === "checked" && e.outcome === "done") ? "bg-ok-wash text-ok" : bad ? "bg-rose-wash text-rose-text" : "bg-warn-wash text-warn";
    body = (
      <>
        <p className={cx("m-0 text-[13px]/5 font-medium", bad ? "text-rose-text" : "text-ink")}>{label(e, step ?? {})}</p>
        {e.text ? <p className="text-ink-soft m-0 mt-0.5 whitespace-pre-wrap break-words text-[13px]/5">{e.text}</p> : null}
      </>
    );
  } else if (m.kind === "awaiting") {
    icon = <ApprovalIcon />;
    tone = "bg-warn-wash text-warn";
    body = <p className="text-ink m-0 text-[13px]/5">{t("workflows.replay.awaiting")}</p>;
  } else if (m.kind === "finished") {
    icon = m.status === "done" ? <CheckIcon /> : <span>✕</span>;
    tone = m.status === "done" ? "bg-ok-wash text-ok" : m.status === "failed" ? "bg-block-wash text-block" : "bg-hover text-ink-2";
    body = (
      <div className="grid min-w-0 gap-2">
        <p className="m-0 flex items-center gap-2 text-[13px]/5">
          <span className="text-ink font-medium">{t("workflows.replay.finished")}</span>
          <RunStatusChip status={m.status} />
        </p>
        {m.error ? <p className="text-block m-0 whitespace-pre-wrap break-words text-[13px]/5">{m.error}</p> : null}
        <RunArtifacts run={run} />
      </div>
    );
  }
  return (
    <div className={line}>
      <span className={stamp}>{timed ? at : ""}</span>
      <span aria-hidden="true" className={cx(mark, tone)}>
        {icon}
      </span>
      <div className="min-w-0">{body}</div>
    </div>
  );
}
