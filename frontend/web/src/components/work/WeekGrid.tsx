"use client";

import { dateFormat } from "@/lib/intl";
import { useLocale, useT, useFormat } from "@/lib/i18n/client";
import { INTL_TAG } from "@/lib/i18n/config";
import { useEffect, useRef, useState } from "react";
import { cx } from "@/lib/ui";
import { addDays, at, calendarZone, isAllDay, parts } from "./calTime";
import type { CalEvent } from "./types";
import { toneOf } from "./calTone";
import { dayMonthOptions } from "@/lib/format";

const HOUR = 48; // px per hour
const SNAP = 15; // minutes

type Drag = { id: string; mode: "move" | "resize"; x0: number; y0: number; day0: number; s0: number; e0: number; day: number; s: number; e: number; moved: boolean };

/**
 * Week view like Google Calendar: day columns on an hour grid with a now-line. Your own events drag to
 * another day or time (15-minute steps) and resize from the bottom edge; clicking empty time creates one.
 */
export function WeekGrid({
  events,
  start,
  me,
  onMove,
  onSlot,
  onOpen,
}: {
  events: CalEvent[];
  /** Day key (YYYY-MM-DD) of the first column. */
  start: string;
  me: string;
  onMove: (e: CalEvent, startsAt: Date, endsAt: Date) => void;
  onSlot: (startsAt: Date) => void;
  /** A click on any entry (anyone's, any kind): open it. */
  onOpen: (e: CalEvent) => void;
}) {
  const tag = INTL_TAG[useLocale()];
  const WEEKDAY = dateFormat(tag, { timeZone: calendarZone(), weekday: "short" });
  const DAYNUM = dateFormat(tag, { timeZone: calendarZone(), ...dayMonthOptions(tag) });
  const { time } = useFormat();
  const tx = useT();
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const scroller = useRef<HTMLDivElement>(null);
  // The hour grid scrolls by itself, so it must end where the panel ends: a fixed calc() guessed the height above it
  // (tabs, toolbar, the all-day row) and let the page scroll as well, two scrollbars for one calendar. Measure instead.
  const [gridH, setGridH] = useState<number | null>(null);
  useEffect(() => {
    let frame = 0;
    const fit = () => {
      const el = scroller.current;
      if (!el || window.innerWidth < 768) return setGridH(null);
      // First guess from the space left under the grid (the page column's bottom padding, the ground and edges),
      // then take off whatever still makes the page scroll once laid out: the shell's min-heights differ by screen.
      const first = Math.max(300, Math.floor(window.innerHeight - el.getBoundingClientRect().top - window.scrollY - 64));
      setGridH(first);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const over = document.documentElement.scrollHeight - window.innerHeight;
        if (over > 0) setGridH(Math.max(300, first - over));
      });
    };
    fit();
    window.addEventListener("resize", fit);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", fit);
    };
  }, []);
  const wide = useRef<HTMLDivElement>(null);
  const cols = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => Date.now());
  const [drag, setDrag] = useState<Drag | null>(null);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  // Whole-day events sit in their own row above the hours; the grid holds timed ones.
  const timed = events.filter((e) => !isAllDay(e));
  const allDay = events.filter(isAllDay);
  // Day keys compare as text; the last covered day is the one the final millisecond falls on.
  const covers = (e: CalEvent, k: string) => parts(e.startsAt).key <= k && k <= parts(new Date(Date.parse(e.endsAt) - 1)).key;
  // Open at 08:00, or earlier if this week has an earlier event, so the first meeting is never scrolled out of
  // sight (opening "around now" hid tomorrow's 10:00 at midday). Placed once per week, after its events arrive.
  const first = Math.min(...timed.filter((e) => days.includes(parts(e.startsAt).key)).map((e) => parts(e.startsAt).minutes));
  const placed = useRef<string | null>(null);
  useEffect(() => {
    const el = scroller.current;
    // Wait for the measured height on desktop: before it the grid is not a scroll box yet and scrollTop is lost.
    if (!el || placed.current === start || (gridH === null && window.innerWidth >= 768)) return;
    if (Number.isFinite(first)) placed.current = start;
    const from = Math.min(8 * 60, Number.isFinite(first) ? first : Infinity) - 30;
    el.scrollTop = Math.max(0, (from / 60) * HOUR);
  }, [start, first, gridH]);
  // On a narrow screen only a few days fit: bring today's column into view.
  useEffect(() => {
    const el = wide.current;
    const i = days.indexOf(parts(new Date()).key);
    if (el && i > 0 && el.scrollWidth > el.clientWidth) el.scrollLeft = i * colWidth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start]);
  const today = parts(new Date(now));
  const colWidth = () => (cols.current ? cols.current.getBoundingClientRect().width / 7 : 100);
  const snap = (m: number) => Math.round(m / SNAP) * SNAP;

  const down = (ev: React.PointerEvent, e: CalEvent, mode: Drag["mode"]) => {
    if (e.organizerId !== me || ev.button !== 0) return;
    ev.stopPropagation();
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    const p = parts(e.startsAt);
    const s0 = p.minutes;
    const e0 = s0 + Math.round((Date.parse(e.endsAt) - Date.parse(e.startsAt)) / 60_000);
    const day0 = days.indexOf(p.key);
    setDrag({ id: e.id, mode, x0: ev.clientX, y0: ev.clientY, day0, s0, e0, day: day0, s: s0, e: e0, moved: false });
  };
  const move = (ev: React.PointerEvent) => {
    if (!drag) return;
    const dx = ev.clientX - drag.x0;
    const dy = ev.clientY - drag.y0;
    const moved = drag.moved || Math.abs(dx) > 4 || Math.abs(dy) > 4;
    const delta = snap((dy / HOUR) * 60);
    if (drag.mode === "resize") {
      setDrag({ ...drag, moved, e: Math.min(24 * 60, Math.max(drag.s0 + SNAP, drag.e0 + delta)) });
      return;
    }
    const len = drag.e0 - drag.s0;
    const s = Math.min(24 * 60 - len, Math.max(0, drag.s0 + delta));
    const day = Math.min(6, Math.max(0, drag.day0 + Math.round(dx / colWidth())));
    setDrag({ ...drag, moved, day, s, e: s + len });
  };
  // A drag ends in a click too: that click must not open the card.
  const justDragged = useRef(false);
  const up = (e: CalEvent) => {
    const d = drag;
    setDrag(null);
    if (!d || !d.moved) return;
    justDragged.current = true;
    if (d.day === d.day0 && d.s === d.s0 && d.e === d.e0) return;
    const key = days[d.day]!;
    onMove(e, at(key, d.s), at(key, d.e));
  };
  const slot = (ev: React.MouseEvent<HTMLDivElement>, key: string) => {
    if (ev.target !== ev.currentTarget) return;
    const y = ev.clientY - ev.currentTarget.getBoundingClientRect().top;
    onSlot(at(key, Math.floor(((y / HOUR) * 60) / 30) * 30));
  };

  return (
    <div className="bg-surface shadow-card overflow-hidden rounded-xl">
      <div ref={wide} className="overflow-x-auto">
        {/* 640px: the week fits an iPad held upright (≈680px of content); narrower screens scroll to today. */}
        <div className="min-w-[640px]">
          <div className="border-hairline grid grid-cols-[52px_repeat(7,minmax(0,1fr))] border-b">
            <span />
            {days.map((k) => (
              <div key={k} className={cx("border-hairline border-l px-2 py-1.5 text-center", weekend(k) && "bg-hover/40")}>
                <p className="text-ink-2 text-xs capitalize">{WEEKDAY.format(at(k, 12 * 60))}</p>
                <p
                  className={cx(
                    "mx-auto mt-0.5 inline-grid h-7 min-w-7 place-items-center rounded-full px-2 text-sm font-semibold tabular-nums",
                    k === today.key ? "bg-accent text-on-brand" : weekend(k) ? "text-ink-2" : "text-ink",
                  )}
                >
                  {DAYNUM.format(at(k, 12 * 60))}
                </p>
              </div>
            ))}
          </div>
          {allDay.some((e) => days.some((k) => covers(e, k))) ? (
            <div className="border-hairline grid grid-cols-[52px_repeat(7,minmax(0,1fr))] border-b">
              <span className="text-ink-2 self-center pr-2 text-right text-xs">{tx("work.weekgrid.allDay")}</span>
              {days.map((k) => (
                <div key={k} className={cx("border-hairline grid content-start gap-1 border-l p-1", weekend(k) && "bg-hover/40")}>
                  {allDay
                    .filter((e) => covers(e, k))
                    .map((e) => (
                      <button
                        type="button"
                        key={e.id}
                        title={e.title}
                        onClick={() => onOpen(e)}
                        className={cx(
                          "text-ink block w-full truncate rounded-sm border-l-[3px] px-1.5 py-0.5 text-left text-xs font-medium transition-[filter] hover:brightness-[0.97]",
                          e.response === "declined" ? "border-l-edge bg-ground text-ink-2 line-through" : toneOf(e).block,
                        )}
                      >
                        {e.title}
                      </button>
                    ))}
                </div>
              ))}
            </div>
          ) : null}
          <div
            ref={scroller}
            className="min-h-[300px] overflow-y-auto max-md:max-h-[calc(100dvh-260px)]"
            style={gridH ? { height: gridH } : undefined}
            tabIndex={0}
            role="region"
            aria-label={tx("work.weekgrid.hours")}
          >
            <div className="relative grid grid-cols-[52px_minmax(0,1fr)]" style={{ height: 24 * HOUR }}>
              <div className="relative">
                {Array.from({ length: 24 }, (_, h) => (
                  <span key={h} className="text-ink-2 absolute right-2 -translate-y-1/2 text-xs tabular-nums" style={{ top: h * HOUR }}>
                    {h ? `${String(h).padStart(2, "0")}:00` : ""}
                  </span>
                ))}
              </div>
              <div ref={cols} className="grid grid-cols-7">
                {days.map((k, di) => {
                  const evs = timed.filter((e) => parts(e.startsAt).key === k).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
                  // Overlaps share the column width.
                  const lanes: string[][] = [];
                  const lane = new Map<string, number>();
                  for (const e of evs) {
                    let i = lanes.findIndex((l) => l.every((id) => evs.find((x) => x.id === id)!.endsAt <= e.startsAt));
                    if (i === -1) {
                      lanes.push([]);
                      i = lanes.length - 1;
                    }
                    lanes[i]!.push(e.id);
                    lane.set(e.id, i);
                  }
                  const dragged = drag && drag.day === di ? events.find((x) => x.id === drag.id) : undefined;
                  return (
                    <div
                      key={k}
                      className={cx("border-hairline hover:bg-hover/30 relative cursor-cell border-l", weekend(k) && "bg-hover/40")}
                      onClick={(ev) => slot(ev, k)}
                      role="group"
                      aria-label={tx("work.weekgrid.ngay", { p0: DAYNUM.format(at(k, 12 * 60)) })}
                    >
                      {Array.from({ length: 24 }, (_, h) => (
                        <span key={h} className="border-hairline/70 pointer-events-none absolute inset-x-0 border-t" style={{ top: h * HOUR }} aria-hidden="true" />
                      ))}
                      {k === today.key ? (
                        <span
                          className="border-accent pointer-events-none absolute inset-x-0 z-10 border-t-2"
                          style={{ top: (today.minutes / 60) * HOUR }}
                          role="img"
                          aria-label={tx("work.weekgrid.bay_gio", { p0: time(new Date(now)) })}
                        >
                          <span className="bg-accent absolute -left-[5px] -top-[5px] size-2 rounded-full" />
                        </span>
                      ) : null}
                      {evs.map((e) => {
                        const s = parts(e.startsAt).minutes;
                        const end = parts(e.endsAt);
                        const en = end.key === k ? Math.max(end.minutes, s + 20) : 24 * 60;
                        return (
                          <EventBlock
                            key={e.id}
                            e={e}
                            top={(s / 60) * HOUR + 1}
                            height={Math.max(((en - s) / 60) * HOUR - 2, 22)}
                            left={`calc(${(lane.get(e.id)! / lanes.length) * 100}% + 2px)`}
                            width={`calc(${100 / lanes.length}% - 4px)`}
                            label={`${time(e.startsAt)}–${time(e.endsAt)}`}
                            mine={e.organizerId === me}
                            ghost={drag?.id === e.id && drag.moved}
                            onDown={down}
                            onMove={move}
                            onUp={up}
                            onOpen={() => {
                              if (justDragged.current) {
                                justDragged.current = false;
                                return;
                              }
                              onOpen(e);
                            }}
                          />
                        );
                      })}
                      {dragged && drag?.moved ? (
                        // Where it will land; the original keeps the pointer until it is dropped.
                        <div
                          aria-hidden="true"
                          className="bg-accent-wash border-accent/50 shadow-soft pointer-events-none absolute z-20 overflow-hidden rounded-md border px-1.5 py-1 text-xs"
                          style={{ top: (drag.s / 60) * HOUR + 1, height: Math.max(((drag.e - drag.s) / 60) * HOUR - 2, 22), left: 2, right: 2 }}
                        >
                          <span className="block truncate font-semibold">{dragged.title}</span>
                          <span className="block truncate text-xs">
                            {time(at(k, drag.s))}–{time(at(k, drag.e))}
                          </span>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function EventBlock({
  e,
  top,
  height,
  left,
  width,
  label,
  mine,
  ghost = false,
  onDown,
  onMove,
  onUp,
  onOpen,
}: {
  e: CalEvent;
  top: number;
  height: number;
  left: string;
  width: string;
  label: string;
  mine: boolean;
  ghost?: boolean;
  onDown: (ev: React.PointerEvent, e: CalEvent, mode: "move" | "resize") => void;
  onMove: (ev: React.PointerEvent) => void;
  onUp: (e: CalEvent) => void;
  onOpen: () => void;
}) {
  const declined = e.response === "declined";
  return (
    <div
      role="button"
      tabIndex={0}
      aria-haspopup="dialog"
      title={e.title}
      onPointerDown={(ev) => onDown(ev, e, "move")}
      onPointerMove={onMove}
      onPointerUp={() => onUp(e)}
      onClick={(ev) => {
        ev.stopPropagation();
        onOpen();
      }}
      onKeyDown={(ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          onOpen();
        }
      }}
      className={cx(
        "absolute touch-none select-none overflow-hidden rounded-md border-l-[3px] px-1.5 py-1 text-xs shadow-[0_0_0_1px_var(--surface)] transition-[filter] hover:brightness-[0.97]",
        mine ? "cursor-grab" : "cursor-pointer",
        ghost && "cursor-grabbing opacity-40",
        declined
          ? "border-l-edge bg-ground text-ink-2"
          : e.response === "pending"
            ? cx(toneOf(e).block, "text-ink-soft outline-ink-2/40 outline-dashed outline-1 -outline-offset-1")
            : cx(toneOf(e).block, "text-ink"),
      )}
      style={{ top, height, left, width }}
    >
      <span className={cx("block truncate font-medium", declined && "line-through")}>{e.title}</span>
      <span className="block truncate text-xs opacity-80">
        {label}
        {e.location ? ` · ${e.location}` : ""}
      </span>
      {mine ? <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-1.5 cursor-ns-resize" onPointerDown={(ev) => onDown(ev, e, "resize")} /> : null}
    </div>
  );
}

/** Saturday or Sunday (a "YYYY-MM-DD" day key): muted, as most companies here work Monday to Friday. */
const weekend = (k: string) => {
  const d = new Date(`${k}T12:00:00Z`).getUTCDay();
  return d === 0 || d === 6;
};
