import type { PoolClient } from "pg";
import type { EventEnvelope } from "@workspace/contracts";
import { DEFAULT_TIME_ZONE, isTimeZone } from "@workspace/shared";
import { defaultFormats } from "./codes.js";

/** Projection of the workspace settings (code formats, timezone). Version-gated: older events never overwrite newer state. */
export async function applySettingsEvent(e: EventEnvelope, c: PoolClient): Promise<void> {
  if (e.eventType === "platform.workspace.created.v1") {
    const { timezone: tz, locale } = e.payload as { timezone?: unknown; locale?: string };
    await c.query(`INSERT INTO workspace_settings (code_formats, timezone, locale, version) VALUES ($1, $2, $3, 1) ON CONFLICT DO NOTHING`, [
      JSON.stringify(defaultFormats(locale)),
      isTimeZone(tz) ? tz : DEFAULT_TIME_ZONE,
      locale === "en" || locale === "vi" || locale === "zh" || locale === "es" ? locale : "en",
    ]);
  }
  if (e.eventType === "platform.workspace.config_changed.v1") {
    const p = e.payload as { version: number; config: { codeFormats: Record<string, string>; timezone: string; locale?: string } };
    await c.query(
      `INSERT INTO workspace_settings (code_formats, timezone, locale, version) VALUES ($1,$2,$3,$4)
       ON CONFLICT (singleton) DO UPDATE SET code_formats = EXCLUDED.code_formats, timezone = EXCLUDED.timezone,
         locale = coalesce(EXCLUDED.locale, workspace_settings.locale), version = EXCLUDED.version
       WHERE workspace_settings.version < EXCLUDED.version`,
      [JSON.stringify(p.config.codeFormats), p.config.timezone, ["en", "vi", "zh", "es"].includes(p.config.locale ?? "") ? p.config.locale : null, p.version],
    );
  }
}

/** SQL for the workspace's IANA zone (the projection above, one row). */
export const TZ_SQL = `coalesce((SELECT timezone FROM workspace_settings LIMIT 1), '${DEFAULT_TIME_ZONE}')`;

/** The workspace's IANA zone. */
export async function workspaceTimeZone(c: PoolClient): Promise<string> {
  return (await c.query<{ tz: string }>(`SELECT ${TZ_SQL} AS tz`)).rows[0]!.tz;
}

/**
 * The workspace's language, for text written with no request behind it (the calendar feed). A person's own request
 * carries theirs in `x-locale`; this is the fallback when nobody is asking.
 */
export async function workspaceLocale(c: PoolClient): Promise<"vi" | "en"> {
  // Text written here exists in Vietnamese and English; every other workspace language reads the English one.
  const r = (await c.query<{ locale: string | null }>("SELECT locale FROM workspace_settings LIMIT 1")).rows[0];
  return r?.locale === "vi" ? "vi" : "en";
}
