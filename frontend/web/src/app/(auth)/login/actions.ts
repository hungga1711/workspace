"use server";

import { redirect } from "next/navigation";
import { demoLogin, mfaLogin, passwordLogin, safeNext, type LoginError } from "@/lib/auth";
import { config } from "@/lib/config";

export interface LoginState {
  error: LoginError | null;
  email: string;
  /** The password was right and the account uses two-step sign-in: ask for the code next. */
  mfa?: boolean;
}

export async function login(_prev: LoginState, form: FormData): Promise<LoginState> {
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");
  const r = await passwordLogin(email, password);
  if (!r.ok) return "mfa" in r ? { error: null, email, mfa: true } : { error: r.error, email };
  redirect(afterLogin(r.mustChangePassword, String(form.get("next") ?? "")));
}

export async function verifyCode(prev: LoginState, form: FormData): Promise<LoginState> {
  const r = await mfaLogin(String(form.get("code") ?? "").trim());
  if (!r.ok) return r.error === "expired" ? { error: "expired", email: prev.email } : { error: r.error, email: prev.email, mfa: true };
  redirect(afterLogin(r.mustChangePassword, String(form.get("next") ?? "")));
}

/** Demo quick sign-in (DEMO_MODE=1): one button per seeded role, straight into the app. */
export async function demoSignIn(form: FormData): Promise<void> {
  const as = String(form.get("as") ?? "");
  if (!config.demoMode || (as !== "owner" && as !== "manager" && as !== "staff")) redirect("/login");
  if (!(await demoLogin(as))) redirect("/login?notice=demo_failed");
  // Each role lands where AI Insights shows best from that side.
  redirect(as === "staff" ? "/app/me?tab=ai" : as === "owner" ? "/app/ai/adoption/usage" : "/app");
}

/** A temporary password (set by an admin or the inviter) is replaced before anything else; the gateway enforces it too. */
function afterLogin(mustChangePassword: boolean, next: string): string {
  const to = safeNext(next);
  return mustChangePassword ? `/change-password?next=${encodeURIComponent(to)}` : to;
}
