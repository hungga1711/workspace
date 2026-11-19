"use client";

import { useT } from "@/lib/i18n/client";
import Link from "next/link";
import { useActionState } from "react";
import { control, authCta, authCard, cx } from "@/lib/ui";
import { requestReset, type ForgotState } from "./actions";

export default function ForgotPassword() {
  const tx = useT();
  const [state, action, pending] = useActionState<ForgotState, FormData>(requestReset, { sent: false, error: null, email: "" });
  return (
    <div className={cx(authCard, "!shadow-hero")}>
      <h1 className="font-display m-0 mb-1 text-center text-xl font-semibold tracking-tight">{tx("signIn.forgotPasswordPage.quen_mat_khau")}</h1>
      {state.sent && state.mailConfigured === false ? (
        <div className="mt-3 grid gap-4" role="status">
          <p className="text-sm">{tx("signIn.forgotPasswordPage.noMailTitle")}</p>
          <p className="text-ink-2 text-sm">{tx("signIn.forgotPasswordPage.noMailBody")}</p>
          <Link href="/login" className={`${authCta} w-full`}>
            {tx("signIn.forgotPasswordPage.quay_lai_dang_nhap")}
          </Link>
        </div>
      ) : state.sent ? (
        <div className="mt-3 grid gap-4" role="status">
          <p className="text-sm">
            {tx("signIn.forgotPasswordPage.neu")} <b>{state.email}</b> {tx("signIn.forgotPasswordPage.co_tai_khoan_la")}
          </p>
          <p className="text-ink-2 text-sm">{tx("signIn.forgotPasswordPage.khong_thay_email_kiem")}</p>
          <Link href="/login" className={`${authCta} w-full`}>
            {tx("signIn.forgotPasswordPage.quay_lai_dang_nhap")}
          </Link>
        </div>
      ) : (
        <form action={action} className="mt-1 grid gap-4">
          <p className="text-ink-2 -mt-1 text-center text-sm">{tx("signIn.forgotPasswordPage.nhap_email_cong_viec")}</p>
          {state.error ? (
            <p className="bg-block-wash text-block rounded-lg px-3.5 py-2.5 text-sm" role="alert">
              {state.error === "rate_limited" ? tx("signIn.forgotPasswordPage.ban_da_yeu_cau") : tx("signIn.forgotPasswordPage.chua_gui_duoc_yeu")}
            </p>
          ) : null}
          <label className="grid gap-1.5 text-sm font-medium">
            {tx("signIn.forgotPasswordPage.email_cong_viec")}
            <input name="email" type="email" required autoComplete="email" defaultValue={state.email} autoFocus className={`${control} min-h-11 font-normal`} />
          </label>
          <button type="submit" className={`${authCta} w-full`} disabled={pending}>
            {pending ? tx("signIn.forgotPasswordPage.dang_gui") : tx("signIn.forgotPasswordPage.gui_lien_ket_dat")}
          </button>
          <p className="text-center text-sm">
            <Link href="/login">{tx("signIn.forgotPasswordPage.quay_lai_dang_nhap")}</Link>
          </p>
        </form>
      )}
    </div>
  );
}
