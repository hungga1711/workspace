"use client";

import { dateFormat } from "@/lib/intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { useFormat, useLocale } from "@/lib/i18n/client";
import { INTL_TAG } from "@/lib/i18n/config";
import { weekdayDate } from "@/lib/format";
import { btn, btnSm, cx } from "@/lib/ui";
import { KpiStrip } from "@/components/ui/KpiStrip";
import { IconTile } from "@/components/ui/Bento";
import { BellIcon, CalendarIcon, ClockIcon, FlagIcon } from "@/components/app/icons";
import { addDays, calendarWeeks, leaveDays, level, monthStarts } from "./attendanceGrid";

export interface AttendanceDay {
  day: string;
  checkIn: string;
  checkOut: string | null;
  lateMinutes?: number;
  source?: string;
  correctionNote?: string | null;
  /** Closed by the server as a forgotten check-out (no hours); shown as "no check-out" until corrected. */
  missedCheckout?: boolean;
}

const hours = (d: AttendanceDay) => (d.checkOut ? (Date.parse(d.checkOut) - Date.parse(d.checkIn)) / 3600_000 : 0);
/** Shades of the accent by hours worked (level 1–4); level 0 is an empty cell. */
const SHADE = ["bg-hover", "bg-accent/25", "bg-accent/50", "bg-accent/75", "bg-accent"] as const;
const CELL = "size-[13px] rounded-[3px]";
/** A cell of the year grid: as wide as its column, so the year fills the card instead of leaving half of it blank. */
const DAY = "aspect-square w-full rounded-[3px]";

/**
 * Của tôi › Chấm công & nghỉ: a year of attendance as a grid (a column per week, Monday at the top),
 * shaded by hours worked; days without a check-out and leave days stand out. Choosing a day (click, or the arrow
 * keys once the grid has focus) shows its times below. The last 30 days are summed above the grid.
 */
export function AttendanceHistory({
  days,
  today,
  leaves,
  onFix,
  fixFrom,
}: {
  days: AttendanceDay[];
  today: string;
  leaves: { startDate: string; endDate: string }[];
  /** "Đề nghị sửa" on the chosen day: ask the manager to fix (or add) its times. */
  onFix?: (day: string) => void;
  /** The oldest day a fix can still be asked for. */
  fixFrom?: string;
}) {
  const { t, time } = useFormat();
  const locale = useLocale();
  const byDay = useMemo(() => new Map(days.map((d) => [d.day, d])), [days]);
  const onLeave = useMemo(() => leaveDays(leaves), [leaves]);
  const weeks = useMemo(() => calendarWeeks(today), [today]);
  const months = useMemo(() => monthStarts(weeks, today), [weeks, today]);
  // Opens on the latest forgotten check-out that can still be fixed, so "Request a fix" starts on that day.
  const [selected, setSelected] = useState(() => {
    const missed = days.filter((d) => d.missedCheckout && (!fixFrom || d.day >= fixFrom)).map((d) => d.day);
    return missed.length ? missed.sort().at(-1)! : today;
  });
  const scroller = useRef<HTMLDivElement>(null);
  const cells = useRef(new Map<string, HTMLButtonElement>());

  // Narrow screens show the most recent weeks first; older ones scroll in from the left.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, []);

  const tag = INTL_TAG[locale];
  // Vietnamese short months are "Tháng 12": too wide for a four-week column, so the label is "T12" there.
  const monthName = (ym: string) => (locale === "vi" ? `T${Number(ym.slice(5, 7))}` : dateFormat(tag, { month: "short", timeZone: "UTC" }).format(new Date(`${ym}-01T00:00:00Z`)));
  const weekdayName = (d: string) => dateFormat(tag, { weekday: "short", timeZone: "UTC" }).format(new Date(`${d}T00:00:00Z`));
  const longDate = (d: string) => weekdayDate(dateFormat(tag, { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }), new Date(`${d}T00:00:00Z`));

  const forgot = (d: AttendanceDay | undefined, day: string) => !!d && !d.checkOut && day < today;
  const describe = (day: string) => {
    const d = byDay.get(day);
    if (d) {
      const span = `${time(d.checkIn)} – ${d.checkOut ? time(d.checkOut) : t("me.history.noCheckOut")}`;
      return d.checkOut ? `${span} · ${t("me.history.hours", { h: hours(d).toFixed(1) })}` : span;
    }
    if (onLeave.has(day)) return t("me.meview.nghi_phep");
    return t("me.history.noRecord");
  };

  const recent = days.filter((d) => d.day > addDays(today, -30));
  const worked = recent.filter((d) => d.checkOut);
  const avg = worked.length ? worked.reduce((n, d) => n + hours(d), 0) / worked.length : 0;
  const forgotten = recent.filter((d) => forgot(d, d.day)).length;

  const move = (delta: number) => {
    const next = addDays(selected, delta);
    if (next > today || next < weeks[0]![0]!) return;
    setSelected(next);
    cells.current.get(next)?.focus();
  };
  const sel = byDay.get(selected);

  return (
    <section aria-labelledby="hist-h" className="grid min-w-0 gap-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <IconTile tone="sky">
          <CalendarIcon />
        </IconTile>
        <h2 id="hist-h" className="m-0 text-sm font-semibold tracking-[-0.01em]">
          {t("me.history.title")}
        </h2>
        <span className="text-ink-2 text-[13px]">{t("me.history.range")}</span>
      </div>

      <KpiStrip
        keepZeros
        label={t("me.history.last30")}
        items={[
          { label: t("me.history.daysWorked"), icon: <CalendarIcon />, hue: "blue" as const, value: recent.length },
          { label: t("me.history.avgHours"), icon: <ClockIcon />, hue: "teal" as const, value: Number(avg.toFixed(1)), format: (n) => n.toFixed(1) },
          {
            label: t("me.history.late"),
            icon: <FlagIcon />,
            value: recent.filter((d) => (d.lateMinutes ?? 0) > 0).length,
            tone: recent.some((d) => (d.lateMinutes ?? 0) > 0) ? "warn" : "default",
          },
          { label: t("me.meview.quen_cham_cong_ra"), icon: <BellIcon />, value: forgotten, tone: forgotten ? "warn" : "default", info: t("me.meview.nho_hr_sua") },
        ]}
      />

      <div className="bg-surface shadow-card min-w-0 rounded-xl p-5 max-sm:p-4">
        <div ref={scroller} className="-mx-1 overflow-x-auto px-1 pb-1 pt-0.5">
          <div className="grid min-w-[54rem] grid-cols-[auto_minmax(0,1fr)] gap-x-2">
            <span />
            {/* Month names over the column where each month starts. */}
            <div className="relative h-5" aria-hidden="true">
              {months.map((m) => (
                <span key={m.month} className="text-ink-2 absolute top-0 text-xs" style={{ left: `${(m.column / weeks.length) * 100}%` }}>
                  {monthName(m.month)}
                </span>
              ))}
            </div>
            <div className="grid grid-rows-[repeat(7,minmax(0,1fr))] gap-[3px]" aria-hidden="true">
              {weeks[0]!.map((d, i) => (
                <span key={d} className="text-ink-2 flex min-h-0 items-center whitespace-nowrap text-xs/none">
                  {i % 2 === 0 ? weekdayName(d) : ""}
                </span>
              ))}
            </div>
            <div
              role="group"
              aria-label={t("me.history.gridLabel")}
              className="grid auto-cols-fr grid-flow-col grid-rows-[repeat(7,auto)] gap-[3px]"
              onKeyDown={(e) => {
                const delta = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 }[e.key];
                if (delta === undefined) return;
                e.preventDefault();
                move(delta);
              }}
            >
              {weeks.flat().map((day) => {
                if (day > today) return <span key={day} className={DAY} aria-hidden="true" />;
                const d = byDay.get(day);
                const tone = forgot(d, day) ? "bg-warn" : d ? SHADE[level(hours(d))] : onLeave.has(day) ? "bg-violet/45" : SHADE[0];
                return (
                  <button
                    key={day}
                    ref={(el) => {
                      if (el) cells.current.set(day, el);
                      else cells.current.delete(day);
                    }}
                    type="button"
                    tabIndex={day === selected ? 0 : -1}
                    aria-label={`${longDate(day)}: ${describe(day)}`}
                    aria-pressed={day === selected}
                    title={`${longDate(day)}\n${describe(day)}`}
                    onClick={() => setSelected(day)}
                    className={cx(
                      DAY,
                      tone,
                      "hover:ring-ink/30 hover:ring-1",
                      day === today && "ring-ink/40 ring-1",
                      day === selected && "ring-ink outline-none ring-2 ring-offset-1",
                      "focus-visible:ring-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1",
                    )}
                  />
                );
              })}
            </div>
          </div>
        </div>

        <div className="text-ink-2 mt-3 flex flex-wrap items-center justify-end gap-x-4 gap-y-2 text-xs">
          <span className="flex items-center gap-1">
            {t("me.history.less")}
            {SHADE.map((s) => (
              <span key={s} className={cx(CELL, s)} aria-hidden="true" />
            ))}
            {t("me.history.more")}
          </span>
          <span className="flex items-center gap-1.5">
            <span className={cx(CELL, "bg-warn")} aria-hidden="true" />
            {t("me.meview.quen_cham_cong_ra")}
          </span>
          <span className="flex items-center gap-1.5">
            <span className={cx(CELL, "bg-violet/45")} aria-hidden="true" />
            {t("me.meview.nghi_phep")}
          </span>
        </div>

        {/* The chosen day, in words: what the grid only shows as a shade. */}
        <div className="border-divider mt-4 grid gap-1 border-t pt-4" aria-live="polite">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="m-0 text-sm font-semibold first-letter:uppercase">{longDate(selected)}</p>
            {onFix && (!fixFrom || selected >= fixFrom) ? (
              <button type="button" className={cx(btn, btnSm)} onClick={() => onFix(selected)}>
                {t("me.attendancefix.de_nghi_sua")}
              </button>
            ) : null}
          </div>
          {sel ? (
            <dl className="m-0 flex flex-wrap gap-x-6 gap-y-1 text-sm">
              <div className="flex gap-1.5">
                <dt className="text-ink-2">{t("me.meview.vao")}</dt>
                <dd className="m-0 tabular-nums">{time(sel.checkIn)}</dd>
              </div>
              <div className="flex gap-1.5">
                <dt className="text-ink-2">{t("me.history.out")}</dt>
                <dd className={cx("m-0 tabular-nums", forgot(sel, selected) && "text-warn")}>{sel.checkOut ? time(sel.checkOut) : t("me.history.noCheckOut")}</dd>
              </div>
              {sel.checkOut ? (
                <div className="flex gap-1.5">
                  <dt className="text-ink-2">{t("me.meview.so_gio")}</dt>
                  <dd className="m-0 tabular-nums">{hours(sel).toFixed(1)}</dd>
                </div>
              ) : null}
              {sel.lateMinutes ? <dd className="text-warn m-0">{t("me.attendancefix.di_muon", { p0: sel.lateMinutes })}</dd> : null}
              {sel.source === "admin" ? (
                <dd className="text-ink-2 m-0" title={sel.correctionNote ?? undefined}>
                  {t("me.meview.hr_da_sua")}
                </dd>
              ) : null}
            </dl>
          ) : (
            <p className="text-ink-2 m-0 text-sm">{describe(selected)}</p>
          )}
        </div>
      </div>
    </section>
  );
}
