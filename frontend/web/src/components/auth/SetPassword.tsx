"use client";

import { control } from "@/lib/ui";
import { useT } from "@/lib/i18n/client";
import { useActionState, useState } from "react";
import { authCta, cx } from "@/lib/ui";
import { setPassword, type SetState } from "@/app/(auth)/reset-password/actions";

const field = `${control} min-h-11 w-full font-normal`;

/** Shared by password reset and invite activation; rules mirror the backend (8+ chars, letters and digits). */
export function SetPasswordForm({ token, email, purpose }: { token: string; email: string; purpose: "reset" | "activate" }) {
  const [state, action, pending] = useActionState<SetState, FormData>(setPassword, { error: null });
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const t = useT();
  const rules = [
    [pw.length >= 8, t("auth.rule8")],
    [/[A-Za-z]/.test(pw) && /\d/.test(pw), t("auth.ruleMix")],
    [pw.length > 0 && pw === pw2, t("auth.ruleMatch")],
  ] as const;
  const ok = rules.every(([v]) => v);
  return (
    <form action={action} className="grid grid-cols-1 gap-4">
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="purpose" value={purpose} />
      <p className="text-ink-2 text-sm">
        {t("auth.account")} <b className="text-ink">{email}</b>
      </p>
      {state.error ? (
        <p className="bg-block-wash text-block rounded-lg px-3.5 py-2.5 text-sm" role="alert">
          {state.error}
        </p>
      ) : null}
      <label className="grid gap-1.5 text-sm font-medium">
        {t("auth.newPassword")}
        <input name="password" type="password" required autoComplete="new-password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} className={field} />
      </label>
      <label className="grid gap-1.5 text-sm font-medium">
        {t("auth.repeatPassword")}
        <input type="password" required autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} className={field} />
      </label>
      <ul className="m-0 grid list-none gap-1 p-0 text-sm" aria-label={t("auth.requirements")}>
        {rules.map(([v, label]) => (
          <li key={label} className={cx("flex items-center gap-2", v ? "text-ok" : "text-ink-2")}>
            <span aria-hidden="true">{v ? "✓" : "○"}</span>
            {label}
          </li>
        ))}
      </ul>
      <button type="submit" className={`${authCta} w-full`} disabled={!ok || pending}>
        {t(pending ? "auth.saving" : purpose === "activate" ? "auth.activate" : "auth.setNew")}
      </button>
    </form>
  );
}
