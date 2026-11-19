"use client";

import { IconTile } from "@/components/ui/Bento";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/client";
import { useFormat, useT } from "@/lib/i18n/client";
import { btn, btnPrimary, btnSm, cx, input, mono } from "@/lib/ui";
import { Field } from "@/components/ui/bits";
import { AdminHeader } from "./AdminNav";
import { PickerField } from "./PickerField";
import { Modal } from "@/components/ui/Modal";
import { BotIcon, LinkIcon, ShieldIcon } from "@/components/app/icons";
import { refreshAiStatus } from "@/app/admin/workspace/ai/actions";
import { InfoTip } from "@/components/ui/InfoTip";
import { useConfirm } from "@/components/ui/Confirm";

type Mode = "key" | "api" | "selfhost";
type Vendor = "openai" | "anthropic" | "gemini" | "openai_compatible" | "device";
export interface AiConnection {
  id: string;
  /** "device": the AI on an admin's connected computer, made in one click (AiLocalAdmin), never edited in the form. */
  mode: Mode | "device";
  vendor: Vendor;
  name: string;
  baseUrl: string | null;
  hasKey: boolean;
  keyHint: string | null;
  modelFast: string;
  modelSmart: string;
  isDefault: boolean;
  enabled: boolean;
  test: { at: string; ok: boolean; error: string | null } | null;
  /** Whether the main model calls tools (found by "Kiểm tra"); null until tested. */
  tools?: boolean | null;
  /** Its own web tools (search, reading linked pages, its code sandbox) when a question needs them. */
  web?: boolean;
}
interface Check {
  baseUrl: string | null;
  models: { ok: boolean; models: string[]; error?: string };
  test: { ok: boolean; ms: number; model?: string; error?: string } | null;
}

const MODES: Mode[] = ["key", "api", "selfhost"];
const VENDORS = ["openai", "anthropic", "gemini"] as const;
const MODE_ICON = { key: ShieldIcon, api: LinkIcon, selfhost: BotIcon };
const card = "rounded-xl shadow-card bg-surface";

/**
 * Admin › AI › Kết nối AI. One gateway for every AI feature in the workspace, three ways in: a vendor API
 * key, an OpenAI-compatible LLM API, or a model the company runs itself (Ollama…). The default
 * connection serves every feature; the others appear in Trợ lý AI's model menu. Keys are write-only.
 */
export function AiConnectionsAdmin({ connections, env, noHeader }: { connections: AiConnection[]; env: string[]; noHeader?: boolean }) {
  const t = useT();
  const { confirm, dialog } = useConfirm();
  const router = useRouter();
  const [editing, setEditing] = useState<{ mode: Mode; conn?: AiConnection } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const done = async () => {
    await refreshAiStatus();
    router.refresh();
  };
  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    setErr(null);
    try {
      await fn();
      await done();
    } catch {
      setErr(t("aic.failed"));
    } finally {
      setBusy(null);
    }
  };
  // grid-cols-1: an implicit auto column grew past a 360px phone to fit the widest line inside.
  return (
    <>
      {dialog}
      <div className="grid grid-cols-1 gap-5">
        {/* Under the AI switches (Admin › AI) the page header is theirs; this block keeps a section title and the action. */}
        {noHeader ? (
          <div className="flex items-center justify-between gap-3">
            <div className="grid gap-0.5">
              <h2 className="m-0 flex min-w-0 items-center gap-3 text-sm/6 font-semibold tracking-[-0.01em]">
                <IconTile tone="sky">
                  <LinkIcon />
                </IconTile>
                {t("aic.title")}
              </h2>
              <p className="text-ink-2 m-0 text-sm">{t("aic.sub")}</p>
            </div>
            {connections.length ? (
              <button type="button" className={btnPrimary} onClick={() => setEditing({ mode: "key" })}>
                {t("aic.add")}
              </button>
            ) : null}
          </div>
        ) : (
          <AdminHeader
            title={t("aic.title")}
            sub={t("aic.sub")}
            actions={
              connections.length ? (
                <button type="button" className={btnPrimary} onClick={() => setEditing({ mode: "key" })}>
                  {t("aic.add")}
                </button>
              ) : null
            }
          />
        )}

        {connections.length === 0 ? (
          <section aria-labelledby="aic-pick" className="grid gap-3">
            <h2 id="aic-pick" className="m-0 text-[14px]/6 font-semibold">
              {env.length ? t("aic.pickMore") : t("aic.pick")}
            </h2>
            <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 md:grid-cols-3">
              {MODES.map((m) => {
                const Icon = MODE_ICON[m];
                return (
                  <li key={m}>
                    <button type="button" className={cx(card, "hover:bg-hover/60 grid h-full w-full content-start gap-2 p-4 text-left")} onClick={() => setEditing({ mode: m })}>
                      <Icon className="text-brand-text size-5" />
                      <span className="font-semibold">{t(`aic.mode.${m}`)}</span>
                      <span className="text-ink-2 text-sm">{t(`aic.modeHint.${m}`)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : (
          <ul className="m-0 grid list-none gap-3 p-0">
            {connections.map((c) => (
              <li key={c.id} className={cx(card, "grid gap-3 p-4")}>
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-[1_1_16rem]">
                    <p className="m-0 flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{c.name}</span>
                      <span className="bg-hover text-ink-2 rounded-sm px-1.5 py-0.5 text-xs font-medium">{t(`aic.mode.${c.mode}`)}</span>
                      {c.isDefault ? <span className="bg-signal-wash text-brand-text rounded-sm px-1.5 py-0.5 text-xs font-semibold">{t("aic.default")}</span> : null}
                    </p>
                    <p className="text-ink-2 m-0 mt-1 text-sm">
                      <span className={mono}>{c.modelSmart}</span>
                      {c.modelFast !== c.modelSmart ? (
                        <>
                          {" · "}
                          {t("aic.fast")} <span className={mono}>{c.modelFast}</span>
                        </>
                      ) : null}
                      {c.baseUrl && c.mode !== "device" ? <span className={cx(mono, "block truncate")}>{c.baseUrl}</span> : null}
                      {c.keyHint ? <span className="block">{t("aic.keyStored", { hint: c.keyHint })}</span> : null}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className={cx(btn, btnSm)}
                      disabled={busy === c.id}
                      onClick={() => void act(c.id, () => api(`ai/connections/${c.id}/test`, { method: "POST" }))}
                    >
                      {busy === c.id ? t("aic.testing") : t("aic.test")}
                    </button>
                    {!c.isDefault ? (
                      <button type="button" className={cx(btn, btnSm)} onClick={() => void act(c.id, () => api(`ai/connections/${c.id}/default`, { method: "POST" }))}>
                        {t("aic.makeDefault")}
                      </button>
                    ) : null}
                    {c.mode !== "device" ? (
                      <button type="button" className={cx(btn, btnSm)} onClick={() => setEditing({ mode: c.mode as Mode, conn: c })}>
                        {t("aic.edit")}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className={cx(btn, btnSm, "text-block hover:bg-block-wash")}
                      onClick={async () => {
                        if (await confirm({ title: t("aic.removeConfirm", { name: c.name }), danger: true }))
                          void act(c.id, () => api(`ai/connections/${c.id}`, { method: "DELETE" }));
                      }}
                    >
                      {t("aic.remove")}
                    </button>
                  </div>
                </div>
                <TestLine test={c.test} />
                {c.tools === false ? <p className="text-ink-2 m-0 text-xs">{t("aic.noTools")}</p> : null}
                <div className="border-divider flex items-start justify-between gap-4 border-t pt-3">
                  <div className="grid min-w-0 gap-0.5">
                    <span className="text-sm font-medium">{t("aic.web")}</span>
                    <span className="text-ink-2 text-xs">{t("aic.webHint")}</span>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={c.web !== false}
                    aria-label={t("aic.web")}
                    disabled={busy === c.id}
                    onClick={() => void act(c.id, () => api(`ai/connections/${c.id}/web`, { method: "POST", body: { on: c.web === false } }))}
                    className={cx("relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-60", c.web !== false ? "bg-brand" : "bg-hairline")}
                  >
                    <span className={cx("bg-surface absolute top-0.5 size-5 rounded-full shadow transition-all", c.web !== false ? "left-[22px]" : "left-0.5")} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {err ? (
          <p role="alert" className="text-block m-0 text-sm">
            {err}
          </p>
        ) : null}
        {env.length ? <p className="text-ink-2 m-0 text-sm">{t("aic.env", { list: env.join(", ") })}</p> : null}
        <p className="text-ink-2 m-0 flex items-center gap-1 text-xs">
          {t("aic.privacyShort")}
          <InfoTip text={t("aic.privacy")} label={t("aic.title")} />
        </p>

        {editing ? (
          <ConnectionDialog
            mode={editing.mode}
            conn={editing.conn}
            onClose={() => setEditing(null)}
            onSaved={async () => {
              setEditing(null);
              await done();
            }}
          />
        ) : null}
      </div>
    </>
  );
}

function TestLine({ test }: { test: AiConnection["test"] }) {
  const t = useT();
  const { ago } = useFormat();
  if (!test) return <p className="text-ink-2 m-0 text-xs">{t("aic.untested")}</p>;
  return (
    <p role="status" className={cx("m-0 text-xs", test.ok ? "text-ok" : "text-block")}>
      {test.ok ? t("aic.testOk", { ago: ago(test.at) }) : t("aic.testFail", { error: test.error ?? "" })}
    </p>
  );
}

function ConnectionDialog({ mode: initialMode, conn, onClose, onSaved }: { mode: Mode; conn?: AiConnection; onClose: () => void; onSaved: () => Promise<void> }) {
  const t = useT();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [vendor, setVendor] = useState<(typeof VENDORS)[number]>(conn && conn.vendor !== "openai_compatible" && conn.vendor !== "device" ? conn.vendor : "openai");
  const [baseUrl, setBaseUrl] = useState(conn?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(conn?.mode !== "key" ? (conn?.modelSmart ?? "") : "");
  const [modelFast, setModelFast] = useState(conn && conn.modelFast !== conn.modelSmart ? conn.modelFast : "");
  const [name, setName] = useState(conn?.name ?? "");
  const [check, setCheck] = useState<Check | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Mirrors the server (sameEndpoint): the stored key is reused only for the same vendor and address.
  const sameUrl =
    (conn?.baseUrl ?? "").replace(/\/+$/, "") === baseUrl.trim().replace(/\/+$/, "") || (!!conn?.baseUrl && `${baseUrl.trim().replace(/\/+$/, "")}/v1` === conn.baseUrl);
  const keepsKey = !!conn?.hasKey && conn.mode === mode && (mode === "key" ? conn.vendor === vendor : sameUrl);
  const body = () => ({
    mode,
    ...(mode === "key" ? { vendor } : { baseUrl: baseUrl.trim() }),
    ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    ...(model.trim() ? { modelSmart: model.trim() } : {}),
    ...(modelFast.trim() ? { modelFast: modelFast.trim() } : {}),
    ...(name.trim() ? { name: name.trim() } : {}),
  });
  const problem = (e: unknown) => {
    const b = (e as { body?: { issues?: { path: string; message: string }[] } }).body;
    return b?.issues?.length ? b.issues.map((i) => `${i.path}: ${i.message}`).join("; ") : t("aic.failed");
  };
  const runCheck = async () => {
    setChecking(true);
    setError(null);
    try {
      const r = await api<Check>("ai/connections/check", {
        method: "POST",
        body: { ...body(), ...(conn ? { id: conn.id } : {}), ...(model.trim() ? { model: model.trim() } : {}) },
      });
      setCheck(r);
      if (!model.trim() && mode !== "key" && r.models.models[0]) setModel(r.models.models[0]);
    } catch (e) {
      setError(problem(e));
    } finally {
      setChecking(false);
    }
  };
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api(conn ? `ai/connections/${conn.id}` : "ai/connections", { method: conn ? "PATCH" : "POST", body: body() });
      await onSaved();
    } catch (e) {
      setError(problem(e));
      setSaving(false);
    }
  };
  const needsKey = mode !== "selfhost" && !keepsKey;
  const canSave = (mode === "key" || (baseUrl.trim() && model.trim())) && (!needsKey || apiKey.trim());
  return (
    <Modal
      title={conn ? t("aic.editTitle") : t("aic.addTitle")}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className={btn} onClick={() => void runCheck()} disabled={checking || (mode !== "key" && !baseUrl.trim())}>
            {checking ? t("aic.testing") : t("aic.check")}
          </button>
          <span className="flex-1" />
          <button type="button" className={btn} onClick={onClose}>
            {t("aic.cancel")}
          </button>
          <button type="button" className={btnPrimary} disabled={!canSave || saving} onClick={() => void save()}>
            {t("aic.save")}
          </button>
        </>
      }
    >
      <div className="grid gap-4">
        <div role="radiogroup" aria-label={t("aic.how")} className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              onClick={() => {
                setMode(m);
                setModel("");
                setModelFast("");
                setCheck(null);
              }}
              className={cx("border-hairline grid content-start gap-0.5 rounded-lg border p-3 text-left", mode === m ? "ring-brand bg-signal-wash ring-2" : "hover:bg-hover")}
            >
              <span className="text-sm font-semibold">{t(`aic.mode.${m}`)}</span>
              <span className="text-ink-2 text-xs">{t(`aic.modeShort.${m}`)}</span>
            </button>
          ))}
        </div>

        {mode === "key" ? (
          <PickerField
            label={t("aic.vendor")}
            value={vendor}
            onChange={(v) => {
              // Models and the stored key belong to one vendor: start fresh when it changes.
              setVendor(v as (typeof VENDORS)[number]);
              setModel("");
              setModelFast("");
              setCheck(null);
            }}
            options={VENDORS.map((v) => ({ value: v, label: t(`aic.vendors.${v}`) }))}
          />
        ) : (
          <Field label={t("aic.baseUrl")} hint={t(`aic.baseUrlHint.${mode}`)}>
            <input
              className={cx(input, mono)}
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={mode === "selfhost" ? "http://ollama:11434" : "https://openrouter.ai/api/v1"}
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
        )}

        <Field label={mode === "selfhost" ? t("aic.keyOptional") : t("aic.key")} hint={keepsKey ? t("aic.keyKeep", { hint: conn?.keyHint ?? "" }) : t("aic.keyHint")}>
          <input className={cx(input, mono)} type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" spellCheck={false} />
        </Field>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t("aic.model")} hint={mode === "key" ? t("aic.modelDefault") : t("aic.modelHint")}>
            <input className={cx(input, mono)} value={model} onChange={(e) => setModel(e.target.value)} list="aic-models" autoComplete="off" spellCheck={false} />
          </Field>
          <Field label={t("aic.modelFast")} hint={t("aic.modelFastHint")}>
            <input className={cx(input, mono)} value={modelFast} onChange={(e) => setModelFast(e.target.value)} list="aic-models" autoComplete="off" spellCheck={false} />
          </Field>
        </div>
        <datalist id="aic-models">
          {(check?.models.models ?? []).map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        <Field label={t("aic.name")}>
          <input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("aic.namePlaceholder")} />
        </Field>

        {check ? (
          <div role="status" className="bg-hover/60 grid gap-1 rounded-lg p-3 text-sm">
            {check.test ? (
              <span className={check.test.ok ? "text-ok font-medium" : "text-block font-medium"}>
                {check.test.ok ? t("aic.checkOk", { model: check.test.model ?? "", ms: check.test.ms }) : t("aic.testFail", { error: check.test.error ?? "" })}
              </span>
            ) : null}
            <span className="text-ink-2">
              {check.models.ok ? t("aic.modelsFound", { count: check.models.models.length }) : t("aic.modelsFail", { error: check.models.error ?? "" })}
            </span>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-block m-0 text-sm">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
