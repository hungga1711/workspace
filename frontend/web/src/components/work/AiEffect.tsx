"use client";

import Link from "next/link";
import { useState } from "react";
import { featureLabel, topicLabel } from "@/lib/ai-labels";
import { usd } from "@/lib/ai-spend";
import { INTL_TAG } from "@/lib/i18n/config";
import { useFormat, useT } from "@/lib/i18n/client";
import { cx } from "@/lib/ui";
import { ListIcon, TrendIcon } from "@/components/app/icons";
import { panel, PanelHead } from "./progressUi";
import { Segmented } from "@/components/ui/Segmented";
import { InfoTip } from "@/components/ui/InfoTip";
import type { AiOversight } from "./AiOversightView";
import { enoughToCompare, MIN_COMPARE_SAMPLE } from "@/lib/metrics";

/*
 * Công việc › AI, the boss's second question: does the AI the company pays for go with getting work done?
 * AI use (ai module oversight) next to outcomes (work module followup/outcomes) for the same people:
 * first tasks finished with the company AI's help against tasks finished without it (ADR 0011), then
 * frequent AI users against the rest, then the 8-week trend.
 */

export interface TaskGroup {
  done: number;
  dated: number;
  onTime: number;
  cycleDays: number | null;
}
export interface Outcomes {
  days: number;
  people: { userId: string; done: number; dated: number; onTime: number; cycleDays: number | null; open: number; overdue: number }[];
  weekly: { week: string; done: number; dated: number; onTime: number; aiDone?: number }[];
  /** Tasks finished in the window with the company AI's help (before they were done) and without. */
  withAi?: { assisted: TaskGroup; other: TaskGroup };
}
export type Outcome = Outcomes["people"][number];

/** Uses per week from which someone counts as a frequent AI user in the comparison. */
const HEAVY_PER_WEEK = 3;
const uses = (p: { prompts: number; inApp: { calls: number } }) => p.prompts + p.inApp.calls;
/** A share as "75%", or null when there is nothing to divide (shown as "chưa có", never "0%" or a dash). */
export const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : null);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
/** Sums a group's outcomes: tasks done per person, on-time share of dated tasks, median days to finish. */
export function sumUp(all: (Outcome | undefined)[]) {
  // People with no outcome row are outside the work module's answer (not "did nothing"): leave them out.
  const list = all.filter((o): o is Outcome => !!o);
  const done = list.reduce((n, o) => n + (o?.done ?? 0), 0);
  const dated = list.reduce((n, o) => n + (o?.dated ?? 0), 0);
  const onTime = list.reduce((n, o) => n + (o?.onTime ?? 0), 0);
  const cycle = median(list.flatMap((o) => (o?.cycleDays == null ? [] : [o.cycleDays])));
  return { people: list.length, done, dated, onTime, perPerson: list.length ? done / list.length : 0, cycle };
}
/**
 * The answer first: "AI có giúp làm việc tốt hơn?" as one sentence over tasks finished with the company AI's help
 * against the rest (ADR 0011), then the two groups on the two numbers a boss reads, drawn as paired dots (on time,
 * days to finish). How to read it sits behind ⓘ; frequent users against the rest is a folded section below.
 */
export function Effect({ outcomes, weekly }: { outcomes: Outcomes; weekly: AiOversight["weekly"] }) {
  const t = useT();
  return (
    <section aria-labelledby="ai-effect-h" className={panel}>
      <PanelHead id="ai-effect-h" hue="green" icon={<TrendIcon />} title={t("aiw.o.effect")}>
        <InfoTip text={t("aiw.o.effectNote")} label={t("aiw.o.effect")} />
      </PanelHead>
      <div className="grid gap-4">
        {outcomes.withAi ? (
          <WithAi {...outcomes.withAi} days={outcomes.days} trend={<TwinTrend ai={weekly} done={outcomes.weekly} />} />
        ) : (
          <p className="text-ink-2 m-0 text-sm">{t("aiw.o.effectEmpty")}</p>
        )}
      </div>
    </section>
  );
}

/** On-time share of dated tasks, or null when too few to mean anything. */
// On time rests on tasks with a due date, so those are what must reach the minimum.
const onTimeShare = (g: TaskGroup) => (g.dated >= MIN_COMPARE_SAMPLE ? g.onTime / g.dated : null);
/** Median days to finish, or null when too few tasks or no measurable duration (same-day tasks read as 0). */
const daysToDone = (g: TaskGroup) => (g.done >= MIN_COMPARE_SAMPLE && g.cycleDays != null && g.cycleDays > 0 ? g.cycleDays : null);

/**
 * The headline: one sentence saying which way it goes once both groups have enough tasks, the two groups as a
 * legend (tasks done), and the paired-dot comparison.
 */
function WithAi({ days, assisted, other, trend }: { days: number; assisted: TaskGroup; other: TaskGroup; trend: React.ReactNode }) {
  const t = useT();
  const parts: string[] = [];
  const da = daysToDone(assisted);
  const dn = daysToDone(other);
  if (da != null && dn != null) {
    const d = Math.round((dn - da) * 10) / 10;
    parts.push(d > 0 ? t("aiw.o.verdictFaster", { days: d }) : d < 0 ? t("aiw.o.verdictSlower", { days: -d }) : t("aiw.o.verdictSameSpeed"));
  }
  const oa = onTimeShare(assisted);
  const on = onTimeShare(other);
  if (oa != null && on != null) {
    const pts = Math.round((oa - on) * 100);
    parts.push(pts > 0 ? t("aiw.o.verdictOnTimeUp", { points: pts }) : pts < 0 ? t("aiw.o.verdictOnTimeDown", { points: -pts }) : t("aiw.o.verdictOnTimeSame"));
  }
  // Below MIN_COMPARE_SAMPLE finished tasks in either group there is no verdict: 7 against 6 tasks says nothing.
  const enough = enoughToCompare(assisted.done, other.done);
  const settled = enough && parts.length > 0;
  const verdict = !assisted.done ? t("aiw.o.withAiNone") : settled ? t("aiw.o.verdict", { parts: parts.join(", ") }) : t("aiw.o.compareTooFew");
  const groups = [
    { key: "yes", label: t("aiw.o.withAiYes"), g: assisted, dot: "bg-accent" },
    { key: "no", label: t("aiw.o.withAiNo"), g: other, dot: "border-ink-2 border-[1.5px] bg-surface" },
  ];
  const maxDays = Math.max(1, ...[da, dn].filter((x): x is number => x != null)) * 1.25;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-x-12 gap-y-6 xl:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <div className="grid content-start gap-5">
        <div className="grid gap-1.5">
          <p className={cx("m-0 text-balance tracking-tight", settled ? "text-xl/tight font-semibold md:text-2xl/tight" : "text-ink-2 text-lg/snug")} data-testid="ai-verdict">
            {verdict}
          </p>
          {assisted.done && !enough ? (
            <p className="text-ink-2 m-0 text-sm" data-testid="ai-sample">
              {t("aiw.o.compareSample", { min: MIN_COMPARE_SAMPLE, ai: assisted.done, other: other.done })}
            </p>
          ) : null}
        </div>
        <div className="grid items-end gap-x-8 gap-y-4 sm:grid-cols-[auto_minmax(0,1fr)]">
          <ul className="m-0 grid list-none gap-2 p-0">
            {groups.map(({ key, label, g, dot }) => (
              <li key={key} className="flex items-baseline gap-2.5 text-sm" data-testid={`with-ai-${key}`}>
                <span className={cx("size-2.5 shrink-0 translate-y-px rounded-full", dot)} aria-hidden="true" />
                <span className="text-ink-2 w-28 shrink-0">{label}</span>
                <span className="font-medium tabular-nums">{t("aiw.o.tasksDone", { count: g.done })}</span>
              </li>
            ))}
          </ul>
          {trend}
        </div>
      </div>
      <div className={cx("grid content-start gap-4", !enough && "hidden")}>
        <h3 id="ai-with-h" className="text-ink-2 m-0 flex items-center gap-1.5 text-xs font-medium">
          {t("aiw.o.withAi")}
          <InfoTip text={`${t("aiw.o.withAiLead", { count: days })} ${t("aiw.o.withAiNote")}`} label={t("aiw.o.withAi")} align="right" />
          <Link href="/app/ai/adoption/how" className="text-ink-soft ml-auto font-normal">
            {t("aiHub.adoption.projects.how")}
          </Link>
        </h3>
        <Pair
          label={t("aiw.o.onTime")}
          hint={t("aiw.o.heroOnTimeHint")}
          a={oa == null ? null : oa * 100}
          b={on == null ? null : on * 100}
          max={100}
          format={(v) => `${Math.round(v)}%`}
          ticks={[0, 50, 100]}
        />
        <Pair label={t("aiw.o.heroDays")} hint={t("aiw.o.heroDaysHint")} a={da} b={dn} max={maxDays} format={(v) => t("aiw.o.heroDaysValue", { days: v.toFixed(1) })} />
      </div>
    </div>
  );
}

/**
 * Eight weeks of AI use (accent) against tasks done (ink), each line scaled to its own peak: do they rise together?
 * Leading weeks where both are empty are dropped (at least four weeks stay), so a new install is not a flat line.
 */
function TwinTrend({ ai, done }: { ai: AiOversight["weekly"]; done: Outcomes["weekly"] }) {
  const t = useT();
  const { shortDate } = useFormat();
  let weeks = ai.map((w) => ({ week: w.week, uses: w.prompts + w.inApp, people: w.people, done: done.find((d) => d.week === w.week)?.done ?? 0 }));
  const first = weeks.findIndex((w) => w.uses || w.done);
  if (first < 0) return null;
  weeks = weeks.slice(Math.min(first, Math.max(0, weeks.length - 4)));
  const line = (vals: number[]) => {
    const max = Math.max(1, ...vals);
    return vals.map((v, i) => `${i ? "L" : "M"}${(i / Math.max(1, vals.length - 1)) * 100},${38 - (v / max) * 34}`).join(" ");
  };
  const label = weeks.map((w) => t("aiw.o.trendWeek", { date: shortDate(w.week), ai: w.uses, people: w.people, done: w.done })).join("; ");
  return (
    <div className="grid gap-1.5">
      <div className="text-ink-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span>{t("aiw.o.trendShort")}</span>
        <span className="flex items-center gap-1.5">
          <span className="bg-accent h-0.5 w-3 rounded-full" />
          {t("aiw.o.trendAi")}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="bg-ink/40 h-0.5 w-3 rounded-full" />
          {t("aiw.o.trendDone")}
        </span>
      </div>
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label={label} className="h-10 w-full max-w-xs overflow-visible">
        <path d={line(weeks.map((w) => w.done))} fill="none" stroke="var(--ink)" strokeOpacity="0.35" strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        <path
          d={line(weeks.map((w) => w.uses))}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
}

/**
 * One measure for both groups on a shared axis: the AI group as a filled accent dot, the rest as a hollow dot,
 * joined by a bar whose length is the gap. Values sit above the dots; a missing side reads "Chưa đủ dữ liệu".
 */
function Pair({
  label,
  hint,
  a,
  b,
  max,
  format,
  ticks,
}: {
  label: string;
  hint?: string;
  a: number | null;
  b: number | null;
  max: number;
  format: (v: number) => string;
  ticks?: number[];
}) {
  const t = useT();
  const pos = (v: number) => Math.min(100, Math.max(0, (v / max) * 100));
  const x = (v: number) => `${pos(v)}%`;
  // Labels stay inside the card at the ends of the axis.
  const tx = (v: number) => `${Math.min(94, Math.max(6, pos(v)))}%`;
  const both = a != null && b != null;
  // Two values close together (on a phone 14 % points is ~40 px): push their labels apart, the lower one
  // ending left of its dot and the higher one starting right of it, so the numbers never overlap.
  const close = both && Math.abs(pos(a) - pos(b)) < 22;
  const anchor = (v: number, other: number | null, lowerOnTie: boolean) =>
    close && other != null
      ? v < other || (v === other && lowerOnTie)
        ? { textAnchor: "end" as const, dx: -2 }
        : { textAnchor: "start" as const, dx: 2 }
      : { textAnchor: "middle" as const, dx: 0 };
  const sr = [`${t("aiw.o.withAiYes")}: ${a == null ? t("aiw.o.notEnough") : format(a)}`, `${t("aiw.o.withAiNo")}: ${b == null ? t("aiw.o.notEnough") : format(b)}`].join(", ");
  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline gap-2 text-sm">
        <span className="font-medium">{label}</span>
        {hint ? <InfoTip text={hint} label={label} /> : null}
      </div>
      {a == null && b == null ? (
        <p className="text-ink-2 m-0 flex h-9 items-center gap-2 text-xs">
          <span className="border-hairline block h-px flex-1 border-t border-dashed" aria-hidden="true" />
          {t("aiw.o.notEnough")}
          <span className="border-hairline block h-px flex-1 border-t border-dashed" aria-hidden="true" />
        </p>
      ) : (
        <svg role="img" aria-label={`${label}: ${sr}`} className="h-14 w-full overflow-visible">
          <line x1="0" x2="100%" y1="36" y2="36" stroke="var(--hairline)" strokeWidth="2" strokeLinecap="round" />
          {(ticks ?? []).map((v) => (
            <g key={v}>
              <line x1={x(v)} x2={x(v)} y1="32" y2="40" stroke="var(--hairline)" strokeWidth="1" />
            </g>
          ))}
          {both ? <line x1={x(Math.min(a, b))} x2={x(Math.max(a, b))} y1="36" y2="36" stroke="var(--ink)" strokeOpacity="0.14" strokeWidth="6" strokeLinecap="round" /> : null}
          {b != null ? (
            <g className="animate-rise">
              <circle cx={x(b)} cy="36" r="7" fill="var(--surface)" stroke="var(--ink-2)" strokeWidth="1.5" />
              <text x={tx(b)} y="16" {...anchor(b, a, true)} className="fill-ink-2 text-sm tabular-nums">
                {format(b)}
              </text>
            </g>
          ) : null}
          {a != null ? (
            <g className="animate-rise">
              <circle cx={x(a)} cy="36" r="8" fill="var(--accent)" />
              <text x={tx(a)} y="16" {...anchor(a, b, false)} className="fill-ink text-sm font-semibold tabular-nums">
                {format(a)}
              </text>
            </g>
          ) : null}
        </svg>
      )}
      {(a == null) !== (b == null) ? <p className="text-ink-2 m-0 text-xs">{t("aiw.o.notEnoughFor", { group: a == null ? t("aiw.o.withAiYes") : t("aiw.o.withAiNo") })}</p> : null}
    </div>
  );
}

/** Frequent AI users (3+ uses a week) against everyone else: tasks done per person, on time, days to finish. */
export function HeavyLight({ data, work }: { data: AiOversight; work: Map<string, Outcome> }) {
  const t = useT();
  const heavyAt = Math.ceil((HEAVY_PER_WEEK * data.days) / 7);
  const heavy = data.people.filter((p) => uses(p) >= heavyAt);
  const light = data.people.filter((p) => uses(p) < heavyAt);
  const groups = [
    { key: "heavy", label: t("aiw.o.groupHeavy"), ...sumUp(heavy.map((p) => work.get(p.userId))) },
    { key: "light", label: t("aiw.o.groupLight"), ...sumUp(light.map((p) => work.get(p.userId))) },
  ];
  const rows: { label: string; value: (g: (typeof groups)[number]) => string }[] = [
    { label: t("aiw.o.donePer"), value: (g) => (g.people ? g.perPerson.toFixed(1) : t("ui.noData")) },
    { label: t("aiw.o.onTime"), value: (g) => (g.done >= MIN_COMPARE_SAMPLE ? (pct(g.onTime, g.dated) ?? t("ui.noData")) : t("ui.noData")) },
    { label: t("aiw.o.cycle"), value: (g) => (g.done < MIN_COMPARE_SAMPLE || g.cycle == null || g.cycle === 0 ? t("ui.noData") : g.cycle.toFixed(1)) },
  ];
  if (!heavy.length || !light.length) return <p className="text-ink-2 m-0 text-sm">{t("aiw.o.effectEmpty")}</p>;
  return (
    <table className="w-full max-w-xl border-collapse text-left text-sm">
      <thead>
        <tr className="border-hairline border-b text-xs">
          <th className="py-2 pr-2 font-medium">
            <span className="sr-only">{t("aiw.o.effect")}</span>
          </th>
          {groups.map((g) => (
            <th key={g.key} className="px-2 py-2 text-right font-medium">
              <span className="text-ink block">{g.label}</span>
              <span className="text-ink-2 block font-normal tabular-nums">{t("aiw.o.groupPeople", { count: g.people })}</span>
              <span className="text-ink-2 block font-normal tabular-nums">{t("aiw.o.tasksDone", { count: g.done })}</span>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.label} className="border-hairline border-b last:border-0">
            <th scope="row" className="text-ink-2 py-2.5 pr-2 font-normal">
              {r.label}
            </th>
            {groups.map((g) => (
              <td key={g.key} className="px-2 py-2.5 text-right text-base font-semibold tabular-nums">
                {r.value(g)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * What AI is used for, in one card: the company AI's features inside workspace (and on what work), or the topics
 * people ask outside tools about; a switch picks which, starting with whichever has data.
 */
export function UsedFor({
  features,
  subjects = [],
  topics,
  custom,
}: {
  features: AiOversight["features"];
  subjects?: AiOversight["subjects"];
  topics: [string, number][];
  custom?: Record<string, string>;
}) {
  const t = useT();
  const { locale } = useFormat();
  const number = (n: number) => n.toLocaleString(INTL_TAG[locale]);
  const shown = features.filter((f) => f.calls > 0).slice(0, 5);
  const [view, setView] = useState<"company" | "outside">(shown.length || !topics.length ? "company" : "outside");
  const rows =
    view === "company"
      ? shown.map((f) => ({
          key: f.feature,
          label: featureLabel(t, f.feature),
          value: f.calls,
          title: [t("aiw.o.featurePeople", { count: f.people }), t("aiw.o.tokens", { value: number(f.tokens) }), f.cost ? usd(f.cost, locale) : null].filter(Boolean).join(" · "),
        }))
      : topics.slice(0, 5).map(([k, v]) => ({ key: k, label: topicLabel(t, k, custom), value: v, title: undefined }));
  const max = Math.max(1, ...rows.map((r) => r.value));
  const title = view === "company" ? t("aiw.o.featuresTitle") : t("aiw.o.whatFor");
  return (
    <section aria-labelledby="ai-used-h" className={panel}>
      <PanelHead id="ai-used-h" hue="violet" icon={<ListIcon />} title={t("aiw.o.usedFor")}>
        <Segmented
          size="sm"
          label={t("aiw.o.usedFor")}
          value={view}
          onChange={setView}
          options={[
            { value: "company", label: t("aiw.o.segCompany") },
            { value: "outside", label: t("aiw.o.segOutside") },
          ]}
        />
      </PanelHead>
      <section aria-label={title} className="grid gap-2.5">
        {rows.length === 0 ? (
          <p className="text-ink-2 m-0 text-sm">{view === "company" ? t("aiw.o.featuresEmpty") : t("aiw.o.noData")}</p>
        ) : (
          rows.map((r) => (
            <div key={r.key} className="grid grid-cols-[9.5rem_minmax(0,1fr)_2rem] items-center gap-3 text-sm max-sm:grid-cols-[7.5rem_minmax(0,1fr)_2rem]" title={r.title}>
              <span className="min-w-0 leading-snug">{r.label}</span>
              <span className="bg-hover block h-1.5 overflow-hidden rounded-full">
                <span className="bg-accent block h-full rounded-full" style={{ width: `${(r.value / max) * 100}%` }} />
              </span>
              <span className="text-ink-2 text-right text-xs tabular-nums">{r.value}</span>
            </div>
          ))
        )}
        {view === "company" && subjects.length ? (
          <ul className="border-hairline m-0 mt-1 flex list-none flex-wrap items-center gap-1.5 border-t p-0 pt-3 text-xs">
            <li className="text-ink-2 mr-1">{t("aiw.o.subjectsTitle")}</li>
            {subjects.filter(isSubject).map((x) => (
              <li key={x.type} className="bg-hover rounded-sm px-1.5 py-0.5" title={t("aiw.o.calls", { count: x.calls })}>
                {t(`aiw.o.subject.${x.type}`)} <span className="tabular-nums">{x.items}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </section>
  );
}

const SUBJECTS = ["task", "document", "meeting", "message", "channel"] as const;
const isSubject = (x: { type: string }): x is { type: (typeof SUBJECTS)[number]; calls: number; items: number } => (SUBJECTS as readonly string[]).includes(x.type);
