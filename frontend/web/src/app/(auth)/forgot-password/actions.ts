"use server";

import { publicGateway } from "@/lib/public-gateway";
import { getLocale } from "@/lib/i18n/server";

export interface ForgotState {
  sent: boolean;
  error: "rate_limited" | "unavailable" | null;
  email: string;
  /** False when this server cannot send email: the screen says to ask an admin instead of waiting for one. */
  mailConfigured?: boolean;
}

/** Asks the backend to email a reset link. The answer is the same whether the account exists or not. */
export async function requestReset(_prev: ForgotState, form: FormData): Promise<ForgotState> {
  const email = String(form.get("email") ?? "").trim();
  let mailConfigured = true;
  try {
    const res = await publicGateway("/api/auth/password-reset", { email, locale: await getLocale() });
    if (res.status === 429) return { sent: false, error: "rate_limited", email };
    if (!res.ok && res.status !== 400) return { sent: false, error: "unavailable", email };
    const body = (await res.json().catch(() => null)) as { mailConfigured?: boolean } | null;
    if (body?.mailConfigured === false) mailConfigured = false;
  } catch {
    return { sent: false, error: "unavailable", email };
  }
  return { sent: true, error: null, email, mailConfigured };
}
