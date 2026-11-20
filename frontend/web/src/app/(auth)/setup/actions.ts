"use server";

import { getLocale } from "@/lib/i18n/server";
import { isLocale } from "@/lib/i18n/config";
import { headers } from "next/headers";
import { publicGateway } from "@/lib/public-gateway";
import { redirect } from "next/navigation";
import { REQUEST_ID_HEADER, requestIdFrom } from "@/lib/request-id";
import { passwordLogin } from "@/lib/auth";
import { isCountry } from "@/lib/country";
import { applyCountryDefaults } from "@/lib/country-defaults";

export type SetupError = "already_set_up" | "rate_limited" | "invalid" | "unavailable" | "setup_token" | "weak_password";
export interface SetupState {
  error: SetupError | null;
  detail?: string;
  /** weak_password: which rule failed (an i18n key under signIn.resetPasswordActions, the activation page's wording). */
  passwordError?: string;
  requestId?: string;
  fields: Record<string, string>;
}

/**
 * First-run setup: creates the workspace and its owner, then signs the owner in.
 * Each failure gets its own message and keeps what was typed.
 */
export async function setup(_prev: SetupState, form: FormData): Promise<SetupState> {
  const fields = {
    companyName: String(form.get("companyName") ?? ""),
    ownerName: String(form.get("ownerName") ?? ""),
    ownerEmail: String(form.get("ownerEmail") ?? ""),
    timezone: String(form.get("timezone") ?? ""),
    country: String(form.get("country") ?? ""),
    setupToken: String(form.get("setupToken") ?? ""),
    // The two AI switches (checkboxes: present only when ticked), kept as strings so a failed submit re-ticks them.
    aiAssistant: form.get("aiAssistant") ? "1" : "",
    aiMonitoring: form.get("aiMonitoring") ? "1" : "",
    mode: form.get("mode") === "insights" ? "insights" : "full",
  };
  // The company's language: the radio on the form (it also set the cookie), else whatever this page is shown in.
  const chosen = form.get("locale");
  const locale = isLocale(chosen) ? chosen : await getLocale();
  const requestId = requestIdFrom((await headers()).get(REQUEST_ID_HEADER));
  let res: Response;
  try {
    res = await publicGateway(
      "/api/signup",
      {
        ...fields,
        timezone: fields.timezone || undefined,
        country: isCountry(fields.country) ? fields.country : undefined,
        setupToken: fields.setupToken || undefined,
        aiAssistant: fields.aiAssistant === "1",
        // AI Insights only needs the extension's records: the platform turns monitoring on with it.
        aiMonitoring: fields.aiMonitoring === "1" || fields.mode === "insights",
        mode: fields.mode,
        password: String(form.get("password") ?? ""),
        locale,
      },
      requestId,
    );
  } catch {
    return { error: "unavailable", requestId, fields };
  }
  if (res.status === 429) return { error: "rate_limited", fields };
  if (res.status === 409) return { error: "already_set_up", fields };
  if (res.status === 403) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    if (body?.error === "setup_token") return { error: "setup_token", fields };
    return { error: "unavailable", requestId, fields };
  }
  if (res.status === 400) {
    const body = (await res.json().catch(() => null)) as { error?: string; message?: string; reason?: string } | null;
    if (body?.error === "weak_password") {
      const reason = body.reason === "too_long" ? "pw_too_long" : body.reason === "letters_and_digits" ? "pw_letters_digits" : "pw_too_short";
      return { error: "weak_password", passwordError: reason, fields };
    }
    return { error: "invalid", detail: body?.message ?? body?.error, fields };
  }
  if (!res.ok) return { error: "unavailable", requestId, fields };
  const signedIn = await passwordLogin(fields.ownerEmail, String(form.get("password") ?? ""));
  // The country's holidays, work week and annual leave, as a starting point the admin can change. Never blocks setup:
  // the Admin overview's setup checklist still points at holidays if this did not go through.
  if (signedIn.ok && isCountry(fields.country)) await applyCountryDefaults(fields.country).catch(() => undefined);
  redirect(signedIn.ok ? "/app/welcome" : `/login?email=${encodeURIComponent(fields.ownerEmail)}&next=${encodeURIComponent("/app/welcome")}`);
}
