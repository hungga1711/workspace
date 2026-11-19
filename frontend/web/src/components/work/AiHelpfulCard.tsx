"use client";

import { sourceLabel, topicLabel } from "@/lib/ai-labels";
import { useState } from "react";
import { useT } from "@/lib/i18n/client";
import { InfoTip } from "@/components/ui/InfoTip";
import { Segmented } from "@/components/ui/Segmented";
import { CheckCircleIcon } from "@/components/app/icons";
import { panel, PanelHead } from "./progressUi";

export interface HelpfulTally {
  key: string | null;
  yes: number;
  no: number;
  partly: number;
}
export interface HelpfulBreakdown {
  sources: HelpfulTally[];
  topics: HelpfulTally[];
  departments: HelpfulTally[];
}

/**
 * Công việc › AI, "AI có giúp không?": the share of staff's own one-tap answers that said yes or partly, by tool,
 * topic and department. Only answered conversations count; the number of answers sits next to each share so a
 * 100% from two answers reads as what it is.
 */
export function AiHelpfulCard({ helpful, custom }: { helpful: HelpfulBreakdown; custom?: Record<string, string> }) {
  const t = useT();
  const total = helpful.sources.reduce((n, x) => n + x.yes + x.no + x.partly, 0);
  // One list at a time (tool, kind of work, department), not three side by side: a third of the words.
  const [view, setView] = useState<"sources" | "topics" | "departments">("sources");
  const views = {
    sources: { title: t("aiw.o.tools"), rows: helpful.sources, label: (k: string | null) => sourceLabel(t, k ?? "other") },
    topics: { title: t("aiw.o.topics"), rows: helpful.topics, label: (k: string | null) => topicLabel(t, k ?? "other", custom) },
    departments: { title: t("aiw.o.dept"), rows: helpful.departments, label: (k: string | null) => k ?? t("follow.deptNone") },
  };
  const column = (rows: HelpfulTally[], label: (k: string | null) => string) => (
    <div className="grid content-start gap-2">
      <ul className="m-0 grid list-none gap-x-8 gap-y-2 p-0 md:grid-cols-2">
        {rows.slice(0, 8).map((r) => {
          const n = r.yes + r.no + r.partly;
          const share = n ? Math.round(((r.yes + r.partly) / n) * 100) : 0;
          const yes = n ? (r.yes / n) * 100 : 0;
          const partly = n ? (r.partly / n) * 100 : 0;
          return (
            <li key={r.key ?? ""} className="grid gap-1 text-sm">
              <span className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate">{label(r.key)}</span>
                <span className="text-ink shrink-0 text-xs font-medium tabular-nums" title={t("aiInsights.answers", { count: n })}>
                  {share}%
                </span>
              </span>
              <span className="bg-progress-track flex h-1.5 overflow-hidden rounded-full" aria-hidden="true">
                <span className="bg-accent block h-full" style={{ width: `${yes}%` }} />
                <span className="bg-accent/40 block h-full" style={{ width: `${partly}%` }} />
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
  return (
    <section aria-labelledby="ai-helpful-h" className={panel} data-testid="ai-helpful-card">
      <PanelHead id="ai-helpful-h" hue="teal" icon={<CheckCircleIcon />} title={t("aiInsights.oversightHelpful")}>
        {total ? (
          <Segmented
            label={t("aiInsights.oversightHelpful")}
            size="sm"
            value={view}
            onChange={setView}
            options={(["sources", "topics", "departments"] as const).map((v) => ({ value: v, label: views[v].title }))}
          />
        ) : null}
        <InfoTip text={t("aiInsights.oversightHelpfulLead")} label={t("aiInsights.oversightHelpful")} align="right" />
      </PanelHead>
      <div className="grid content-start gap-3">
        {total === 0 ? <p className="text-ink-2 m-0 text-sm">{t("aiInsights.oversightHelpfulEmpty")}</p> : column(views[view].rows, views[view].label)}
      </div>
    </section>
  );
}
