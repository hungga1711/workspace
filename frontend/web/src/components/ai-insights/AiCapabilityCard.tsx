"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { useT } from "@/lib/i18n/client";
import { InfoTip } from "@/components/ui/InfoTip";
import { Avatar } from "@/lib/people";
import { cx, progressFill, progressTrack } from "@/lib/ui";
import { ChevronDownIcon, UsersIcon, StarIcon } from "@/components/app/icons";
import { panel, PanelHead } from "@/components/work/progressUi";

interface Capability {
  departments: {
    name: string | null;
    people: number;
    active: number;
    top: { userId: string; displayName: string; prompts: number; rated: number; score: number | null; mentor: boolean }[];
  }[];
}

/**
 * The capability map: per department, the people who use AI most and rate it helpful, with suggested mentors.
 * Fetched on its own (the oversight page does not wait for it); hidden until someone in the audience uses AI.
 */
export function AiCapabilityCard({ days }: { days: number }) {
  const t = useT();
  const [c, setC] = useState<Capability | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api<Capability>(`ai/insights/capability?days=${days >= 90 ? 90 : 30}`)
      .then((r) => live && setC(r))
      .catch(() => live && setC(null));
    return () => {
      live = false;
    };
  }, [days]);
  const depts = c?.departments.filter((d) => d.top.length) ?? [];
  if (!depts.length) return null;
  return (
    <section aria-labelledby="ai-capability-h" className={panel} data-testid="ai-capability-card">
      <PanelHead id="ai-capability-h" hue="teal" icon={<UsersIcon />} title={t("aiInsights.capability.title")}>
        <InfoTip text={t("aiInsights.capability.sub")} label={t("aiInsights.capability.title")} align="right" />
      </PanelHead>
      {/* One row per department: who uses AI (bar), and the person to ask first; the rest of the list opens on tap. */}
      <ul className="divide-hairline m-0 grid list-none divide-y p-0">
        {depts.map((d) => {
          const key = d.name ?? "";
          const on = open === key;
          const lead = d.top[0]!;
          const person = (p: (typeof d.top)[number], size: "xs" | "sm") => (
            <>
              <Avatar id={p.userId} name={p.displayName} size={size} />
              <span className="min-w-0 flex-1 truncate">{p.displayName}</span>
              {p.mentor ? (
                <span className="text-warn-fill inline-flex" title={t("aiInsights.capability.mentor")} aria-label={t("aiInsights.capability.mentor")}>
                  <StarIcon className="size-3.5 fill-current" />
                </span>
              ) : null}
              <span className="text-ink-2 w-9 text-right text-xs tabular-nums" title={p.score == null ? t("aiInsights.capability.unrated") : t("aiInsights.oversightHelpful")}>
                {p.score == null ? "–" : t("aiInsights.capability.score", { pct: `${Math.round(p.score * 100)}%` })}
              </span>
            </>
          );
          return (
            <li key={key}>
              <button
                type="button"
                aria-expanded={on}
                onClick={() => setOpen(on ? null : key)}
                className="hover:bg-hover -mx-2 grid w-[calc(100%+1rem)] grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 rounded-md px-2 py-2 text-left text-sm sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)_minmax(0,14rem)_auto]"
              >
                <span className="truncate font-medium">{d.name ?? t("aiInsights.capability.noDept")}</span>
                <span className="flex items-center gap-2 max-sm:order-last max-sm:col-span-2" title={t("aiInsights.capability.active", { active: d.active, people: d.people })}>
                  <span className={cx(progressTrack, "h-1 flex-1")}>
                    <span className={progressFill} style={{ width: `${d.people ? (d.active / d.people) * 100 : 0}%` }} />
                  </span>
                  <span className="text-ink-2 w-12 shrink-0 text-right text-xs tabular-nums">{t("aiInsights.capability.active", { active: d.active, people: d.people })}</span>
                </span>
                <span className="flex min-w-0 items-center gap-2 max-sm:hidden">{person(lead, "xs")}</span>
                <ChevronDownIcon className={cx("text-ink-2 size-4 transition-transform", on && "rotate-180")} />
              </button>
              {on ? (
                <ul className="divide-hairline m-0 mb-2 grid list-none divide-y p-0 pl-2 sm:ml-[11rem] sm:pl-4">
                  {d.top.map((p) => (
                    <li key={p.userId} className="flex items-center gap-2 py-1.5 text-sm">
                      {person(p, "sm")}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
