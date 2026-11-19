"use client";

import { numberFormat } from "@/lib/intl";
import { INTL_TAG } from "@/lib/i18n/config";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/client";
import { useFormat, useLocale, useT } from "@/lib/i18n/client";
import { formatMoney } from "@/lib/money";
import { btn, btnGhost, btnPrimary, btnSm, cx } from "@/lib/ui";
import { Segmented } from "@/components/ui/Segmented";
import { Avatar } from "@/lib/people";
import { CheckIcon, CopyIcon, TerminalIcon, TrashIcon } from "@/components/app/icons";
import { useToast } from "@/components/ui/Toast";

type Mix = { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; total: number };

/** GET /api/ai/local-usage (ai module, local-usage.ts). */
export interface TokenUsageData {
  scope: "team" | "me";
  days: number;
  from: string;
  to: string;
  /** total leaves cache reads out (they are in the mix); costUsd is the company AI's metered cost, listValueUsd what the
   * computers' tokens would cost at API list prices. */
  totals: Mix & { turns: number; sessions: number; costUsd: number; listValueUsd?: number; unpricedTokens: number; previous: number };
  cacheReuse: number | null;
  activeDays: number;
  bestStreak: number;
  busiest: { day: string; total: number } | null;
  daily: { day: string; total: number; tools: Record<string, number> }[];
  tools: { tool: string; total: number; costUsd: number; people: number; sessions: number }[];
  models: { model: string; tool: string; total: number; costUsd: number | null }[];
  people: {
    userId: string;
    displayName: string;
    department: string | null;
    total: number;
    costUsd: number;
    tools: Record<string, number>;
    activeDays: number;
    previous: number;
    lastSyncAt: string | null;
  }[];
  connected: number;
  devices: { device: string; lastSyncAt: string }[];
}

const TOOLS = ["claude-code", "codex", "gemini-cli", "opencode", "local-model", "other", "company"] as const;
type Tool = (typeof TOOLS)[number];
/** Each tool's identity colour, the same in every bar and legend on the page. */
const TOOL_BG: Record<Tool, string> = {
  "claude-code": "bg-tangerine",
  codex: "bg-sky",
  "gemini-cli": "bg-rose",
  opencode: "bg-ok",
  "local-model": "bg-brand",
  other: "bg-ink-2",
  company: "bg-violet",
};
const toolOf = (k: string): Tool => ((TOOLS as readonly string[]).includes(k) ? (k as Tool) : "other");
const MIX = [
  { key: "input", bg: "bg-accent" },
  { key: "output", bg: "bg-violet" },
  { key: "cacheRead", bg: "bg-sky" },
  { key: "cacheWrite", bg: "bg-tangerine" },
] as const;
/** The calendar's five steps, darker for more (quartiles of the window's active days). */
const LEVEL = ["bg-hover", "bg-accent/25", "bg-accent/50", "bg-accent/75", "bg-accent"];

function useNum() {
  const locale = useLocale();
  const compact = numberFormat(INTL_TAG[locale], { notation: "compact", maximumFractionDigits: 1 });
  return {
    tokens: (n: number) => compact.format(n),
    usd: (n: number) => formatMoney(n, "USD", locale).short,
  };
}

/**
 * Token use the way desktop agent tools show it (orca's usage pane): one total, the token mix, a calendar of days,
 * then by tool, model and person. Local coding agents and the company AI on one page, so "how much AI" is answered
 * by tokens and not only by conversations. One bordered surface, compact rows.
 */
export function TokenUsage({
  data,
  base,
  windows = [7, 30, 90],
  origin,
  apiUrl,
}: {
  data: TokenUsageData;
  /** The page the period links go to (?days=). */
  base: string;
  windows?: (7 | 30 | 90)[];
  origin: string;
  apiUrl: string;
}) {
  const t = useT();
  const n = useNum();
  const tt = data.totals;
  const [connect, setConnect] = useState(data.scope === "me" && !data.devices.length);
  const change = tt.previous > 0 ? Math.round(((tt.total - tt.previous) / tt.previous) * 100) : null;
  const cells = [
    {
      // Cache reads are context sent again on every turn (often 95% of the count): shown apart, not as new work.
      // The server's total already leaves them out (ai/metrics.ts workTokens).
      label: t("aiHub.tokens.fresh"),
      value: n.tokens(tt.total),
      note: [
        tt.cacheRead ? t("aiHub.tokens.plusCache", { count: n.tokens(tt.cacheRead) }) : null,
        change === null ? t("aiHub.tokens.noPrev") : t("aiHub.tokens.vsPrev", { sign: change > 0 ? "+" : "", pct: change, days: data.days }),
      ]
        .filter(Boolean)
        .join(" · "),
    },
    {
      label: t("aiHub.tokens.cost"),
      value: n.usd(tt.costUsd),
      note: tt.listValueUsd
        ? t("aiHub.tokens.report.apiEst", { amount: n.usd(tt.listValueUsd) })
        : tt.unpricedTokens
          ? t("aiHub.tokens.unpriced", { count: n.tokens(tt.unpricedTokens) })
          : t("aiHub.tokens.costNote"),
    },
    {
      label: t("aiHub.tokens.days"),
      value: t("aiHub.tokens.daysValue", { active: data.activeDays, days: data.days }),
      note: t("aiHub.tokens.streak", { count: data.bestStreak }),
    },
    {
      label: t("aiHub.tokens.cache"),
      // Agents reuse most of their context: 99.9% and 100% differ by real money, so keep a decimal up there.
      value: data.cacheReuse === null || !tt.cacheRead ? "–" : data.cacheReuse >= 0.99 ? `${Math.floor(data.cacheReuse * 1000) / 10}%` : `${Math.round(data.cacheReuse * 100)}%`,
      note: t("aiHub.tokens.cacheNote"),
    },
  ];
  return (
    <section className="border-hairline bg-surface min-w-0 overflow-hidden rounded-lg border" aria-labelledby="tok-h" data-testid="token-usage">
      <header className="border-hairline flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-3">
        <div className="min-w-[min(100%,16rem)] flex-1">
          <h2 id="tok-h" className="text-ink m-0 text-sm font-semibold tracking-[-0.01em]">
            {t("aiHub.tokens.title")}
          </h2>
          <p className="text-ink-2 m-0 mt-0.5 text-xs">{t(data.scope === "team" ? "aiHub.tokens.subTeam" : "aiHub.tokens.subMe")}</p>
        </div>
        <Segmented
          size="sm"
          label={t("aiHub.tokens.window")}
          value={String(data.days)}
          options={windows.map((d) => ({ value: String(d), label: t(`aiHub.tokens.d${d}`), href: `${base}?days=${d}` }))}
        />
        <button type="button" className={cx(btn, btnSm)} aria-expanded={connect} onClick={() => setConnect((x) => !x)}>
          <TerminalIcon />
          {t("aiHub.tokens.connect.button")}
        </button>
      </header>
      {connect ? <Connect origin={origin} apiUrl={apiUrl} /> : null}

      <dl className="divide-hairline border-hairline m-0 grid grid-cols-4 divide-x border-b max-lg:grid-cols-2 max-lg:[&>div:nth-child(-n+2)]:border-b max-lg:[&>div:nth-child(3)]:border-l-0">
        {cells.map((c) => (
          <div key={c.label} className="border-hairline min-w-0 px-4 py-3.5 max-sm:px-3">
            <dt className="text-ink-2 text-xs/4">{c.label}</dt>
            <dd className="text-ink m-0 mt-1 text-xl font-semibold tabular-nums tracking-[-0.02em] max-sm:text-lg">{c.value}</dd>
            <dd className="text-ink-2 m-0 mt-0.5 line-clamp-2 text-xs">{c.note}</dd>
          </div>
        ))}
      </dl>

      {tt.total === 0 ? (
        <p className="text-ink-2 m-0 px-4 py-6 text-center text-sm">{t("aiHub.tokens.empty")}</p>
      ) : (
        <>
          <MixBar mix={tt} />
          <Calendar data={data} />
          <div className="divide-hairline border-hairline grid border-t max-lg:divide-y lg:grid-cols-2 lg:divide-x">
            <Tools data={data} />
            <Models data={data} />
          </div>
        </>
      )}
      {data.scope === "team" ? <People data={data} /> : null}
      <Devices devices={data.devices} />
    </section>
  );
}

function MixBar({ mix }: { mix: Mix }) {
  const t = useT();
  const n = useNum();
  // The bar shows every part of the mix, cache reads too, so it is scaled to their sum, not to the headline total.
  const whole = Math.max(
    1,
    MIX.reduce((sum, m) => sum + mix[m.key], 0),
  );
  return (
    <div className="border-hairline grid gap-2 border-b px-4 py-3">
      <span className="text-ink-2 text-xs font-medium">{t("aiHub.tokens.mix")}</span>
      <span className="bg-hover flex h-2 overflow-hidden rounded-full" aria-hidden="true">
        {MIX.map((m) => (
          <span key={m.key} className={cx("h-full", m.bg)} style={{ width: `${(mix[m.key] / whole) * 100}%` }} />
        ))}
      </span>
      <ul className="m-0 flex list-none flex-wrap gap-x-5 gap-y-1 p-0 text-xs">
        {MIX.map((m) => (
          <li key={m.key} className="flex items-center gap-1.5">
            <span aria-hidden="true" className={cx("size-2 rounded-[2px]", m.bg)} />
            <span className="text-ink-2">{t(`aiHub.tokens.${m.key}`)}</span>
            <span className="text-ink font-medium tabular-nums">{n.tokens(mix[m.key])}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A calendar of the window, a column per week (Monday first), shaded by tokens that day. */
function Calendar({ data }: { data: TokenUsageData }) {
  const t = useT();
  const f = useFormat();
  const n = useNum();
  const label = (day: string) => f.shortDate(`${day}T12:00:00Z`, "UTC");
  const active = data.daily
    .filter((d) => d.total > 0)
    .map((d) => d.total)
    .sort((a, b) => a - b);
  const q = [0.25, 0.5, 0.75].map((x) => active[Math.floor(x * (active.length - 1))] ?? 0);
  const level = (v: number) => (v <= 0 ? 0 : v <= q[0]! ? 1 : v <= q[1]! ? 2 : v <= q[2]! ? 3 : 4);
  const lead = (new Date(`${data.from}T12:00:00Z`).getUTCDay() + 6) % 7;
  const cells: ({ day: string; total: number } | null)[] = [...Array<null>(lead).fill(null), ...data.daily];
  const weeks = Array.from({ length: Math.ceil(cells.length / 7) }, (_, i) => cells.slice(i * 7, i * 7 + 7));
  const max = Math.max(1, ...data.daily.map((d) => d.total));
  return (
    <div className="border-hairline grid gap-2.5 border-b px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-ink-2 text-xs font-medium">{t("aiHub.tokens.calendar")}</span>
        {data.busiest ? <span className="text-ink-2 text-xs">{t("aiHub.tokens.busiest", { day: label(data.busiest.day), tokens: n.tokens(data.busiest.total) })}</span> : null}
        <span className="text-ink-2 ml-auto flex items-center gap-1 text-xs" aria-hidden="true">
          {t("aiHub.tokens.less")}
          {LEVEL.map((c) => (
            <span key={c} className={cx("size-2.5 rounded-[2px]", c)} />
          ))}
          {t("aiHub.tokens.more")}
        </span>
      </div>
      <div className="flex min-w-0 items-end gap-4 overflow-x-auto">
        {data.days > 7 ? (
          <div className="flex shrink-0 gap-[3px]" role="img" aria-label={t("aiHub.tokens.calendar")}>
            {weeks.map((w, i) => (
              <div key={i} className="grid grid-rows-7 gap-[3px]">
                {w.map((d, j) =>
                  d ? (
                    <span
                      key={d.day}
                      title={t("aiHub.tokens.dayTip", { day: label(d.day), tokens: n.tokens(d.total) })}
                      className={cx("size-3.5 rounded-[3px]", LEVEL[level(d.total)])}
                    />
                  ) : (
                    <span key={`e${j}`} className="size-3.5" />
                  ),
                )}
              </div>
            ))}
          </div>
        ) : null}
        {/* Day bars, stacked by tool: the calendar says when, the bars how much and with what. */}
        <div className="flex h-16 min-w-0 flex-1 items-end gap-[2px]" aria-hidden="true">
          {data.daily.map((d) => (
            <span key={d.day} className="flex h-full min-w-[3px] flex-1 flex-col-reverse" title={t("aiHub.tokens.dayTip", { day: label(d.day), tokens: n.tokens(d.total) })}>
              {Object.entries(d.tools)
                .sort((a, b) => b[1] - a[1])
                .map(([k, v]) => (
                  <span key={k} className={cx("block w-full first:rounded-b-[1px] last:rounded-t-[2px]", TOOL_BG[toolOf(k)])} style={{ height: `${(v / max) * 100}%` }} />
                ))}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function Row({ dot, name, meta, share, value, sub }: { dot: string; name: React.ReactNode; meta?: React.ReactNode; share: number; value: string; sub: string }) {
  return (
    <li className="grid min-w-0 grid-cols-[minmax(0,1fr)_5.5rem_4.5rem] items-center gap-3 px-4 py-2 text-[13px] max-sm:grid-cols-[minmax(0,1fr)_4.5rem]">
      <span className="flex min-w-0 items-center gap-2">
        <span aria-hidden="true" className={cx("size-2 shrink-0 rounded-full", dot)} />
        {/* The name keeps its room; the meta beside it gives way first. */}
        <span className="text-ink min-w-0 max-w-full shrink-0 truncate">{name}</span>
        {meta ? <span className="text-ink-2 min-w-0 truncate text-xs max-sm:hidden">{meta}</span> : null}
      </span>
      <span className="bg-hover h-1.5 overflow-hidden rounded-full max-sm:hidden" aria-hidden="true">
        <span className={cx("block h-full rounded-full", dot)} style={{ width: `${Math.max(2, share * 100)}%` }} />
      </span>
      <span className="text-right tabular-nums">
        <span className="text-ink block font-medium">{value}</span>
        <span className="text-ink-2 block text-xs">{sub}</span>
      </span>
    </li>
  );
}

function Tools({ data }: { data: TokenUsageData }) {
  const t = useT();
  const n = useNum();
  const max = Math.max(1, ...data.tools.map((x) => x.total));
  return (
    <div className="min-w-0 py-2">
      <h3 className="text-ink-2 m-0 px-4 py-1.5 text-xs font-medium">{t("aiHub.tokens.byTool")}</h3>
      <ul className="m-0 list-none p-0">
        {data.tools.map((x) => (
          <Row
            key={x.tool}
            dot={TOOL_BG[toolOf(x.tool)]}
            name={t(`aiHub.tokens.tool.${toolOf(x.tool)}`)}
            meta={data.scope === "team" ? t("aiHub.tokens.peopleCount", { count: x.people }) : x.sessions ? t("aiHub.tokens.sessions", { count: x.sessions }) : null}
            share={x.total / max}
            value={n.tokens(x.total)}
            sub={n.usd(x.costUsd)}
          />
        ))}
      </ul>
    </div>
  );
}

function Models({ data }: { data: TokenUsageData }) {
  const t = useT();
  const n = useNum();
  const max = Math.max(1, ...data.models.map((x) => x.total));
  return (
    <div className="min-w-0 py-2">
      <h3 className="text-ink-2 m-0 px-4 py-1.5 text-xs font-medium">{t("aiHub.tokens.byModel")}</h3>
      <ul className="m-0 list-none p-0">
        {data.models.slice(0, 6).map((x) => (
          <Row
            key={`${x.tool}:${x.model}`}
            dot={TOOL_BG[toolOf(x.tool)]}
            name={<span className="font-mono text-[12px]">{x.model}</span>}
            share={x.total / max}
            value={n.tokens(x.total)}
            sub={x.costUsd === null ? t("aiHub.tokens.noPrice") : n.usd(x.costUsd)}
          />
        ))}
      </ul>
    </div>
  );
}

function People({ data }: { data: TokenUsageData }) {
  const t = useT();
  const f = useFormat();
  const n = useNum();
  const [all, setAll] = useState(false);
  const shown = all ? data.people : data.people.slice(0, 10);
  const max = Math.max(1, ...data.people.map((x) => x.total));
  return (
    <div className="border-hairline border-t">
      <div className="flex flex-wrap items-baseline gap-x-3 px-4 pb-1 pt-3">
        <h3 className="text-ink-2 m-0 text-xs font-medium">{t("aiHub.tokens.people")}</h3>
        <span className="text-ink-2 text-xs">{t("aiHub.tokens.connected", { count: data.connected })}</span>
      </div>
      <ul className="m-0 list-none p-0" data-testid="token-people">
        {shown.map((p) => {
          const change = p.previous > 0 && p.total > 0 ? Math.round(((p.total - p.previous) / p.previous) * 100) : null;
          return (
            <li
              key={p.userId}
              className="border-hairline grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,9rem)_5rem_4.5rem] items-center gap-3 border-t px-4 py-2 text-[13px] first:border-t-0 max-md:grid-cols-[minmax(0,1fr)_5rem]"
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <Avatar id={p.userId} size="sm" />
                <span className="min-w-0">
                  <span className="text-ink block truncate font-medium">{p.displayName || "—"}</span>
                  <span className="text-ink-2 block truncate text-xs">
                    {[p.department, p.lastSyncAt ? t("aiHub.tokens.synced", { when: f.ago(p.lastSyncAt) }) : t("aiHub.tokens.notConnected")].filter(Boolean).join(" · ")}
                  </span>
                </span>
              </span>
              <span className="bg-hover flex h-1.5 overflow-hidden rounded-full max-md:hidden" aria-hidden="true">
                {Object.entries(p.tools)
                  .sort((a, b) => b[1] - a[1])
                  .map(([k, v]) => (
                    <span key={k} className={cx("h-full", TOOL_BG[toolOf(k)])} style={{ width: `${(v / max) * 100}%` }} />
                  ))}
              </span>
              <span className="text-right tabular-nums">
                <span className="text-ink block font-medium">{p.total ? n.tokens(p.total) : "–"}</span>
                <span className={cx("block text-xs", change !== null && change > 0 ? "text-ok" : "text-ink-2")}>{change === null ? "" : `${change > 0 ? "+" : ""}${change}%`}</span>
              </span>
              <span className="text-ink-2 text-right text-xs tabular-nums max-md:hidden">{p.total ? n.usd(p.costUsd) : ""}</span>
            </li>
          );
        })}
      </ul>
      {data.people.length > 10 ? (
        <button type="button" className={cx(btnGhost, btnSm, "mx-2 mb-2")} aria-expanded={all} onClick={() => setAll((x) => !x)}>
          {all ? t("ui.showLess") : t("aiHub.tokens.allPeople", { count: data.people.length })}
        </button>
      ) : null}
    </div>
  );
}

function Devices({ devices }: { devices: TokenUsageData["devices"] }) {
  const t = useT();
  const f = useFormat();
  const router = useRouter();
  const toast = useToast();
  if (!devices.length) return null;
  const remove = async (device: string) => {
    if (!window.confirm(t("aiHub.tokens.removeConfirm", { device }))) return;
    try {
      await api(`ai/local-usage/devices/${encodeURIComponent(device)}`, { method: "DELETE" });
      router.refresh();
    } catch {
      toast({ message: t("common.actionFailed") });
    }
  };
  return (
    <div className="border-hairline border-t py-2">
      <h3 className="text-ink-2 m-0 px-4 py-1.5 text-xs font-medium">{t("aiHub.tokens.devices")}</h3>
      <ul className="m-0 list-none p-0">
        {devices.map((d) => (
          <li key={d.device} className="flex min-w-0 items-center gap-2 px-4 py-1.5 text-[13px]">
            <TerminalIcon className="text-ink-2 size-3.5 shrink-0" />
            <span className="text-ink min-w-0 truncate">{d.device}</span>
            <span className="text-ink-2 shrink-0 text-xs">{t("aiHub.tokens.synced", { when: f.ago(d.lastSyncAt) })}</span>
            <button type="button" className={cx(btnGhost, btnSm, "ml-auto")} aria-label={`${t("aiHub.tokens.remove")}: ${d.device}`} onClick={() => void remove(d.device)}>
              <TrashIcon />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * How to send this computer's tokens: AI › Connect does it in one line with everything else the computer connects
 * for; the collector's own command stays under "Advanced".
 */
function Connect({ origin, apiUrl }: { origin: string; apiUrl: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const lines = [`curl -O ${origin}/runner/workspace-usage.mjs`, `node workspace-usage.mjs --url ${apiUrl} --key wos_… --every 30`];
  const cmd = lines.join("\n");
  return (
    <div className="bg-ground border-hairline grid gap-3 border-b px-4 py-4 text-[13px]" data-testid="token-connect">
      <div className="flex min-w-0 flex-wrap items-center gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1 basis-72">
          <h3 className="text-ink m-0 text-sm font-semibold">{t("aiConnect.pointer.title")}</h3>
          <p className="text-ink-2 m-0 mt-1 max-w-2xl">{t("aiConnect.pointer.lead")}</p>
        </div>
        <Link href="/app/ai/connect" className={cx(btnPrimary, btnSm, "no-underline")}>
          {t("aiConnect.pointer.cta")}
        </Link>
      </div>
      <details className="min-w-0">
        <summary className="text-ink-2 hover:text-ink cursor-pointer">{t("aiConnect.pointer.advanced")}</summary>
        <ol className="m-0 mt-3 grid list-none gap-2.5 p-0">
          <li className="flex items-start gap-2.5">
            <span className="bg-hover text-ink-2 mt-px grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold">1</span>
            <span className="min-w-0">
              {t("aiHub.tokens.connect.step1")}{" "}
              <Link href="/app/me?tab=security" className="text-accent-text">
                {t("aiHub.tokens.connect.keyLink")}
              </Link>
            </span>
          </li>
          <li className="flex items-start gap-2.5">
            <span className="bg-hover text-ink-2 mt-px grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold">2</span>
            <span className="grid min-w-0 flex-1 gap-2">
              <span>
                {t("aiHub.tokens.connect.step2")}{" "}
                <a href={`${origin}/runner/workspace-usage.mjs`} download className="text-accent-text">
                  {t("aiHub.tokens.connect.download")}
                </a>
              </span>
              <span className="bg-term text-term-ink flex min-w-0 items-center gap-2 rounded-md py-1.5 pl-3 pr-1.5 font-mono text-xs">
                <span className="grid min-w-0 flex-1 overflow-x-auto whitespace-nowrap">
                  {lines.map((l) => (
                    <span key={l}>
                      <span className="text-term-2 select-none">$ </span>
                      {l}
                    </span>
                  ))}
                </span>
                <button
                  type="button"
                  className={cx(btnGhost, btnSm, "text-term-ink hover:text-term-ink shrink-0 self-start hover:bg-transparent hover:opacity-80")}
                  aria-label={t("aiHub.tokens.connect.copy")}
                  onClick={() => {
                    void navigator.clipboard?.writeText(cmd);
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1500);
                  }}
                >
                  {copied ? <CheckIcon /> : <CopyIcon />}
                </button>
              </span>
            </span>
          </li>
        </ol>
      </details>
      <p className="text-ink-2 m-0 max-w-2xl text-xs">{t("aiHub.tokens.connect.privacy")}</p>
    </div>
  );
}
