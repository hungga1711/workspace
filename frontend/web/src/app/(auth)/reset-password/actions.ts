"use server";

import { redirect } from "next/navigation";
import { getT } from "@/lib/i18n/server";
import { passwordLogin } from "@/lib/auth";
import { publicGateway } from "@/lib/public-gateway";

export interface SetState {
  error: string | null;
}

const post = (path: string, body: unknown) => publicGateway(`/api/auth/${path}`, body);

/** Looks up a reset/activation link without consuming it (for the page header). */
export async function inspectToken(token: string): Promise<{ email: string; purpose: "reset" | "activate" } | null> {
  if (!token) return null;
  const res = await post("token", { token }).catch(() => null);
  return res?.ok ? ((await res.json()) as { email: string; purpose: "reset" | "activate" }) : null;
}

export async function setPassword(_prev: SetState, form: FormData): Promise<SetState> {
  const tx = await getT();
  const token = String(form.get("token") ?? "");
  const password = String(form.get("password") ?? "");
  const res = await post("password-set", { token, password }).catch(() => null);
  if (!res) return { error: tx("signIn.resetPasswordActions.khong_ket_noi_duoc") };
  if (res.status === 404) return { error: tx("signIn.resetPasswordActions.lien_ket_da_het") };
  if (res.status === 429) return { error: tx("signIn.resetPasswordActions.ban_da_thu_qua") };
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { error?: string; reason?: string };
    if (b.error === "weak_password") {
      const reason = b.reason === "too_long" ? "pw_too_long" : b.reason === "letters_and_digits" ? "pw_letters_digits" : "pw_too_short";
      return { error: tx(`signIn.resetPasswordActions.${reason}`) };
    }
    return { error: tx("signIn.resetPasswordActions.chua_dat_duoc_mat") };
  }
  const done = (await res.json()) as { email: string; purpose: string };
  // Activation signs the new member straight in; a reset sends them to sign in fresh.
  if (done.purpose === "activate") {
    const r = await passwordLogin(done.email, password);
    if (r.ok) redirect("/app/home");
    redirect(`/login?notice=activated&email=${encodeURIComponent(done.email)}`);
  }
  redirect(`/login?notice=reset&email=${encodeURIComponent(done.email)}`);
}
