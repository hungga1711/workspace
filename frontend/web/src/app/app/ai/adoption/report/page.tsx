import { numberFormat } from "@/lib/intl";
import { INTL_TAG } from "@/lib/i18n/config";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { gw, GatewayError } from "@/lib/gateway";
import { getFormat, getLocale, getT } from "@/lib/i18n/server";
import { aiMonitoring } from "@/lib/ai";
import { sourceLabel, topicLabel } from "@/lib/ai-labels";
import { formatMoney } from "@/lib/money";
import { cx } from "@/lib/ui";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { ReadFailed } from "@/components/ui/ReadFailed";
import { Segmented } from "@/components/ui/Segmented";
import { PrintButton } from "@/components/ai-insights/PrintButton";
import { Avatar } from "@/lib/people";
import type { TokenUsageData } from "@/components/ai-hub/TokenUsage";

interface Group {
  done: number;
  dated: number;
  onTime: number;
  cycleDays: number | null;
}
interface Report {
  days: number;
  generatedAt: string;
  totals: {
    people: number;
    active: number;
    extension: number;
    conversations: number;
    prompts: number;
    rated: number;
    helpful: { yes: number; partly: number; no: number };
    flagged: number;
    safety: { warn: number; redact: number; block: number };
    costUsd: number;
    importedCostUsd: number;
    unpricedTokens: number;
  };
  sensitiveMode: "warn" | "redact" | "block";
  topics: { key: string; prompts: number }[];
  sources: { key: string; prompts: number }[];
  departments: { name: string | null; people: number; active: number; prompts: number; rated: number; yes: number; partly: number }[];
  people: { userId: string; displayName: string; department: string | null; prompts: number; score: number | null }[];
  mentors: { displayName: string; department: string | null }[];
  work: { assisted: Group; other: Group } | null;
  topicLabels: { key: string; labelVi: string; labelEn: string }[];
  recommendations: { key: string; params: Record<string, string | number> }[];
}

export async function generateMetadata({ searchParams }: { searchParams: Promise<{ days?: string }> }): Promise<Metadata> {
  const t = await getT();
  return { title: t((await searchParams).days === "30" ? "aiInsights.report.title30" : "aiInsights.report.title") };
}

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "–");
/** A section of the one surface: a quiet label, then its rows; on paper, it never splits across pages. */
const block = "grid min-w-0 content-start gap-3 px-5 py-4 max-sm:px-4 print:break-inside-avoid print:px-0 print:py-2";
const label = "text-ink-2 m-0 text-xs font-medium print:text-[11px]";
const TOOL_BG: Record<string, string> = { "claude-code": "bg-tangerine", codex: "bg-sky", "gemini-cli": "bg-rose", opencode: "bg-ok", company: "bg-violet" };
const TOOL_KEYS = ["claude-code", "codex", "gemini-cli", "opencode", "local-model", "other", "company"] as const;

/**
 * Báo cáo tuần (AI › Áp dụng AI): one printable page for the owner, in the style of the AI pages: one bordered
 * surface, a strip of figures, then sections as quiet rows. Tokens (every AI token, the coding agents on people's
 * computers included: local-usage.ts) sit next to conversations, so "how much AI" has a number. Server-rendered, no
 * chart library: printing ("Save as PDF") gives the same page.
 */
export default async function AiReportPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  if (!(await aiMonitoring())) notFound();
  const days = (await searchParams).days === "30" ? 30 : 7;
  let status = 0;
  const [r, tok] = await Promise.all([
    gw<Report>(`/api/ai/insights/report?days=${days}`).catch((e: unknown) => {
      status = e instanceof GatewayError ? e.status : 500;
      return null;
    }),
    gw<TokenUsageData>(`/api/ai/local-usage?days=${days}&scope=team`).catch(() => null),
  ]);
  // A failed read (busy gateway) says so with a retry; it is not a missing page.
  // Someone with no team to report on (staff) gets "no access", not a retry that can never work.
  if (!r && status === 403) return <ReadFailed status={403} home="/app/ai/adoption" />;
  if (!r) return <LoadFailed className="bg-surface shadow-card rounded-xl px-5 py-4" />;
  const [t, f, locale] = await Promise.all([getT(), getFormat(), getLocale()]);
  // Whole cents on a one-page report; Admin › AI keeps the precise figures.
  const usd = (n: number) => formatMoney(n, "USD", locale).short;
  const compact = numberFormat(INTL_TAG[locale], { notation: "compact", maximumFractionDigits: 1 });
  const custom = Object.fromEntries(r.topicLabels.map((x) => [x.key, (locale === "vi" ? x.labelVi || x.labelEn : x.labelEn || x.labelVi) || ""]).filter(([, l]) => l));
  const topicName = (k: string) => topicLabel(t, k, custom);
  const tt = r.totals;
  const safety = tt.safety.warn + tt.safety.redact + tt.safety.block;
  const topMax = Math.max(1, ...r.topics.map((x) => x.prompts));
  const helpfulRated = tt.helpful.yes + tt.helpful.partly + tt.helpful.no;
  const until = new Date(r.generatedAt);
  const from = new Date(until.getTime() - days * 86400_000);
  const recText = (x: Report["recommendations"][number]) =>
    t(`aiInsights.rec.${x.key}` as "aiInsights.rec.keep_going", { ...x.params, ...(x.key === "coach_topic" ? { topic: topicName(String(x.params.topic)) } : {}) });
  const tokChange = tok && tok.totals.previous > 0 ? Math.round(((tok.totals.total - tok.totals.previous) / tok.totals.previous) * 100) : null;
  const localCost = tok ? tok.tools.filter((x) => x.tool !== "company").reduce((n, x) => n + x.costUsd, 0) : 0;
  const toolName = (k: string) => t(`aiHub.tokens.tool.${(TOOL_KEYS as readonly string[]).includes(k) ? (k as (typeof TOOL_KEYS)[number]) : "other"}`);
  const kpis: { label: string; value: string; note: string; tone?: "ok" | "block" }[] = [
    { label: t("aiInsights.report.prompts"), value: tt.prompts.toLocaleString(locale), note: t("aiInsights.report.ratedOf", { rated: tt.rated, total: tt.conversations }) },
    { label: t("aiInsights.report.active"), value: `${tt.active}/${tt.people}`, note: pct(tt.active, tt.people) },
    {
      // Work tokens: the server leaves cache reads out of the total (ai/metrics.ts).
      label: t("aiHub.tokens.fresh"),
      value: tok ? compact.format(tok.totals.total) : "–",
      note: tokChange === null ? t("aiHub.tokens.noPrev") : t("aiHub.tokens.vsPrev", { sign: tokChange > 0 ? "+" : "", pct: tokChange, days }),
    },
    {
      label: t("aiInsights.report.helpfulShare"),
      value: pct(tt.helpful.yes + tt.helpful.partly / 2, helpfulRated),
      note: `${t("aiInsights.report.yes")} ${tt.helpful.yes} · ${t("aiInsights.report.partly")} ${tt.helpful.partly} · ${t("aiInsights.report.no")} ${tt.helpful.no}`,
      tone: "ok",
    },
    {
      label: t("aiInsights.report.costCompany"),
      value: usd(tt.costUsd),
      note: localCost ? t("aiHub.tokens.report.apiEst", { amount: usd(localCost) }) : t("aiInsights.report.safety") + ` ${tt.flagged + safety}`,
    },
  ];
  return (
    <div className="grid gap-3 print:max-w-none print:text-[11px]">
      <article className="border-hairline bg-surface min-w-0 overflow-hidden rounded-lg border print:rounded-none print:border-0">
        <header className="border-hairline flex flex-wrap items-end gap-x-6 gap-y-3 border-b px-5 py-4 max-sm:px-4 print:px-0">
          <div className="min-w-[min(100%,18rem)] flex-1">
            <p className="text-ink-2 m-0 text-xs tabular-nums">
              {f.shortDate(from)} – {f.shortDate(until)} · {t("aiInsights.report.generated", { when: f.time(until) })}
            </p>
            <h2 className="text-ink m-0 mt-1 text-lg font-semibold tracking-[-0.02em]">{t(days === 30 ? "aiInsights.report.title30" : "aiInsights.report.title")}</h2>
            <p className="text-ink-2 m-0 mt-0.5 text-[13px] print:hidden">{t("aiInsights.report.sub")}</p>
          </div>
          <span className="flex flex-wrap items-center gap-2 print:hidden">
            <Segmented
              className="shrink-0"
              size="sm"
              label={t("aiw.o.window")}
              value={String(days)}
              options={([7, 30] as const).map((d) => ({
                value: String(d),
                label: t(d === 7 ? "aiInsights.report.days7" : "aiInsights.report.days30"),
                href: `/app/ai/adoption/report?days=${d}`,
              }))}
            />
            <PrintButton />
          </span>
        </header>

        <dl
          aria-label={t("aiInsights.report.title")}
          className="bg-hairline border-hairline m-0 grid grid-cols-5 gap-px border-b max-lg:grid-cols-3 max-sm:grid-cols-2 print:grid-cols-5"
        >
          {kpis.map((k) => (
            <div key={k.label} className="bg-surface min-w-0 px-4 py-3.5 max-lg:last:col-span-2 max-sm:px-3 max-sm:last:col-span-2 print:px-2 print:py-1.5">
              <dt className="text-ink-2 text-xs">{k.label}</dt>
              <dd className={cx("m-0 mt-1 text-xl font-semibold tabular-nums tracking-[-0.02em] max-sm:text-lg print:text-base", k.tone === "ok" ? "text-ok" : "text-ink")}>
                {k.value}
              </dd>
              <dd className="text-ink-2 m-0 mt-0.5 text-xs">{k.note}</dd>
            </div>
          ))}
        </dl>

        {tt.conversations === 0 && tt.prompts === 0 ? <p className="text-ink-2 border-hairline m-0 border-b px-5 py-3 text-sm">{t("aiInsights.report.noData")}</p> : null}

        <section className={cx(block, "border-hairline border-b")} aria-labelledby="rep-next">
          <h2 id="rep-next" className={label}>
            {t("aiInsights.report.next")}
          </h2>
          <ol className="m-0 grid list-none gap-2 p-0 text-sm print:text-[11px]" data-testid="report-recommendations">
            {r.recommendations.map((x, i) => (
              <li key={x.key} className="flex items-start gap-2.5">
                <span className="bg-hover text-ink-2 mt-px grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold tabular-nums">{i + 1}</span>
                <span className="min-w-0">{recText(x)}</span>
              </li>
            ))}
          </ol>
        </section>

        <div className="divide-hairline border-hairline grid border-b max-lg:divide-y lg:grid-cols-2 lg:divide-x print:grid-cols-2 print:divide-x">
          <section className={block} aria-labelledby="rep-tokens" data-testid="report-tokens">
            <h2 id="rep-tokens" className={label}>
              {t("aiHub.tokens.report.title")}
            </h2>
            {tok && tok.totals.total > 0 ? (
              <>
                <span className="bg-hover flex h-2 overflow-hidden rounded-full" aria-hidden="true">
                  {tok.tools.map((x) => (
                    <span key={x.tool} className={cx("h-full", TOOL_BG[x.tool] ?? "bg-ink-2")} style={{ width: `${(x.total / tok.totals.total) * 100}%` }} />
                  ))}
                </span>
                <ul className="m-0 grid list-none gap-1.5 p-0 text-sm print:text-[11px]">
                  {tok.tools.map((x) => (
                    <li key={x.tool} className="flex items-center gap-2">
                      <span aria-hidden="true" className={cx("size-2 shrink-0 rounded-full", TOOL_BG[x.tool] ?? "bg-ink-2")} />
                      <span className="min-w-0 flex-1">{toolName(x.tool)}</span>
                      <span className="text-ink-2 text-xs tabular-nums">{t("aiHub.tokens.peopleCount", { count: x.people })}</span>
                      <span className="w-16 text-right font-medium tabular-nums">{compact.format(x.total)}</span>
                      <span className="text-ink-2 w-14 text-right text-xs tabular-nums">{usd(x.costUsd)}</span>
                    </li>
                  ))}
                </ul>
                <h3 className={cx(label, "mt-1")}>{t("aiHub.tokens.report.topPeople")}</h3>
                <ul className="m-0 grid list-none gap-1.5 p-0 text-sm print:text-[11px]">
                  {tok.people
                    .filter((p) => p.total > 0)
                    .slice(0, 5)
                    .map((p) => {
                      const ch = p.previous > 0 ? Math.round(((p.total - p.previous) / p.previous) * 100) : null;
                      return (
                        <li key={p.userId} className="flex min-w-0 items-center gap-2">
                          <span className="print:hidden">
                            <Avatar id={p.userId} size="sm" />
                          </span>
                          <span className="min-w-0 flex-1 truncate">{p.displayName || "—"}</span>
                          <span className={cx("text-xs tabular-nums", ch !== null && ch > 0 ? "text-ok" : "text-ink-2")}>{ch === null ? "" : `${ch > 0 ? "+" : ""}${ch}%`}</span>
                          <span className="w-16 text-right font-medium tabular-nums">{compact.format(p.total)}</span>
                        </li>
                      );
                    })}
                </ul>
              </>
            ) : (
              <p className="text-ink-2 m-0 text-sm">{t("aiHub.tokens.report.none")}</p>
            )}
          </section>

          <section className={block} aria-labelledby="rep-used">
            <h2 id="rep-used" className={label}>
              {t("aiInsights.report.used")}
            </h2>
            {r.topics.length ? null : <p className="text-ink-2 m-0 text-[13px]">{t("aiInsights.report.noData")}</p>}
            <ul className="m-0 grid list-none gap-2 p-0 empty:hidden">
              {r.topics.map((x) => (
                <li key={x.key} className="grid grid-cols-[8rem_minmax(0,1fr)_3rem] items-center gap-3 text-sm max-sm:grid-cols-[7.5rem_minmax(0,1fr)_2.5rem] print:text-[11px]">
                  <span className="min-w-0 leading-snug">{topicName(x.key)}</span>
                  <span className="bg-hover block h-1.5 overflow-hidden rounded-full">
                    <span className="bg-accent block h-full rounded-full" style={{ width: `${(x.prompts / topMax) * 100}%` }} />
                  </span>
                  <span className="text-ink-2 text-right text-xs tabular-nums">{x.prompts}</span>
                </li>
              ))}
            </ul>
            {r.sources.length ? (
              <p className="text-ink-2 m-0 text-xs">
                {r.sources
                  .slice(0, 6)
                  .map((s) => `${sourceLabel(t, s.key)} ${s.prompts}`)
                  .join(" · ")}
              </p>
            ) : null}
          </section>
        </div>

        <div className="divide-hairline border-hairline grid border-b max-lg:divide-y lg:grid-cols-2 lg:divide-x print:grid-cols-2 print:divide-x">
          <section className={block} aria-labelledby="rep-helps">
            <h2 id="rep-helps" className={label}>
              {t("aiInsights.report.helps")}
            </h2>
            <div className="bg-hover flex h-2 overflow-hidden rounded-full" aria-hidden="true">
              <span className="bg-ok block h-full" style={{ width: pct(tt.helpful.yes, helpfulRated).replace("–", "0%") }} />
              <span className="bg-warn block h-full" style={{ width: pct(tt.helpful.partly, helpfulRated).replace("–", "0%") }} />
              <span className="bg-block block h-full" style={{ width: pct(tt.helpful.no, helpfulRated).replace("–", "0%") }} />
            </div>
            <h3 className={cx(label, "mt-1")}>{t("aiInsights.report.tasks")}</h3>
            {r.work && r.work.assisted.done + r.work.other.done > 0 ? (
              <table className="w-full text-left text-sm print:text-[11px]">
                <thead className="text-ink-2 text-xs">
                  <tr>
                    <th className="py-1 font-medium">{t("aiInsights.report.group")}</th>
                    <th className="py-1 pl-3 text-right font-medium">{t("aiInsights.report.done")}</th>
                    <th className="py-1 pl-3 text-right font-medium">{t("aiInsights.report.onTime")}</th>
                    <th className="py-1 pl-3 text-right font-medium">{t("aiInsights.report.cycle")}</th>
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {(
                    [
                      ["withAi", r.work.assisted],
                      ["withoutAi", r.work.other],
                    ] as const
                  ).map(([k, g]) => (
                    <tr key={k} className="border-hairline border-t">
                      <td className="py-1.5">{t(`aiInsights.report.${k}`)}</td>
                      <td className="py-1.5 pl-3 text-right">{g.done}</td>
                      <td className="py-1.5 pl-3 text-right">{pct(g.onTime, g.dated)}</td>
                      <td className="py-1.5 pl-3 text-right">{g.cycleDays == null ? "–" : g.cycleDays.toLocaleString(locale, { maximumFractionDigits: 1 })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-ink-2 m-0 text-sm">{t("aiInsights.report.noTasks")}</p>
            )}
          </section>

          <section className={block} aria-labelledby="rep-who">
            <h2 id="rep-who" className={label}>
              {t("aiInsights.report.who")}
            </h2>
            <table className="w-full table-fixed text-left text-sm print:text-[11px]">
              <thead className="text-ink-2 text-xs">
                <tr>
                  <th className="py-1 font-medium">{t("aiInsights.report.dept")}</th>
                  <th className="w-20 py-1 text-right font-medium max-sm:w-16">{t("aiInsights.report.active")}</th>
                  <th className="w-20 py-1 text-right font-medium max-sm:w-16">{t("aiInsights.report.prompts")}</th>
                  <th className="w-16 py-1 text-right font-medium max-sm:w-12">{t("aiInsights.report.yes")}</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {r.departments.map((d) => (
                  <tr key={d.name ?? ""} className="border-hairline border-t">
                    <td className="py-1.5 pr-2">{d.name ?? t("aiInsights.capability.noDept")}</td>
                    <td className="py-1.5 text-right">{`${d.active}/${d.people}`}</td>
                    <td className="py-1.5 text-right">{d.prompts}</td>
                    <td className="py-1.5 text-right">{pct(d.yes + d.partly / 2, d.rated)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {r.mentors.length ? <p className="m-0 text-sm">{t("aiInsights.report.mentors", { names: r.mentors.map((m) => m.displayName).join(", ") })}</p> : null}
          </section>
        </div>

        <section className={block} aria-labelledby="rep-safety">
          <h2 id="rep-safety" className={label}>
            {t("aiInsights.report.safety")} · {t("aiInsights.report.cost")}
          </h2>
          <dl className="m-0 grid gap-x-8 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-3 print:grid-cols-4 print:text-[11px]">
            {(
              [
                [t("aiInsights.report.flagged"), String(tt.flagged)],
                [t("aiInsights.report.warned"), String(tt.safety.warn)],
                [t("aiInsights.report.redacted"), String(tt.safety.redact)],
                [t("aiInsights.report.blocked"), String(tt.safety.block)],
                [t("aiInsights.report.costCompany"), usd(tt.costUsd)],
                ...(tt.importedCostUsd ? [[t("aiInsights.report.costImported"), usd(tt.importedCostUsd)]] : []),
                ...(localCost ? [[t("aiHub.tokens.report.apiCost"), usd(localCost)]] : []),
              ] as [string, string][]
            ).map(([k, v]) => (
              <div key={k} className="border-hairline flex min-w-0 items-baseline justify-between gap-3 border-t py-1.5">
                <dt className="text-ink-2 min-w-0">{k}</dt>
                <dd className="m-0 font-medium tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="text-ink-2 m-0 text-xs">
            {t("aiInsights.report.mode", {
              mode: t(r.sensitiveMode === "block" ? "aiInsights.report.modeBlock" : r.sensitiveMode === "redact" ? "aiInsights.report.modeRedact" : "aiInsights.report.modeWarn"),
            })}
            {tt.unpricedTokens ? ` ${t("aiInsights.report.unpriced")}` : ""}
          </p>
        </section>
      </article>
      <p className="text-ink-2 m-0 text-xs">{t("aiInsights.report.footer")}</p>
    </div>
  );
}
