import { DEFAULT_TIME_ZONE, deployFeatureMap, isTimeZone } from "@workspace/shared";
import { CURRENCY_BY_COUNTRY, currencyFor } from "./currency.js";
import { z } from "zod";

/** Code formats: {id10} = first 10 ULID chars, {yyyy} = year, {seqN} = the workspace's counter padded to N. */
const codeFormat = z
  .string()
  .min(3)
  .max(40)
  .regex(/^[A-Z0-9-]*(\{(id10|yyyy|seq[3-9])\}[A-Z0-9-]*)+$/, "invalid code format");

/** Company names: setup, the stored workspace name and branding.displayName share this limit (Vietnamese legal names run long). */
export const WORKSPACE_NAME_MAX = 80;

const aiFeaturesSchema = z.object({ assistant: z.boolean(), monitoring: z.boolean() }).default({ assistant: false, monitoring: false });
export type AiFeatures = { assistant: boolean; monitoring: boolean };

export const workspaceConfigSchema = z.object({
  features: z.object({
    attendance: z.boolean(),
    customWorkflow: z.boolean(),
    // AI is two separate switches, both off until the company turns them on at /setup or in Admin › AI:
    // `assistant` (the company's own model: Trợ lý AI, @AI, summaries) and `monitoring` (what staff do on
    // ChatGPT/Claude/Gemini/Copilot through the browser extension, a form of staff monitoring). Older rows have
    // neither key, which reads as off.
    ai: aiFeaturesSchema,
  }),
  // Home keeps a fixed order; admins only toggle the secondary sections.
  home: z.object({ sections: z.object({ announcements: z.boolean(), attendance: z.boolean() }) }),
  branding: z.object({
    displayName: z.string().trim().min(1).max(WORKSPACE_NAME_MAX),
    primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    // Set by the logo endpoints (logo.ts) to the gateway's versioned path; an absolute URL is still accepted.
    logoUrl: z.union([z.string().url(), z.string().regex(/^\/api\/workspace-logo\?v=\d+$/)]).nullable(),
  }),
  codeFormats: z.object({ task: codeFormat, project: codeFormat, document: codeFormat, employee: codeFormat, request: codeFormat, meeting: codeFormat, whiteboard: codeFormat }),
  locale: z.enum(["en", "vi", "zh", "es"]),
  timezone: z.string().refine(isTimeZone, "unknown time zone"),
  // ISO 4217 code for approval amounts and budgets; older rows have none and read as VND.
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .default("VND"),
  // ISO 3166 country the company works in: drives public holidays, the default annual leave and the currency
  // suggested in Settings (web lib/country.ts). Null on older rows and when setup could not tell.
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .nullable()
    .default(null),
  // "insights": AI Insights only. Tasks come from the company's own tool (Asana, ClickUp, Linear, Jira) through task
  // sync, and the web hides chat, boards, docs, whiteboards and time from navigation; the modules themselves stay on,
  // so switching back to "full" loses nothing. Older rows have no mode and read as full.
  mode: z.enum(["full", "insights"]).default("full"),
  // Where staff download the desktop app the admin built for this server (frontend/desktop: `pnpm desktop:build
  // <address>`), e.g. a shared drive. Null: Profile shows no desktop app.
  desktopDownloadUrl: z
    .string()
    .max(500)
    .url()
    .regex(/^https?:\/\//i, "http or https only")
    .nullable()
    .default(null),
});
export type WorkspaceConfig = z.infer<typeof workspaceConfigSchema>;

/**
 * Reading a stored config never fails on the display name: a value written under an older or different limit is
 * shortened rather than turning every page into a 500. Writes still go through workspaceConfigSchema.
 */
const storedConfigSchema = workspaceConfigSchema.extend({
  branding: workspaceConfigSchema.shape.branding.extend({
    displayName: z
      .string()
      .min(1)
      .transform((s) => s.slice(0, WORKSPACE_NAME_MAX)),
  }),
});
export function readWorkspaceConfig(raw: unknown): WorkspaceConfig {
  return storedConfigSchema.parse(withCodeDefaults(raw));
}

/**
 * Request, meeting and whiteboard codes came after the other formats: a config saved without them (stored, or sent
 * by an older client) takes the defaults the work module also falls back to (work/codes.ts), so the two never
 * disagree. Read-time rather than a migration: existing installations get "W-{seq3}" the first time the config is
 * read, and keep it once an admin saves the settings.
 */
export function withCodeDefaults(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const r = raw as { codeFormats?: Record<string, unknown> };
  if (!r.codeFormats || typeof r.codeFormats !== "object") return raw;
  return { ...r, codeFormats: { request: "YC-{seq3}", meeting: "H-{seq3}", whiteboard: "W-{seq3}", ...r.codeFormats } };
}

/**
 * Video meetings exist on this server when LiveKit is configured. Development keeps the local container as a
 * fallback (the work module's `meetConfigFromEnv` applies the same rule); production needs `LIVEKIT_URL`.
 */
export function meetEnabledFromEnv(): boolean {
  return Boolean(process.env.LIVEKIT_URL) || process.env.NODE_ENV !== "production";
}

export function defaultConfig(
  name: string,
  locale: "en" | "vi" | "zh" | "es" = "en",
  timezone: string = DEFAULT_TIME_ZONE,
  ai: AiFeatures = { assistant: false, monitoring: false },
  country: string | null = null,
  mode: "full" | "insights" = "full",
): WorkspaceConfig {
  return {
    // Every module is on by default; admins can switch the optional ones off. AI is the exception: off until asked for.
    features: { attendance: true, customWorkflow: true, ai: { ...ai } },
    home: { sections: { announcements: true, attendance: true } },
    branding: { displayName: name.slice(0, WORKSPACE_NAME_MAX), primaryColor: "#163B7A", logoUrl: null },
    codeFormats: {
      task: "T-{seq3}",
      project: "P-{seq3}",
      document: "D-{seq3}",
      employee: "EMP-{seq6}",
      // Requests and meetings read in the workspace's language: yêu cầu / họp in Vietnamese, request / meeting otherwise.
      request: locale === "vi" ? "YC-{seq3}" : "R-{seq3}",
      meeting: locale === "vi" ? "H-{seq3}" : "M-{seq3}",
      whiteboard: "W-{seq3}",
    },
    locale,
    timezone: isTimeZone(timezone) ? timezone : DEFAULT_TIME_ZONE,
    currency: (country && CURRENCY_BY_COUNTRY[country]) || currencyFor(isTimeZone(timezone) ? timezone : DEFAULT_TIME_ZONE, locale),
    country,
    mode,
    desktopDownloadUrl: null,
  };
}

/**
 * Modules as the web and the gateway see them: chat and work always, the optional ones as the admin set them,
 * `meet` from the server's own configuration (not a setting: there is nothing to switch on without LiveKit), and
 * the features the deployment left out (`DISABLED_FEATURES`, ADR 0026) as `false` under their own names.
 *
 * A deployment's choice outranks the admin's: without `time` attendance is off whatever Settings says, without
 * `ai` both AI switches read off, so everything that already follows those switches (the gateway's AI routes, the
 * ai module's status, the web's AI surfaces) follows the flag with no second path.
 */
export function effectiveFeatures(config: WorkspaceConfig, env: NodeJS.ProcessEnv = process.env): Record<string, boolean> {
  const { ai, ...modules } = config.features;
  const deployed = deployFeatureMap(env);
  // The two AI switches travel as flat keys like every other module (the gateway gates routes on them).
  // The short navigation is Home and AI: without AI there is nothing short to show, so the full app stays.
  const insightsOnly = config.mode === "insights" && deployed.ai;
  // AI Insights only keeps every route (task sync writes into work, people still sign in); it switches attendance off
  // so the clock-in button and Time leave the shell, and tells the web to show the short navigation.
  return {
    chat: true,
    work: true,
    ...modules,
    ...deployed,
    attendance: modules.attendance && !insightsOnly && deployed.time,
    aiAssistant: ai.assistant && deployed.ai,
    aiMonitoring: ai.monitoring && deployed.ai,
    meet: meetEnabledFromEnv(),
    insightsOnly,
  };
}
