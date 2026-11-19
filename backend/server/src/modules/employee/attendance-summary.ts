/** Days of a period, and who was in, late, away or absent: the pure part of GET attendance/summary. */

/** Working days in [start, end] as YYYY-MM-DD: the work week (ISO weekdays) minus holidays. */
export function workingDayList(start: string, end: string, holidays: ReadonlySet<string>, workWeek: readonly number[]): string[] {
  const out: string[] = [];
  for (let d = new Date(`${start}T00:00:00Z`), n = 0; d <= new Date(`${end}T00:00:00Z`) && n < 400; d.setUTCDate(d.getUTCDate() + 1), n++) {
    const day = d.toISOString().slice(0, 10);
    if (workWeek.includes(d.getUTCDay() || 7) && !holidays.has(day)) out.push(day);
  }
  return out;
}

/** Each day of approved leave that falls in the list, from [start, end] ranges. */
export function leaveDaySet(ranges: { start: string; end: string }[], days: readonly string[]): Set<string> {
  return new Set(days.filter((d) => ranges.some((r) => d >= r.start && d <= r.end)));
}

export interface DayRow {
  day: string;
  lateMinutes: number;
  hours: number;
  missedCheckout: boolean;
}

export interface PersonSummary {
  workingDays: number;
  presentDays: number;
  lateDays: number;
  lateMinutes: number;
  hours: number;
  missedCheckouts: number;
  leaveDays: number;
  /** Working days up to `today` with no check-in and no approved leave. */
  absentDays: number;
  absentOn: string[];
}

/**
 * One person's period. Days after `today` are not absences yet; today counts only once it is over (`today` is the
 * last day that can be absent, the caller passes yesterday while the day is still running).
 */
export function summarize(days: readonly string[], rows: DayRow[], leave: ReadonlySet<string>, lastCountable: string): PersonSummary {
  const present = new Set(rows.map((r) => r.day));
  const byDay = new Map<string, { late: number }>();
  for (const r of rows) byDay.set(r.day, { late: Math.max(byDay.get(r.day)?.late ?? 0, r.lateMinutes) });
  const absentOn = days.filter((d) => d <= lastCountable && !present.has(d) && !leave.has(d));
  const late = [...byDay.values()].filter((x) => x.late > 0);
  return {
    workingDays: days.length,
    presentDays: present.size,
    lateDays: late.length,
    lateMinutes: late.reduce((n, x) => n + x.late, 0),
    hours: Math.round(rows.reduce((n, r) => n + r.hours, 0) * 10) / 10,
    missedCheckouts: rows.filter((r) => r.missedCheckout).length,
    leaveDays: days.filter((d) => leave.has(d)).length,
    absentDays: absentOn.length,
    absentOn,
  };
}
