"use client";

import { dateFormat } from "@/lib/intl";
import { useState } from "react";
import { useFormat, useLocale, useT } from "@/lib/i18n/client";
import { INTL_TAG } from "@/lib/i18n/config";
import { cx } from "@/lib/ui";
import { isAllDay, addDays, at, calendarZone, parts } from "./calTime";
import type { CalEvent } from "./types";
import { toneOf } from "./calTone";

const SHOW = 3;

/**
 * Month view like Google Calendar: six weeks from the Monday before the 1st. Your own events drag to
 * another day (keeping their time); a day's number opens that week; empty space creates an event.
 */
export function MonthGrid({
  events,
  start,
  month,
  me,
  onMove,
  onSlot,
  onOpenDay,
  onOpen,
}: {
  events: CalEvent[];
  /** Day key of the top-left cell. */
  start: string;
  /** "YYYY-MM" of the month shown, to dim the days around it. */
  month: string;
  me: string;
  onMove: (e: CalEvent, startsAt: Date, endsAt: Date) => void;
  onSlot: (startsAt: Date) => void;
  onOpenDay: (key: string) => void;
  /** A click on any entry: open it. */
  onOpen: (e: CalEvent) => void;
}) {
  const tag = INTL_TAG[useLocale()];
  const WEEKDAY = dateFormat(tag, { timeZone: calendarZone(), weekday: "short" });
  const { time } = useFormat();
  const t = useT();
  const [over, setOver] = useState<string | null>(null);
  const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  const todayKey = parts(new Date()).key;
  const byDay = new Map<string, CalEvent[]>();
  for (const e of [...events].sort((a, b) => a.startsAt.localeCompare(b.startsAt))) {
    const k = parts(e.startsAt).key;
    byDay.set(k, [...(byDay.get(k) ?? []), e]);
  }
  const drop = (key: string, id: string) => {
    const e = events.find((x) => x.id === id);
    if (!e || e.organizerId !== me) return;
    const from = parts(e.startsAt);
    if (from.key === key) return;
    const len = Date.parse(e.endsAt) - Date.parse(e.startsAt);
    const s = at(key, from.minutes);
    onMove(e, s, new Date(s.getTime() + len));
  };
  return (
    <div className="bg-surface shadow-card overflow-hidden rounded-xl">
      <div className="border-hairline grid grid-cols-7 border-b">
        {days.slice(0, 7).map((k) => (
          <p key={k} className="text-ink-2 m-0 px-2 py-1.5 text-center text-xs capitalize">
            {WEEKDAY.format(at(k, 12 * 60))}
          </p>
        ))}
      </div>
      <div className="grid grid-cols-[repeat(7,minmax(0,1fr))] grid-rows-6">
        {days.map((k) => {
          const evs = byDay.get(k) ?? [];
          const inMonth = k.startsWith(month);
          return (
            <div
              key={k}
              onClick={(ev) => {
                if (ev.target === ev.currentTarget) onSlot(at(k, 9 * 60));
              }}
              onDragOver={(ev) => {
                ev.preventDefault();
                setOver(k);
              }}
              onDragLeave={() => setOver((o) => (o === k ? null : o))}
              onDrop={(ev) => {
                ev.preventDefault();
                setOver(null);
                drop(k, ev.dataTransfer.getData("text/x-event"));
              }}
              className={cx(
                "border-hairline min-h-[112px] min-w-0 cursor-cell border-b border-l p-1 first:border-l-0 [&:nth-child(7n+1)]:border-l-0",
                !inMonth
                  ? "bg-ground/60"
                  : (() => {
                      const wd = new Date(`${k}T12:00:00Z`).getUTCDay();
                      return wd === 0 || wd === 6 ? "bg-hover/40" : null;
                    })(),
                over === k && "bg-hover",
              )}
            >
              <button
                type="button"
                onClick={() => onOpenDay(k)}
                className={cx(
                  "mb-0.5 grid h-6 min-w-6 place-items-center rounded-full px-1.5 text-xs font-semibold tabular-nums",
                  k === todayKey ? "bg-accent text-on-brand" : inMonth ? "text-ink hover:bg-hover" : "text-ink-2 hover:bg-hover",
                )}
                aria-label={t("work.monthgrid.openWeek", { day: k.slice(8).replace(/^0/, "") })}
              >
                {Number(k.slice(8))}
              </button>
              <ul className="m-0 grid list-none gap-0.5 p-0">
                {evs.slice(0, SHOW).map((e) => (
                  <li key={e.id} className="min-w-0">
                    <button
                      type="button"
                      draggable={e.organizerId === me}
                      onDragStart={(ev) => {
                        ev.dataTransfer.setData("text/x-event", e.id);
                        ev.dataTransfer.effectAllowed = "move";
                      }}
                      onClick={() => onOpen(e)}
                      aria-haspopup="dialog"
                      title={e.title}
                      className={cx(
                        "hover:bg-hover flex min-h-6 w-full min-w-0 items-center gap-1.5 overflow-hidden rounded-md px-1.5 py-0.5 text-left text-xs transition-colors",
                        e.response === "declined" && "text-ink-2 line-through",
                        e.organizerId === me ? "cursor-grab" : "cursor-pointer",
                      )}
                    >
                      <span
                        className={cx(
                          "size-2 shrink-0 rounded-full",
                          e.response === "pending" ? "border-ink-2 border border-dashed" : e.response === "declined" ? "bg-edge" : toneOf(e).dot,
                        )}
                        aria-hidden="true"
                      />
                      {isAllDay(e) ? null : <span className="text-ink-2 text-xs tabular-nums">{time(e.startsAt)}</span>}
                      <span className="min-w-0 truncate font-medium">{e.title}</span>
                    </button>
                  </li>
                ))}
                {evs.length > SHOW ? (
                  <li>
                    <button type="button" onClick={() => onOpenDay(k)} className="text-ink-2 hover:text-ink min-h-6 px-1 text-xs font-medium">
                      {t("work.monthgrid.more", { count: evs.length - SHOW })}
                    </button>
                  </li>
                ) : null}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}
