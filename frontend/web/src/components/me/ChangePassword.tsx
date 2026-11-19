"use client";

import { useT } from "@/lib/i18n/client";
import { useState } from "react";
import { api } from "@/lib/client";
import { btn, btnPrimary, cx, input } from "@/lib/ui";
import { Modal } from "@/components/ui/Modal";
import { Field } from "@/components/ui/bits";

/** The fields and rules of a password change; the identity module checks the current password first. */
function usePasswordChange(onDone: () => void) {
  const tx = useT();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const rules = [
    [next.length >= 8, tx("me.changepassword.it_nhat_8_ky")],
    [/[A-Za-z]/.test(next) && /\d/.test(next), tx("me.changepassword.chu_va_so")],
    [next.length > 0 && next === again, tx("me.changepassword.khop")],
    [next.length > 0 && next !== current, tx("me.changepassword.khac_hien_tai")],
  ] as const;
  const ok = current.length > 0 && rules.every(([v]) => v);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("identity/me/password", { method: "POST", body: { current, next } });
      onDone();
    } catch (e) {
      const b = e as { status?: number; body?: { error?: string } };
      setError(
        b.body?.error === "wrong_password" || b.status === 401
          ? tx("me.changepassword.mat_khau_hien_tai_2")
          : b.body?.error === "weak_password"
            ? tx("me.changepassword.mat_khau_moi_chua")
            : tx("me.changepassword.chua_doi_duoc_mat"),
      );
    } finally {
      setBusy(false);
    }
  };
  const fields = (
    <div className="grid grid-cols-1 gap-4">
      {error ? (
        <p className="bg-block-wash text-block rounded-lg px-3 py-2 text-sm" role="alert">
          {error}
        </p>
      ) : null}
      <Field label={tx("me.changepassword.mat_khau_hien_tai")}>
        <input className={input} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </Field>
      <Field label={tx("me.changepassword.mat_khau_moi")}>
        <input className={input} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
      </Field>
      <Field label={tx("me.changepassword.nhap_lai_mat_khau")}>
        <input className={input} type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
      </Field>
      <ul className="m-0 grid list-none gap-1 p-0 text-sm" aria-label={tx("me.changepassword.yeu_cau_mat_khau")}>
        {rules.map(([v, label]) => (
          <li key={label} className={cx("flex items-center gap-2", v ? "text-ok" : "text-ink-2")}>
            <span aria-hidden="true">{v ? "✓" : "○"}</span>
            {label}
          </li>
        ))}
      </ul>
    </div>
  );
  return { fields, ok, busy, submit };
}

/** Change password while signed in (Me › Security). */
export function ChangePasswordModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const tx = useT();
  const { fields, ok, busy, submit } = usePasswordChange(onDone);
  return (
    <Modal
      title={tx("me.changepassword.doi_mat_khau")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btn} onClick={onClose}>
            {tx("me.changepassword.huy")}
          </button>
          <button type="button" className={btnPrimary} disabled={!ok || busy} onClick={() => void submit()}>
            {busy ? tx("me.changepassword.dang_luu") : tx("me.changepassword.doi_mat_khau")}
          </button>
        </>
      }
    >
      {fields}
    </Modal>
  );
}

/** The forced change after a temporary password (/change-password): a plain form, then on to the app. */
export function ChangePasswordForm({ next }: { next: string }) {
  const tx = useT();
  // A full navigation: the session's token predates the change and the next request refreshes it.
  const { fields, ok, busy, submit } = usePasswordChange(() => window.location.assign(next));
  return (
    <form
      className="grid gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok && !busy) void submit();
      }}
    >
      {fields}
      <button type="submit" className={cx(btnPrimary, "w-full")} disabled={!ok || busy}>
        {busy ? tx("me.changepassword.dang_luu") : tx("me.changepassword.doi_mat_khau")}
      </button>
    </form>
  );
}
