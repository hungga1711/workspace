/**
 * Calendar arithmetic in the workspace's time zone (lib/timezone.ts), so grids and drags give the same instants
 * whatever the browser's own zone is. Day keys are "YYYY-MM-DD" in that zone; daylight saving is handled.
 */
import { workspaceTimeZone, zoneOffset } from "@/lib/timezone";

/** The zone the grid is drawn in (for Intl formatters next to it). */
export const calendarZone = workspaceTimeZone;

/** "YYYY-MM-DD" and minutes since midnight, in the workspace's zone. */
export function parts(d: Date | string) {
  const instant = new Date(d);
  const t = new Date(instant.getTime() + zoneOffset(instant));
  return { key: t.toISOString().slice(0, 10), minutes: t.getUTCHours() * 60 + t.getUTCMinutes() };
}

/** The instant of a day key at a number of minutes after midnight (workspace zone). */
export function at(key: string, minutes = 0): Date {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d) + minutes * 60_000;
  // The offset at the guess, then again at the result: right on both sides of a daylight-saving change.
  const first = wall - zoneOffset(new Date(wall));
  return new Date(wall - zoneOffset(new Date(first)));
}

/** A date field's "YYYY-MM-DDTHH:mm" for an instant, in the workspace's zone (not the browser's). */
export function zonedInput(iso: string | Date): string {
  const { key, minutes } = parts(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${key}T${p(Math.floor(minutes / 60))}:${p(minutes % 60)}`;
}

/** A date field's "YYYY-MM-DD[THH:mm]" back to an instant, read in the workspace's zone. */
export function fromZonedInput(v: string): Date {
  const [key, hm = "00:00"] = v.split("T") as [string, string?];
  const [h, m] = hm.split(":").map(Number) as [number, number];
  return at(key, h * 60 + m);
}

export function addDays(key: string, n: number): string {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Monday of the week containing the day. */
export function weekStart(key: string): string {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // Monday = 0
  return addDays(key, -dow);
}

/** First Monday on or before the 1st of the month: the top-left cell of a six-week month grid. */
export function monthGridStart(key: string): string {
  return weekStart(`${key.slice(0, 8)}01`);
}

export const today = () => parts(new Date()).key;

/** An event that fills whole days (starts at 00:00 and lasts 23 hours or more): shown in the all-day row, not on the hour grid. */
export const isAllDay = (e: { startsAt: string; endsAt: string }) => parts(e.startsAt).minutes === 0 && Date.parse(e.endsAt) - Date.parse(e.startsAt) >= 23 * 3600_000;
