import { dateFormat } from "@/lib/intl";
import type { T } from "@/lib/i18n/core";
import { at, parts } from "@/components/work/calTime";
import { workspaceTimeZone } from "@/lib/timezone";
export interface AttendanceRow {
  userId: string;
  code: string;
  displayName: string;
  department: string | null;
  days: number;
  hours: number;
  open: number;
  lateDays: number;
  leaveDays: number;
}
export interface AttendanceReport {
  month: string;
  workingDays: number;
  workWeek: number[];
  shift: { start: string; end: string | null; lateAfterMin: number } | null;
  employees: AttendanceRow[];
}

/** The last 12 months, newest first, as YYYY-MM in the workspace's time zone. */
export function recentMonths(n = 12): string[] {
  const [y, m] = parts(new Date()).key.split("-").map(Number) as [number, number];
  return Array.from({ length: n }, (_, i) => new Date(Date.UTC(y, m - 1 - i, 1)).toISOString().slice(0, 7));
}

export const monthLabel = (tx: T, m: string) => tx("labels.month", { m: m.slice(5, 7), y: m.slice(0, 4) });

/** "08:30": a check-in or -out in the workspace's time zone, 24-hour; empty for none (a form value or "—" in a table). */
export const clockTime = (iso: string | null) =>
  iso ? dateFormat("en-GB", { timeZone: workspaceTimeZone(), hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso)) : "";

/** "2026-09-10" + "08:30" (workspace time) → ISO instant. */
export const clockIso = (day: string, time: string) => at(day, Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5))).toISOString();
