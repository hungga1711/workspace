"use client";

import { IconTile } from "@/components/ui/Bento";
import { SendIcon } from "@/components/app/icons";
import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/client";
import { useT } from "@/lib/i18n/client";
import { btn, btnSm, cx } from "@/lib/ui";

export interface ReportSettings {
  weeklyEmail: boolean;
  mailConfigured: boolean;
}

/** Admin › AI › the owner's weekly report: a link to the page and the Monday email switch (off by default). */
export function AiReportEmailAdmin({ settings }: { settings: ReportSettings }) {
  const t = useT();
  const [on, setOn] = useState(settings.weeklyEmail);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const toggle = async () => {
    setBusy(true);
    try {
      const r = await api<ReportSettings>("ai/insights/report/settings", { method: "PUT", body: { weeklyEmail: !on } });
      setOn(r.weeklyEmail);
      setMsg({ text: t("aiInsights.report.saved"), ok: true });
    } catch {
      setMsg({ text: t("aiInsights.report.failed"), ok: false });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="grid gap-3" aria-labelledby="ai-report-h">
      <div className="flex items-start justify-between gap-3">
        <div className="grid gap-1">
          <h2 id="ai-report-h" className="m-0 flex min-w-0 items-center gap-3 text-sm/6 font-semibold tracking-[-0.01em]">
            <IconTile tone="tangerine">
              <SendIcon />
            </IconTile>
            {t("aiInsights.report.title")}
          </h2>
          <p className="text-ink-2 m-0 text-sm">{t("aiInsights.report.sub")}</p>
        </div>
        <Link href="/app/ai/adoption/report" className={cx(btn, btnSm, "shrink-0 no-underline")}>
          {t("aiInsights.links.report")}
        </Link>
      </div>
      <div className="bg-surface shadow-card flex items-start justify-between gap-4 rounded-xl px-4 py-3">
        <div className="grid gap-0.5">
          <span className="text-sm font-medium">{t("aiInsights.report.emailTitle")}</span>
          <span className="text-ink-2 text-xs">{t("aiInsights.report.emailHint")}</span>
          {!settings.mailConfigured ? <span className="text-warn text-xs">{t("aiInsights.report.emailNoSmtp")}</span> : null}
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={t("aiInsights.report.emailTitle")}
          disabled={busy}
          onClick={() => void toggle()}
          className={cx("relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-60", on ? "bg-brand" : "bg-hairline")}
        >
          <span className={cx("bg-surface absolute top-0.5 size-5 rounded-full shadow transition-all", on ? "left-[22px]" : "left-0.5")} />
        </button>
      </div>
      {msg ? (
        <p className={cx("m-0 text-sm", msg.ok ? "text-ok" : "text-block")} role="status">
          {msg.text}
        </p>
      ) : null}
    </section>
  );
}
