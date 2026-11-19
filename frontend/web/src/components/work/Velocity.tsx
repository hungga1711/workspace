"use client";

import { numberFormat } from "@/lib/intl";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";
import { useFormat, useT } from "@/lib/i18n/client";
import { INTL_TAG } from "@/lib/i18n/config";
import { Avatar } from "@/lib/people";
import { btn, btnSm, card, cx } from "@/lib/ui";
import { taskHref } from "@/lib/links";
import { Bars } from "@/components/ui/charts";

/*
 * The pace of a slice of work (backend work/velocity.ts), shown instead of "% done". On a board work is
 * added at any time, so done ÷ total falls while a team ships; what the boss can act on is how much got done and how
 * much came in each week, what is in flight, and what has not moved.
 */

export interface VelocityWeek {
  week: string;
  done: number;
  added: number;
  cycleDays: number | null;
}

export interface AttentionTask {
  id: string;
  code: string;
  title: string;
  status: string;
  assigneeId: string | null;
  dueAt: string | null;
  since: string | null;
  reason: "overdue" | "stuck";
}

export interface VelocityData {
  weeks: VelocityWeek[];
  now: { inProgress: number; review: number; stuck: number; overdue: number; open: number };
  thisWeek: { done: number; added: number };
  stuckDays: number;
  attention: AttentionTask[];
  /** Done since Monday, newest first (up to ten the viewer may read). */
  finished: { id: string; code: string; title: string; assigneeId: string | null }[];
}

/** The per-project pace from GET work/projects (8 weeks, oldest first). */
export interface ProjectFlow {
  done: number[];
  added: number[];
  thisWeek: { done: number; added: number };
  inProgress: number;
  stuck: number;
}

/** "This week: 12 done · 8 added · 6 in progress · 3 stuck": the one line that replaces a percentage. */
export function FlowLine({
  done,
  added,
  inProgress,
  stuck,
  overdue,
  stuckDays = 7,
  className,
}: {
  done: number;
  added: number;
  inProgress: number;
  stuck: number;
  overdue?: number;
  stuckDays?: number;
  className?: string;
}) {
  const t = useT();
  const parts: React.ReactNode[] = [
    <span key="d" className="text-ink font-medium">
      {t("flow.done", { count: done })}
    </span>,
    <span key="a">{t("flow.added", { count: added })}</span>,
    <span key="p">{t("flow.inProgress", { count: inProgress })}</span>,
  ];
  if (stuck)
    parts.push(
      <span key="s" className="text-warn font-medium" title={t("flow.stuckHint", { days: stuckDays })}>
        {t("flow.stuck", { count: stuck })}
      </span>,
    );
  if (overdue)
    parts.push(
      <span key="o" className="text-block font-medium">
        {t("flow.overdue", { count: overdue })}
      </span>,
    );
  return (
    <p className={cx("text-ink-2 m-0 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-[13px] tabular-nums", className)}>
      <span className="text-ink-2">{t("flow.thisWeek")}:</span>
      {parts.map((p, i) => (
        // The dot trails its part, so a wrapped line never starts with "·".
        <span key={i} className="inline-flex items-baseline gap-1.5">
          {p}
          {i < parts.length - 1 ? (
            <span aria-hidden="true" className="text-ink-soft">
              ·
            </span>
          ) : null}
        </span>
      ))}
    </p>
  );
}

/**
 * Paired micro-bars per week, done (ink) next to added (muted): a card-sized trend. The last pair is this week.
 * Plain SVG so a project card does not pull the chart module in.
 */
export function FlowSpark({ done, added, className }: { done: number[]; added: number[]; className?: string }) {
  const t = useT();
  const n = Math.max(done.length, added.length);
  if (!n) return null;
  const max = Math.max(1, ...done, ...added);
  const slot = 10;
  const bar = 3.5;
  const h = 24;
  const w = n * slot;
  const y = (v: number) => h - Math.max(v ? 1.5 : 0, (v / max) * h);
  const label = `${t("flow.chart", { weeks: n })}: ${done.map((d, i) => `${d}/${added[i] ?? 0}`).join(", ")}`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label} className={cx("block h-6 w-auto shrink-0 overflow-visible", className)} preserveAspectRatio="xMaxYMax meet">
      {Array.from({ length: n }, (_, i) => {
        const x = i * slot + 1;
        const d = done[i] ?? 0;
        const a = added[i] ?? 0;
        return (
          <g key={i}>
            <rect x={x} y={y(d)} width={bar} height={h - y(d)} rx={1} fill="var(--ink)" fillOpacity={i === n - 1 ? 0.9 : 0.55} />
            <rect x={x + bar + 0.5} y={y(a)} width={bar} height={h - y(a)} rx={1} fill="var(--ink-2)" fillOpacity={0.28} />
          </g>
        );
      })}
    </svg>
  );
}

/** Whether the backlog shrank, grew or held over the last four weeks (done minus added). */
function trend(weeks: VelocityWeek[]): { key: "flow.shrinking" | "flow.growing" | "flow.steady"; done: number; added: number } {
  const last = weeks.slice(-4);
  const done = last.reduce((s, w) => s + w.done, 0);
  const added = last.reduce((s, w) => s + w.added, 0);
  const gap = done - added;
  // Within a task a week either way is noise, not a direction.
  const key = Math.abs(gap) <= Math.max(1, last.length / 4) ? "flow.steady" : gap > 0 ? "flow.shrinking" : "flow.growing";
  return { key, done, added };
}

/** The latest week with a cycle time, then the median of those over the window. */
function cycleOf(weeks: VelocityWeek[]): number | null {
  const xs = weeks.map((w) => w.cycleDays).filter((x): x is number => x !== null);
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * The pace block: this week's line, done vs added per week, cycle time, backlog direction and (optionally) the
 * overdue and stuck tasks. `scope` is `project:<id>`, `department:<id or name>`, `person:<id>` or `workspace`.
 */
export function Velocity({
  scope,
  weeks = 8,
  showAttention = false,
  className,
  title,
  onData,
}: {
  scope: string;
  weeks?: number;
  showAttention?: boolean;
  className?: string;
  title?: React.ReactNode;
  /** Hands the loaded numbers to the parent (the Overview's status update drafts from them). */
  onData?: (d: VelocityData) => void;
}) {
  const t = useT();
  const { locale, shortDate } = useFormat();
  const [data, setData] = useState<VelocityData | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => {
    setFailed(false);
    api<VelocityData>(`work/velocity?scope=${encodeURIComponent(scope)}&weeks=${weeks}`).then(
      (d) => {
        setData(d);
        onData?.(d);
      },
      () => setFailed(true),
    );
  }, [scope, weeks, onData]);
  useEffect(load, [load]);
  const num = numberFormat(INTL_TAG[locale], { maximumFractionDigits: 1 });

  return (
    <section className={cx(card, "grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 p-5 max-sm:p-4", className)} aria-busy={!data && !failed}>
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-ink m-0 text-[15px] font-semibold">{title ?? t("flow.title")}</h2>
        {data ? <span className="text-ink-2 text-xs">{t(trend(data.weeks).key)}</span> : null}
      </header>
      {failed ? (
        <div className="text-ink-2 flex flex-wrap items-center gap-3 text-sm">
          {t("flow.loadFailed")}
          <button type="button" className={cx(btn, btnSm)} onClick={load}>
            {t("common.retry")}
          </button>
        </div>
      ) : !data ? (
        <div className="grid gap-3" aria-hidden="true">
          <span className="bg-hover h-4 w-2/3 animate-pulse rounded" />
          <span className="bg-hover h-32 animate-pulse rounded-lg" />
        </div>
      ) : (
        <>
          <FlowLine
            done={data.thisWeek.done}
            added={data.thisWeek.added}
            inProgress={data.now.inProgress + data.now.review}
            stuck={data.now.stuck}
            overdue={data.now.overdue}
            stuckDays={data.stuckDays}
            className="text-sm"
          />
          <Bars
            data={data.weeks.map((w, i) => ({ label: shortDate(`${w.week}T12:00:00Z`, "UTC"), value: w.done, highlight: i === data.weeks.length - 1 }))}
            compare={data.weeks.map((w) => w.added)}
            seriesLabels={[t("flow.seriesDone"), t("flow.seriesAdded")]}
            label={t("flow.chart", { weeks: data.weeks.length })}
            sparse={t("flow.chartSparse")}
            height={120}
          />
          <dl className="text-ink-2 m-0 grid gap-1 text-[13px]">
            <div>
              <dt className="sr-only">{t("flow.title")}</dt>
              <dd className="m-0">
                {(() => {
                  const c = cycleOf(data.weeks);
                  return c === null ? t("flow.cycleNone") : t("flow.cycle", { days: num.format(c) });
                })()}
              </dd>
            </div>
            <div>
              <dd className="m-0">{t("flow.trendHint", { done: trend(data.weeks).done, added: trend(data.weeks).added })}</dd>
            </div>
          </dl>
          {showAttention ? <Attention items={data.attention} stuckDays={data.stuckDays} /> : null}
          <p className="text-ink-soft m-0 text-xs">{t("flow.howCounted")}</p>
        </>
      )}
    </section>
  );
}

function Attention({ items, stuckDays }: { items: AttentionTask[]; stuckDays: number }) {
  const t = useT();
  const days = (iso: string | null) => (iso ? Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)) : stuckDays);
  return (
    <div className="border-hairline grid gap-2 border-t pt-4">
      <h3 className="text-ink m-0 text-[13px] font-semibold">{t("flow.attention")}</h3>
      {items.length ? (
        <ul className="m-0 grid list-none gap-1 p-0">
          {items.map((x) => (
            <li key={x.id} className="flex min-w-0 items-center gap-2 text-sm">
              <span className="text-ink-2 shrink-0 font-mono text-xs tabular-nums">{x.code}</span>
              <Link href={taskHref({ id: x.id, code: x.code })} className="text-ink -my-1.5 block min-w-0 flex-1 truncate py-1.5 no-underline hover:underline" title={x.title}>
                {x.title}
              </Link>
              <span className={cx("shrink-0 text-xs font-medium tabular-nums", x.reason === "overdue" ? "text-block" : "text-warn")}>
                {x.reason === "overdue" ? t("flow.overdueBy", { count: days(x.dueAt) }) : t("flow.stuckFor", { count: days(x.since) })}
              </span>
              {x.assigneeId ? <Avatar id={x.assigneeId} size="xs" /> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-ink-2 m-0 text-sm">{t("flow.attentionNone")}</p>
      )}
    </div>
  );
}
