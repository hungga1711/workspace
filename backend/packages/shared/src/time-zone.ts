import type { EventEnvelope } from "@workspace/contracts";
import type { PoolClient } from "pg";

/** The product default until the admin picks another (Admin › Cài đặt), and for workspaces older than the projection. */
export const DEFAULT_TIME_ZONE = "Asia/Ho_Chi_Minh";

/** True for an IANA zone the runtime knows (aliases such as Asia/Saigon included). */
export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const formats = new Map<string, Intl.DateTimeFormat>();

/** How far the zone is ahead of UTC at that instant, in milliseconds (daylight saving included). */
export function zoneOffset(at: Date, tz: string = DEFAULT_TIME_ZONE): number {
  let f = formats.get(tz);
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
    formats.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - Math.floor(at.getTime() / 1000) * 1000;
}

/** The wall clock in the zone at that instant, as a Date whose UTC fields read it (getUTCDate() is the local day). */
export function wallClock(at: Date, tz: string = DEFAULT_TIME_ZONE): Date {
  return new Date(at.getTime() + zoneOffset(at, tz));
}

/** "YYYY-MM-DD" of that instant in the zone. */
export function dayKey(at: Date, tz: string = DEFAULT_TIME_ZONE): string {
  return wallClock(at, tz).toISOString().slice(0, 10);
}

/** "dd/mm" of that instant in the zone (vi-VN's short date uses "-", which reads oddly in a sentence). */
export function ddmm(at: Date, tz: string = DEFAULT_TIME_ZONE): string {
  const k = dayKey(at, tz);
  return `${k.slice(8, 10)}/${k.slice(5, 7)}`;
}

/** The instant a "YYYY-MM-DD" day starts in the zone. */
export function startOfDay(key: string, tz: string = DEFAULT_TIME_ZONE): Date {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d);
  // The offset at the guess, then again at the result: right on both sides of a daylight-saving change.
  const first = wall - zoneOffset(new Date(wall), tz);
  return new Date(wall - zoneOffset(new Date(first), tz));
}

/**
 * SQL for the workspace's zone, for `AT TIME ZONE` in queries. Reads the module's own `workspace_settings`
 * projection (one row), so no call to the platform module.
 */
export const WORKSPACE_TZ_SQL = `coalesce((SELECT timezone FROM workspace_settings LIMIT 1), '${DEFAULT_TIME_ZONE}')`;

/** The workspace's IANA time zone (see WORKSPACE_TZ_SQL). */
export async function workspaceTimeZone(c: PoolClient): Promise<string> {
  return (await c.query<{ tz: string }>(`SELECT ${WORKSPACE_TZ_SQL} AS tz`)).rows[0]!.tz;
}

/**
 * Keeps a module's `workspace_settings` projection (one row: timezone, version) in step with the platform module:
 * creation sets it, a config change replaces it unless an older snapshot arrives late. Other events are ignored,
 * so a consumer of the `workspace.platform.workspace` topic can call it for every event.
 */
export async function projectWorkspaceTimeZone(e: EventEnvelope, c: PoolClient): Promise<void> {
  if (e.eventType === "platform.workspace.created.v1") {
    const tz = (e.payload as { timezone?: unknown }).timezone;
    await c.query("INSERT INTO workspace_settings (timezone, version) VALUES ($1, 1) ON CONFLICT (singleton) DO NOTHING", [isTimeZone(tz) ? tz : DEFAULT_TIME_ZONE]);
  } else if (e.eventType === "platform.workspace.config_changed.v1") {
    const p = e.payload as { version: number; config: { timezone?: unknown } };
    if (!isTimeZone(p.config.timezone)) return;
    await c.query(
      `INSERT INTO workspace_settings (timezone, version) VALUES ($1, $2)
       ON CONFLICT (singleton) DO UPDATE SET timezone = EXCLUDED.timezone, version = EXCLUDED.version WHERE workspace_settings.version < EXCLUDED.version`,
      [p.config.timezone, p.version],
    );
  }
}
