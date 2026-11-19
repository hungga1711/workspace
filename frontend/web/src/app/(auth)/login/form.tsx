"use client";

import type { T } from "@/lib/i18n/core";
import { useT } from "@/lib/i18n/client";
import { control } from "@/lib/ui";
import Link from "next/link";
import { useActionState } from "react";
import { authCta } from "@/lib/ui";
import { login, verifyCode, type LoginState } from "./actions";

const field = `${control} min-h-10 w-full font-normal aria-[invalid=true]:border-block`;
const MESSAGE = (tx: T): Record<string, [string, string]> => ({
  invalid: [tx("signIn.loginForm.email_hoac_mat_khau"), tx("signIn.loginForm.kiem_tra_lai_hoac")],
  locked: [tx("signIn.loginForm.tai_khoan_dang_tam"), tx("signIn.loginForm.do_nhap_sai_nhieu")],
  not_ready: [tx("signIn.loginForm.tai_khoan_chua_kich"), tx("signIn.loginForm.mo_email_moi_va")],
  rate_limited: [tx("signIn.loginForm.ban_da_thu_qua"), tx("signIn.loginForm.vui_long_doi_15")],
  unavailable: [tx("signIn.loginForm.khong_ket_noi_duoc"), tx("signIn.loginForm.thu_lai_sau_it")],
  disabled: [tx("signIn.loginForm.tai_khoan_bi_tat"), tx("signIn.loginForm.dung_tai_khoan_khac")],
  invalid_code: [tx("signIn.loginForm.ma_chua_dung"), tx("signIn.loginForm.kiem_tra_gio")],
  code_used: [tx("signIn.loginForm.codeUsed"), tx("signIn.loginForm.codeUsedHint")],
  expired: [tx("signIn.loginForm.het_thoi_gian"), tx("signIn.loginForm.dang_nhap_lai_tu_dau")],
});

export function LoginForm({ next, email, notice, alert }: { next: string; email: string; notice: string | null; alert?: [string, string] | null }) {
  const tx = useT();
  const [state, action, pending] = useActionState<LoginState, FormData>(login, { error: null, email });
  const m = state.error ? MESSAGE(tx)[state.error] : (alert ?? null);
  if (state.mfa) return <CodeStep next={next} email={state.email} />;
  return (
    <form action={action} className="grid grid-cols-1 gap-4" noValidate={false}>
      {notice ? (
        <p className="bg-ok-wash text-ok rounded-lg px-3.5 py-2.5 text-sm" role="status">
          {notice}
        </p>
      ) : null}
      {m ? (
        <p className="bg-block-wash rounded-lg px-3.5 py-2.5 text-sm" role="alert">
          <b className="text-block font-semibold">{m[0]}</b> {m[1]}
        </p>
      ) : null}
      <input type="hidden" name="next" value={next} />
      <label className="grid gap-1.5 text-sm font-medium">
        {tx("signIn.loginForm.email_cong_viec")}
        <input
          className={field}
          name="email"
          type="email"
          required
          autoComplete="username"
          defaultValue={state.email}
          autoFocus={!state.email}
          aria-invalid={state.error === "invalid" || undefined}
        />
      </label>
      <div className="grid gap-2">
        <label className="grid gap-1.5 text-sm font-medium">
          {tx("signIn.loginForm.mat_khau")}
          <input
            className={field}
            name="password"
            type="password"
            required
            autoComplete="current-password"
            autoFocus={Boolean(state.email)}
            aria-invalid={state.error === "invalid" || undefined}
          />
        </label>
        <Link href="/forgot-password" className="text-brand-text justify-self-end text-sm font-medium no-underline hover:underline">
          {tx("signIn.loginForm.quen_mat_khau")}
        </Link>
      </div>
      <button type="submit" className={`${authCta} w-full`} disabled={pending}>
        {pending ? tx("signIn.loginForm.dang_dang_nhap") : tx("signIn.loginForm.dang_nhap")}
      </button>
    </form>
  );
}

/** Two-step sign-in: the password was right; now the authenticator code (or a recovery code). */
function CodeStep({ next, email }: { next: string; email: string }) {
  const tx = useT();
  const [state, action, pending] = useActionState<LoginState, FormData>(verifyCode, { error: null, email, mfa: true });
  const m = state.error ? MESSAGE(tx)[state.error] : null;
  if (!state.mfa) return <LoginForm next={next} email={state.email} notice={null} alert={m} />;
  return (
    <form action={action} className="grid grid-cols-1 gap-4">
      <div className="grid gap-1">
        <h2 className="m-0 text-base font-semibold">{tx("signIn.loginForm.xac_minh_hai_buoc")}</h2>
        <p className="text-ink-2 m-0 text-sm">{tx("signIn.loginForm.nhap_ma_6_so")}</p>
      </div>
      {m ? (
        <p className="bg-block-wash rounded-lg px-3.5 py-2.5 text-sm" role="alert">
          <b className="text-block font-semibold">{m[0]}</b> {m[1]}
        </p>
      ) : null}
      <input type="hidden" name="next" value={next} />
      <label className="grid gap-1.5 text-sm font-medium">
        {tx("signIn.loginForm.ma_xac_minh")}
        <input
          className={`${field} font-mono tracking-[0.2em]`}
          name="code"
          required
          autoFocus
          autoComplete="one-time-code"
          inputMode="text"
          maxLength={9}
          pattern="[0-9]{6}|[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}"
          aria-invalid={state.error === "invalid_code" || state.error === "code_used" || undefined}
        />
      </label>
      <button type="submit" className={`${authCta} w-full`} disabled={pending}>
        {pending ? tx("signIn.loginForm.dang_xac_nhan") : tx("signIn.loginForm.xac_nhan")}
      </button>
    </form>
  );
}
