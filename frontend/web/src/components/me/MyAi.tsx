"use client";

import { featureLabel, sensitiveLabel, sourceLabel, topicLabel } from "@/lib/ai-labels";
import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/client";
import { useAiEnabled } from "@/lib/ai-context";
import { useFormat, useT } from "@/lib/i18n/client";
import { btn, btnPrimary, btnSm, cx, mono } from "@/lib/ui";
import { ChartIcon, CopyIcon, GlobeIcon, InfoIcon, ShieldIcon } from "@/components/app/icons";
import dynamic from "next/dynamic";
import { IconTile } from "@/components/ui/Bento";
import type { MyInsights } from "./MyAiInsights";

// The AI Insights cards (charts, task picker, export) load with the AI tab, not with every Của tôi page.
const MyAiInsights = dynamic(() => import("./MyAiInsights").then((m) => m.MyAiInsights));

export interface MyAiData {
  policy: { detail: "topic" | "summary"; captureResponses: boolean; retentionDays: number };
  stats: { source: string; conversations: number; prompts: number }[];
  extension: { createdAt: string; lastSeenAt: string | null } | null;
  /** What Tiến độ › AI shows a manager about me (same rows, same masking); older API answers lack it. */
  managerSees?: {
    days: number;
    /** `summary` is the one line the AI wrote (policy "summary", a hosted model): never the prompt or its title. */
    conversations: { id: string; source: string; topic: string; sensitive: string[]; prompts: number; lastAt: string; summary?: string }[];
    features: { feature: string; calls: number }[];
  };
  /** AI Insights for the person (week, "có giúp", task links, warnings, export and erasure); older API answers lack it. */
  insights?: MyInsights;
}

const card = "rounded-xl bg-surface border border-hairline";

/**
 * Của tôi › AI (AI Insights): what AI did for me this week and whether it helped, my conversations and the tasks
 * they served, then what the company records about my AI use and who can see it, my numbers for 30 days, and the
 * browser extension's connection code. Nothing here is hidden from me.
 */
export function MyAi({ data }: { data: MyAiData }) {
  const t = useT();
  const { ago } = useFormat();
  // No company AI provider: only the extension is recorded, and there is no assistant to open.
  const aiOn = useAiEnabled();
  const [code, setCode] = useState<string | null>(null);
  const [connected, setConnected] = useState(data.extension);
  const [copied, setCopied] = useState(false);
  const connect = async () => {
    const r = await api<{ token: string }>("ai/monitor/connection", { method: "POST" });
    setCode(`${window.location.origin}#${r.token}`);
    setConnected({ createdAt: new Date().toISOString(), lastSeenAt: null });
  };
  const disconnect = async () => {
    await api("ai/monitor/connection", { method: "DELETE" });
    setCode(null);
    setConnected(null);
  };
  const copy = async () => {
    if (!code) return;
    await navigator.clipboard.writeText(code).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const total = data.stats.reduce((n, s) => n + s.prompts, 0);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5 max-md:gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      {data.insights ? <MyAiInsights data={data.insights} /> : null}
      <section className={cx(card, "grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-3 p-5")} aria-labelledby="ai-policy-h">
        <h2 id="ai-policy-h" className="m-0 flex min-w-0 items-center gap-3 text-sm font-semibold tracking-[-0.01em]">
          <IconTile tone="sky">
            <ShieldIcon />
          </IconTile>
          {t("aiw.me.policyTitle")}
        </h2>
        <ul className="text-ink m-0 grid list-disc gap-1.5 pl-5 text-sm">
          <li>{t(aiOn ? "aiw.me.what" : "aiOff.whatExt")}</li>
          <li>{t(`aiw.detail.${data.policy.detail}`)}</li>
          <li>{t(data.policy.captureResponses ? "aiw.me.responsesOn" : "aiw.me.responsesOff")}</li>
          <li>{t("aiw.me.retention", { days: data.policy.retentionDays })}</li>
        </ul>
        {aiOn ? (
          <Link href="/app/ai/ask" className={cx(btnPrimary, btnSm, "justify-self-start no-underline")}>
            {t("aiw.me.openAssistant")}
          </Link>
        ) : (
          <p className="text-ink-2 m-0 text-xs">{t("aiOff.oversightNote")}</p>
        )}
      </section>

      <section className={cx(card, "grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-3 p-5")} aria-labelledby="ai-ext-h">
        <h2 id="ai-ext-h" className="m-0 flex min-w-0 items-center gap-3 text-sm font-semibold tracking-[-0.01em]">
          <IconTile tone="tangerine">
            <GlobeIcon />
          </IconTile>
          {t("aiw.me.extTitle")}
        </h2>
        <p className="text-ink-2 m-0 text-sm">{t("aiw.me.extLead")}</p>
        <p className="m-0 text-sm">
          {connected ? (
            <span className="text-ink inline-flex items-center gap-1.5 font-medium">
              <span className="bg-ok size-1.5 rounded-full" aria-hidden="true" />
              {connected.lastSeenAt ? t("aiw.me.extSeen", { when: ago(connected.lastSeenAt) }) : t("aiw.me.extWaiting")}
            </span>
          ) : (
            <span className="text-ink-2">{t("aiw.me.extNone")}</span>
          )}
        </p>
        <ol className="text-ink m-0 grid gap-1 pl-5 text-sm">
          <li>
            {t("aiw.me.step1")}{" "}
            <a href="/downloads/workspace-ai.zip" download className="text-ink font-medium">
              workspace-ai.zip
            </a>
          </li>
          <li>{t("aiw.me.step2")}</li>
          <li>{t("aiw.me.step3")}</li>
        </ol>
        {code ? (
          <div className="bg-ground border-hairline grid gap-2 rounded-xl border p-3">
            <span className="text-ink-2 text-xs font-medium">{t("aiw.me.codeLabel")}</span>
            <code className={cx(mono, "break-all text-xs")} data-testid="ai-code">
              {code}
            </code>
            <button type="button" className={cx(btn, btnSm, "justify-self-start")} onClick={() => void copy()}>
              <CopyIcon className="size-4" />
              {copied ? t("aiw.me.copied") : t("aiw.me.copy")}
            </button>
            <span className="text-ink-2 text-xs">{t("aiw.me.codeOnce")}</span>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <button type="button" className={cx(btnPrimary, btnSm)} onClick={() => void connect()}>
            {connected ? t("aiw.me.newCode") : t("aiw.me.makeCode")}
          </button>
          {connected ? (
            <button type="button" className={cx(btn, btnSm)} onClick={() => void disconnect()}>
              {t("aiw.me.disconnect")}
            </button>
          ) : null}
        </div>
      </section>

      <section className={cx(card, "grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-3 p-5")} aria-labelledby="ai-stats-h">
        <h2 id="ai-stats-h" className="m-0 flex min-w-0 items-center gap-3 text-sm font-semibold tracking-[-0.01em]">
          <IconTile tone="violet">
            <ChartIcon />
          </IconTile>
          {t("aiw.me.statsTitle")}
        </h2>
        {total === 0 ? (
          <p className="text-ink-2 m-0 text-sm">{t("aiw.me.statsEmpty")}</p>
        ) : (
          <ul className="m-0 grid list-none gap-2 p-0">
            {data.stats.map((s) => (
              <li key={s.source} className="flex items-center gap-3 text-sm">
                <span className="w-28 shrink-0">{sourceLabel(t, s.source)}</span>
                <span className="bg-progress-track block h-1.5 flex-1 overflow-hidden rounded-full">
                  <span className="bg-progress block h-full rounded-full" style={{ width: `${(s.prompts / total) * 100}%` }} />
                </span>
                <span className="text-ink-2 w-24 text-right text-xs tabular-nums">{t("aiw.prompts", { count: s.prompts })}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {data.managerSees ? <ManagerSeesAi sees={data.managerSees} detail={data.policy.detail} /> : null}
    </div>
  );
}

/**
 * "Quản lý thấy gì": the very rows a manager reads about me in AI › Áp dụng AI. A manager never reads a prompt: each
 * conversation is its tool, topic and count, and (policy "summary") the one line the AI wrote about it.
 */
function ManagerSeesAi({ sees, detail }: { sees: NonNullable<MyAiData["managerSees"]>; detail: MyAiData["policy"]["detail"] }) {
  const t = useT();
  const { ago } = useFormat();
  return (
    <section id="ai-sees" className={cx(card, "grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-3 p-5 lg:col-span-2")} aria-labelledby="ai-sees-h">
      <h2 id="ai-sees-h" className="m-0 flex min-w-0 items-center gap-3 text-sm font-semibold tracking-[-0.01em]">
        <IconTile tone="sky">
          <InfoIcon />
        </IconTile>
        {t("aiw.me.seesTitle")}
      </h2>
      <p className="text-ink-2 m-0 text-sm">{t(detail === "topic" ? "aiw.me.seesLeadTopic" : "aiw.me.seesLead")}</p>
      {sees.conversations.length === 0 ? (
        <p className="text-ink-2 m-0 text-sm">{t("aiw.me.seesEmpty")}</p>
      ) : (
        <ul className="divide-divider-soft ring-hairline m-0 grid list-none grid-cols-[minmax(0,1fr)] divide-y rounded-xl p-0 ring-1 ring-inset">
          {sees.conversations.slice(0, 20).map((c) => (
            <li key={c.id} className="grid gap-0.5 px-3 py-2.5 text-sm">
              <span className="min-w-0 font-medium">{c.summary || topicLabel(t, c.topic)}</span>
              <span className="text-ink-2 text-xs">{[sourceLabel(t, c.source), topicLabel(t, c.topic), t("aiw.prompts", { count: c.prompts }), ago(c.lastAt)].join(" · ")}</span>
              {c.sensitive.length ? <span className="text-warn text-xs">{t("aiw.me.seesFlagged", { kinds: c.sensitive.map((k) => sensitiveLabel(t, k)).join(", ") })}</span> : null}
            </li>
          ))}
        </ul>
      )}
      {sees.features.length ? (
        <p className="text-ink-2 m-0 flex flex-wrap gap-x-3 gap-y-1 text-xs">
          <span className="text-ink font-medium">{t("aiw.me.seesFeatures")}</span>
          {sees.features.map((f) => (
            <span key={f.feature}>
              {featureLabel(t, f.feature)} <span className="text-ink tabular-nums">{f.calls}</span>
            </span>
          ))}
        </p>
      ) : null}
    </section>
  );
}
