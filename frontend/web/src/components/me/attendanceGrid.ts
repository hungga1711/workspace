/**
 * The attendance history calendar: one column per week, Monday to Sunday, ending with the week of
 * `today`. Days are ISO dates (YYYY-MM-DD) in the workspace's zone; the maths is done on UTC midnights so no local
 * time zone or DST can shift a day.
 */
const DAY_MS = 86_400_000;
const toMs = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
const toDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export const addDays = (d: string, n: number) => toDay(toMs(d) + n * DAY_MS);
/** 0 = Monday … 6 = Sunday. */
export const weekday = (d: string) => (new Date(toMs(d)).getUTCDay() + 6) % 7;

/** `weeks` columns of seven days, oldest first; the last column holds `today` (days after it are still listed). */
export function calendarWeeks(today: string, weeks = 53): string[][] {
  const start = addDays(today, -weekday(today) - (weeks - 1) * 7);
  return Array.from({ length: weeks }, (_, w) => Array.from({ length: 7 }, (_, d) => addDays(start, w * 7 + d)));
}

/** Columns where a month starts (its 1st falls in that week, by `today`), for the labels above the grid. */
export function monthStarts(columns: string[][], today: string): { column: number; month: string }[] {
  const out: { column: number; month: string }[] = [];
  columns.forEach((week, column) => {
    const first = week.find((d) => d.endsWith("-01") && d <= today);
    if (first) out.push({ column, month: first.slice(0, 7) });
  });
  return out;
}

/** Shade 0–4 by hours worked: 0 none, then under 4 h, under 7 h, under 9 h, 9 h or more. */
export function level(hours: number): 0 | 1 | 2 | 3 | 4 {
  if (hours <= 0) return 0;
  if (hours < 4) return 1;
  if (hours < 7) return 2;
  if (hours < 9) return 3;
  return 4;
}

/** Every day from `from` to `to` (inclusive) that a leave covers. */
export function leaveDays(leaves: { startDate: string; endDate: string }[]): Set<string> {
  const out = new Set<string>();
  for (const l of leaves) for (let d = l.startDate; d <= l.endDate && out.size < 5000; d = addDays(d, 1)) out.add(d);
  return out;
}
