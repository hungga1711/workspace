"use client";

import { useState } from "react";
import { api } from "@/lib/client";
import { useT } from "@/lib/i18n/client";
import type { McpAuth, McpPreset } from "@/lib/mcp-gallery";
import { finishInPopup, openBlank } from "@/lib/mcp-oauth";
import { btn, btnPrimary, cx, input, mono } from "@/lib/ui";
import { Modal } from "@/components/ui/Modal";
import { Field } from "@/components/ui/bits";
import { Checkbox } from "@/components/ui/Checkbox";
import { Segmented } from "@/components/ui/Segmented";
import { Gallery } from "./McpGallery";
import type { McpServer } from "./McpServersAdmin";

interface Check {
  ok: boolean;
  error: string | null;
  oauth: boolean;
  serverInfo?: { name?: string; version?: string };
  tools?: number;
}

/**
 * Adding or editing an MCP server. A new one starts at the gallery (or a preset picked from it); the form takes the
 * address, how it signs in and who may use it. Saving tests it at once (and opens the OAuth sign-in for a company
 * account), so the admin lands on a card that already lists the server's tools.
 */
export function McpServerDialog({
  server,
  preset,
  departments,
  redirectUri,
  onClose,
  onSaved,
}: {
  server?: McpServer | undefined;
  /** From the gallery: null for "another server"; undefined opens the gallery first. */
  preset?: McpPreset | null | undefined;
  departments: { id: string; name: string }[];
  redirectUri: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const [picking, setPicking] = useState(!server && preset === undefined);
  const [presetId, setPresetId] = useState<string | null>(server?.preset ?? preset?.id ?? null);
  const [name, setName] = useState(server?.name ?? preset?.name ?? "");
  const [url, setUrl] = useState(server?.url ?? preset?.url ?? "");
  const [auth, setAuth] = useState<McpAuth>(server?.auth ?? preset?.auth ?? "none");
  const [headerName, setHeaderName] = useState(server?.headerName ?? preset?.headerName ?? "");
  const [secret, setSecret] = useState("");
  const [perUser, setPerUser] = useState(server?.oauthPerUser ?? preset?.perUser ?? false);
  const [clientId, setClientId] = useState(server?.oauthClientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [audience, setAudience] = useState<McpServer["audience"]>(server?.audience ?? "everyone");
  const [deptIds, setDeptIds] = useState<string[]>(server?.departmentIds ?? []);
  const [enabled, setEnabled] = useState(server?.enabled ?? true);
  const [check, setCheck] = useState<Check | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pick = (p: McpPreset | null) => {
    setPicking(false);
    setPresetId(p?.id ?? null);
    setName(p?.name ?? "");
    setUrl(p?.url ?? "");
    setAuth(p?.auth ?? "none");
    setHeaderName(p?.headerName ?? "");
    setPerUser(p?.perUser ?? false);
  };
  // The stored token stays only for the same address and kind of sign-in (as the server decides).
  const keepsSecret = !!server?.secretHint && server.url === url.trim() && server.auth === "header";
  const problem = (e: unknown) => {
    const b = (e as { body?: { issues?: { path: string; message: string }[]; message?: string } }).body;
    return b?.issues?.length ? b.issues.map((i) => `${i.path}: ${i.message}`).join("; ") : (b?.message ?? t("mcpClient.failed"));
  };
  const runCheck = async () => {
    setChecking(true);
    setError(null);
    try {
      setCheck(
        await api<Check>("ai/mcp/check", {
          method: "POST",
          body: {
            url: url.trim(),
            ...(auth === "header" && headerName.trim() ? { headerName: headerName.trim() } : {}),
            ...(auth === "header" && secret.trim() ? { secret: secret.trim() } : {}),
            ...(server ? { id: server.id } : {}),
          },
        }),
      );
    } catch (e) {
      setError(problem(e));
    } finally {
      setChecking(false);
    }
  };
  const save = async () => {
    // A company sign-in follows the save: its popup opens on this click, or a blocker would stop it.
    const signIn = auth === "oauth" && !perUser && (!server || server.auth !== "oauth" || server.url !== url.trim() || !server.connected);
    const win = signIn ? openBlank() : null;
    setSaving(true);
    setError(null);
    try {
      const body = {
        name: name.trim(),
        url: url.trim(),
        preset: presetId,
        auth,
        ...(auth === "header" && headerName.trim() ? { headerName: headerName.trim() } : {}),
        ...(auth === "header" && secret.trim() ? { secret: secret.trim() } : {}),
        ...(auth === "oauth" ? { oauthPerUser: perUser } : {}),
        ...(auth === "oauth" && clientId.trim() ? { oauthClientId: clientId.trim() } : {}),
        ...(auth === "oauth" && clientSecret.trim() ? { oauthClientSecret: clientSecret.trim() } : {}),
        audience,
        departmentIds: audience === "departments" ? deptIds : [],
        enabled,
      };
      const r = await api<{ server: McpServer }>(server ? `ai/mcp/servers/${server.id}` : "ai/mcp/servers", { method: server ? "PATCH" : "POST", body });
      if (signIn) {
        const start = await api<{ url: string }>(`ai/mcp/servers/${r.server.id}/oauth/start`, { method: "POST" });
        await finishInPopup(win, start.url);
      } else if (auth !== "oauth") {
        // Reads the server's name and tools now, so the card is complete; a failure shows on the card.
        await api(`ai/mcp/servers/${r.server.id}/test`, { method: "POST" }).catch(() => undefined);
      }
      onSaved();
    } catch (e) {
      win?.close();
      setError(problem(e));
      setSaving(false);
    }
  };
  const canSave = name.trim() && url.trim() && (auth !== "header" || secret.trim() || keepsSecret) && (audience !== "departments" || deptIds.length > 0);
  const checkLine = check
    ? check.ok
      ? { ok: true, text: t("mcpClient.check.ok", { server: [check.serverInfo?.name, check.serverInfo?.version].filter(Boolean).join(" ") || name, count: check.tools ?? 0 }) }
      : check.error === "needs_auth"
        ? { ok: false, text: check.oauth ? t("mcpClient.check.oauth") : t("mcpClient.check.token") }
        : { ok: false, text: t("mcpClient.testFail", { error: check.error ?? "" }) }
    : null;

  if (picking)
    return (
      <Modal title={t("mcpClient.addTitle")} onClose={onClose} wide>
        <div className="grid gap-3">
          <p className="text-ink-2 m-0 text-sm">{t("mcpClient.pick")}</p>
          <Gallery onPick={pick} />
        </div>
      </Modal>
    );
  return (
    <Modal
      title={server ? t("mcpClient.editTitle") : t("mcpClient.addTitle")}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className={btn} onClick={() => void runCheck()} disabled={checking || !url.trim()}>
            {checking ? t("mcpClient.testing") : t("mcpClient.check.button")}
          </button>
          <span className="flex-1" />
          <button type="button" className={btn} onClick={onClose}>
            {t("mcpClient.cancel")}
          </button>
          <button type="button" className={btnPrimary} disabled={!canSave || saving} onClick={() => void save()}>
            {auth === "oauth" && !perUser && !server?.connected ? t("mcpClient.saveSignIn") : t("mcpClient.save")}
          </button>
        </>
      }
    >
      <div className="grid gap-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <Field label={t("mcpClient.name")}>
            <input className={input} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="GitHub" />
          </Field>
          <Field label={t("mcpClient.url")} hint={t("mcpClient.urlHint")}>
            <input
              className={cx(input, mono)}
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setCheck(null);
              }}
              placeholder="https://mcp.example.com/mcp"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
        </div>

        <div className="grid gap-1.5">
          <span className="text-sm font-medium">{t("mcpClient.auth")}</span>
          <Segmented
            label={t("mcpClient.auth")}
            value={auth}
            onChange={(v) => {
              setAuth(v);
              setCheck(null);
            }}
            options={(["none", "header", "oauth"] as const).map((v) => ({ value: v, label: t(`mcpClient.authShort.${v}`) }))}
            className="justify-self-start"
          />
        </div>

        {auth === "header" ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <Field label={t("mcpClient.headerName")} hint={t("mcpClient.headerNameHint")}>
              <input
                className={cx(input, mono)}
                value={headerName}
                onChange={(e) => setHeaderName(e.target.value)}
                placeholder="Authorization"
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            <Field label={t("mcpClient.secret")} hint={keepsSecret ? t("mcpClient.secretKeep", { hint: server?.secretHint ?? "" }) : t("mcpClient.secretHint")}>
              <input className={cx(input, mono)} type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" spellCheck={false} />
            </Field>
          </div>
        ) : null}

        {auth === "oauth" ? (
          <div className="grid gap-3">
            <Checkbox checked={perUser} onChange={(e) => setPerUser(e.currentTarget.checked)} label={t("mcpClient.perUser")} hint={t("mcpClient.perUserHint")} />
            <details className="group">
              <summary className="text-ink-2 hover:text-ink cursor-pointer text-xs">{t("mcpClient.advanced")}</summary>
              <div className="mt-3 grid gap-3">
                <p className="text-ink-2 m-0 text-xs [overflow-wrap:anywhere]">{t("mcpClient.redirect", { url: redirectUri })}</p>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label={t("mcpClient.clientId")} hint={t("mcpClient.clientIdHint")}>
                    <input className={cx(input, mono)} value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" spellCheck={false} />
                  </Field>
                  <Field label={t("mcpClient.clientSecret")} hint={server?.hasClientSecret ? t("mcpClient.clientSecretKeep") : undefined}>
                    <input className={cx(input, mono)} type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} autoComplete="off" />
                  </Field>
                </div>
              </div>
            </details>
          </div>
        ) : null}

        <div className="grid gap-1.5">
          <span className="text-sm font-medium">{t("mcpClient.who")}</span>
          <Segmented
            label={t("mcpClient.who")}
            value={audience}
            onChange={setAudience}
            options={(["everyone", "departments", "admins"] as const).map((v) => ({ value: v, label: t(`mcpClient.audience.${v}`) }))}
            className="justify-self-start"
          />
          {audience === "departments" ? (
            departments.length ? (
              <div className="border-hairline mt-1 grid max-h-44 grid-cols-1 gap-1 overflow-y-auto rounded-lg border p-2 sm:grid-cols-2">
                {departments.map((d) => (
                  <Checkbox
                    key={d.id}
                    checked={deptIds.includes(d.id)}
                    onChange={(e) => {
                      const on = e.currentTarget.checked;
                      setDeptIds((ids) => (on ? [...ids, d.id] : ids.filter((x) => x !== d.id)));
                    }}
                    label={d.name}
                  />
                ))}
              </div>
            ) : (
              <p className="text-ink-2 m-0 text-xs">{t("mcpClient.noDepartments")}</p>
            )
          ) : null}
        </div>

        {server ? <Checkbox checked={enabled} onChange={(e) => setEnabled(e.currentTarget.checked)} label={t("mcpClient.enabled")} /> : null}

        {checkLine ? (
          <div role="status" className="bg-hover/60 grid gap-2 rounded-lg p-3 text-sm">
            <span className={cx("font-medium [overflow-wrap:anywhere]", checkLine.ok ? "text-ok" : "text-block")}>{checkLine.text}</span>
            {check?.error === "needs_auth" && check.oauth && auth !== "oauth" ? (
              <button type="button" className={cx(btn, "justify-self-start")} onClick={() => setAuth("oauth")}>
                {t("mcpClient.check.useOauth")}
              </button>
            ) : null}
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-block m-0 text-sm [overflow-wrap:anywhere]">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
