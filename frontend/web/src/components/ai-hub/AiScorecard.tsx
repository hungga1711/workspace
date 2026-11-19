"use client";

import { numberFormat } from "@/lib/intl";
import Link from "next/link";
import { useMemo, useState } from "react";
import { INTL_TAG } from "@/lib/i18n/config";
import { useFormat, useLocale, useT } from "@/lib/i18n/client";
import { featureLabel, sourceLabel, topicLabel } from "@/lib/ai-labels";
import { compareOutcomes, MIN_COMPARE_SAMPLE, share } from "@/lib/metrics";
import { Avatar } from "@/lib/people";
import { btnGhost, btnSm, cx } from "@/lib/ui";
import { IconTile } from "@/components/ui/Bento";
import { InfoTip } from "@/components/ui/InfoTip";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { Segmented } from "@/components/ui/Segmented";
import { ChartIcon, ChevronRightIcon, ShieldIcon, TrendIcon, UsersIcon } from "@/components/app/icons";
import type { TokenUsageData } from "./TokenUsage";
import type { Outcomes } from "@/components/work/AiEffect";

/** GET /api/ai/adoption/people (ai module, adoption-people.ts). */
export type Pattern = "power" | "regular" | "light" | "new" | "lapsed" | "none";
type Top = { key: string; count: number }[];
export interface AiProfile {
  userId: string;
  displayName: string;
  title: string | null;
  department: string | null;
  pattern: Pattern;
  trend: "up" | "down" | "flat" | null;
  uses: number;
  prevUses: number;
  prompts: number;
  inAppCalls: number;
  conversations: number;
  activeDays: number;
  spark: number[];
  sources: Top;
  topics: Top;
  features: Top;
  tools: Top;
  tokens: number;
  companyTokens: number;
  localTokens: number;
  costUsd: number;
  listValueUsd: number;
  rated: number;
  helpful: number | null;
  aiTasks: number;
  flagged: number;
  attention: "sensitive" | "unhelpful" | null;
}
export interface AiPeopleData {
  days: number;
  scope: "team" | "me";
  totals: {
    people: number;
    using: number;
    patterns: Record<Pattern, number>;
    uses: number;
    prevUses: number;
    prompts: number;
    outsidePrompts: number;
    inAppCalls: number;
    companyTokens: number;
    localTokens: number;
    costUsd: number;
    prevCostUsd: number;
    listValueUsd: number;
    unpricedTokens: number;
    rated: number;
    helpful: number | null;
    aiTasks: number;
    flagged: number;
    attention: number;
  };
  departments: { name: string | null; people: number; using: number; uses: number; tokens: number; costUsd: number; helpful: number | null }[];
  features: { feature: string; calls: number; tokens: number; costUsd: number; people: number }[];
  people: AiProfile[];
}

const PATTERNS: Pattern[] = ["power", "regular", "light", "new", "lapsed", "none"];
/** How much someone uses AI, one hue from strong to faint; "stopped" is amber (worth a look), "not yet" the track. */
const PATTERN_BG: Record<Pattern, string> = {
  power: "bg-accent",
  regular: "bg-accent/65",
  light: "bg-accent/35",
  new: "bg-sky",
  lapsed: "bg-warn-fill",
  none: "bg-edge",
};
/** Each coding tool's identity colour, as on Usage (TokenUsage.tsx). */
const TOOL_BG: Record<string, string> = {
  "claude-code": "bg-tangerine",
  codex: "bg-sky",
  "gemini-cli": "bg-rose",
  opencode: "bg-ok-fill",
  other: "bg-ink-2",
  company: "bg-violet",
};
const TOOL_KEYS = ["claude-code", "codex", "gemini-cli", "opencode", "local-model", "other", "company"] as const;
const toolKey = (k: string) => ((TOOL_KEYS as readonly string[]).includes(k) ? (k as (typeof TOOL_KEYS)[number]) : "other");

function useNum() {
  const locale = useLocale();
  const compact = numberFormat(INTL_TAG[locale], { notation: "compact", maximumFractionDigits: 1 });
  return { tokens: (n: number) => compact.format(n) };
}

type Filter = Pattern | "all" | "attention";

/**
 * AI › Áp dụng AI › Tổng quan, the top of the page: the owner's three questions answered before anything
 * else, each as one card with one big figure and the picture behind it: how many tokens went in and out, whether work
 * done with AI goes better, and how many people use it. Money is left out on purpose (each model has its own price).
 * The third card's bar is also the filter of the list under it, where every person gets one line saying how they use
 * AI (a rule over their counts, no model). Each card reads on its own, so a failed read takes out one card, never the
 * page.
 */
export function AiScorecard({
  people,
  tokens,
  outcomes,
  base,
}: {
  people: AiPeopleData | null;
  tokens: TokenUsageData | null;
  outcomes: Outcomes | null;
  /** The page the period links go to (?days=). */
  base: string;
}) {
  const t = useT();
  const [filter, setFilter] = useState<Filter>("all");
  const days = people?.days ?? tokens?.days ?? 30;
  const team = people?.scope === "team";
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4" data-testid="ai-scorecard">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Verdict people={people} outcomes={outcomes} />
        <Segmented
          size="sm"
          label={t("aiHub.tokens.window")}
          value={String(days)}
          options={([7, 30, 90] as const).map((d) => ({ value: String(d), label: t(`aiHub.tokens.d${d}`), href: `${base}?days=${d}` }))}
        />
      </div>
      <div className={cx("grid grid-cols-[minmax(0,1fr)] gap-4", team ? "lg:grid-cols-3" : "lg:grid-cols-2")}>
        <SpendCard people={people} tokens={tokens} />
        <EffectCard people={people} outcomes={outcomes} />
        {team ? (
          <WhoCard
            people={people}
            filter={filter}
            onFilter={(f) => {
              setFilter((x) => (x === f ? "all" : f));
              document.getElementById("ai-people")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
            }}
          />
        ) : null}
      </div>
      {people && (people.features.length || people.departments.length > 1) ? <WhereItGoes people={people} tokens={tokens} /> : null}
      {people ? team ? <PeopleList data={people} outcomes={outcomes} filter={filter} onFilter={setFilter} /> : <MyLine me={people.people[0]} days={people.days} /> : null}
    </div>
  );
}

/** The page in one sentence: tokens, effect, reach. Each part appears only when its figure exists. */
function Verdict({ people, outcomes }: { people: AiPeopleData | null; outcomes: Outcomes | null }) {
  const t = useT();
  const n = useNum();
  const f = useFormat();
  const cmp = outcomes?.withAi ? compareOutcomes(outcomes.withAi.assisted, outcomes.withAi.other) : null;
  const faster = cmp?.days ? cmp.days.other - cmp.days.ai : null;
  const tokenTotal = people ? people.totals.companyTokens + people.totals.localTokens : 0;
  const parts = [
    tokenTotal > 0 ? t("aiHub.score.verdict.tokens", { tokens: n.tokens(tokenTotal), days: people!.days }) : null,
    faster !== null && faster > 0 ? t("aiHub.score.verdict.faster", { days: f.daysShort(faster) }) : null,
    people?.scope === "team" && people.totals.people ? t("aiHub.score.verdict.reach", { using: people.totals.using, people: people.totals.people }) : null,
  ].filter(Boolean);
  return (
    <h2 className="text-ink font-display m-0 min-w-[min(100%,18rem)] flex-1 text-balance text-xl font-semibold tracking-[-0.02em]" data-testid="ai-verdict">
      {parts.length ? parts.join(" ") : t("aiHub.score.verdict.empty")}
    </h2>
  );
}

function Card({
  id,
  tone,
  icon,
  title,
  tip,
  children,
}: {
  id: string;
  tone: "violet" | "green" | "sky";
  icon: React.ReactNode;
  title: string;
  tip?: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="bg-surface shadow-card flex min-w-0 flex-col gap-4 rounded-xl p-5 max-sm:p-4">
      <header className="flex min-w-0 items-center gap-2.5">
        <IconTile tone={tone}>{icon}</IconTile>
        <h3 id={id} className="text-ink m-0 min-w-0 flex-1 truncate text-sm font-semibold tracking-[-0.01em]">
          {title}
        </h3>
        {tip ? <InfoTip text={tip} align="right" /> : null}
      </header>
      {children}
    </section>
  );
}

const Big = ({ children, good }: { children: React.ReactNode; good?: boolean }) => (
  <span className={cx("font-display text-[32px]/[1.1] font-semibold tabular-nums tracking-[-0.035em]", good ? "text-ok" : "text-ink")}>{children}</span>
);

/** A change against the window before: "+12%" in ink (more tokens is not good or bad by itself). */
function Delta({ now, before, days }: { now: number; before: number; days: number }) {
  const t = useT();
  if (!(before > 0)) return null;
  const pct = Math.round(((now - before) / before) * 100);
  return (
    <span className="bg-hover text-ink-soft inline-flex h-5 items-center rounded-full px-1.5 text-[11px] font-medium tabular-nums" title={t("aiHub.score.vsBefore", { days })}>
      {pct > 0 ? "+" : ""}
      {pct}%
    </span>
  );
}

/** 1. How many tokens: the total, input vs output, tokens a day by tool, and the facts an owner asks next. */
function SpendCard({ people, tokens }: { people: AiPeopleData | null; tokens: TokenUsageData | null }) {
  const t = useT();
  const n = useNum();
  const f = useFormat();
  const tt = people?.totals;
  const daily = tokens?.daily ?? [];
  const max = Math.max(1, ...daily.map((d) => d.total));
  const tools = [...new Set(daily.flatMap((d) => Object.keys(d.tools)))];
  const total = tokens?.totals.total ?? (tt ? tt.companyTokens + tt.localTokens : 0);
  // Previous-period tokens are not on the people totals; the Usage endpoint keeps them as `previous`.
  const prevTotal = tokens?.totals.previous ?? 0;
  const input = tokens?.totals.input ?? 0;
  const output = tokens?.totals.output ?? 0;
  const label = (day: string) => f.shortDate(`${day}T12:00:00Z`, "UTC");
  return (
    <Card id="sc-spend" tone="violet" icon={<ChartIcon />} title={t("aiHub.score.spend.title")} tip={t("aiHub.score.spend.tip")}>
      {!tt && !tokens ? (
        <LoadFailed what={t("aiHub.score.spend.title")} />
      ) : (
        <>
          <p className="m-0 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <Big>{n.tokens(total)}</Big>
            {prevTotal > 0 ? <Delta now={total} before={prevTotal} days={people?.days ?? tokens?.days ?? 30} /> : null}
            <span className="text-ink-2 text-[13px] tabular-nums">{t("aiHub.score.spend.tokens")}</span>
          </p>
          {daily.some((d) => d.total > 0) ? (
            <div className="grid gap-1.5">
              <div className="flex h-24 items-end gap-[2px]" role="img" aria-label={t("aiHub.score.spend.daily")}>
                {daily.map((d) => (
                  <span
                    key={d.day}
                    className="group/bar relative flex h-full min-w-[2px] flex-1 flex-col-reverse"
                    title={t("aiHub.tokens.dayTip", { day: label(d.day), tokens: n.tokens(d.total) })}
                  >
                    {d.total ? (
                      Object.entries(d.tools)
                        .sort((a, b) => b[1] - a[1])
                        .map(([k, v]) => (
                          <span
                            key={k}
                            className={cx("block w-full opacity-85 transition-opacity last:rounded-t-[3px] group-hover/bar:opacity-100", TOOL_BG[toolKey(k)])}
                            style={{ height: `${Math.max(3, (v / max) * 100)}%` }}
                          />
                        ))
                    ) : (
                      <span className="bg-edge block h-px w-full" />
                    )}
                  </span>
                ))}
              </div>
              <div className="text-ink-2 flex items-center justify-between gap-2 text-xs tabular-nums">
                <span>{daily[0] ? label(daily[0].day) : ""}</span>
                {tools.length > 1 ? (
                  <span className="flex min-w-0 flex-wrap justify-center gap-x-3">
                    {tools.map((k) => (
                      <span key={k} className="inline-flex items-center gap-1">
                        <span aria-hidden="true" className={cx("size-2 rounded-[2px]", TOOL_BG[toolKey(k)])} />
                        {t(`aiHub.tokens.tool.${toolKey(k)}`)}
                      </span>
                    ))}
                  </span>
                ) : null}
                <span>{daily.at(-1) ? label(daily.at(-1)!.day) : ""}</span>
              </div>
            </div>
          ) : (
            <p className="text-ink-2 m-0 text-[13px]">{t("aiHub.score.spend.none")}</p>
          )}
          {tt || tokens ? (
            <dl className="border-divider m-0 mt-auto grid grid-cols-3 gap-3 border-t pt-3">
              <Fact label={t("aiHub.score.spend.input")} value={tokens ? n.tokens(input) : "–"} />
              <Fact label={t("aiHub.score.spend.output")} value={tokens ? n.tokens(output) : "–"} />
              <Fact
                label={t("aiHub.score.spend.outside")}
                value={tt?.prompts ? `${Math.round((tt.outsidePrompts / tt.prompts) * 100)}%` : "–"}
                title={tt ? t("aiHub.score.spend.outsideTip", { outside: tt.outsidePrompts, all: tt.prompts }) : undefined}
              />
            </dl>
          ) : null}
        </>
      )}
    </Card>
  );
}

const Fact = ({ label, value, title }: { label: string; value: string; title?: string }) => (
  <div className="min-w-0" title={title}>
    <dt className="text-ink-2 truncate text-xs" title={label}>
      {label}
    </dt>
    <dd className="text-ink m-0 mt-0.5 text-sm font-semibold tabular-nums">{value}</dd>
  </div>
);

/** Two bars on one scale: with AI in the accent, without in grey; the value sits at the bar's end. */
function Versus({ label, ai, other, max, fmt, better }: { label: string; ai: number; other: number; max: number; fmt: (n: number) => string; better: boolean }) {
  const t = useT();
  const row = (name: string, v: number, cls: string, strong: boolean) => (
    <span className="grid grid-cols-[4.75rem_minmax(0,1fr)_auto] items-center gap-2 text-xs">
      <span className="text-ink-2 truncate">{name}</span>
      <span className="bg-progress-track h-2 overflow-hidden rounded-full">
        <span className={cx("block h-full rounded-full", cls)} style={{ width: `${Math.max(3, (v / Math.max(max, 0.0001)) * 100)}%` }} />
      </span>
      <span className={cx("min-w-10 text-right tabular-nums", strong ? (better ? "text-ok font-semibold" : "text-ink font-semibold") : "text-ink-2")}>{fmt(v)}</span>
    </span>
  );
  return (
    <div className="grid gap-1.5">
      <span className="text-ink text-[13px] font-medium">{label}</span>
      {row(t("aiHub.score.effect.withAi"), ai, "bg-accent", true)}
      {row(t("aiHub.score.effect.without"), other, "bg-ink-2/45", false)}
    </div>
  );
}

/** 2. Does it pay off: tasks finished with AI recorded against the rest, and what people themselves say. */
function EffectCard({ people, outcomes }: { people: AiPeopleData | null; outcomes: Outcomes | null }) {
  const t = useT();
  const f = useFormat();
  const w = outcomes?.withAi;
  const cmp = w ? compareOutcomes(w.assisted, w.other) : null;
  const faster = cmp?.days ? cmp.days.other - cmp.days.ai : null;
  const points = cmp?.onTime ? cmp.onTime.ai - cmp.onTime.other : null;
  const helpful = people?.totals.helpful ?? null;
  return (
    <Card id="sc-effect" tone="green" icon={<TrendIcon />} title={t("aiHub.score.effect.title")} tip={t("aiHub.score.effect.tip", { min: MIN_COMPARE_SAMPLE })}>
      {!outcomes && !people ? (
        <LoadFailed what={t("aiHub.score.effect.title")} />
      ) : (
        <>
          <p className="m-0 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            {faster !== null && faster > 0 ? (
              <>
                <Big good>{f.daysShort(faster)}</Big>
                <span className="text-ink-2 text-[13px]">{t("aiHub.score.effect.faster")}</span>
              </>
            ) : points !== null && points > 0 ? (
              <>
                <Big good>+{points}</Big>
                <span className="text-ink-2 text-[13px]">{t("aiHub.score.effect.points")}</span>
              </>
            ) : helpful !== null ? (
              <>
                <Big>{Math.round(helpful * 100)}%</Big>
                <span className="text-ink-2 text-[13px]">{t("aiHub.score.effect.helpfulBig")}</span>
              </>
            ) : (
              <span className="text-ink-2 text-[13px]">
                {w ? t("aiHub.adoption.projects.notEnoughN", { ai: w.assisted.done, other: w.other.done, min: MIN_COMPARE_SAMPLE }) : t("aiHub.score.effect.none")}
              </span>
            )}
          </p>
          {cmp?.days ? (
            <Versus
              label={t("aiHub.score.effect.days")}
              ai={cmp.days.ai}
              other={cmp.days.other}
              max={Math.max(cmp.days.ai, cmp.days.other)}
              fmt={f.daysShort}
              better={cmp.days.ai < cmp.days.other}
            />
          ) : null}
          {cmp?.onTime ? (
            <Versus label={t("aiHub.score.effect.onTime")} ai={cmp.onTime.ai} other={cmp.onTime.other} max={100} fmt={(v) => `${v}%`} better={cmp.onTime.ai > cmp.onTime.other} />
          ) : null}
          <dl className="border-divider m-0 mt-auto grid grid-cols-3 gap-3 border-t pt-3">
            <Fact label={t("aiHub.score.effect.tasksAi")} value={w ? String(w.assisted.done) : "–"} />
            <Fact label={t("aiHub.score.effect.tasksOther")} value={w ? String(w.other.done) : "–"} />
            <Fact
              label={t("aiHub.score.effect.helpful")}
              value={helpful === null ? "–" : `${Math.round(helpful * 100)}%`}
              title={people ? t("aiHub.score.effect.helpfulTip", { count: people.totals.rated }) : undefined}
            />
          </dl>
        </>
      )}
    </Card>
  );
}

/** 3. Who uses it: the head count and everyone sorted into how much they use AI; each group filters the list below. */
function WhoCard({ people, filter, onFilter }: { people: AiPeopleData | null; filter: Filter; onFilter: (f: Filter) => void }) {
  const t = useT();
  const tt = people?.totals;
  return (
    <Card id="sc-who" tone="sky" icon={<UsersIcon />} title={t("aiHub.score.who.title")} tip={t("aiHub.score.who.tip")}>
      {!tt ? (
        <LoadFailed what={t("aiHub.score.who.title")} />
      ) : (
        <>
          <p className="m-0 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <Big>
              {tt.using}
              <span className="text-ink-2 text-xl font-medium">/{tt.people}</span>
            </Big>
            <span className="text-ink-2 text-[13px]">{t("aiHub.score.who.using", { pct: share(tt.using, tt.people) ?? 0 })}</span>
          </p>
          <span className="flex h-2.5 gap-[2px] overflow-hidden rounded-full" aria-hidden="true">
            {PATTERNS.map((k) =>
              tt.patterns[k] ? (
                <span key={k} className={cx("h-full first:rounded-l-full last:rounded-r-full", PATTERN_BG[k])} style={{ flexGrow: tt.patterns[k], flexBasis: 0 }} />
              ) : null,
            )}
          </span>
          <ul className="m-0 -mx-2 grid list-none p-0">
            {PATTERNS.filter((k) => tt.patterns[k]).map((k) => (
              <li key={k}>
                <button
                  type="button"
                  aria-pressed={filter === k}
                  onClick={() => onFilter(k)}
                  className={cx(
                    "hover:bg-hover flex min-h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors",
                    filter === k && "bg-selected",
                  )}
                >
                  <span aria-hidden="true" className={cx("size-2 shrink-0 rounded-[3px]", PATTERN_BG[k])} />
                  <span className="text-ink-soft min-w-0 flex-1 truncate">{t(`aiHub.score.pattern.${k}`)}</span>
                  <span className="text-ink font-medium tabular-nums">{tt.patterns[k]}</span>
                </button>
              </li>
            ))}
          </ul>
          {tt.attention ? (
            <button
              type="button"
              aria-pressed={filter === "attention"}
              onClick={() => onFilter("attention")}
              className={cx(
                "bg-warn-wash/60 text-warn ring-warn/15 hover:bg-warn-wash mt-auto flex min-h-8 items-center gap-2 rounded-md px-2.5 text-left text-[13px] font-medium ring-1 ring-inset transition-colors",
                filter === "attention" && "bg-warn-wash",
              )}
            >
              <ShieldIcon className="size-4 shrink-0" />
              <span className="min-w-0 flex-1">{t("aiHub.score.who.attention", { count: tt.attention })}</span>
              <ChevronRightIcon className="size-4 shrink-0" />
            </button>
          ) : null}
        </>
      )}
    </Card>
  );
}

function Bars({ title, rows }: { title: string; rows: { key: string; name: React.ReactNode; meta?: string; value: number; right: string; sub?: string; bg: string }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="min-w-0 px-5 py-4 max-sm:px-4">
      <h4 className="text-ink-2 m-0 mb-2.5 text-xs font-medium">{title}</h4>
      <ul className="m-0 grid list-none gap-2.5 p-0">
        {rows.map((r) => (
          <li key={r.key} className="grid min-w-0 gap-1 text-[13px]">
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="text-ink min-w-0 truncate">{r.name}</span>
              {r.meta ? <span className="text-ink-2 shrink-0 text-xs tabular-nums">{r.meta}</span> : null}
              <span className="flex-1" />
              <span className="text-ink shrink-0 font-medium tabular-nums">{r.right}</span>
              {r.sub ? <span className="text-ink-2 w-14 shrink-0 text-right text-xs tabular-nums">{r.sub}</span> : null}
            </span>
            <span className="bg-progress-track h-1.5 overflow-hidden rounded-full" aria-hidden="true">
              <span className={cx("block h-full rounded-full", r.bg)} style={{ width: `${Math.max(1.5, (r.value / max) * 100)}%` }} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Where the tokens go: by department, by what the company AI is asked to do, by model. Tokens are the bar. */
function WhereItGoes({ people, tokens }: { people: AiPeopleData; tokens: TokenUsageData | null }) {
  const t = useT();
  const n = useNum();
  const depts = people.departments.filter((d) => d.tokens > 0).slice(0, 6);
  const feats = people.features.slice(0, 6);
  const models = (tokens?.models ?? []).slice(0, 6);
  const cols = [depts.length > 1, feats.length > 0, models.length > 0].filter(Boolean).length;
  if (!cols) return null;
  return (
    <section aria-labelledby="sc-where" className="bg-surface shadow-card min-w-0 overflow-hidden rounded-xl">
      <header className="border-divider flex items-center gap-2 border-b px-5 py-3 max-sm:px-4">
        <h3 id="sc-where" className="text-ink m-0 min-w-0 flex-1 text-sm font-semibold tracking-[-0.01em]">
          {t("aiHub.score.where.title")}
        </h3>
        <Link href={`/app/ai/adoption/usage?days=${people.days}`} className="text-ink-soft text-xs">
          {t("aiHub.score.where.all")}
        </Link>
      </header>
      <div className={cx("divide-divider grid max-lg:divide-y lg:divide-x", cols === 3 ? "lg:grid-cols-3" : cols === 2 ? "lg:grid-cols-2" : "")}>
        {depts.length > 1 ? (
          <Bars
            title={t("aiHub.score.where.dept")}
            rows={depts.map((d) => ({
              key: d.name ?? "",
              name: d.name ?? t("aiHub.adoption.team.noDept"),
              meta: `${d.using}/${d.people}`,
              value: d.tokens,
              right: n.tokens(d.tokens),
              bg: "bg-violet",
            }))}
          />
        ) : null}
        {feats.length ? (
          <Bars
            title={t("aiHub.score.where.feature")}
            rows={feats.map((x) => ({
              key: x.feature,
              name: featureLabel(t, x.feature),
              meta: t("aiHub.tokens.peopleCount", { count: x.people }),
              value: x.tokens,
              right: n.tokens(x.tokens),
              bg: "bg-violet",
            }))}
          />
        ) : null}
        {models.length ? (
          <Bars
            title={t("aiHub.score.where.model")}
            rows={models.map((x) => ({
              key: `${x.tool}:${x.model}`,
              name: <span className="font-mono text-xs">{x.model}</span>,
              value: x.total,
              right: n.tokens(x.total),
              bg: TOOL_BG[toolKey(x.tool)] ?? "bg-violet",
            }))}
          />
        ) : null}
      </div>
    </section>
  );
}

/** A person's window as a strip of bars, a cell per day (per week over 90 days). */
function Spark({ values, className }: { values: number[]; className?: string }) {
  const max = Math.max(1, ...values);
  return (
    <span className={cx("flex h-6 items-end gap-px", className)} aria-hidden="true">
      {values.map((v, i) => (
        <span key={i} className={cx("min-w-px flex-1 rounded-[1px]", v ? "bg-accent" : "bg-edge")} style={{ height: v ? `${Math.max(14, (v / max) * 100)}%` : "2px" }} />
      ))}
    </span>
  );
}

type T = ReturnType<typeof useT>;
const KNOWN_TOPICS = new Set(["code", "writing", "analysis", "translation", "research", "sales", "hr", "design", "planning"]);
/** How a person uses AI, in a few words from their counts: the pattern, the tools, the kind of work, what they say. */
export function profileLine(t: T, p: AiProfile, days: number): string[] {
  if (p.pattern === "none") return [t("aiHub.score.line.none")];
  if (p.pattern === "lapsed") return [t("aiHub.score.line.lapsed", { days })];
  const tools = [...p.sources.map((s) => sourceLabel(t, s.key)), ...p.tools.map((x) => t(`aiHub.tokens.tool.${toolKey(x.key)}`))].slice(0, 2);
  // A company-defined topic has no label here and would read "Other": the line names only the kinds it can name.
  const topics = p.topics
    .filter((x) => KNOWN_TOPICS.has(x.key))
    .slice(0, 2)
    .map((x) => topicLabel(t, x.key));
  const work = topics.length ? topics : p.features.slice(0, 2).map((x) => featureLabel(t, x.key));
  return [
    `${t(`aiHub.score.pattern.${p.pattern}`)}, ${t("aiHub.score.line.days", { n: p.activeDays, days })}`,
    tools.length ? tools.join(", ") : null,
    work.length ? work.join(", ") : null,
    p.helpful === null ? null : t(p.helpful >= 0.5 ? "aiHub.score.line.helps" : "aiHub.score.line.helpsNot", { pct: Math.round(p.helpful * 100) }),
  ].filter((x): x is string => !!x);
}

const SORTS = ["use", "tokens", "helpful"] as const;
type Sort = (typeof SORTS)[number];
const ROW =
  "grid-cols-[minmax(0,1.1fr)_minmax(0,1.6fr)_6rem_4.5rem_5.5rem_1.25rem] max-xl:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_4.5rem_1.25rem] max-md:grid-cols-[minmax(0,1fr)_4.5rem_1.25rem]";

/** Everyone in view, one line each: who, how they use AI, their days, tokens and the work they finished. */
function PeopleList({ data, outcomes, filter, onFilter }: { data: AiPeopleData; outcomes: Outcomes | null; filter: Filter; onFilter: (f: Filter) => void }) {
  const t = useT();
  const [sort, setSort] = useState<Sort>("use");
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const work = useMemo(() => new Map((outcomes?.people ?? []).map((o) => [o.userId, o])), [outcomes]);
  const list = useMemo(() => {
    const rows = data.people.filter((p) => (filter === "all" ? true : filter === "attention" ? !!p.attention : p.pattern === filter));
    if (sort === "tokens") return [...rows].sort((a, b) => b.tokens - a.tokens || b.uses - a.uses);
    if (sort === "helpful") return [...rows].sort((a, b) => (b.helpful ?? -1) - (a.helpful ?? -1) || b.rated - a.rated);
    return rows;
  }, [data.people, filter, sort]);
  const shown = all ? list : list.slice(0, 12);
  const chips: Filter[] = ["all", ...PATTERNS.filter((k) => data.totals.patterns[k]), ...(data.totals.attention ? (["attention"] as const) : [])];
  return (
    <section id="ai-people" aria-labelledby="sc-people" className="bg-surface shadow-card min-w-0 scroll-mt-20 overflow-hidden rounded-xl" data-testid="ai-people">
      <header className="border-divider flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-5 py-3 max-sm:px-4">
        <h3 id="sc-people" className="text-ink m-0 min-w-0 flex-1 basis-48 text-sm font-semibold tracking-[-0.01em]">
          {t("aiHub.score.people.title")} <span className="text-ink-2 font-normal tabular-nums">{list.length}</span>
        </h3>
        <Segmented
          size="sm"
          label={t("aiHub.score.people.sort")}
          value={sort}
          onChange={(v) => setSort(v)}
          options={SORTS.map((k) => ({ value: k, label: t(`aiHub.score.people.by.${k}`) }))}
        />
      </header>
      <div className="border-divider no-scrollbar flex gap-1.5 overflow-x-auto border-b px-5 py-2 max-sm:px-4" role="group" aria-label={t("aiHub.score.people.filter")}>
        {chips.map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={filter === k}
            onClick={() => {
              onFilter(k);
              setAll(false);
            }}
            className={cx(
              "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium ring-1 ring-inset transition-colors",
              filter === k ? "bg-brand text-on-brand ring-brand" : "text-ink-soft ring-hairline hover:bg-hover",
            )}
          >
            {k !== "all" && k !== "attention" ? <span aria-hidden="true" className={cx("size-2 rounded-[3px]", PATTERN_BG[k], filter === k && "ring-on-brand/40 ring-1")} /> : null}
            {t(k === "all" ? "aiHub.score.people.all" : k === "attention" ? "aiHub.score.people.attention" : `aiHub.score.pattern.${k}`)}
            <span className={cx("tabular-nums", filter === k ? "text-on-brand/70" : "text-ink-2")}>
              {k === "all" ? data.totals.people : k === "attention" ? data.totals.attention : data.totals.patterns[k]}
            </span>
          </button>
        ))}
      </div>
      <div aria-hidden="true" className={cx("text-ink-2 border-divider grid items-center gap-3 border-b px-5 py-1.5 text-xs max-md:hidden", ROW)}>
        <span>{t("aiHub.score.people.col.person")}</span>
        <span>{t("aiHub.score.people.col.how")}</span>
        <span className="max-xl:hidden">{t("aiHub.score.people.col.days", { days: data.days })}</span>
        <span className="text-right">{t("aiHub.score.people.col.tokens")}</span>
        <span className="text-right max-xl:hidden">{t("aiHub.score.people.col.work")}</span>
        <span />
      </div>
      {shown.length ? (
        <ul className="divide-divider m-0 list-none divide-y p-0">
          {shown.map((p) => (
            <PersonRow
              key={p.userId}
              p={p}
              days={data.days}
              work={work.get(p.userId)}
              open={open === p.userId}
              onToggle={() => setOpen((o) => (o === p.userId ? null : p.userId))}
            />
          ))}
        </ul>
      ) : (
        <p className="text-ink-2 m-0 px-5 py-3 text-[13px]">{t("aiHub.score.people.empty")}</p>
      )}
      {list.length > 12 ? (
        <button type="button" className={cx(btnGhost, btnSm, "mx-3 my-2")} aria-expanded={all} onClick={() => setAll((x) => !x)}>
          {all ? t("ui.showLess") : t("aiHub.tokens.allPeople", { count: list.length })}
        </button>
      ) : null}
    </section>
  );
}

function PersonRow({ p, days, work, open, onToggle }: { p: AiProfile; days: number; work: Outcomes["people"][number] | undefined; open: boolean; onToggle: () => void }) {
  const t = useT();
  const n = useNum();
  const line = profileLine(t, p, days);
  const quiet = p.pattern === "none" || p.pattern === "lapsed";
  const onTime = work ? share(work.onTime, work.dated) : null;
  const id = `sc-p-${p.userId}`;
  return (
    <li className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
        className={cx(
          "hover:bg-hover/70 grid min-h-12 w-full cursor-pointer items-center gap-3 px-5 py-1.5 text-left text-[13px] transition-colors max-sm:px-4",
          ROW,
          open && "bg-hover/50",
        )}
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <Avatar id={p.userId} name={p.displayName} size="sm" />
          <span className="min-w-0">
            <span className="text-ink flex min-w-0 items-center gap-1.5 font-medium">
              <span className="truncate">{p.displayName || "—"}</span>
              {p.attention ? <ShieldIcon className="text-warn size-3.5 shrink-0" aria-label={t(`aiHub.score.attention.${p.attention}`, { count: p.flagged })} /> : null}
            </span>
            <span className="text-ink-2 block truncate text-xs">
              <span className="md:hidden">{line[0]}</span>
              <span className="max-md:hidden">{p.department ?? p.title ?? ""}</span>
            </span>
          </span>
        </span>
        <span className="flex min-w-0 items-center gap-2 max-md:hidden" title={line.join(" · ")}>
          <span aria-hidden="true" className={cx("size-2 shrink-0 rounded-[3px]", PATTERN_BG[p.pattern])} />
          <span className={cx("min-w-0 truncate", quiet ? "text-ink-2" : "text-ink")}>
            {line[0]}
            {line.length > 1 ? <span className="text-ink-2"> · {line.slice(1).join(" · ")}</span> : null}
          </span>
        </span>
        <Spark values={p.spark} className="max-xl:hidden" />
        <span className="text-ink text-right font-medium tabular-nums">{p.tokens ? n.tokens(p.tokens) : <span className="text-ink-2 font-normal">–</span>}</span>
        <span className="text-right text-xs tabular-nums max-xl:hidden" title={t("aiHub.score.people.workTip")}>
          {work?.done ? (
            <>
              <span className="text-ink">{t("aiHub.score.people.done", { count: work.done })}</span>
              {onTime !== null ? (
                <span className={cx("block", onTime >= 80 ? "text-ok" : onTime < 50 ? "text-block" : "text-ink-2")}>{t("aiHub.score.people.onTime", { pct: onTime })}</span>
              ) : null}
            </>
          ) : (
            <span className="text-ink-2">–</span>
          )}
        </span>
        <ChevronRightIcon aria-hidden="true" className={cx("text-ink-2 size-4 justify-self-end transition-transform", open && "rotate-90")} />
      </button>
      {open ? <PersonDetail id={id} p={p} days={days} work={work} /> : null}
    </li>
  );
}

function Mini({ title, rows, label, bg }: { title: string; rows: Top; label: (k: string) => string; bg: string }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  if (!rows.length) return null;
  return (
    <div className="min-w-0">
      <h4 className="text-ink-2 m-0 mb-1.5 text-xs font-medium">{title}</h4>
      <ul className="m-0 grid list-none gap-1.5 p-0 text-[13px]">
        {rows.map((r) => (
          <li key={r.key} className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)_2rem] items-center gap-2">
            <span className="text-ink truncate">{label(r.key)}</span>
            <span className="bg-progress-track h-1.5 overflow-hidden rounded-full" aria-hidden="true">
              <span className={cx("block h-full rounded-full", bg)} style={{ width: `${Math.max(3, (r.count / max) * 100)}%` }} />
            </span>
            <span className="text-ink-2 text-right text-xs tabular-nums">{r.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A person opened: the same counts behind their line, as small bars, and where to read more. */
function PersonDetail({ id, p, days, work }: { id: string; p: AiProfile; days: number; work: Outcomes["people"][number] | undefined }) {
  const t = useT();
  const n = useNum();
  const f = useFormat();
  const line = profileLine(t, p, days);
  const facts = [
    { label: t("aiHub.score.detail.uses"), value: f.number(p.uses, 0), sub: p.prevUses ? t("aiHub.score.detail.before", { n: p.prevUses }) : undefined },
    { label: t("aiHub.score.detail.activeDays"), value: `${p.activeDays}/${days}` },
    {
      label: t("aiHub.score.detail.tokens"),
      value: n.tokens(p.tokens),
      sub: p.localTokens ? t("aiHub.score.detail.local", { tokens: n.tokens(p.localTokens) }) : undefined,
    },
    { label: t("aiHub.score.detail.helpful"), value: p.helpful === null ? "–" : `${Math.round(p.helpful * 100)}%`, sub: t("aiHub.score.detail.rated", { count: p.rated }) },
    { label: t("aiHub.score.detail.aiTasks"), value: String(p.aiTasks), sub: work?.done ? t("aiHub.score.people.done", { count: work.done }) : undefined },
  ];
  return (
    <div id={id} className="bg-ground/60 border-divider animate-rise grid gap-4 border-t px-5 py-4 max-sm:px-4 md:pl-[3.75rem]">
      <p className="text-ink m-0 text-[13px] md:hidden">{line.join(" · ")}</p>
      {p.attention ? (
        <p className="text-warn m-0 flex items-center gap-1.5 text-[13px] font-medium">
          <ShieldIcon className="size-4 shrink-0" />
          {t(`aiHub.score.attention.${p.attention}`, { count: p.flagged })}
        </p>
      ) : null}
      <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(7.5rem,1fr))] gap-x-4 gap-y-3">
        {facts.map((x) => (
          <div key={x.label} className="min-w-0">
            <dt className="text-ink-2 truncate text-xs">{x.label}</dt>
            <dd className="text-ink m-0 mt-0.5 text-base font-semibold tabular-nums">{x.value}</dd>
            {x.sub ? <dd className="text-ink-2 m-0 truncate text-xs tabular-nums">{x.sub}</dd> : null}
          </div>
        ))}
      </dl>
      {p.uses || p.localTokens ? (
        <div className="grid gap-x-8 gap-y-4 md:grid-cols-3">
          <Mini title={t("aiHub.score.detail.tools")} rows={p.sources} label={(k) => sourceLabel(t, k)} bg="bg-accent" />
          <Mini title={t("aiHub.score.detail.topics")} rows={p.topics} label={(k) => topicLabel(t, k)} bg="bg-accent" />
          <Mini title={t("aiHub.score.detail.features")} rows={p.features} label={(k) => featureLabel(t, k)} bg="bg-violet" />
        </div>
      ) : null}
      <span className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <Link href={`/app/work/people/${p.userId}`} className="text-ink-soft">
          {t("aiHub.score.detail.openPerson")}
        </Link>
        <Link href={`/app/ai/adoption/usage?days=${days}`} className="text-ink-soft">
          {t("aiHub.score.detail.openUsage")}
        </Link>
      </span>
    </div>
  );
}

/** Someone who follows no team: their own line, the same rule a manager would read about them. */
function MyLine({ me, days }: { me: AiProfile | undefined; days: number }) {
  const t = useT();
  if (!me) return null;
  return (
    <section
      aria-labelledby="sc-me"
      className="bg-surface shadow-card flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 rounded-xl px-5 py-4 max-sm:px-4"
      data-testid="ai-me-line"
    >
      <span aria-hidden="true" className={cx("size-2.5 shrink-0 rounded-[3px]", PATTERN_BG[me.pattern])} />
      <div className="min-w-0 flex-1 basis-56">
        <h3 id="sc-me" className="text-ink-2 m-0 text-xs font-medium">
          {t("aiHub.score.me.title")}
        </h3>
        <p className="text-ink m-0 mt-0.5 text-sm">{profileLine(t, me, days).join(" · ")}</p>
      </div>
      <Spark values={me.spark} className="w-40 max-sm:w-full" />
    </section>
  );
}
