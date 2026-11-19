"use client";

import { dateFormat } from "@/lib/intl";
import { useToast } from "@/components/ui/Toast";
import { topicLabel, topicLabels, sourceLabel, sensitiveLabel } from "@/lib/ai-labels";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { useFormat, useT } from "@/lib/i18n/client";
import { Avatar } from "@/lib/people";
import { btn, btnGhost, btnSm, cx } from "@/lib/ui";
import { Segmented } from "@/components/ui/Segmented";
import { formatMoney } from "@/lib/money";
import { Drawer } from "@/components/ui/Drawer";
import { ChartIcon, DownloadIcon, ShieldIcon } from "@/components/app/icons";
import { panel, PanelHead } from "./progressUi";
import { Figures, ReportPage } from "./report";
import { EmptyState } from "@/components/ui/EmptyState";
import { InfoTip } from "@/components/ui/InfoTip";
import { downloadCsv } from "@/lib/downloadCsv";
import { featureLabel } from "@/lib/ai-labels";
import { usd } from "@/lib/ai-spend";
import { INTL_TAG } from "@/lib/i18n/config";
import { workspaceTimeZone } from "@/lib/timezone";
import { Effect, HeavyLight, UsedFor, pct, sumUp, type Outcomes } from "./AiEffect";
import { AiHelpfulCard, type HelpfulBreakdown } from "./AiHelpfulCard";
import { AiSafetyCard } from "./AiSafetyCard";
import { AiCapabilityCard } from "@/components/ai-insights/AiCapabilityCard";
import { chartable, firstShown } from "@/lib/metrics";

export type { Outcomes } from "./AiEffect";

export interface Policy {
  detail: "topic" | "summary";
  captureResponses: boolean;
  retentionDays: number;
}
export interface AiConversation {
  id: string;
  userId: string;
  source: string;
  topic: string;
  sensitive: string[];
  prompts: number;
  model: string;
  startedAt: string;
  lastAt: string;
  summary?: string;
}
interface Counts {
  sources: Record<string, number>;
  topics: Record<string, number>;
  prompts: number;
  flagged: number;
}
export interface AiOversight {
  days: number;
  /** The workspace's IANA zone; `daily` and `weekly` are counted in it. */
  timeZone?: string;
  policy: Policy;
  canEditPolicy: boolean;
  totals: {
    people: number;
    active: number;
    prompts: number;
    inApp: number;
    tokens: number;
    /** USD from the prices in Admin › Kết nối AI; unpricedTokens had no price (hosted models only). */
    cost?: number;
    unpricedTokens?: number;
    outside: number;
    flagged: number;
    extension: number;
  };
  people: (Counts & {
    userId: string;
    displayName: string;
    title: string | null;
    department: string | null;
    extension: boolean;
    conversations: number;
    lastAt: string | null;
    /** Company-AI features used inside the app (summaries, translation, task and doc helpers…). */
    inApp: { calls: number; tokens: number; cost?: number; features: Record<string, number> };
  })[];
  departments: (Counts & { name: string | null; people: number; active: number; inApp: number; tokens: number; cost?: number })[];
  daily: { day: string; source: string; prompts: number }[];
  /** Eight weeks (Monday first): conversation prompts and in-app AI uses, and how many people used AI. */
  weekly: { week: string; prompts: number; inApp: number; people: number; cost?: number }[];
  features: { feature: string; calls: number; tokens: number; cost?: number; people: number }[];
  /** What the company AI worked on: tasks, documents, meetings… (calls and distinct items). */
  subjects?: { type: string; calls: number; items: number }[];
  /** Staff's own "AI có giúp không?" answers by tool, topic and department (AI Insights). */
  helpful?: HelpfulBreakdown;
  topicLabels?: { key: string; labelVi: string; labelEn: string }[];
  recent: AiConversation[];
  flagged: AiConversation[];
}

/** Work module followup/outcomes: what the same people got done (Theo dõi's numbers, per window). */
const SOURCES = ["company", "chatgpt", "claude", "gemini", "copilot", "other"] as const;
// Identity colours (bòn bon accents), never status: which tool, not whether it is good or bad.
const SOURCE_BG: Record<string, string> = { company: "bg-brand", chatgpt: "bg-sky", claude: "bg-tangerine", gemini: "bg-violet", copilot: "bg-mark-blue", other: "bg-ink-2" };
const top = (r: Record<string, number>, n: number) =>
  Object.entries(r)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);

/**
 * Tiến độ › AI: does AI help, then what people do with it. The answer first (tasks finished with the company AI
 * against the rest), four numbers, use per day by tool, what the company AI and the outside tools are used for,
 * cost, and what needs attention (sensitive data stays in view). Departments, people and the frequent-user
 * comparison fold away below. A person opens their conversations; admins set the policy here.
 */
export function AiOversightView({ data, outcomes }: { data: AiOversight; outcomes?: Outcomes | null }) {
  const t = useT();
  const { ago, locale } = useFormat();
  const custom = topicLabels(data.topicLabels ?? [], locale);
  const [person, setPerson] = useState<string | null>(null);
  const [dept, setDept] = useState<string | null>(null);
  const tt = data.totals;
  const work = new Map((outcomes?.people ?? []).map((o) => [o.userId, o]));
  const people = dept === null ? data.people : data.people.filter((p) => (p.department ?? "") === dept);
  const topics = data.people.reduce<Record<string, number>>((acc, p) => {
    for (const [k, v] of Object.entries(p.topics)) acc[k] = (acc[k] ?? 0) + v;
    return acc;
  }, {});
  const exportCsv = () =>
    downloadCsv(`ai-${new Date().toISOString().slice(0, 10)}.csv`, [
      [
        t("follow.person"),
        t("aiw.o.dept"),
        t("aiw.o.prompts"),
        t("aiw.o.inApp"),
        t("aiw.o.costCol"),
        t("aiw.o.tools"),
        t("aiw.o.topics"),
        t("aiw.o.flaggedShort"),
        t("follow.colDone"),
        t("aiw.o.onTime"),
        t("aiw.o.last"),
      ],
      ...people.map((p) => [
        p.displayName,
        p.department ?? "",
        String(p.prompts),
        String(p.inApp.calls),
        (p.inApp.cost ?? 0).toFixed(4),
        top(p.sources, 5)
          .map(([k, v]) => `${sourceLabel(t, k)} ${v}`)
          .join(", "),
        top(p.topics, 3)
          .map(([k]) => topicLabel(t, k, custom))
          .join(", "),
        String(p.flagged),
        work.has(p.userId) ? String(work.get(p.userId)!.done) : "",
        work.has(p.userId) ? (pct(work.get(p.userId)!.onTime, work.get(p.userId)!.dated) ?? "") : "",
        p.lastAt ? new Date(p.lastAt).toLocaleDateString(INTL_TAG[locale], { dateStyle: "medium" }) : "",
      ]),
    ]);
  const flagged = data.flagged.length > 0;
  return (
    <ReportPage
      title={`${t("work.report.ai")} · ${t("aiw.o.days", { count: data.days })}`}
      actions={
        <>
          <Segmented
            label={t("aiw.o.window")}
            value={String(data.days)}
            options={[7, 30, 90].map((d) => ({ value: String(d), label: t("aiw.o.days", { count: d }), href: `/app/ai/adoption/usage?days=${d}` }))}
          />
          {data.canEditPolicy ? (
            // The policy is set in Admin › AI › Privacy, with the safety net and retention.
            <Link href="/admin/workspace/ai/privacy" className={cx(btn, btnSm, "no-underline")} title={t(`aiw.detailShort.${data.policy.detail}`)}>
              <ShieldIcon />
              {t("aiw.o.policy")}
            </Link>
          ) : (
            <span className="text-ink-2 flex items-center gap-1.5 text-xs">
              <ShieldIcon className="size-3.5" />
              {t(`aiw.detailShort.${data.policy.detail}`)}
            </span>
          )}
        </>
      }
    >
      {/* One short line: what is recorded, in two words, with the full sentence behind ⓘ; the extension
          count and its reminder beside it. The paragraph it replaces ran to three lines. */}
      <p className="text-ink-2 m-0 mb-5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs" data-testid="ai-recorded">
        <span className="flex items-center gap-1.5">
          <Link href="/app/me?tab=ai" className="text-ink-soft no-underline hover:underline">
            {t(`aiw.detailShort.${data.policy.detail}`)}
          </Link>
          <InfoTip
            text={`${t("aiw.o.recordedLine", { detail: t(`aiw.detailShort.${data.policy.detail}`).toLowerCase(), responses: data.policy.captureResponses ? "" : t("aiw.o.recordedNoResponses") })} ${t("aiw.o.recordedPolicy")}: /app/me?tab=ai`}
            label={t("aiw.o.recordedPolicy")}
          />
        </span>
        <span aria-hidden="true">·</span>
        <span className="flex items-center gap-x-2">
          {t("aiw.o.extension")} <span className="text-ink font-medium tabular-nums">{`${tt.extension}/${tt.people}`}</span>
          <InfoTip text={t("aiw.o.extensionInfo")} label={t("aiw.o.extension")} />
          {tt.extension < tt.people ? <RemindExtension /> : null}
        </span>
      </p>

      <div id="ai-figures" className="scroll-mt-16">
        <Figures
          label={t("aiw.o.numbers")}
          items={[
            { label: t("aiw.o.active"), value: `${tt.active}/${tt.people}` },
            { label: t("aiw.o.prompts"), value: tt.prompts.toLocaleString(INTL_TAG[locale]) },
            { label: t("aiw.o.outside"), value: tt.prompts ? `${Math.round((tt.outside / tt.prompts) * 100)}%` : "–", tone: "quiet" },
            { label: t("aiw.o.cost"), value: formatMoney(tt.cost ?? 0, "USD", locale).short, tone: "quiet" },
            { label: t("aiw.o.flaggedShort"), value: tt.flagged, tone: tt.flagged ? "bad" : "quiet" },
          ]}
        />
      </div>

      {outcomes ? <Effect outcomes={outcomes} weekly={data.weekly} /> : null}
      {data.helpful ? <AiHelpfulCard helpful={data.helpful} custom={custom} /> : null}
      <DailyChart daily={data.daily} days={data.days} {...(data.timeZone ? { timeZone: data.timeZone } : {})} />
      <UsedFor features={data.features} subjects={data.subjects ?? []} topics={top(topics, 6)} custom={custom} />

      {/* Nothing recorded yet: say so in place of the list of conversations. */}
      {data.recent.length === 0 && !flagged ? (
        <section aria-label={t("aiw.o.recent")} className={panel}>
          <EmptyState
            kind="none"
            title={t("aiw.o.emptyTitle")}
            action={
              <Link href="/app/me?tab=ai" className={cx(btn, btnSm, "no-underline")}>
                {t("aiw.o.emptyCta")}
              </Link>
            }
          />
        </section>
      ) : null}
      {flagged ? (
        <section aria-labelledby="ai-flag-h" className={panel}>
          {/* Coaching, not an alarm: someone may have pasted sensitive data; the manager's job is a friendly word. */}
          <PanelHead id="ai-flag-h" hue="orange" icon={<ShieldIcon />} title={t("aiw.o.attention")} count={tt.flagged}>
            <InfoTip text={t("aiw.o.attentionLead")} label={t("aiw.o.attention")} align="right" />
          </PanelHead>
          <ConversationList items={data.flagged} people={data.people} compact custom={custom} />
        </section>
      ) : null}

      <AiSafetyCard days={data.days} />
      <AiCapabilityCard days={data.days} />

      <Details
        sections={[
          // The recent conversations: a detail behind a toggle, not a list of prompts on the main page.
          ...(data.recent.length
            ? [
                {
                  id: "ai-recent",
                  title: t("aiw.o.recent"),
                  meta: String(data.recent.length),
                  body: <ConversationList items={data.recent} people={data.people} custom={custom} />,
                },
              ]
            : []),
          ...(data.departments.some((d) => d.name)
            ? [
                {
                  id: "ai-departments",
                  title: t("follow.deptTitle"),
                  meta: String(data.departments.length),
                  body: (
                    <ul className="divide-hairline grid list-none divide-y p-0">
                      {data.departments.map((d) => {
                        const key = d.name ?? "";
                        const g = sumUp(data.people.filter((p) => (p.department ?? "") === key).map((p) => work.get(p.userId)));
                        return (
                          <li key={key}>
                            <button
                              type="button"
                              aria-pressed={dept === key}
                              onClick={() => setDept(dept === key ? null : key)}
                              className={cx(
                                "grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-2 px-4 py-3 text-left transition-colors md:grid-cols-[minmax(0,11rem)_minmax(0,1fr)_auto_auto]",
                                dept === key ? "bg-selected/60" : "hover:bg-hover/60",
                              )}
                            >
                              <span className="min-w-0">
                                <span className="block truncate font-medium">{d.name ?? t("follow.deptNone")}</span>
                                <span className="text-ink-2 block truncate text-xs">
                                  {top(d.topics, 2)
                                    .map(([k]) => topicLabel(t, k, custom))
                                    .join(" · ") || t("aiw.o.noUse")}
                                </span>
                              </span>
                              <span className="order-last col-span-2 md:order-none md:col-span-1">
                                <SourceBar sources={d.sources} />
                              </span>
                              <span className="text-ink-2 text-xs tabular-nums">
                                {t("aiw.o.activeOf", { active: d.active, people: d.people })}
                                {outcomes ? ` · ${t("aiw.o.deptWork", { done: g.done, onTime: pct(g.onTime, g.dated) ?? t("ui.noData") })}` : ""}
                              </span>
                              <span className="text-right text-xs tabular-nums">
                                {d.flagged ? (
                                  <span className="inline-flex items-center gap-1.5 font-medium">
                                    <span aria-hidden="true" className="bg-block size-1.5 rounded-full" />
                                    {t("aiw.o.flaggedCount", { count: d.flagged })}
                                  </span>
                                ) : d.cost ? (
                                  usd(d.cost, locale)
                                ) : null}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  ),
                },
              ]
            : []),
          {
            id: "ai-people",
            title: t("aiw.o.people"),
            meta: dept ? `${dept} · ${people.length}` : String(people.length),
            body: (
              <div className="grid gap-0">
                <div className="flex items-center gap-2 px-4 pt-3">
                  <Legend />
                  <span className="flex-1" />
                  <button type="button" className={cx(btnGhost, btnSm)} onClick={exportCsv}>
                    <DownloadIcon />
                    {t("follow.export")}
                  </button>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-left text-sm">
                    <thead>
                      <tr className="text-ink-2 border-hairline whitespace-nowrap border-b text-xs">
                        <th className="px-4 py-2.5 font-medium">{t("follow.person")}</th>
                        <th className="w-[24%] px-3 py-2.5 font-medium">{t("aiw.o.tools")}</th>
                        <th className="px-3 py-2.5 text-right font-medium">{t("aiw.o.prompts")}</th>
                        <th className="hidden px-3 py-2.5 text-right font-medium sm:table-cell" title={t("aiw.o.inAppHint")}>
                          {t("aiw.o.inApp")}
                        </th>
                        <th className="hidden px-3 py-2.5 text-right font-medium md:table-cell" title={t("aiw.o.doneHint")}>
                          {t("follow.colDone")}
                        </th>
                        <th className="px-3 py-2.5 text-right font-medium">{t("aiw.o.flaggedShort")}</th>
                        <th className="hidden px-4 py-2.5 text-right font-medium lg:table-cell">{t("aiw.o.last")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {people.map((p) => (
                        <tr key={p.userId} className="border-hairline hover:bg-hover/60 cursor-pointer border-b last:border-0" onClick={() => setPerson(p.userId)}>
                          <td className="px-4 py-2.5">
                            <button
                              type="button"
                              className="flex min-w-0 items-center gap-2.5 text-left"
                              onClick={(e) => {
                                e.stopPropagation();
                                setPerson(p.userId);
                              }}
                            >
                              <Avatar id={p.userId} name={p.displayName} size="sm" />
                              <span className="min-w-0">
                                <span className="block truncate font-medium">{p.displayName}</span>
                                <span className="text-ink-2 block truncate text-xs">{[p.department, p.extension ? null : t("aiw.o.extOff")].filter(Boolean).join(" · ")}</span>
                              </span>
                            </button>
                          </td>
                          <td className="px-3 py-2.5">{p.prompts ? <SourceBar sources={p.sources} /> : <span className="text-ink-2 text-xs">–</span>}</td>
                          <td className={cx("px-3 py-2.5 text-right tabular-nums", !p.prompts && "text-ink-2")}>{p.prompts}</td>
                          <td
                            className={cx("hidden px-3 py-2.5 text-right tabular-nums sm:table-cell", !p.inApp.calls && "text-ink-2")}
                            title={top(p.inApp.features, 4)
                              .map(([k, v]) => `${featureLabel(t, k)} ${v}`)
                              .join(", ")}
                          >
                            {p.inApp.calls}
                          </td>
                          <td className={cx("hidden px-3 py-2.5 text-right tabular-nums md:table-cell", !work.get(p.userId)?.done && "text-ink-2")}>
                            {work.get(p.userId)?.done ?? "–"}
                          </td>
                          <td className={cx("px-3 py-2.5 text-right tabular-nums", p.flagged ? "text-ink font-semibold" : "text-ink-2")}>
                            {p.flagged ? <span aria-hidden="true" className="bg-block mr-1.5 inline-block size-1.5 rounded-full align-middle" /> : null}
                            {p.flagged}
                          </td>
                          <td className="text-ink-2 hidden whitespace-nowrap px-4 py-2.5 text-right text-xs lg:table-cell">{p.lastAt ? ago(p.lastAt) : "–"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ),
          },
          ...(outcomes
            ? [
                {
                  id: "ai-compare",
                  title: t("aiw.o.compareShort"),
                  body: (
                    <div className="grid gap-3 px-4 py-3">
                      <p className="text-ink-2 m-0 flex items-center gap-1.5 text-xs">
                        {t("aiw.o.days", { count: data.days })}
                        <InfoTip text={t("aiw.o.effectLead", { count: data.days })} label={t("aiw.o.compareTitle")} />
                      </p>
                      <HeavyLight data={data} work={work} />
                    </div>
                  ),
                },
              ]
            : []),
        ]}
      />

      {person ? <PersonDrawer userId={person} days={data.days} name={data.people.find((p) => p.userId === person)?.displayName ?? ""} onClose={() => setPerson(null)} /> : null}
    </ReportPage>
  );
}

/**
 * The detail sections (departments, people, frequent users against the rest) behind one row of toggles instead of
 * a stack of folded cards: several can be open at once, in a fixed order, and a #id in the URL opens that one.
 */
function Details({ sections }: { sections: { id: string; title: string; meta?: string; body: React.ReactNode }[] }) {
  const t = useT();
  const [open, setOpen] = useState<string[]>([]);
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (sections.some((s) => s.id === id)) setOpen([id]);
    // Only on mount: later toggles own the state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const toggle = (id: string) => {
    const next = open.includes(id) ? open.filter((x) => x !== id) : [...open, id];
    setOpen(next);
    history.replaceState(null, "", next.length ? `#${next[next.length - 1]}` : window.location.pathname + window.location.search);
  };
  return (
    <section id="ai-details" aria-label={t("aiw.o.details")} className={cx(panel, "scroll-mt-16")}>
      <div className="flex flex-wrap items-center gap-2 pb-3">
        <h2 className="text-ink m-0 mr-2 text-sm font-medium">{t("aiw.o.details")}</h2>
        {sections.map((s) => {
          const on = open.includes(s.id);
          return (
            <button
              key={s.id}
              type="button"
              aria-expanded={on}
              aria-controls={s.id}
              onClick={() => toggle(s.id)}
              className={cx(
                "inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[13px] transition-colors",
                on ? "bg-ink text-on-brand" : "text-ink-soft hover:bg-hover shadow-[0_0_0_1px_var(--hairline)]",
              )}
            >
              {s.title}
              {s.meta ? <span className={cx("text-xs tabular-nums", on ? "text-on-brand/70" : "text-ink-2")}>{s.meta}</span> : null}
            </button>
          );
        })}
      </div>
      {sections
        .filter((s) => open.includes(s.id))
        .map((s) => (
          <section key={s.id} id={s.id} aria-label={s.title} className="border-hairline animate-rise border-t">
            {s.body}
          </section>
        ))}
    </section>
  );
}

function SourceBar({ sources }: { sources: Record<string, number> }) {
  const t = useT();
  const total = Object.values(sources).reduce((n, v) => n + v, 0);
  if (!total) return <span className="bg-hover block h-2 rounded-full" />;
  return (
    <span
      className="bg-hover flex h-2 overflow-hidden rounded-full"
      role="img"
      aria-label={SOURCES.filter((s) => sources[s])
        .map((s) => `${sourceLabel(t, s)} ${sources[s]}`)
        .join(", ")}
    >
      {SOURCES.filter((s) => sources[s]).map((s) => (
        <span key={s} className={cx("block h-full", SOURCE_BG[s])} style={{ width: `${(sources[s]! / total) * 100}%` }} />
      ))}
    </span>
  );
}

function Legend() {
  const t = useT();
  return (
    <p className="text-ink-2 m-0 flex flex-wrap gap-x-4 gap-y-1 text-xs">
      {SOURCES.filter((s) => s !== "other").map((s) => (
        <span key={s} className="flex items-center gap-1.5">
          <span className={cx("size-2.5 rounded-sm", SOURCE_BG[s])} />
          {sourceLabel(t, s)}
        </span>
      ))}
    </p>
  );
}

function ConversationList({
  items,
  people,
  compact,
  custom,
}: {
  items: AiConversation[];
  people: { userId: string; displayName: string }[];
  compact?: boolean;
  custom?: Record<string, string>;
}) {
  const t = useT();
  const { ago } = useFormat();
  const name = (id: string) => people.find((p) => p.userId === id)?.displayName ?? "";
  return (
    <>
      <ul className={cx("m-0 grid list-none grid-cols-[minmax(0,1fr)] p-0", compact ? "gap-1" : "divide-hairline divide-y")}>
        {items.map((c) => (
          <li key={c.id} className={cx(compact ? "hover:bg-hover -mx-2 rounded-md px-2 py-1.5" : "px-4 py-2.5")}>
            <div className={cx("flex gap-2.5", compact ? "items-start" : "items-center")}>
              {!compact ? <Avatar id={c.userId} name={name(c.userId)} size="sm" /> : null}
              <div className="min-w-0 flex-1">
                {compact ? (
                  <p className="m-0 flex flex-wrap items-baseline gap-x-2 text-sm">
                    <span className="font-medium">{name(c.userId)}</span>
                    <span className="text-ink-2">
                      {sourceLabel(t, c.source)} · {topicLabel(t, c.topic, custom)} · {ago(c.lastAt)}
                    </span>
                  </p>
                ) : null}
                {c.summary || !compact ? <p className={cx("text-ink m-0 truncate text-sm")}>{c.summary || topicLabel(t, c.topic, custom)}</p> : null}
                {!compact ? (
                  <p className="text-ink-2 m-0 truncate text-xs">
                    <span className="text-ink">{name(c.userId)}</span> · {sourceLabel(t, c.source)} · {topicLabel(t, c.topic, custom)} · {ago(c.lastAt)}
                  </p>
                ) : null}
                {c.sensitive.length ? (
                  <p className="m-0 mt-1 flex flex-wrap gap-1">
                    {c.sensitive.map((s) => (
                      <span key={s} className="bg-warn-wash text-warn rounded-sm px-1.5 py-0.5 text-xs font-medium">
                        {sensitiveLabel(t, s)}
                      </span>
                    ))}
                  </p>
                ) : null}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

function PersonDrawer({ userId, name, days, onClose }: { userId: string; name: string; days: number; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const notDone = () => toast({ message: t("common.actionFailed") });
  const router = useRouter();
  const [data, setData] = useState<{ conversations: AiConversation[] } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    api<{ conversations: AiConversation[] }>(`ai/oversight/people/${userId}?days=${days}`)
      .then(setData)
      .catch(() => setFailed(true));
  }, [userId, days]);
  return (
    <Drawer
      title={
        <span className="flex items-center gap-2">
          <Avatar id={userId} name={name} size="sm" />
          {name}
        </span>
      }
      onClose={onClose}
      actions={
        <span className="flex gap-2">
          <button
            type="button"
            className={cx(btn, btnSm)}
            onClick={() =>
              void api<{ id: string }>("chat/dms", { method: "POST", body: { userId } })
                .then((r) => router.push(`/app/chat/${r.id}`))
                .catch(notDone)
            }
          >
            {t("aiw.o.message")}
          </button>
          <Link href={`/app/work/people/${userId}`} className={cx(btn, btnSm, "no-underline")}>
            {t("aiw.o.workOf")}
          </Link>
        </span>
      }
    >
      {failed ? (
        <p className="text-block p-4 text-sm">{t("aiw.o.loadFailed")}</p>
      ) : !data ? (
        <p className="text-ink-2 p-4 text-sm">{t("common.loading")}</p>
      ) : data.conversations.length === 0 ? (
        <p className="text-ink-2 p-4 text-sm">{t("aiw.o.personEmpty", { count: days })}</p>
      ) : (
        <ConversationList items={data.conversations} people={[{ userId, displayName: name }]} />
      )}
    </Drawer>
  );
}

/**
 * Prompts per day, stacked by tool: is AI use growing, and is it moving from outside tools to the
 * company's assistant? Days without use stay as empty columns so gaps are visible.
 */
/**
 * "AI có giúp làm việc tốt hơn?": frequent AI users next to everyone else (tasks done per person, on time,
 * days to finish), and eight weeks of AI use next to tasks done. A comparison for the boss to read, not a
 * verdict: the note says roles and workload differ.
 */
function DailyChart({ daily, days, timeZone }: { daily: AiOversight["daily"]; days: number; timeZone?: string }) {
  const t = useT();
  const { shortDate } = useFormat();
  // Days as the ai module counts them: calendar days in the workspace's zone.
  const dayKey = dateFormat("en-CA", { timeZone: timeZone ?? workspaceTimeZone(), year: "numeric", month: "2-digit", day: "2-digit" });
  const allKeys: string[] = [];
  for (let i = days - 1; i >= 0; i--) allKeys.push(dayKey.format(new Date(Date.now() - i * 86400_000)));
  const byDay = new Map<string, Record<string, number>>();
  for (const d of daily) byDay.set(d.day, { ...(byDay.get(d.day) ?? {}), [d.source]: d.prompts });
  const allTotals = allKeys.map((k) => Object.values(byDay.get(k) ?? {}).reduce((n, v) => n + v, 0));
  // Days before the first use are dropped (at least four stay); fewer than three days with use is a sentence.
  const lead = firstShown([allTotals]);
  const keys = allKeys.slice(lead);
  const totals = allTotals.slice(lead);
  const max = Math.max(1, ...totals);
  if (!daily.length) return null;
  if (!chartable([totals]))
    return (
      <section aria-labelledby="ai-daily-h" className={panel}>
        <PanelHead id="ai-daily-h" hue="blue" icon={<ChartIcon />} title={t("aiw.o.daily")} />
        <p className="text-ink-2 m-0 text-sm" data-testid="chart-sparse">
          {t("aiw.o.dailySparse", { days: totals.filter((n) => n > 0).length, count: totals.reduce((n, v) => n + v, 0) })}
        </p>
      </section>
    );
  return (
    <section aria-labelledby="ai-daily-h" className={panel}>
      <PanelHead id="ai-daily-h" hue="blue" icon={<ChartIcon />} title={t("aiw.o.daily")}>
        <Legend />
      </PanelHead>
      <div className="grid gap-3">
        <div className="flex h-28 items-end gap-[3px]" role="img" aria-label={t("aiw.o.dailyLabel", { count: totals.reduce((n, v) => n + v, 0), days })}>
          {keys.map((k, i) => {
            const day = byDay.get(k) ?? {};
            return (
              <div key={k} className="group relative flex h-full min-w-0 flex-1 flex-col justify-end" title={`${shortDate(k)}: ${totals[i]}`}>
                <div className="flex flex-col-reverse overflow-hidden rounded-t-sm" style={{ height: `${(totals[i]! / max) * 100}%` }}>
                  {SOURCES.filter((s) => day[s]).map((s) => (
                    <span key={s} className={cx("block w-full", SOURCE_BG[s])} style={{ height: `${(day[s]! / totals[i]!) * 100}%` }} />
                  ))}
                </div>
                {totals[i] === 0 ? <span className="bg-hover block h-0.5 w-full rounded-full" /> : null}
              </div>
            );
          })}
        </div>
        <div className="text-ink-2 flex justify-between text-xs tabular-nums">
          <span>{shortDate(keys[0]!)}</span>
          <span>{shortDate(keys[keys.length - 1]!)}</span>
        </div>
      </div>
    </section>
  );
}

/** Sends everyone without a working extension a Home notice with the setup steps. */
function RemindExtension() {
  const t = useT();
  const toast = useToast();
  const failed = () => toast({ message: t("common.actionFailed") });
  const [sent, setSent] = useState<number | null>(null);
  return sent === null ? (
    <button
      type="button"
      className="text-ink hover:bg-hover -mx-1.5 inline-flex min-h-7 items-center justify-self-start rounded-md px-1.5 text-xs font-medium"
      onClick={() =>
        void api<{ reminded: number }>("ai/oversight/remind-extension", { method: "POST" })
          .then((r) => setSent(r.reminded))
          .catch(failed)
      }
    >
      {t("aiw.o.remind")}
    </button>
  ) : (
    <span className="text-ok text-xs" role="status">
      {t("aiw.o.reminded", { count: sent })}
    </span>
  );
}
