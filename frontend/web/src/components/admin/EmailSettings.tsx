"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { useT } from "@/lib/i18n/client";
import { btn, btnGhost, btnPrimary, btnSm, chipOk, chipWarn, cx, input } from "@/lib/ui";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { useConfirm } from "@/components/ui/Confirm";

type Security = "tls" | "starttls" | "none";
type Provider = "google" | "microsoft" | "resend" | "sendgrid" | "mailgun" | "ses" | "postmark" | "custom";

interface Saved {
  provider: Provider;
  host: string;
  port: number;
  security: Security;
  username: string | null;
  hasPassword: boolean;
  fromAddress: string;
  fromName: string | null;
}

interface Status {
  configured: boolean;
  from: string | null;
  source: "app" | "env" | null;
}

/** Known providers: host, port and how to sign in, so the admin only pastes a password or key. */
const PRESETS: Record<Provider, { host: string; port: number; security: Security; username?: string }> = {
  google: { host: "smtp.gmail.com", port: 587, security: "starttls" },
  microsoft: { host: "smtp.office365.com", port: 587, security: "starttls" },
  resend: { host: "smtp.resend.com", port: 465, security: "tls", username: "resend" },
  sendgrid: { host: "smtp.sendgrid.net", port: 587, security: "starttls", username: "apikey" },
  mailgun: { host: "smtp.mailgun.org", port: 587, security: "starttls" },
  ses: { host: "email-smtp.us-east-1.amazonaws.com", port: 587, security: "starttls" },
  postmark: { host: "smtp.postmarkapp.com", port: 587, security: "starttls" },
  custom: { host: "", port: 587, security: "starttls" },
};
const PROVIDERS = Object.keys(PRESETS) as Provider[];

interface Form {
  provider: Provider;
  host: string;
  port: string;
  security: Security;
  username: string;
  password: string;
  fromAddress: string;
  fromName: string;
}

const fromSaved = (s: Saved | null): Form =>
  s
    ? {
        provider: s.provider,
        host: s.host,
        port: String(s.port),
        security: s.security,
        username: s.username ?? "",
        password: "",
        fromAddress: s.fromAddress,
        fromName: s.fromName ?? "",
      }
    : { provider: "google", host: PRESETS.google.host, port: String(PRESETS.google.port), security: "starttls", username: "", password: "", fromAddress: "", fromName: "" };

/**
 * Admin › Settings › Email: the company's mail server, entered here and used at once (no .env, no restart). Presets
 * fill host, port and security for the common providers; the password is stored sealed and never shown again. Without
 * email, invites and password resets are handed over as links.
 */
export function EmailSettings() {
  const t = useT();
  const { confirm, dialog } = useConfirm();
  const [status, setStatus] = useState<Status | null | "failed">(null);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [form, setForm] = useState<Form>(fromSaved(null));
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<"" | "save" | "test" | "clear">("");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const load = () =>
    Promise.all([api<Status>("identity/mail/status"), api<{ settings: Saved | null }>("identity/mail/settings")])
      .then(([st, s]) => {
        setStatus(st);
        setSaved(s.settings);
        setForm(fromSaved(s.settings));
      })
      .catch(() => setStatus("failed"));
  useEffect(() => {
    void load();
  }, []);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const pick = (p: Provider) => {
    const pre = PRESETS[p];
    setForm((f) => ({
      ...f,
      provider: p,
      host: pre.host || f.host,
      port: String(pre.port),
      security: pre.security,
      username: pre.username ?? (p === "google" || p === "microsoft" ? f.fromAddress : f.username),
    }));
  };
  const body = () => ({
    provider: form.provider,
    host: form.host.trim(),
    port: Number(form.port),
    security: form.security,
    username: form.username.trim() || null,
    password: form.password,
    fromAddress: form.fromAddress.trim(),
    fromName: form.fromName.trim() || null,
  });
  const valid = form.host.trim() && Number(form.port) > 0 && /\S+@\S+\.\S+/.test(form.fromAddress.trim());

  const describe = (r: { ok: boolean; to: string; error: string | null }) =>
    r.ok ? t("admin.email.sent", { to: r.to }) : r.error && r.error !== "mail_not_configured" ? t("admin.email.failedWith", { error: r.error }) : t("admin.email.failed");

  const test = async (draft: boolean) => {
    setBusy("test");
    setResult(null);
    try {
      const r = await api<{ ok: boolean; to: string; error: string | null }>("identity/mail/test", { method: "POST", body: draft ? body() : {} });
      setResult({ ok: r.ok, text: describe(r) });
    } catch {
      setResult({ ok: false, text: t("admin.email.failed") });
    } finally {
      setBusy("");
    }
  };
  const save = async () => {
    setBusy("save");
    setResult(null);
    try {
      await api("identity/mail/settings", { method: "PUT", body: body() });
      setEditing(false);
      await load();
      setResult({ ok: true, text: t("admin.email.saved") });
    } catch {
      setResult({ ok: false, text: t("admin.email.saveFailed") });
    } finally {
      setBusy("");
    }
  };
  const clear = async () => {
    if (!(await confirm({ title: t("admin.email.clearTitle"), body: t("admin.email.clearBody"), confirmLabel: t("admin.email.clear"), danger: true }))) return;
    setBusy("clear");
    try {
      await api("identity/mail/settings", { method: "DELETE" });
      await load();
    } finally {
      setBusy("");
    }
  };

  if (status === "failed") return <LoadFailed onRetry={() => void load()} />;
  if (!status) return <span className="shimmer block h-4 w-2/5 rounded-md" />;

  const showForm = editing || !status.configured;
  const field = (id: keyof Form, label: string, el: React.ReactNode, hint?: string) => (
    <label htmlFor={`mail-${id}`} className="grid min-w-0 gap-1">
      <span className="text-ink text-xs font-medium">{label}</span>
      {el}
      {hint ? <span className="text-ink-2 text-xs">{hint}</span> : null}
    </label>
  );
  const pwHint =
    form.provider === "google"
      ? t("admin.email.hintGoogle")
      : form.provider === "microsoft"
        ? t("admin.email.hintMicrosoft")
        : ["resend", "sendgrid", "postmark"].includes(form.provider)
          ? t("admin.email.hintApiKey")
          : undefined;

  return (
    <div className="grid gap-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        {status.configured ? <span className={chipOk}>{t("admin.email.on")}</span> : <span className={chipWarn}>{t("admin.email.off")}</span>}
        {status.from ? <span className="text-ink-2 min-w-0 truncate">{t("admin.email.from", { from: status.from })}</span> : null}
        {status.source === "env" ? <span className="text-ink-2">· {t("admin.email.fromEnv")}</span> : null}
      </div>

      {!showForm ? (
        <div className="grid gap-3">
          <p className="text-ink-2 m-0">{saved ? t("admin.email.onSaved", { host: saved.host }) : t("admin.email.onBody")}</p>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={cx(btn, btnSm)} disabled={!!busy} onClick={() => void test(false)}>
              {busy === "test" ? t("admin.email.sending") : t("admin.email.test")}
            </button>
            <button type="button" className={cx(btn, btnSm)} onClick={() => setEditing(true)}>
              {saved ? t("admin.email.change") : t("admin.email.useApp")}
            </button>
            {saved ? (
              <button type="button" className={cx(btnGhost, btnSm)} disabled={!!busy} onClick={() => void clear()}>
                {t("admin.email.clear")}
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) void save();
          }}
        >
          {!status.configured ? <p className="text-ink-2 m-0">{t("admin.email.offBodyApp")}</p> : null}
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t("admin.email.provider")}>
            {PROVIDERS.map((p) => (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={form.provider === p}
                onClick={() => pick(p)}
                className={cx(btn, btnSm, form.provider === p && "bg-selected text-ink shadow-[0_0_0_1px_var(--ink-2)]")}
              >
                {t(`admin.email.providers.${p}`)}
              </button>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {field(
              "fromAddress",
              t("admin.email.fromAddress"),
              <input
                id="mail-fromAddress"
                type="email"
                autoComplete="off"
                className={input}
                value={form.fromAddress}
                onChange={(e) => set("fromAddress", e.target.value)}
                placeholder="no-reply@example.com"
                required
              />,
            )}
            {field(
              "fromName",
              t("admin.email.fromName"),
              <input id="mail-fromName" className={input} value={form.fromName} onChange={(e) => set("fromName", e.target.value)} placeholder={t("admin.email.fromNamePh")} />,
            )}
            {field(
              "host",
              t("admin.email.host"),
              <input id="mail-host" className={input} value={form.host} onChange={(e) => set("host", e.target.value)} placeholder="smtp.example.com" required />,
              form.provider === "ses" ? t("admin.email.hintSes") : undefined,
            )}
            <div className="grid grid-cols-2 gap-3">
              {field(
                "port",
                t("admin.email.port"),
                <input id="mail-port" inputMode="numeric" className={input} value={form.port} onChange={(e) => set("port", e.target.value.replace(/\D/g, ""))} required />,
              )}
              {field(
                "security",
                t("admin.email.security"),
                <select id="mail-security" className={input} value={form.security} onChange={(e) => set("security", e.target.value as Security)}>
                  <option value="starttls">STARTTLS</option>
                  <option value="tls">SSL/TLS</option>
                  <option value="none">{t("admin.email.securityNone")}</option>
                </select>,
              )}
            </div>
            {field(
              "username",
              t("admin.email.username"),
              <input id="mail-username" autoComplete="off" className={input} value={form.username} onChange={(e) => set("username", e.target.value)} />,
            )}
            {field(
              "password",
              t("admin.email.password"),
              <input
                id="mail-password"
                type="password"
                autoComplete="new-password"
                className={input}
                value={form.password}
                onChange={(e) => set("password", e.target.value)}
                placeholder={saved?.hasPassword ? t("admin.email.passwordKept") : ""}
              />,
              pwHint,
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="submit" className={cx(btnPrimary, btnSm)} disabled={!valid || !!busy}>
              {busy === "save" ? t("admin.email.saving") : t("admin.email.save")}
            </button>
            <button type="button" className={cx(btn, btnSm)} disabled={!valid || !!busy} onClick={() => void test(true)}>
              {busy === "test" ? t("admin.email.sending") : t("admin.email.testForm")}
            </button>
            {status.configured ? (
              <button
                type="button"
                className={cx(btnGhost, btnSm)}
                onClick={() => {
                  setEditing(false);
                  setForm(fromSaved(saved));
                }}
              >
                {t("common.cancel")}
              </button>
            ) : null}
          </div>
        </form>
      )}
      {dialog}
      {result ? (
        <p role="status" className={cx("m-0", result.ok ? "text-ok" : "text-block")}>
          {result.text}
        </p>
      ) : null}
    </div>
  );
}
