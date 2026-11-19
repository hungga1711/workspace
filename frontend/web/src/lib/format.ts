/**
 * Labels and time formatting shared by server and client components.
 * `makeFormat(locale, t)` is the localized set (use `useFormat()` in client components, `getFormat()`
 * on the server).
 */
import { INTL_TAG, type Locale } from "./i18n/config";
import type { T } from "./i18n/core";
import { workspaceTimeZone } from "./timezone";
import { formatMoney } from "./money";
import { dateFormat, numberFormat } from "./intl";

/** The task statuses, in board order (labels come from the dictionary: `useFormat().status`). */
export const STATUS_KEYS = ["todo", "in_progress", "review", "done", "cancelled"] as const;
const PRIORITY_KEYS = ["urgent", "high", "medium", "low"] as const;
const KIND_KEYS = ["approval", "mention", "dm", "task", "meeting", "deadline", "leave", "decision", "blocker"] as const;

/**
 * "Friday, 25/12" / "Thứ Sáu, 25/12": the weekday, then the date, always joined by ", ". Not Intl's own joining:
 * ICU versions differ there (Node prints "Friday 25/12", Chromium "Friday, 25/12"), and a server-rendered date that
 * the browser formats differently fails hydration.
 */
export function weekdayDate(format: Intl.DateTimeFormat, d: Date): string {
  const parts = format.formatToParts(d);
  const i = parts.findIndex((p) => p.type === "weekday");
  if (i < 0) return format.format(d);
  const rest = parts
    .slice(i + 1)
    .filter((p, j) => !(j === 0 && p.type === "literal"))
    .map((p) => p.value)
    .join("");
  return `${parts[i]!.value}, ${rest}`;
}

/**
 * Day and month for an Intl tag: digits in Vietnamese ("09/11"), the month's name elsewhere ("Nov 9", "9 nov", "11月9日"),
 * since 11/9 is 11 September to an American reader and 9 November to a British one.
 */
export const dayMonthOptions = (tag: string): Intl.DateTimeFormatOptions => (tag.startsWith("vi") ? { day: "2-digit", month: "2-digit" } : { day: "numeric", month: "short" });
/** A full date and time that no reader misreads ("Nov 9, 2026, 5:00 PM"); for tooltips and audit rows. */
export const dateTimeMedium: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" };

/** Current hour 0–23 in a time zone. Not via vi-VN: it prints "11 giờ", which Number() reads as NaN (always "evening"). */
function hourIn(tz: string): number {
  return Number(dateFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(new Date()));
}

/** IP addresses for people: loopback reads as `local` (the translated "this machine"), IPv4-mapped IPv6 as plain IPv4. */
export function ipLabel(ip: string | null | undefined, local: string): string {
  if (!ip) return "—";
  const v = ip.replace(/^::ffff:/i, "");
  if (v === "::1" || v === "0:0:0:0:0:0:0:1" || v.startsWith("127.")) return local;
  return v;
}

/** YYYY-MM-DD of a moment in the given time zone (toISOString is UTC and is a day behind after midnight in Asia). */
export function localDate(d: Date | string = new Date(), tz = workspaceTimeZone()): string {
  return dateFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(d));
}

/** The locale-bound formatters: translated words, Intl in that locale, the workspace time zone by default. */
export function makeFormat(locale: Locale, t: T) {
  const tag = INTL_TAG[locale];
  const f = (opts: Intl.DateTimeFormatOptions, tz = workspaceTimeZone()) => dateFormat(tag, { timeZone: tz, ...opts });
  const key = (d: Date, tz: string) => dateFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  // Vietnamese reads day/month digits ("09/11"); English, Chinese and Spanish name the month ("Nov 9", "11月9日",
  // "9 nov"): 11/9 means 9 November to a British reader and 11 September to an American one. Another year's date
  // names its year.
  const numericDayMonth = locale === "vi";
  const yearOf = (d: Date) => (d.getFullYear() !== new Date().getFullYear() ? ({ year: "numeric" } as const) : {});
  const shortDate = (iso: string | Date, tz = workspaceTimeZone()) => {
    const d = new Date(iso);
    if (!numericDayMonth) return f({ day: "numeric", month: "short", ...yearOf(d) }, tz).format(d);
    const parts = f({ day: "2-digit", month: "2-digit" }, tz).formatToParts(d);
    const y = d.getFullYear() !== new Date().getFullYear() ? `/${d.getFullYear()}` : "";
    return `${parts.find((p) => p.type === "day")?.value}/${parts.find((p) => p.type === "month")?.value}${y}`;
  };
  const monthStyle = numericDayMonth ? ("numeric" as const) : ("short" as const);
  const dayKind = (iso: string | Date, tz = workspaceTimeZone()): "today" | "tomorrow" | "yesterday" | null => {
    // Called for every row of a long list on each render (chat day separators): the date's own key is read once.
    const day = key(new Date(iso), tz);
    const now = Date.now();
    if (day === key(new Date(now), tz)) return "today";
    if (day === key(new Date(now + 86400e3), tz)) return "tomorrow";
    if (day === key(new Date(now - 86400e3), tz)) return "yesterday";
    return null;
  };
  const time = (iso: string | Date, tz = workspaceTimeZone()) => f({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" }, tz).format(new Date(iso));
  return {
    locale,
    t,
    time,
    shortDate,
    longDate: (iso: string | Date = new Date(), tz = workspaceTimeZone()) => {
      const s = weekdayDate(f({ weekday: "long", day: "numeric", month: "long" }, tz), new Date(iso));
      return s.charAt(0).toUpperCase() + s.slice(1);
    },
    dayLabel: (iso: string | Date, tz = workspaceTimeZone()) => {
      const k = dayKind(iso, tz);
      // Another year's day names its year: a message from two years ago is not mistaken for this autumn's.
      return k ? t(`format.${k}`) : weekdayDate(f({ weekday: "long", day: "numeric", month: monthStyle, ...yearOf(new Date(iso)) }, tz), new Date(iso));
    },
    /** When a message was sent, as chat apps show it: "14:05" today, "Yesterday 14:05", else "9 Nov 14:05". */
    stamp: (iso: string | Date, tz = workspaceTimeZone()) => {
      const k = dayKind(iso, tz);
      if (k === "today") return time(iso, tz);
      return `${k === "yesterday" ? t("format.yesterday") : shortDate(iso, tz)} ${time(iso, tz)}`;
    },
    /** The full date and time, for a timestamp's tooltip. */
    dateTime: (iso: string | Date, tz = workspaceTimeZone()) => f(dateTimeMedium, tz).format(new Date(iso)),
    /** dayLabel for the middle of a sentence: "due today", not "due Today". */
    dayInline: (iso: string | Date, tz = workspaceTimeZone()) => {
      const k = dayKind(iso, tz);
      return k ? t(`format.${k}`).toLocaleLowerCase(tag) : weekdayDate(f({ weekday: "long", day: "numeric", month: monthStyle }, tz), new Date(iso));
    },
    ago: (iso: string | Date) => {
      const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
      if (s < 60) return t("format.justNow");
      if (s < 3600) return t("format.minutesAgo", { count: Math.floor(s / 60) });
      if (s < 86400) return t("format.hoursAgo", { count: Math.floor(s / 3600) });
      if (s < 7 * 86400) return t("format.daysAgo", { count: Math.floor(s / 86400) });
      return shortDate(iso);
    },
    dueLabel: (iso: string | null, tz = workspaceTimeZone()): { text: string; overdue: boolean } | null => {
      if (!iso) return null;
      const d = new Date(iso);
      const diff = d.getTime() - Date.now();
      if (diff < 0) {
        const days = Math.floor(-diff / 86400e3);
        return { text: days >= 1 ? t("format.daysLate", { count: days }) : t("format.overdue"), overdue: true };
      }
      const k = dayKind(d, tz);
      if (k === "today") return { text: t("format.dueAt", { time: time(d, tz) }), overdue: false };
      if (k === "tomorrow") return { text: t("format.dueTomorrow"), overdue: false };
      return { text: shortDate(d, tz), overdue: false };
    },
    greeting: (tz = workspaceTimeZone()) => {
      const h = hourIn(tz);
      return t(h >= 4 && h < 11 ? "format.morning" : h >= 11 && h < 13 ? "format.noon" : h >= 13 && h < 18 ? "format.afternoon" : "format.evening");
    },
    /** A plain number in the UI language ("1,250.5" / "1.250,5"); `digits` caps the decimals (1 by default). */
    number: (n: number, digits = 1) => numberFormat(tag, { maximumFractionDigits: digits }).format(n),
    /** A 0–1 ratio as a percentage ("42%", "42 %" in Spanish). */
    percent: (ratio: number, digits = 0) => numberFormat(tag, { style: "percent", maximumFractionDigits: digits }).format(ratio),
    /** Money in the UI language; short form for tables, `.full` for a tooltip (lib/money.ts). */
    money: (amount: number, currency: string) => formatMoney(amount, currency, locale),
    /** A duration in days with its unit, spaced and pluralised per language ("1.6 days", "1,6 ngày", "1.6天", "1,6 días"). */
    days: (n: number) => numberFormat(tag, { style: "unit", unit: "day", unitDisplay: "long", maximumFractionDigits: 1 }).format(n),
    /** The compact form for dense columns ("1.6d", "1,6 ngày", "1.6天", "1,6 d"). */
    daysShort: (n: number) => numberFormat(tag, { style: "unit", unit: "day", unitDisplay: "short", maximumFractionDigits: 1 }).format(n),
    status: (k: string) => (STATUS_KEYS.includes(k as (typeof STATUS_KEYS)[number]) ? t(`format.status.${k as "todo"}`) : k),
    priority: (k: string) => (PRIORITY_KEYS.includes(k as (typeof PRIORITY_KEYS)[number]) ? t(`format.priority.${k as "low"}`) : k),
    kind: (k: string) => (KIND_KEYS.includes(k as (typeof KIND_KEYS)[number]) ? t(`format.kind.${k as "task"}`) : k),
  };
}
export type Format = ReturnType<typeof makeFormat>;
