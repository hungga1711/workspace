/**
 * The workspace's time zone (Admin › Cài đặt), used for every date and time the app shows. One installation holds
 * one workspace, so the zone is process-wide: the server learns it with getTimeZone() (lib/setup.ts) and the browser
 * from I18nProvider, before anything renders. Until then it is the product default.
 */
export const DEFAULT_TIME_ZONE = "Asia/Ho_Chi_Minh";

let zone = DEFAULT_TIME_ZONE;

export const workspaceTimeZone = (): string => zone;

/** Zones already found valid: the check builds a formatter, and every provider render asks again. */
const known = new Set<string>();

export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz) return false;
  if (known.has(tz)) return true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    known.add(tz);
    return true;
  } catch {
    return false;
  }
}

export function setWorkspaceTimeZone(tz: string | null | undefined): void {
  if (isTimeZone(tz)) zone = tz;
}

const fields = new Map<string, Intl.DateTimeFormat>();

/** How far the zone is ahead of UTC at that instant, in milliseconds (daylight saving included). */
export function zoneOffset(at: Date, tz: string = zone): number {
  let f = fields.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    fields.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, Number(x.value)]));
  const wall = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
  return wall - Math.floor(at.getTime() / 1000) * 1000;
}

/** The browser's zone when it is a known IANA name, else the default (used to pre-fill /setup and settings). */
export function browserTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isTimeZone(tz) ? tz : DEFAULT_TIME_ZONE;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

/** The wall-clock time `at` shows in `tz`, as "YYYY-MM-DDTHH:mm" (what a date and time field holds). */
export function wallTime(at: Date, tz: string = zone): string {
  const w = new Date(at.getTime() + zoneOffset(at, tz));
  return w.toISOString().slice(0, 16);
}

/** The instant a wall-clock "YYYY-MM-DDTHH:mm" in `tz` names (twice round for a daylight-saving edge). */
export function fromWallTime(wall: string, tz: string = zone): Date {
  const [d = "", t = "00:00"] = wall.split("T");
  const [y, mo, da] = d.split("-").map(Number);
  const [h, mi] = t.split(":").map(Number);
  const asUtc = Date.UTC(y!, mo! - 1, da!, h ?? 0, mi ?? 0);
  let at = new Date(asUtc - zoneOffset(new Date(asUtc), tz));
  at = new Date(asUtc - zoneOffset(at, tz));
  return at;
}
