/**
 * Shared Intl formatters. Building an Intl.DateTimeFormat or NumberFormat loads locale and time-zone data and costs
 * tens of microseconds (far more on a slow laptop), while using one is cheap. Lists format a date per row (chat
 * messages, tasks, calendar cells), so building one per call was the largest script cost when a long screen rendered
 * (the attendance calendar spent ~150 ms of a 4× throttled load there). Formatters are immutable, so one
 * per locale and option set is shared for the life of the page or server process.
 */
const dates = new Map<string, Intl.DateTimeFormat>();
const numbers = new Map<string, Intl.NumberFormat>();
/** Bounded so a stream of unusual option sets (never expected) cannot grow the cache without end. */
const LIMIT = 500;

const keyOf = (locale: string | undefined, opts: object | undefined) => `${locale ?? ""}|${opts ? JSON.stringify(opts) : ""}`;

export function dateFormat(locale?: string, opts?: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const k = keyOf(locale, opts);
  let f = dates.get(k);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, opts);
    if (dates.size >= LIMIT) dates.clear();
    dates.set(k, f);
  }
  return f;
}

export function numberFormat(locale?: string, opts?: Intl.NumberFormatOptions): Intl.NumberFormat {
  const k = keyOf(locale, opts);
  let f = numbers.get(k);
  if (!f) {
    f = new Intl.NumberFormat(locale, opts);
    if (numbers.size >= LIMIT) numbers.clear();
    numbers.set(k, f);
  }
  return f;
}
