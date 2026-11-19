"use client";

import { LoadFailed } from "@/components/ui/LoadFailed";
import { useCallback, useEffect, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { api } from "@/lib/client";
import { btn, btnPrimary, btnSm, cx, input, mono } from "@/lib/ui";

interface Status {
  enabled: boolean;
  recoveryCodesLeft: number;
  required: boolean;
}

/**
 * Two-step sign-in (TOTP): set up with an authenticator app, recovery codes shown once, turn off or renew
 * codes with a current code. `gate` is the full-page version a workspace that requires it sends people to.
 */
export function TwoStep({ gate = false }: { gate?: boolean }) {
  const tx = useT();
  const [s, setS] = useState<Status | null>(null);
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string; qr: string | null } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState("");
  const [ask, setAsk] = useState<"disable" | "codes" | null>(null);
  const [busy, setBusy] = useState(false);
  const [bad, setBad] = useState(false);
  const [failed, setFailed] = useState(false);
  const load = useCallback(
    () =>
      void api<Status>("identity/me/mfa")
        .then((r) => {
          setFailed(false);
          setS(r);
        })
        .catch(() => setFailed(true)),
    [],
  );
  useEffect(load, [load]);

  const start = async () => {
    setBusy(true);
    try {
      const r = await api<{ secret: string; otpauthUrl: string }>("identity/me/mfa/setup", { method: "POST" });
      // The QR code library loads only here, when someone actually sets this up.
      const qr = await import("qrcode").then((m) => m.toDataURL(r.otpauthUrl, { margin: 1, width: 176 })).catch(() => null);
      setSetup({ ...r, qr });
      setCode("");
    } finally {
      setBusy(false);
    }
  };
  const enable = async () => {
    setBusy(true);
    setBad(false);
    try {
      const r = await api<{ recoveryCodes: string[] }>("identity/me/mfa/enable", { method: "POST", body: { code } });
      setCodes(r.recoveryCodes);
      setSetup(null);
      setCode("");
    } catch {
      setBad(true);
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    setBusy(true);
    setBad(false);
    try {
      if (ask === "disable") await api("identity/me/mfa/disable", { method: "POST", body: { code } });
      else setCodes((await api<{ recoveryCodes: string[] }>("identity/me/mfa/recovery-codes", { method: "POST", body: { code } })).recoveryCodes);
      setAsk(null);
      setCode("");
      load();
    } catch {
      setBad(true);
    } finally {
      setBusy(false);
    }
  };
  const finish = () => {
    setCodes(null);
    if (gate) window.location.assign("/app/home");
    else load();
  };

  const codeInput = (
    <input
      className={cx(input, mono, "max-w-[180px] tracking-[0.2em]")}
      value={code}
      onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
      inputMode="numeric"
      autoComplete="one-time-code"
      aria-label={tx("auth.twoStep.code")}
      aria-invalid={bad || undefined}
      autoFocus
    />
  );

  if (codes)
    return (
      <div className="grid gap-3 text-sm" role="region" aria-label={tx("auth.twoStep.title")}>
        <p className="bg-warn-wash text-warn m-0 rounded-lg px-3 py-2">{tx("auth.twoStep.saveCodes")}</p>
        <ul className={cx(mono, "m-0 grid list-none grid-cols-2 gap-1.5 p-0 text-sm")}>
          {codes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <button type="button" className={cx(btnPrimary, "justify-self-start")} onClick={finish}>
          {tx("auth.twoStep.done")}
        </button>
      </div>
    );

  if (setup)
    return (
      <div className="grid gap-3 text-sm">
        <p className="m-0">{tx("auth.twoStep.step1")}</p>
        <div className="flex flex-wrap items-center gap-4">
          {setup.qr ? <img src={setup.qr} alt="" width={176} height={176} className="border-hairline rounded-md border bg-white" /> : null}
          <div className="grid gap-1.5">
            <code className={cx(mono, "break-all text-sm")}>{setup.secret.replace(/(.{4})/g, "$1 ").trim()}</code>
            <a href={setup.otpauthUrl} className="text-brand-text text-sm font-medium no-underline hover:underline">
              {tx("auth.twoStep.openApp")}
            </a>
          </div>
        </div>
        <p className="m-0">{tx("auth.twoStep.step2")}</p>
        <div className="flex flex-wrap items-center gap-2">
          {codeInput}
          <button type="button" className={btnPrimary} disabled={busy || code.length !== 6} onClick={() => void enable()}>
            {busy ? tx("auth.twoStep.enabling") : tx("auth.twoStep.enable")}
          </button>
        </div>
        {bad ? (
          <p className="text-block m-0" role="alert">
            {tx("auth.twoStep.badCode")}
          </p>
        ) : null}
      </div>
    );

  // A failed read says so with a retry, instead of leaving an empty card.
  if (failed) return <LoadFailed onRetry={load} />;
  if (!s) return null;
  if (!s.enabled)
    return (
      <div className="grid gap-2 text-sm">
        {gate ? null : <p className="m-0 text-sm font-medium">{tx("auth.twoStep.title")}</p>}
        <p className="text-ink-2 m-0">{s.required ? tx("auth.twoStep.required") : tx("auth.twoStep.off")}</p>
        <button type="button" className={cx(gate ? btnPrimary : btn, "justify-self-start")} disabled={busy} onClick={() => void start()}>
          {tx("auth.twoStep.start")}
        </button>
      </div>
    );

  return (
    <div className="grid gap-2 text-sm">
      <p className="m-0 text-sm font-medium">{tx("auth.twoStep.title")}</p>
      <p className="text-ink-2 m-0">
        {tx("auth.twoStep.on")} {tx("auth.twoStep.codesLeft", { p0: s.recoveryCodesLeft })}
      </p>
      {ask ? (
        <div className="grid gap-2">
          <p className="m-0">{tx("auth.twoStep.askCode")}</p>
          <div className="flex flex-wrap items-center gap-2">
            {codeInput}
            <button type="button" className={btnPrimary} disabled={busy || code.length !== 6} onClick={() => void confirm()}>
              {tx("auth.twoStep.confirm")}
            </button>
            <button type="button" className={btn} onClick={() => setAsk(null)}>
              {tx("auth.twoStep.cancel")}
            </button>
          </div>
          {bad ? (
            <p className="text-block m-0" role="alert">
              {tx("auth.twoStep.badCode")}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button type="button" className={cx(btn, btnSm)} onClick={() => setAsk("codes")}>
            {tx("auth.twoStep.newCodes")}
          </button>
          {s.required ? (
            <span className="text-ink-2 text-xs">{tx("auth.twoStep.requiredNoDisable")}</span>
          ) : (
            <button type="button" className={cx(btn, btnSm)} onClick={() => setAsk("disable")}>
              {tx("auth.twoStep.disable")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
