"use client";

import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/client";
import { useFormat, useT } from "@/lib/i18n/client";
import { Avatar } from "@/lib/people";
import { cx } from "@/lib/ui";
import { UsersIcon } from "@/components/app/icons";
import { LoadFailed } from "@/components/ui/LoadFailed";

export interface TeamTodayMember {
  userId: string;
  displayName: string;
  title: string | null;
  departmentId: string | null;
  department: string | null;
  checkIn: string | null;
  checkOut: string | null;
  lateMinutes: number | null;
  missedCheckout: boolean;
  missedYesterday: boolean;
  onLeave: boolean;
}
export interface TeamTodayData {
  day: string;
  workingDay: boolean;
  members: TeamTodayMember[];
  departments: { id: string; name: string }[];
  scope: "team" | "company" | "none";
}

type State = "in" | "late" | "left" | "leave" | "missed" | "notIn" | "off";
/** Rows shown before "Show all": a company list is long, the worst come first. */
const ROWS = 12;

/** One state per person today, the one a manager acts on first: a missed check-out, then late, leave, in, gone, not in. */
export function stateOf(m: TeamTodayMember, workingDay = true): State {
  if (m.onLeave) return "leave";
  if (m.missedCheckout || (!m.checkIn && m.missedYesterday)) return "missed";
  // A weekend or holiday: not clocking in is the day off, not someone missing.
  if (!m.checkIn) return workingDay ? "notIn" : "off";
  if (m.checkOut) return "left";
  return (m.lateMinutes ?? 0) > 0 ? "late" : "in";
}
const ORDER: State[] = ["missed", "late", "notIn", "in", "left", "leave", "off"];
const TONE: Record<State, string> = {
  in: "bg-ok-wash text-ok",
  late: "bg-warn-wash text-warn",
  left: "bg-ink/[0.06] text-ink-soft",
  leave: "bg-accent-wash text-accent-text",
  missed: "bg-block-wash text-block",
  notIn: "bg-ink/[0.06] text-ink-2",
  off: "bg-ink/[0.04] text-ink-2",
};

/**
 * Team today (Chấm công, for managers and HR): who is in, late, on leave, who missed yesterday's check-out and who is
 * not in yet, worst first. HR sees the company and can narrow it to one department.
 */
export function TeamToday({ initial }: { initial: TeamTodayData }) {
  const t = useT();
  const { time } = useFormat();
  const [data, setData] = useState(initial);
  const [dept, setDept] = useState("");
  const [failed, setFailed] = useState(false);
  const [all, setAll] = useState(false);
  const st = (m: TeamTodayMember) => stateOf(m, data.workingDay);
  const pick = (id: string) => {
    setDept(id);
    setFailed(false);
    api<TeamTodayData>(`employee/attendance/team${id ? `?department=${encodeURIComponent(id)}` : ""}`).then(setData, () => setFailed(true));
  };
  const counts = ORDER.map((s) => ({ s, n: data.members.filter((m) => st(m) === s).length }));
  const sorted = [...data.members].sort((a, b) => ORDER.indexOf(st(a)) - ORDER.indexOf(st(b)) || a.displayName.localeCompare(b.displayName));
  const rows = all ? sorted : sorted.slice(0, ROWS);
  return (
    <section id="team" aria-labelledby="team-today-h" className="scroll-mt-20">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 id="team-today-h" className="m-0 flex items-center gap-2 text-base font-semibold">
          <UsersIcon className="text-ink-2 size-4" />
          {t(data.scope === "company" ? "teamToday.titleCompany" : "teamToday.title")}
        </h2>
        {data.scope === "company" && data.departments.length ? (
          <label className="text-ink-2 flex items-center gap-2 text-sm">
            <span className="sr-only">{t("teamToday.department")}</span>
            <select id="team-today-dept" value={dept} onChange={(e) => pick(e.target.value)} className="border-hairline bg-surface text-ink h-8 rounded-lg border px-2 text-sm">
              <option value="">{t("teamToday.allDepartments")}</option>
              {data.departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      {!data.workingDay ? <p className="text-ink-2 m-0 mb-3 text-sm">{t("teamToday.dayOff")}</p> : null}
      {failed ? (
        <LoadFailed />
      ) : (
        <>
          <ul className="m-0 mb-3 flex list-none flex-wrap gap-1.5 p-0" aria-label={t("teamToday.summary")}>
            {counts
              .filter((c) => c.n > 0)
              .map((c) => (
                <li key={c.s} className={cx("inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[13px] font-medium", TONE[c.s])}>
                  <b className="tabular-nums">{c.n}</b> {t(`teamToday.state.${c.s}`)}
                </li>
              ))}
          </ul>
          {rows.length === 0 ? (
            <p className="text-ink-2 m-0 text-sm">{t("teamToday.empty")}</p>
          ) : (
            <ul className="divide-divider-soft border-hairline bg-surface m-0 list-none divide-y rounded-xl border p-0">
              {rows.map((m) => {
                const s = st(m);
                return (
                  <li key={m.userId} className="flex min-w-0 items-center gap-3 px-4 py-2.5 max-sm:px-3">
                    <Avatar id={m.userId} name={m.displayName} size="sm" />
                    <span className="min-w-0 flex-1">
                      <Link href={`/app/work/people/${m.userId}`} className="text-ink block truncate text-sm font-medium no-underline hover:underline">
                        {m.displayName}
                      </Link>
                      <span className="text-ink-2 block truncate text-xs">{[m.title, m.department].filter(Boolean).join(" · ")}</span>
                    </span>
                    <span className="text-ink-2 shrink-0 text-xs tabular-nums max-sm:hidden">
                      {m.checkIn ? (m.checkOut && !m.missedCheckout ? `${time(m.checkIn)}–${time(m.checkOut)}` : time(m.checkIn)) : null}
                    </span>
                    <span className={cx("inline-flex h-6 shrink-0 items-center whitespace-nowrap rounded-md px-2 text-xs font-medium", TONE[s])}>
                      {s === "late" ? t("teamToday.lateBy", { count: m.lateMinutes ?? 0 }) : t(`teamToday.state.${s}`)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {sorted.length > ROWS ? (
            <button type="button" className="text-ink-2 hover:text-ink mt-2 text-sm font-medium" onClick={() => setAll((x) => !x)}>
              {all ? t("teamToday.showFewer") : t("teamToday.showAll", { count: sorted.length })}
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}
