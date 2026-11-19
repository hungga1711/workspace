"use client";

import { dateFormat } from "@/lib/intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { useT, useFormat } from "@/lib/i18n/client";
import { cx, popover } from "@/lib/ui";
import { propertyValue } from "@/components/ui/PropertyRow";
import { CalendarIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from "@/components/app/icons";
import { useClampX } from "./clamp";
import { INTL_TAG } from "@/lib/i18n/config";
import { yearPage } from "./datePages";

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (v: string): Date | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(v);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0)) : null;
};

/**
 * Date (and optional time) without the native picker: the trigger shows dd/mm/yyyy (HH:mm), the popover is a
 * Monday-first month grid (arrows move a day, PageUp/PageDown a month, Enter picks, Esc closes) with Today and
 * Clear. Its month label opens a month grid, and that one's year a page of years, so a date years away is three
 * clicks, not dozens of arrows. The value has the native input's shape ("YYYY-MM-DD" or "YYYY-MM-DDTHH:mm"), so it drops in where a
 * <input type=date|datetime-local> was; `name` posts it with a form.
 */
export function DateField({
  value,
  onChange,
  label,
  withTime = false,
  variant = "field",
  placeholder,
  id,
  name,
  disabled,
  required,
  clearable = true,
  align = "left",
  className,
  triggerClassName,
  display,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  withTime?: boolean;
  /** "title": the trigger is a heading-sized label with a caret (the calendar's period); style it with `triggerClassName`. */
  variant?: "field" | "property" | "button" | "title";
  placeholder?: string;
  id?: string;
  name?: string;
  disabled?: boolean;
  required?: boolean;
  clearable?: boolean;
  align?: "left" | "right";
  className?: string;
  triggerClassName?: string;
  /** How the chosen value reads on the trigger ("Today, 17:00"); the picker still works on `value`. Default dd/mm/yyyy. */
  display?: string;
}) {
  const tx = useT();
  const fmt = useFormat();
  const current = parse(value);
  const [open, setOpen] = useState(false);
  const clamp = useClampX<HTMLDivElement>();
  const [cursor, setCursor] = useState<Date>(() => current ?? new Date());
  const [level, setLevel] = useState<"day" | "month" | "year">("day");
  const [time, setTime] = useState(() => (current && withTime ? `${pad(current.getHours())}:${pad(current.getMinutes())}` : "17:00"));
  const ref = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const c = parse(value) ?? new Date();
    setCursor(c);
    setLevel("day");
    if (withTime && parse(value)) setTime(`${pad(c.getHours())}:${pad(c.getMinutes())}`);
    const away = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", away);
    requestAnimationFrame(() => grid.current?.querySelector<HTMLElement>("[data-cursor=true]")?.focus());
    return () => document.removeEventListener("mousedown", away);
  }, [open, value, withTime]);

  useEffect(() => {
    if (open) grid.current?.querySelector<HTMLElement>("[data-cursor=true]")?.focus();
  }, [cursor, open, level]);

  const tag = INTL_TAG[fmt.locale];
  const weekdays = useMemo(() => {
    const monday = new Date(2024, 0, 1); // a Monday
    return Array.from({ length: 7 }, (_, i) => dateFormat(tag, { weekday: "narrow" }).format(new Date(monday.getFullYear(), 0, 1 + i)));
  }, [tag]);
  const monthLabel = dateFormat(tag, { month: "long", year: "numeric" }).format(cursor);
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const start = new Date(first);
  start.setDate(1 - ((first.getDay() + 6) % 7));
  const days = Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  const today = ymd(new Date());

  const close = () => {
    setOpen(false);
    ref.current?.querySelector<HTMLButtonElement>("button[aria-haspopup=dialog]")?.focus({ preventScroll: true });
  };
  const commit = (d: Date) => {
    onChange(withTime ? `${ymd(d)}T${time}` : ymd(d));
    close();
  };
  // The same day of another month or year, kept inside that month (31 March → 28 February, not 3 March).
  const toMonth = (c: Date, year: number, month: number) => new Date(year, month, Math.min(c.getDate(), new Date(year, month + 1, 0).getDate()));
  const move = (days: number, months = 0) =>
    setCursor((c) => (months ? toMonth(c, c.getFullYear(), c.getMonth() + months) : new Date(c.getFullYear(), c.getMonth(), c.getDate() + days)));
  // Month view moves by month (3 to a row), year view by year; the day view by day (7 to a row).
  const step = (n: number) => (level === "day" ? move(n) : level === "month" ? move(0, n) : move(0, n * 12));
  const keys = (e: React.KeyboardEvent) => {
    const k = e.key;
    const row = level === "day" ? 7 : 3;
    if (k === "Escape") {
      e.stopPropagation();
      if (level === "day") close();
      else setLevel(level === "year" ? "month" : "day");
    } else if (k === "ArrowLeft") step(-1);
    else if (k === "ArrowRight") step(1);
    else if (k === "ArrowUp") step(-row);
    else if (k === "ArrowDown") step(row);
    else if (k === "PageUp") move(0, level === "day" ? -1 : level === "month" ? -12 : -120);
    else if (k === "PageDown") move(0, level === "day" ? 1 : level === "month" ? 12 : 120);
    else if (k === "Enter" && (e.target as HTMLElement).dataset.day) commit(cursor);
    else if (k === "Enter" && (e.target as HTMLElement).dataset.pick) setLevel(level === "year" ? "month" : "day");
    else return;
    e.preventDefault();
  };
  const years = yearPage(cursor.getFullYear());
  const header = level === "day" ? monthLabel : level === "month" ? String(cursor.getFullYear()) : `${years[1]}–${years[10]}`;
  const [prevLabel, nextLabel] =
    level === "day" ? [tx("ui.prevMonth"), tx("ui.nextMonth")] : level === "month" ? [tx("ui.prevYear"), tx("ui.nextYear")] : [tx("ui.prevYears"), tx("ui.nextYears")];
  const page = (dir: number) => move(0, dir * (level === "day" ? 1 : level === "month" ? 12 : 120));
  const cell = "grid place-items-center rounded-md text-sm tabular-nums transition-colors focus-visible:outline-2";

  const shown = !current
    ? null
    : display
      ? display
      : `${pad(current.getDate())}/${pad(current.getMonth() + 1)}/${current.getFullYear()}${withTime ? ` ${pad(current.getHours())}:${pad(current.getMinutes())}` : ""}`;
  const trigger =
    variant === "property"
      ? propertyValue
      : variant === "title"
        ? "inline-flex max-w-full items-center gap-1 rounded-md px-1.5 text-left text-ink hover:bg-hover aria-expanded:bg-hover"
        : variant === "button"
          ? "inline-flex h-9 items-center gap-1.5 rounded-md border border-hairline bg-surface px-3 text-sm font-medium text-ink hover:bg-hover"
          : "flex min-h-9 w-full items-center gap-2 rounded-md border border-hairline bg-surface px-3 text-left text-sm text-ink transition-colors hover:bg-hover/50 aria-expanded:border-ink-2";

  return (
    <div ref={ref} className={cx("relative min-w-0", variant === "field" && "w-full", className)}>
      {name ? <input type="hidden" name={name} value={value} required={required} /> : null}
      <button
        type="button"
        id={id}
        aria-label={shown ? `${label}: ${shown}` : label}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={cx(trigger, "tabular-nums disabled:cursor-not-allowed disabled:opacity-50", triggerClassName)}
      >
        {variant !== "property" && variant !== "title" ? <CalendarIcon className="text-ink-2 size-4 shrink-0" /> : null}
        <span className={cx("min-w-0 flex-1 truncate", !shown && "text-ink-2")}>{shown ?? placeholder ?? tx("ui.datePlaceholder")}</span>
        {variant === "title" ? <ChevronDownIcon aria-hidden="true" className="text-ink-2 size-4 shrink-0" /> : null}
      </button>
      {open ? (
        <div
          ref={clamp}
          role="dialog"
          aria-label={label}
          onKeyDown={keys}
          // Inside a <label> (Field), a click in the popover would "activate" the label, which re-clicks the
          // trigger and reopens the list: cancel that (links in the popover still navigate).
          onClick={(e) => !(e.target as HTMLElement).closest("a") && e.preventDefault()}
          className={cx(
            popover,
            "animate-pop absolute top-full z-50 mt-1 w-[17rem] p-3",
            align === "right" ? "right-0" : "left-0",
            // The calendar's title spans a phone's width: so does its picker, with bigger targets.
            variant === "title" && "max-sm:w-[calc(100vw-2rem)]",
          )}
        >
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              disabled={level === "year"}
              aria-label={level === "day" ? `${tx("ui.pickMonth")}: ${monthLabel}` : level === "month" ? `${tx("ui.pickYear")}: ${header}` : header}
              onClick={() => setLevel(level === "day" ? "month" : "year")}
              className="text-ink hover:bg-hover -ml-1.5 inline-flex h-7 items-center gap-0.5 rounded-md px-1.5 text-sm font-medium tabular-nums first-letter:uppercase disabled:hover:bg-transparent"
            >
              {header}
              {level !== "year" ? <ChevronDownIcon aria-hidden="true" className="text-ink-2 size-3.5" /> : null}
            </button>
            <span className="flex gap-0.5">
              <button type="button" aria-label={prevLabel} onClick={() => page(-1)} className="hover:bg-hover text-ink-2 hover:text-ink grid size-7 place-items-center rounded-md">
                <ChevronLeftIcon className="size-4" />
              </button>
              <button type="button" aria-label={nextLabel} onClick={() => page(1)} className="hover:bg-hover text-ink-2 hover:text-ink grid size-7 place-items-center rounded-md">
                <ChevronRightIcon className="size-4" />
              </button>
            </span>
          </div>
          {level !== "day" ? (
            <div ref={grid} role="grid" aria-label={header} className="grid grid-cols-3 gap-1 text-center">
              {(level === "month" ? Array.from({ length: 12 }, (_, i) => i) : years).map((n, i) => {
                const isMonth = level === "month";
                const on = isMonth ? n === cursor.getMonth() : n === cursor.getFullYear();
                const now = new Date();
                const isNow = isMonth ? cursor.getFullYear() === now.getFullYear() && n === now.getMonth() : n === now.getFullYear();
                const chosen = current && (isMonth ? current.getFullYear() === cursor.getFullYear() && current.getMonth() === n : current.getFullYear() === n);
                const label = isMonth ? dateFormat(tag, { month: "short" }).format(new Date(2024, n, 1)) : String(n);
                return (
                  <button
                    key={n}
                    type="button"
                    role="gridcell"
                    data-pick={n}
                    data-cursor={on}
                    tabIndex={on ? 0 : -1}
                    aria-selected={!!chosen}
                    aria-label={isMonth ? dateFormat(tag, { month: "long", year: "numeric" }).format(new Date(cursor.getFullYear(), n, 1)) : label}
                    onClick={() => {
                      setCursor((c) => (isMonth ? toMonth(c, c.getFullYear(), n) : toMonth(c, n, c.getMonth())));
                      setLevel(isMonth ? "day" : "month");
                    }}
                    className={cx(
                      cell,
                      "h-11 first-letter:uppercase",
                      chosen ? "bg-brand text-on-brand font-medium" : !isMonth && (i === 0 || i === 11) ? "text-ink-2 hover:bg-hover" : "text-ink hover:bg-hover",
                      !chosen && isNow && "ring-hairline font-semibold ring-1 ring-inset",
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          ) : (
            <div ref={grid} role="grid" aria-label={monthLabel} className="grid grid-cols-7 gap-0.5 text-center">
              {weekdays.map((w, i) => (
                <span key={i} role="columnheader" className="text-ink-2 grid h-7 place-items-center text-xs">
                  {w}
                </span>
              ))}
              {days.map((d) => {
                const key = ymd(d);
                const inMonth = d.getMonth() === cursor.getMonth();
                const selected = current && key === ymd(current);
                const isCursor = key === ymd(cursor);
                return (
                  <button
                    key={key}
                    type="button"
                    role="gridcell"
                    data-day={key}
                    data-cursor={isCursor}
                    tabIndex={isCursor ? 0 : -1}
                    aria-selected={!!selected}
                    aria-label={dateFormat(tag, { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(d)}
                    onClick={() => commit(d)}
                    className={cx(
                      cell,
                      "h-8",
                      variant === "title" && "max-sm:h-10",
                      selected ? "bg-brand text-on-brand font-medium" : inMonth ? "text-ink hover:bg-hover" : "text-ink-2 hover:bg-hover",
                      !selected && key === today && "ring-hairline font-semibold ring-1 ring-inset",
                    )}
                  >
                    {d.getDate()}
                  </button>
                );
              })}
            </div>
          )}
          <div className="border-hairline mt-2 flex items-center gap-2 border-t pt-2">
            {withTime ? (
              <input
                aria-label={label}
                value={time}
                onChange={(e) => setTime(e.target.value)}
                onBlur={() => {
                  const m = /^(\d{1,2}):?(\d{2})$/.exec(time.trim());
                  const t = m ? `${pad(Math.min(23, Number(m[1])))}:${pad(Math.min(59, Number(m[2])))}` : "17:00";
                  setTime(t);
                  if (current) onChange(`${ymd(current)}T${t}`);
                }}
                inputMode="numeric"
                placeholder="17:00"
                className="border-hairline focus:border-ink-2 h-7 w-16 rounded-md border px-2 text-sm tabular-nums outline-none"
              />
            ) : null}
            <button type="button" onClick={() => commit(new Date())} className="text-ink hover:bg-hover h-7 rounded-md px-2 text-sm">
              {tx("ui.today")}
            </button>
            {clearable && value ? (
              <button
                type="button"
                onClick={() => {
                  onChange("");
                  close();
                }}
                className="text-ink-2 hover:bg-hover hover:text-ink ml-auto h-7 rounded-md px-2 text-sm"
              >
                {tx("ui.clear")}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
