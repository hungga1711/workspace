import "server-only";
import { cache } from "react";
import { config } from "@/lib/config";
import { DEFAULT_LOCALE, isLocale, type Locale } from "@/lib/i18n/config";
import { setWorkspaceTimeZone, workspaceTimeZone } from "@/lib/timezone";

/**
 * Whether this installation's one workspace exists. Until it does, `/` leads to first-run setup.
 * An unreachable gateway counts as set up, so a hiccup never offers setup on a running installation.
 */
export async function isSetUp(): Promise<boolean> {
  try {
    const r = await fetch(`${config.gatewayUrl}/api/setup`, { cache: "no-store" });
    if (!r.ok) return true;
    return ((await r.json()) as { setUp?: boolean }).setUp !== false;
  } catch {
    return true;
  }
}

interface SetupInfo {
  timezone?: string;
  /** The workspace's language (Admin › Cài đặt): what anyone without a personal choice sees. */
  locale?: Locale;
  /** Video meetings and calls exist on this server (LiveKit configured). */
  meet: boolean;
  /** The company's uploaded logo (Admin › Cài đặt), or null for the standard mark. */
  logoUrl?: string | null;
}

/**
 * What the gateway's public `GET /api/setup` says about this installation: the workspace's time zone (every date
 * on the server is formatted in it, lib/timezone.ts), its language and whether video meetings exist. Asked once
 * per request at most and cached a minute; an unreachable gateway keeps the last known zone and hides nothing.
 */
/** Cache tag of the `/api/setup` answer: Admin › Cài đặt revalidates it on save (settings/actions.ts). */
export const SETUP_TAG = "workspace-setup";

const setupInfo = cache(async (): Promise<SetupInfo> => {
  try {
    const r = await fetch(`${config.gatewayUrl}/api/setup`, { next: { revalidate: 60, tags: [SETUP_TAG] } });
    if (r.ok) {
      const j = (await r.json()) as { timezone?: string; locale?: unknown; meet?: boolean; logoUrl?: unknown };
      setWorkspaceTimeZone(j.timezone);
      const logoUrl = typeof j.logoUrl === "string" && j.logoUrl.startsWith("/api/workspace-logo?") ? j.logoUrl : null;
      return { timezone: j.timezone, locale: isLocale(j.locale) ? j.locale : undefined, meet: j.meet !== false, logoUrl };
    }
  } catch {
    /* keep the last known zone */
  }
  return { meet: true };
});

export const getTimeZone = cache(async (): Promise<string> => {
  await setupInfo();
  return workspaceTimeZone();
});

/**
 * What the first-run form depends on: whether it asks for the token the server printed at start (or SETUP_TOKEN;
 * false once set up), and whether this deployment has AI at all (`DISABLED_FEATURES=ai` leaves it out, ADR 0026).
 */
export async function setupOptions(): Promise<{ tokenRequired: boolean; ai: boolean }> {
  try {
    const r = await fetch(`${config.gatewayUrl}/api/setup`, { cache: "no-store" });
    if (!r.ok) return { tokenRequired: false, ai: true };
    const j = (await r.json()) as { tokenRequired?: boolean; ai?: boolean };
    return { tokenRequired: j.tokenRequired === true, ai: j.ai !== false };
  } catch {
    return { tokenRequired: false, ai: true };
  }
}

/** The language for a viewer who never chose one: the workspace's, Vietnamese until the workspace exists. */
export const getWorkspaceLocale = cache(async (): Promise<Locale> => (await setupInfo()).locale ?? DEFAULT_LOCALE);

/** The company's logo for screens without a session (sign-in), or null for the standard mark. */
export const getWorkspaceLogoUrl = cache(async (): Promise<string | null> => (await setupInfo()).logoUrl ?? null);

/** Whether to show anything that needs LiveKit: "Họp ngay", call buttons, meeting rooms. */
export const meetEnabled = cache(async (): Promise<boolean> => (await setupInfo()).meet);
