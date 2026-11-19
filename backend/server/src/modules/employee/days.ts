import type { PoolClient } from "pg";
import { DEFAULT_WORK_WEEK } from "./settings.js";

/** Working days in [start, end]: the workspace's work week (Mon–Fri unless the admin changed it) minus company holidays. */
export function workingDays(start: string, end: string, holidays: ReadonlySet<string> = new Set(), workWeek: readonly number[] = DEFAULT_WORK_WEEK): number {
  let n = 0;
  for (let d = new Date(`${start}T00:00:00Z`); d <= new Date(`${end}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.getUTCDay() || 7;
    if (workWeek.includes(iso) && !holidays.has(d.toISOString().slice(0, 10))) n++;
  }
  return n;
}

/** The workspace's holidays between two dates (inclusive), as YYYY-MM-DD. */
export async function holidaysBetween(c: PoolClient, from: string, to: string): Promise<Set<string>> {
  return new Set((await c.query<{ day: string }>("SELECT day::text FROM holidays WHERE day BETWEEN $1::date AND $2::date", [from, to])).rows.map((r) => r.day));
}

/** Today (or `at`) as YYYY-MM-DD in the given IANA zone. */
export function localDay(tz: string, at = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** Minutes since local midnight of `at` in the given zone. */
export function localMinutes(tz: string, at = new Date()): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at).map((p) => [p.type, p.value]),
  );
  return Number(parts.hour) * 60 + Number(parts.minute);
}
