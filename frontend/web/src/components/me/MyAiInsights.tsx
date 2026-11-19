"use client";

import Link from "next/link";
import { createContext, useContext, useState } from "react";
import { sensitiveLabel, sourceLabel, topicLabel, topicLabels } from "@/lib/ai-labels";
import { api } from "@/lib/client";
import { useFormat, useT } from "@/lib/i18n/client";
import { MIN_COMPARE_SAMPLE } from "@/lib/metrics";
import { btn, btnPrimary, btnSm, chip, chipOk, chipWarn, cx, input } from "@/lib/ui";
import { KpiStrip } from "@/components/ui/KpiStrip";
import { IconTile } from "@/components/ui/Bento";
import { taskHref } from "@/lib/links";
import { CheckIcon, FileIcon, ShieldIcon, SparkleIcon } from "@/components/app/icons";

export interface TaskBrief {
  id: string;
  code: string;
  title: string;
  status: string;
  completedAt: string | null;
}
interface Group {
  done: number;
  dated: number;
  onTime: number;
  cycleDays: number | null;
}
export interface MyConversation {
  id: string;
  source: string;
  title: string;
  topic: string;
  sensitive: string[];
  prompts: number;
  lastAt: string;
  helpful: "yes" | "no" | "partly" | null;
  task: TaskBrief | null;
  taskLink: "manual" | "hint" | "suggested" | null;
  hint: TaskBrief | null;
  hintFrom?: "code" | "open";
}
/** ai module oversight/me › insights (me-insights.ts). */
export interface MyInsights {
  week: {
    conversations: number;
    prompts: number;
    topics: { topic: string; conversations: number }[];
    sources: { source: string; conversations: number }[];
    helpful: { yes: number; no: number; partly: number };
  };
  conversations: MyConversation[];
  sensitive: { flagged: { kind: string; conversations: number }[]; safety: { action: "warn" | "redact" | "block"; kind: string; count: number }[] };
  tasks: { withAi: { assisted: Group; other: Group }; helped: (TaskBrief & { days: number })[] } | null;
  erasure: { id: string; status: "open" | "done" | "declined"; note: string; requestedAt: string; handledAt: string | null }[];
  topicLabels?: { key: string; labelVi: string; labelEn: string }[];
}

/** The company's own topic names (Admin › AI), so its topics don't read as "other". */
const TopicNames = createContext<Record<string, string>>({});

const card = "rounded-xl bg-surface border border-hairline";
const ACTIONS = ["block", "redact", "warn"] as const;

/**
 * AI Insights in Của tôi › AI, the part people come back for: what AI did for them this week, whether their tasks
 * went faster with it, each conversation with "did it help?" and the task it served, their own warnings, and their
 * data (export, deletion). Loaded on demand by MyAi.
 */
export function MyAiInsights({ data }: { data: MyInsights }) {
  const { locale } = useFormat();
  return (
    <TopicNames.Provider value={topicLabels(data.topicLabels ?? [], locale)}>
      <Week data={data} />
      <Tasks tasks={data.tasks} />
      <Sensitive sensitive={data.sensitive} />
      <DataRights erasure={data.erasure} />
    </TopicNames.Provider>
  );
}

function Bars({ rows }: { rows: { key: string; label: string; n: number }[] }) {
  const t = useT();
  const max = Math.max(1, ...rows.map((r) => r.n));
  return (
    <ul className="m-0 grid list-none gap-2 p-0">
      {rows.map((r) => (
        <li key={r.key} className="flex items-center gap-3 text-sm">
          <span className="w-28 shrink-0 truncate">{r.label}</span>
          <span className="bg-progress-track block h-1.5 flex-1 overflow-hidden rounded-full">
            <span className="bg-progress block h-full rounded-full" style={{ width: `${(r.n / max) * 100}%` }} />
          </span>
          <span className="text-ink-2 w-28 text-right text-xs tabular-nums">{t("aiInsights.conversations", { count: r.n })}</span>
        </li>
      ))}
    </ul>
  );
}

function Week({ data }: { data: MyInsights }) {
  const t = useT();
  const names = useContext(TopicNames);
  const w = data.week;
  const answered = w.helpful.yes + w.helpful.no + w.helpful.partly;
  return (
    <section id="ai-week" className={cx(card, "grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-4 p-5 lg:col-span-2")} aria-labelledby="ai-week-h">
      <div className="grid gap-1">
        <h2 id="ai-week-h" className="m-0 flex min-w-0 items-center gap-3 text-sm font-semibold tracking-[-0.01em]">
          <IconTile tone="violet">
            <SparkleIcon />
          </IconTile>
          {t("aiInsights.title")} · {t("aiInsights.weekTitle")}
        </h2>
        <p className="text-ink-2 m-0 text-sm">{t("aiInsights.lead")}</p>
      </div>
      <KpiStrip
        keepZeros
        label={t("aiInsights.weekTitle")}
        items={[
          { label: t("aiInsights.kpiConversations"), value: w.conversations },
          { label: t("aiInsights.kpiPrompts"), value: w.prompts },
          {
            label: t("aiInsights.kpiHelpful"),
            value: answered ? `${Math.round(((w.helpful.yes + w.helpful.partly) / answered) * 100)}%` : null,
            info: t("aiInsights.kpiHelpfulInfo"),
          },
          { label: t("aiInsights.kpiTasks"), value: data.tasks ? data.tasks.withAi.assisted.done : null, info: t("aiInsights.kpiTasksInfo") },
        ]}
      />
      {w.conversations === 0 ? (
        <p className="text-ink-2 m-0 text-sm">{t("aiInsights.weekEmpty")}</p>
      ) : (
        <div className="grid gap-5 md:grid-cols-2">
          <div className="grid content-start gap-2">
            <h3 className="text-ink-2 m-0 text-xs font-medium">{t("aiInsights.byTopic")}</h3>
            <Bars rows={w.topics.slice(0, 6).map((x) => ({ key: x.topic, label: topicLabel(t, x.topic, names), n: x.conversations }))} />
          </div>
          <div className="grid content-start gap-2">
            <h3 className="text-ink-2 m-0 text-xs font-medium">{t("aiInsights.byTool")}</h3>
            <Bars rows={w.sources.map((x) => ({ key: x.source, label: sourceLabel(t, x.source), n: x.conversations }))} />
          </div>
        </div>
      )}
    </section>
  );
}

/** With AI help against without, for my own finished tasks; says "faster" only with enough tasks on both sides. */
function Tasks({ tasks }: { tasks: MyInsights["tasks"] }) {
  const t = useT();
  const { ago } = useFormat();
  if (!tasks) return null;
  const { assisted, other } = tasks.withAi;
  const days = (g: Group) => (g.done >= MIN_COMPARE_SAMPLE && g.cycleDays != null && g.cycleDays > 0 ? g.cycleDays : null);
  const a = days(assisted);
  const o = days(other);
  const verdict = a != null && o != null ? Math.round(((o - a) / o) * 100) : null;
  const side = (label: string, g: Group, d: number | null) => (
    <div className="bg-ground grid gap-0.5 rounded-xl p-3">
      <span className="text-ink-2 text-xs font-medium">{label}</span>
      <span className="text-lg font-semibold tabular-nums">{d != null ? t("aiInsights.medianDays", { days: d }) : t("aiInsights.noMedian")}</span>
      <span className="text-ink-2 text-xs">{t("aiInsights.doneCount", { count: g.done })}</span>
    </div>
  );
  return (
    <section id="ai-tasks" className={cx(card, "grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-3 p-5 lg:col-span-2")} aria-labelledby="ai-tasks-h">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="ai-tasks-h" className="m-0 flex min-w-0 items-center gap-3 text-sm font-semibold tracking-[-0.01em]">
          <IconTile tone="sky">
            <CheckIcon />
          </IconTile>
          {t("aiInsights.tasksTitle")}
        </h2>
        {verdict != null ? (
          <span className={verdict > 5 ? chipOk : verdict < -5 ? chipWarn : chip}>
            {verdict > 5 ? t("aiInsights.faster", { pct: verdict }) : verdict < -5 ? t("aiInsights.slower", { pct: -verdict }) : t("aiInsights.same")}
          </span>
        ) : null}
      </div>
      <p className="text-ink-2 m-0 text-sm">{t("aiInsights.tasksLead")}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {side(t("aiInsights.withAi"), assisted, a)}
        {side(t("aiInsights.withoutAi"), other, o)}
      </div>
      {tasks.helped.length ? (
        <div className="grid gap-1.5">
          <h3 className="text-ink-2 m-0 text-xs font-medium">{t("aiInsights.helpedTitle")}</h3>
          <ul className="m-0 grid list-none gap-1 p-0 text-sm">
            {tasks.helped.map((x) => (
              <li key={x.id} className="flex min-w-0 items-baseline gap-2">
                <Link href={taskHref(x)} className="text-ink min-w-0 truncate font-medium no-underline hover:underline">
                  <span className="text-ink-2 font-mono text-xs">{x.code}</span> {x.title}
                </Link>
                <span className="text-ink-2 shrink-0 text-xs">{x.completedAt ? ago(x.completedAt) : ""}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-ink-2 m-0 text-sm">{t("aiInsights.tasksEmpty")}</p>
      )}
      <p className="text-ink-2 m-0 text-xs">{t("aiInsights.correlation")}</p>
    </section>
  );
}

function Sensitive({ sensitive }: { sensitive: MyInsights["sensitive"] }) {
  const t = useT();
  const kind = (k: string) => (k === "keyword" ? t("aiInsights.keyword") : k === "other" ? t("aiInsights.kindOther") : sensitiveLabel(t, k));
  const empty = !sensitive.flagged.length && !sensitive.safety.length;
  return (
    <section id="ai-sensitive" className={cx(card, "grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-3 p-5")} aria-labelledby="ai-sens-h">
      <h2 id="ai-sens-h" className="m-0 flex min-w-0 items-center gap-3 text-sm font-semibold tracking-[-0.01em]">
        <IconTile tone="red">
          <ShieldIcon />
        </IconTile>
        {t("aiInsights.sensitiveTitle")}
      </h2>
      <p className="text-ink-2 m-0 text-sm">{t("aiInsights.sensitiveLead")}</p>
      {empty ? (
        <p className="text-ink-2 m-0 text-sm">{t("aiInsights.sensitiveEmpty")}</p>
      ) : (
        <ul className="m-0 grid list-none gap-1.5 p-0 text-sm">
          {sensitive.flagged.map((f) => (
            <li key={`f-${f.kind}`} className="flex items-baseline justify-between gap-3">
              <span>{kind(f.kind)}</span>
              <span className="text-ink-2 text-xs">{t("aiInsights.flaggedIn", { count: f.conversations })}</span>
            </li>
          ))}
          {ACTIONS.flatMap((a) =>
            sensitive.safety
              .filter((s) => s.action === a)
              .map((s) => (
                <li key={`s-${a}-${s.kind}`} className="flex items-baseline justify-between gap-3">
                  <span>{kind(s.kind)}</span>
                  <span className="text-ink-2 text-xs tabular-nums">
                    {t(`aiInsights.action_${a}`)} · {s.count}
                  </span>
                </li>
              )),
          )}
        </ul>
      )}
    </section>
  );
}

/** Export and the erasure request: the person's rights over their AI data, in two buttons. */
function DataRights({ erasure }: { erasure: MyInsights["erasure"] }) {
  const t = useT();
  const { ago } = useFormat();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [requests, setRequests] = useState(erasure);
  const latest = requests[0];
  const exportJson = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await api<unknown>("ai/oversight/me/export");
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `ai-insights-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError(t("aiInsights.exportFailed"));
    } finally {
      setBusy(false);
    }
  };
  const requestErasure = async () => {
    setError(null);
    try {
      const r = await api<{ id: string }>("ai/oversight/me/erasure", { method: "POST", body: { note } });
      setRequests([{ id: r.id, status: "open", note, requestedAt: new Date().toISOString(), handledAt: null }, ...requests.filter((x) => x.id !== r.id)]);
      setAsking(false);
    } catch {
      setError(t("aiInsights.failed"));
    }
  };
  return (
    <section id="ai-data" className={cx(card, "grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-3 p-5")} aria-labelledby="ai-data-h">
      <h2 id="ai-data-h" className="m-0 flex min-w-0 items-center gap-3 text-sm font-semibold tracking-[-0.01em]">
        <IconTile tone="tangerine">
          <FileIcon />
        </IconTile>
        {t("aiInsights.dataTitle")}
      </h2>
      <p className="text-ink-2 m-0 text-sm">{t("aiInsights.dataLead")}</p>
      {latest ? (
        <p className="m-0 text-sm" data-testid="ai-erasure-status">
          {t(`aiInsights.eraseStatus_${latest.status}`, { when: ago(latest.status === "open" ? latest.requestedAt : (latest.handledAt ?? latest.requestedAt)) })}
        </p>
      ) : null}
      {asking ? (
        <div className="grid gap-2">
          <label className="text-ink-2 grid gap-1 text-xs">
            {t("aiInsights.eraseNote")}
            <textarea className={cx(input, "min-h-16 py-2")} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <p className="text-ink-2 m-0 text-xs">{t("aiInsights.eraseHint")}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={cx(btnPrimary, btnSm)} onClick={() => void requestErasure()}>
              {t("aiInsights.eraseSend")}
            </button>
            <button type="button" className={cx(btn, btnSm)} onClick={() => setAsking(false)}>
              {t("aiInsights.eraseCancel")}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button type="button" className={cx(btn, btnSm)} disabled={busy} onClick={() => void exportJson()}>
            {busy ? t("aiInsights.exporting") : t("aiInsights.export")}
          </button>
          {latest?.status !== "open" ? (
            <button type="button" className={cx(btn, btnSm)} onClick={() => setAsking(true)}>
              {t("aiInsights.erase")}
            </button>
          ) : null}
        </div>
      )}
      {error ? <p className="text-block m-0 text-xs">{error}</p> : null}
    </section>
  );
}
