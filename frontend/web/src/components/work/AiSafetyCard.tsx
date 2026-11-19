"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { useT } from "@/lib/i18n/client";
import { cx } from "@/lib/ui";
import { InfoTip } from "@/components/ui/InfoTip";
import { Segmented } from "@/components/ui/Segmented";
import { ShieldIcon } from "@/components/app/icons";
import { panel, PanelHead } from "./progressUi";

interface Counts {
  warn: number;
  redact: number;
  block: number;
}
interface Safety {
  total: Counts;
  people: (Counts & { userId: string; name: string; department: string | null })[];
  departments: (Counts & { department: string | null })[];
}

/**
 * Công việc › AI › the safety net at work: how many sends the extension warned about, redacted or blocked in the
 * window, per department and person. Counts only (the text never reaches workspace). Loaded on its own so the
 * page does not wait for it; hidden when nothing happened.
 */
export function AiSafetyCard({ days }: { days: number }) {
  const t = useT();
  const [s, setS] = useState<Safety | null>(null);
  const [view, setView] = useState<"dept" | "person">("dept");
  useEffect(() => {
    let live = true;
    api<Safety>(`ai/oversight/safety?days=${days}`)
      .then((r) => live && setS(r))
      .catch(() => live && setS(null));
    return () => {
      live = false;
    };
  }, [days]);
  if (!s || s.total.warn + s.total.redact + s.total.block === 0) return null;
  const nums = (c: Counts) => (
    <span className="text-ink-2 flex gap-3 text-xs tabular-nums">
      <span>{t("aiSafety.card.redacted", { count: c.redact })}</span>
      <span>{t("aiSafety.card.blocked", { count: c.block })}</span>
      <span>{t("aiSafety.card.warned", { count: c.warn })}</span>
    </span>
  );
  // Rows carry numbers only; the three words stand once, as column heads.
  const cols = "grid grid-cols-[minmax(0,1fr)_3rem_3rem_4rem] items-center gap-x-2";
  const head = (label: string) => (
    <li className={cx(cols, "text-ink-2 pb-1 text-xs")} aria-hidden="true">
      <span>{label}</span>
      <span className="text-right">{t("aiSafety.card.colRedacted")}</span>
      <span className="text-right">{t("aiSafety.card.colBlocked")}</span>
      <span className="text-right">{t("aiSafety.card.colWarned")}</span>
    </li>
  );
  const cells = (c: Counts) => (
    <>
      <span className={cx("text-right text-xs tabular-nums", c.redact ? "text-ink" : "text-ink-2")}>{c.redact}</span>
      <span className={cx("text-right text-xs tabular-nums", c.block ? "text-ink" : "text-ink-2")}>{c.block}</span>
      <span className={cx("text-right text-xs tabular-nums", c.warn ? "text-ink" : "text-ink-2")}>{c.warn}</span>
    </>
  );
  return (
    <section aria-labelledby="ai-safety-card-h" className={panel} data-testid="ai-safety-card">
      <PanelHead id="ai-safety-card-h" hue="orange" icon={<ShieldIcon />} title={t("aiSafety.card.title")}>
        <span className="max-md:hidden">{nums(s.total)}</span>
        <Segmented
          label={t("aiSafety.card.title")}
          size="sm"
          value={view}
          onChange={setView}
          options={[
            { value: "dept", label: t("aiSafety.card.byDept") },
            { value: "person", label: t("aiSafety.card.byPerson") },
          ]}
        />
        <InfoTip text={t("aiSafety.card.lead")} label={t("aiSafety.card.title")} align="right" />
      </PanelHead>
      {/* One list at a time; the rows carry numbers only and the three words stand once, as column heads. */}
      {view === "dept" ? (
        <ul className="divide-hairline m-0 grid list-none divide-y p-0" aria-label={t("aiSafety.card.byDept")}>
          {head(t("aiSafety.card.byDept"))}
          {s.departments.map((d) => (
            <li key={d.department ?? ""} className={cx(cols, "py-1.5 text-sm")}>
              <span className="truncate">{d.department ?? t("follow.deptNone")}</span>
              {cells(d)}
            </li>
          ))}
        </ul>
      ) : (
        <ul className="divide-hairline m-0 grid list-none divide-y p-0" aria-label={t("aiSafety.card.byPerson")}>
          {head(t("aiSafety.card.byPerson"))}
          {s.people.slice(0, 8).map((p) => (
            <li key={p.userId} className={cx(cols, "py-1.5 text-sm")}>
              <span className="truncate">{p.name || "—"}</span>
              {cells(p)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
