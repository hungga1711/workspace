"use client";

import Link from "next/link";
import { useState } from "react";
import { useFormat, useT } from "@/lib/i18n/client";
import { cx } from "@/lib/ui";
import { IconTile, card, type Tone } from "@/components/ui/Bento";
import { Bars } from "@/components/ui/charts";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { Segmented } from "@/components/ui/Segmented";
import { ChevronDownIcon, ClockIcon, InfoIcon, RefreshIcon, SparkleIcon, StopIcon, TrendIcon } from "@/components/app/icons";
import { Quoted, StepNode } from "../bits";
import { useKindLabel } from "../Graph";
import { useDuration } from "../run/eta";
import { costOf, shortTokens, useInsights, type Insights, type Prices, type Suggestion, type WorkflowInsight } from "./insights";

type Sort = "tokens" | "time" | "failed" | "sentBack";
const tokensOf = (w: { tokens: { input: number; output: number } }) => w.tokens.input + w.tokens.output;
const failShare = (w: Pick<WorkflowInsight, "done" | "failed">) => (w.done + w.failed ? w.failed / (w.done + w.failed) : 0);
const METRIC: Record<Sort, (w: WorkflowInsight) => number> = {
  tokens: tokensOf,
  time: (w) => w.avgSec ?? 0,
  failed: (w) => w.failed,
  sentBack: (w) => w.sentBack,
};

/** A suggestion as a sentence; the step it is about is drawn as a chip (Quoted reads «…»). */
export function useSuggestionText() {
  const t = useT();
  return (s: Suggestion) =>
    t(`workflows.perf.suggest.${s.rule === "check_sends_back" && !s.author ? "check_sends_back_plain" : s.rule}`, {
      step: `«${s.step ?? ""}»`,
      author: `«${s.author ?? ""}»`,
      pct: s.pct ?? 0,
      minutes: s.minutes ?? 0,
    });
}

/** What the tokens cost, as far as anyone knows: "≈ $1.20", "≈ $1.20+" when some are unpriced, or "cost unknown". */
function useCostText() {
  const t = useT();
  const { money } = useFormat();
  return (models: WorkflowInsight["models"], prices: Prices | null): { text: string; title: string } => {
    const c = costOf(models, prices);
    if (c.usd === null) return { text: t("workflows.perf.costUnknown"), title: t("workflows.perf.costUnknownHint") };
    const m = money(c.usd, "USD");
    return { text: t(c.unpriced ? "workflows.perf.costPartial" : "workflows.perf.cost", { amount: m.short }), title: t("workflows.perf.costHint") };
  };
}

/**
 * AI › Workflows › Performance: which workflows cost the most, which take longest and whether that time
 * is work or waiting for people, which steps fail or are sent back, and what to change. Four figures that are also
 * the list's order (a figure is a filter), runs per day, then one row per workflow that opens to its steps. Counted
 * from the runs by rules, for the runs the reader may see; what is not known (tokens of an agent on someone's
 * computer, a model with no price) is said as unknown.
 */
export default function Performance() {
  const t = useT();
  const { number, percent, shortDate } = useFormat();
  const words = useDuration();
  const cost = useCostText();
  const [days, setDays] = useState<"7" | "30" | "90">("30");
  const [sort, setSort] = useState<Sort>("tokens");
  const { data, prices, failed, loading, retry } = useInsights(Number(days));
  const head = (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <Segmented
        label={t("workflows.perf.window")}
        value={days}
        onChange={setDays}
        size="sm"
        options={(["7", "30", "90"] as const).map((d) => ({ value: d, label: t("workflows.perf.days", { count: Number(d) }) }))}
      />
      <p className="text-ink-2 m-0 flex min-w-0 items-center gap-1.5 text-xs">
        <InfoIcon className="size-3.5 shrink-0" />
        {t(data?.capped ? "workflows.perf.capped" : "workflows.perf.basis")}
      </p>
    </div>
  );
  if (failed)
    return (
      <section aria-label={t("workflows.tabs.performance")} className="grid min-w-0 gap-3">
        {head}
        <div className={cx(card, "rounded-xl p-5 max-sm:p-4")}>
          <LoadFailed what={t("workflows.tabs.performance")} onRetry={retry} />
        </div>
      </section>
    );
  if (!data)
    return (
      <section aria-label={t("workflows.tabs.performance")} aria-busy={loading} className="grid min-w-0 gap-3">
        {head}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className="shimmer h-[92px] rounded-xl" />
          ))}
        </div>
        <span className="shimmer h-40 rounded-xl" aria-hidden="true" />
      </section>
    );
  const x = data.totals;
  const finished = x.done + x.failed;
  const all = costOf(
    data.workflows.flatMap((w) => w.models),
    prices,
  );
  const list = [...data.workflows].sort((a, b) => METRIC[sort](b) - METRIC[sort](a) || b.runs - a.runs);
  const max = Math.max(1, ...list.map(METRIC[sort]));
  const avgRun = finished ? (x.workSec + x.waitSec) / finished : 0;
  return (
    <section aria-label={t("workflows.tabs.performance")} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
      {head}
      {x.runs === 0 ? (
        <div className={cx(card, "text-ink-2 rounded-xl p-5 text-[13px] max-sm:p-4")}>{t("workflows.perf.empty", { count: data.days })}</div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <SortTile
              tone="violet"
              icon={<SparkleIcon />}
              label={t("workflows.perf.fig.tokens")}
              n={shortTokens(tokensOf(x))}
              note={
                all.usd === null
                  ? x.tokensUnknownRuns
                    ? t("workflows.perf.unknownRuns", { count: x.tokensUnknownRuns })
                    : ""
                  : cost(
                      data.workflows.flatMap((w) => w.models),
                      prices,
                    ).text
              }
              active={sort === "tokens"}
              onClick={() => setSort("tokens")}
            />
            <SortTile
              tone="sky"
              icon={<ClockIcon />}
              label={t("workflows.perf.fig.time")}
              n={finished ? words(avgRun) : "–"}
              note={x.workSec + x.waitSec > 0 ? t("workflows.perf.waitShare", { pct: percent(x.waitSec / (x.workSec + x.waitSec)) }) : ""}
              active={sort === "time"}
              onClick={() => setSort("time")}
            />
            <SortTile
              tone="red"
              icon={<StopIcon />}
              label={t("workflows.perf.fig.failed")}
              n={number(x.failed)}
              note={finished ? percent(x.failed / finished) : ""}
              alert={x.failed > 0}
              active={sort === "failed"}
              onClick={() => setSort("failed")}
            />
            <SortTile
              tone="rose"
              icon={<RefreshIcon />}
              label={t("workflows.perf.fig.sentBack")}
              n={number(x.sentBack)}
              note={t("workflows.perf.runs", { count: x.runs })}
              active={sort === "sentBack"}
              onClick={() => setSort("sentBack")}
            />
          </div>

          <div className={cx(card, "min-w-0 rounded-xl p-4 max-sm:p-3.5")}>
            <h3 className="text-ink-2 m-0 mb-2 flex items-center gap-1.5 text-xs font-medium">
              <TrendIcon className="size-3.5" />
              {t(data.days <= 14 ? "workflows.perf.perDay" : "workflows.perf.perWeek")}
            </h3>
            <Bars
              height={96}
              label={t(data.days <= 14 ? "workflows.perf.perDay" : "workflows.perf.perWeek")}
              data={dailySeries(data).map((d) => ({ label: shortDate(`${d.day}T12:00:00Z`), value: d.runs }))}
              format={(n) => t("workflows.perf.runs", { count: n })}
              sparse={<p className="text-ink-2 m-0 text-[13px]">{t("workflows.perf.sparse", { count: x.runs })}</p>}
            />
          </div>

          <ul className="m-0 grid min-w-0 list-none gap-2 p-0">
            {list.map((w) => (
              <WorkflowRow key={w.id ?? `name:${w.name}`} w={w} prices={prices} sort={sort} max={max} />
            ))}
          </ul>
          <p className="text-ink-2 m-0 text-xs">{t("workflows.perf.costHint")}</p>
        </>
      )}
    </section>
  );
}

/**
 * Every day of the window that has passed since the first run, so a quiet day is a gap and not a missing bar. Past
 * two weeks the days are added up by week (each bar named by its first day): thirty bars do not fit a phone.
 */
function dailySeries(d: Insights) {
  const days = everyDay(d);
  if (d.days <= 14) return days;
  const weeks: Insights["daily"] = [];
  days.forEach((x, i) => {
    if (i % 7 === 0) weeks.push({ ...x });
    else {
      const w = weeks[weeks.length - 1]!;
      w.runs += x.runs;
      w.failed += x.failed;
      w.tokens += x.tokens;
    }
  });
  return weeks;
}
function everyDay(d: Insights) {
  if (!d.daily.length) return [];
  const by = new Map(d.daily.map((x) => [x.day, x]));
  const out: Insights["daily"] = [];
  const end = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  for (let at = Date.parse(`${d.daily[0]!.day}T00:00:00Z`); at <= end; at += 86_400_000) {
    const day = new Date(at).toISOString().slice(0, 10);
    out.push(by.get(day) ?? { day, runs: 0, failed: 0, tokens: 0 });
  }
  return out;
}

/** A figure that is also the list's order. */
function SortTile({
  tone,
  icon,
  label,
  n,
  note,
  alert,
  active,
  onClick,
}: {
  tone: Tone;
  icon: React.ReactNode;
  label: string;
  n: string;
  note?: string;
  alert?: boolean;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cx(
        card,
        "focus-visible:outline-accent flex min-w-0 cursor-pointer flex-col rounded-xl p-4 text-left focus-visible:outline-2 focus-visible:outline-offset-2 max-sm:p-3.5",
        active && "ring-ink/70 ring-1 ring-inset",
      )}
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <IconTile tone={tone}>{icon}</IconTile>
        <span className="text-ink-2 line-clamp-2 min-w-0 text-[13px] leading-tight">{label}</span>
      </span>
      <span className="mt-3 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className={cx("font-display text-[28px]/none font-semibold tabular-nums tracking-[-0.04em] max-sm:text-2xl/none", alert ? "text-block" : "text-ink")}>{n}</span>
        {note ? <span className="text-ink-2 min-w-0 truncate text-xs">{note}</span> : null}
      </span>
    </button>
  );
}

/** Working time against waiting for people, as one thin bar. */
function TimeSplit({ work, wait, className }: { work: number; wait: number; className?: string }) {
  const t = useT();
  const words = useDuration();
  if (work + wait <= 0) return null;
  return (
    <span
      className={cx("bg-hover flex h-1.5 min-w-0 gap-px overflow-hidden rounded-full", className)}
      role="img"
      aria-label={t("workflows.perf.split", { work: words(work), wait: words(wait) })}
      title={t("workflows.perf.split", { work: words(work), wait: words(wait) })}
    >
      <span className="bg-sky h-full" style={{ width: `${(work / (work + wait)) * 100}%` }} />
      <span className="bg-tangerine h-full flex-1" />
    </span>
  );
}

function WorkflowRow({ w, prices, sort, max }: { w: WorkflowInsight; prices: Prices | null; sort: Sort; max: number }) {
  const t = useT();
  const { number, percent } = useFormat();
  const words = useDuration();
  const cost = useCostText();
  const say = useSuggestionText();
  const kind = useKindLabel();
  const finished = w.done + w.failed;
  const c = cost(w.models, prices);
  const tokens = tokensOf(w);
  const value =
    sort === "tokens"
      ? tokens
        ? shortTokens(tokens)
        : w.tokensUnknownRuns
          ? t("workflows.perf.unknown")
          : "0"
      : sort === "time"
        ? w.avgSec
          ? words(w.avgSec)
          : "–"
        : number(sort === "failed" ? w.failed : w.sentBack);
  const name = <span className="text-ink min-w-0 truncate text-sm font-semibold tracking-[-0.01em]">{w.name}</span>;
  return (
    <li className={cx(card, "min-w-0 rounded-xl")}>
      <details className="group/wf min-w-0">
        <summary className="grid min-w-0 cursor-pointer list-none grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-4 py-3 max-sm:px-3.5 [&::-webkit-details-marker]:hidden">
          <span className="grid min-w-0 gap-1">
            <span className="flex min-w-0 items-center gap-2">
              {name}
              {w.suggestions.length ? (
                <span className="bg-violet-wash text-violet-text inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-1.5 text-[11px] font-semibold tabular-nums [&_svg]:size-3">
                  <SparkleIcon />
                  {w.suggestions.length}
                  <span className="sr-only">{t("workflows.perf.suggestions")}</span>
                </span>
              ) : null}
            </span>
            <span className="text-ink-2 flex min-w-0 flex-wrap gap-x-2.5 gap-y-0.5 text-xs tabular-nums">
              <span>{t("workflows.perf.runs", { count: w.runs })}</span>
              {finished ? <span className={failShare(w) >= 0.3 ? "text-block" : undefined}>{t("workflows.perf.succeeded", { pct: percent(w.done / finished) })}</span> : null}
              <span title={c.title}>
                {tokens ? `${shortTokens(tokens)} ${t("workflows.perf.tokensUnit")} · ${c.text}` : w.tokensUnknownRuns ? t("workflows.perf.tokensUnknown") : null}
              </span>
              {w.avgSec ? <span>{t("workflows.perf.perRun", { time: words(w.avgSec) })}</span> : null}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-2.5">
            <span className="grid w-28 justify-items-end gap-1 max-sm:w-20">
              <span className="text-ink text-sm font-semibold tabular-nums">{value}</span>
              {sort === "time" ? (
                <TimeSplit work={w.avgWorkSec ?? 0} wait={w.avgWaitSec ?? 0} className="w-full" />
              ) : (
                <span className="bg-hover block h-1.5 w-full overflow-hidden rounded-full" aria-hidden="true">
                  <span
                    className={cx("block h-full rounded-full", sort === "failed" ? "bg-block" : sort === "sentBack" ? "bg-rose" : "bg-violet")}
                    style={{ width: `${(METRIC[sort](w) / max) * 100}%` }}
                  />
                </span>
              )}
            </span>
            <ChevronDownIcon className="text-ink-2 size-4 transition-transform group-open/wf:rotate-180" />
          </span>
        </summary>
        <div className="border-divider grid min-w-0 gap-4 border-t px-4 py-3.5 max-sm:px-3.5">
          {w.suggestions.length ? (
            <ul aria-label={t("workflows.perf.suggestions")} className="m-0 grid list-none gap-1.5 p-0">
              {w.suggestions.map((s, i) => (
                <li key={i} className="text-ink flex min-w-0 items-start gap-2 text-[13px]/5">
                  <SparkleIcon className="text-violet-text mt-0.5 size-3.5 shrink-0" />
                  <span className="min-w-0">
                    <Quoted text={say(s)} />
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {w.avgWorkSec !== null && (w.avgWorkSec ?? 0) + (w.avgWaitSec ?? 0) > 0 ? (
            <div className="grid min-w-0 gap-1.5">
              <TimeSplit work={w.avgWorkSec ?? 0} wait={w.avgWaitSec ?? 0} />
              <p className="text-ink-2 m-0 flex flex-wrap gap-x-4 gap-y-0.5 text-xs tabular-nums">
                <span className="inline-flex items-center gap-1.5">
                  <span className="bg-sky size-2 rounded-full" aria-hidden="true" />
                  {t("workflows.perf.working", { time: words(w.avgWorkSec ?? 0) })}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="bg-tangerine size-2 rounded-full" aria-hidden="true" />
                  {t("workflows.perf.waiting", { time: words(w.avgWaitSec ?? 0) })}
                </span>
              </p>
            </div>
          ) : null}
          <div className="-mx-1 min-w-0 overflow-x-auto px-1">
            <table className="w-full min-w-[20.5rem] border-collapse text-left text-[13px] max-sm:text-xs">
              <thead>
                <tr className="text-ink-2 text-xs [&>th:first-child]:pl-0 [&>th]:pb-1.5 [&>th]:pl-2 [&>th]:align-bottom [&>th]:font-medium">
                  <th scope="col">{t("workflows.perf.col.step")}</th>
                  <th scope="col" className="text-right">
                    {t("workflows.perf.col.failed")}
                  </th>
                  <th scope="col" className="text-right">
                    {t("workflows.perf.col.sentBack")}
                  </th>
                  <th scope="col" className="text-right">
                    {t("workflows.perf.col.time")}
                  </th>
                  <th scope="col" className="text-right">
                    {t("workflows.perf.col.tokens")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {w.steps.map((s) => {
                  const st = s.tokens.input + s.tokens.output;
                  const bad = s.runs ? s.failed / s.runs : 0;
                  return (
                    <tr key={s.key} className="border-divider border-t [&>td:first-child]:pl-0 [&>td]:whitespace-nowrap [&>td]:py-1.5 [&>td]:pl-2 [&>td]:align-middle">
                      <td className="min-w-0 max-w-0 pr-1 max-sm:w-[38%] sm:w-[45%]">
                        <span className="flex min-w-0 items-center gap-2">
                          <StepNode kind={s.kind} size="sm" className="max-sm:hidden" />
                          <span className="grid min-w-0">
                            <span className="text-ink truncate font-medium">{s.title}</span>
                            <span className="text-ink-2 truncate text-xs">{[kind(s), s.models[0]].filter(Boolean).join(" · ")}</span>
                          </span>
                        </span>
                      </td>
                      <td className={cx("text-right tabular-nums", s.failed ? (bad >= 0.3 ? "text-block font-medium" : "text-ink") : "text-ink-2")}>
                        {s.failed ? `${number(s.failed)} · ${percent(bad)}` : "–"}
                      </td>
                      <td className={cx("text-right tabular-nums", s.sentBack ? "text-rose-text font-medium" : "text-ink-2")}>
                        {s.sentBack ? number(s.sentBack) : "–"}
                        {s.kind === "check" && s.notPassed ? <span className="text-ink-2 font-normal"> · {percent(s.notPassed / s.runs)}</span> : null}
                      </td>
                      <td className="text-ink text-right tabular-nums">
                        {/* An approval's time is all waiting; its row already says it is one. */}
                        {s.kind === "approval" ? (
                          s.avgWaitSec ? (
                            <span title={t("workflows.perf.waited", { time: words(s.avgWaitSec) })}>{words(s.avgWaitSec)}</span>
                          ) : (
                            "–"
                          )
                        ) : s.avgSec ? (
                          words(s.avgSec)
                        ) : (
                          "–"
                        )}
                      </td>
                      <td className="text-right tabular-nums">
                        {st ? (
                          <span className="text-ink">{shortTokens(Math.round(st / s.runs))}</span>
                        ) : s.tokensUnknown ? (
                          <span className="text-ink-2">{t("workflows.perf.unknown")}</span>
                        ) : (
                          <span className="text-ink-2">–</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1">
            <p className="text-ink-2 m-0 text-xs">{t("workflows.perf.perRunNote")}</p>
            {w.id ? (
              <Link href={`/app/ai/workflows/${w.id}`} className="text-ink text-[13px] font-medium no-underline hover:underline">
                {t("workflows.perf.open")} →
              </Link>
            ) : null}
          </div>
        </div>
      </details>
    </li>
  );
}

/**
 * One workflow's performance on its own page (Blueprint), in a line and its suggestions: read when the page shows it,
 * silent when there is nothing to say (no runs in the last 30 days) or the read fails.
 */
export function WorkflowPerformance({ workflowId, className }: { workflowId: string; className?: string }) {
  const t = useT();
  const { percent } = useFormat();
  const words = useDuration();
  const cost = useCostText();
  const say = useSuggestionText();
  const { data, prices } = useInsights(30, workflowId);
  const w = data?.workflows[0];
  if (!w || !w.runs) return null;
  const finished = w.done + w.failed;
  const tokens = tokensOf(w);
  const c = cost(w.models, prices);
  return (
    <section aria-label={t("workflows.tabs.performance")} className={cx("grid min-w-0 gap-2", className)}>
      <p className="text-ink-2 m-0 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums">
        <span className="text-ink font-medium">{t("workflows.perf.last30")}</span>
        {finished ? <span>{t("workflows.perf.succeeded", { pct: percent(w.done / finished) })}</span> : null}
        {tokens ? (
          <span title={c.title}>
            {shortTokens(Math.round(tokens / w.runs))} {t("workflows.perf.tokensPerRun")} · {c.text}
          </span>
        ) : w.tokensUnknownRuns ? (
          <span>{t("workflows.perf.tokensUnknown")}</span>
        ) : null}
        {(w.avgWorkSec ?? 0) + (w.avgWaitSec ?? 0) > 0 ? (
          <span className="inline-flex items-center gap-2">
            {t("workflows.perf.working", { time: words(w.avgWorkSec ?? 0) })} · {t("workflows.perf.waiting", { time: words(w.avgWaitSec ?? 0) })}
            <TimeSplit work={w.avgWorkSec ?? 0} wait={w.avgWaitSec ?? 0} className="w-16" />
          </span>
        ) : null}
        <Link href="/app/ai/workflows?tab=performance" className="text-ink font-medium no-underline hover:underline">
          {t("workflows.perf.all")} →
        </Link>
      </p>
      {w.suggestions.length ? (
        <ul aria-label={t("workflows.perf.suggestions")} className="m-0 grid list-none gap-1 p-0">
          {w.suggestions.map((s, i) => (
            <li key={i} className="text-ink flex min-w-0 items-start gap-2 text-[13px]/5">
              <SparkleIcon className="text-violet-text mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0">
                <Quoted text={say(s)} />
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
