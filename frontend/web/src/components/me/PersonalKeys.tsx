"use client";

import { LoadFailed } from "@/components/ui/LoadFailed";
import { useT, useFormat } from "@/lib/i18n/client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";
import { btn, btnPrimary, btnSm, cx, input, mono } from "@/lib/ui";
import { Modal } from "@/components/ui/Modal";
import { Field } from "@/components/ui/bits";
import { Checkbox } from "@/components/ui/Checkbox";
import { PERM_LABEL } from "@/components/admin/perm-labels";

// Hồ sơ › AI agent loads from this module too (MeView), so the two account panels share one on-demand chunk.
export { AgentConnections } from "./AgentConnections";

interface Key {
  id: string;
  name: string;
  prefix: string;
  permissions: string[];
  lastUsedAt: string | null;
  revokedAt: string | null;
}
interface Data {
  keys: Key[];
  grantable: string[];
}

/** What an assistant usually needs: read and update my work, search, see my team. */
const SUGGESTED = ["task.read", "task.create", "task.edit", "project.read", "message.read", "document.read"];

/**
 * Me › Hồ sơ › Sign-in and security: personal API keys, which act as me (MCP clients such as a desktop AI assistant,
 * scripts). The MCP address is this app's own origin: the reverse proxy sends /api/mcp to the gateway.
 */
export function PersonalKeys() {
  const tx = useT();
  const { ago } = useFormat();
  const [d, setD] = useState<Data | null>(null);
  const [error, setError] = useState(false);
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const load = useCallback(
    () =>
      void api<Data>("identity/me/api-keys")
        .then((r) => {
          setError(false);
          setD(r);
        })
        .catch(() => setError(true)),
    [],
  );
  useEffect(load, [load]);
  const mcpUrl = typeof window === "undefined" ? "/api/mcp" : `${window.location.origin}/api/mcp`;
  const revoke = async (k: Key) => {
    if (!window.confirm(tx("apiKeys.revokeConfirm", { name: k.name }))) return;
    await api(`identity/me/api-keys/${k.id}`, { method: "DELETE" }).catch(() => setError(true));
    load();
  };
  if (error && !d) return <LoadFailed onRetry={load} />;
  if (!d) return null;
  const live = d.keys.filter((k) => !k.revokedAt);
  return (
    <div className="grid gap-2">
      <div className="flex items-center gap-3">
        <p className="m-0 flex-1 text-sm font-medium">{tx("apiKeys.personalTitle")}</p>
        {d.grantable.length ? (
          <button type="button" className={cx(btn, btnSm)} onClick={() => setCreating(true)}>
            {tx("apiKeys.create")}
          </button>
        ) : null}
      </div>
      <p className="text-ink-2 m-0 text-xs">{tx("apiKeys.personalHint")}</p>
      {live.length ? (
        <ul className="m-0 grid list-none gap-1.5 p-0">
          {live.map((k) => (
            <li key={k.id} className="border-hairline flex items-center gap-3 rounded-md border px-3 py-2 text-sm">
              <span className="min-w-0 flex-1">
                <span className="block truncate">
                  {k.name} <span className={cx(mono, "text-ink-2 text-xs")}>wos_{k.prefix}_…</span>
                </span>
                <span className="text-ink-2 text-xs">{k.lastUsedAt ? tx("apiKeys.lastUsed", { ago: ago(k.lastUsedAt) }) : tx("apiKeys.neverUsed")}</span>
              </span>
              <button type="button" className={cx(btn, btnSm)} onClick={() => void revoke(k)}>
                {tx("apiKeys.revoke")}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-ink-2 m-0 text-sm">{tx("apiKeys.none")}</p>
      )}
      {creating ? (
        <CreateKey
          grantable={d.grantable}
          onClose={() => setCreating(false)}
          onCreated={(key) => {
            setCreating(false);
            setSecret(key);
            load();
          }}
        />
      ) : null}
      {secret ? (
        <Modal
          title={tx("apiKeys.created")}
          onClose={() => setSecret(null)}
          footer={
            <button type="button" className={btnPrimary} onClick={() => setSecret(null)}>
              {tx("apiKeys.done")}
            </button>
          }
        >
          <p className="text-ink-2 mb-3 text-sm">{tx("apiKeys.createdHint", { url: mcpUrl })}</p>
          <input readOnly aria-label={tx("apiKeys.created")} className={cx(input, mono, "text-xs")} value={secret} onFocus={(e) => e.currentTarget.select()} />
          <button type="button" className={cx(btn, btnSm, "mt-2")} onClick={() => void navigator.clipboard?.writeText(secret).then(() => setCopied(true))}>
            {copied ? tx("apiKeys.copied") : tx("apiKeys.copy")}
          </button>
        </Modal>
      ) : null}
    </div>
  );
}

function CreateKey({ grantable, onClose, onCreated }: { grantable: string[]; onClose: () => void; onCreated: (key: string) => void }) {
  const tx = useT();
  const [name, setName] = useState("");
  const [perms, setPerms] = useState<string[]>(() => SUGGESTED.filter((p) => grantable.includes(p)));
  const [error, setError] = useState(false);
  const submit = async () => {
    try {
      const r = await api<{ key: string }>("identity/me/api-keys", { method: "POST", body: { name, permissions: perms } });
      onCreated(r.key);
    } catch {
      setError(true);
    }
  };
  return (
    <Modal
      title={tx("apiKeys.personalTitle")}
      onClose={onClose}
      footer={
        <button type="button" className={btnPrimary} disabled={!name.trim() || !perms.length} onClick={() => void submit()}>
          {tx("apiKeys.create")}
        </button>
      }
    >
      <div className="grid gap-4">
        {error ? (
          <p className="text-block m-0 text-sm" role="alert">
            {tx("apiKeys.failed")}
          </p>
        ) : null}
        <Field label={tx("apiKeys.name")}>
          <input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder={tx("apiKeys.namePlaceholder")} />
        </Field>
        <fieldset className="grid content-start gap-1.5">
          <legend className="mb-1 text-sm font-medium">{tx("apiKeys.permissions")}</legend>
          <div className="border-hairline grid max-h-60 gap-1 overflow-auto rounded-sm border p-2 text-sm">
            {grantable.map((p) => (
              <label key={p} className="flex items-center gap-2">
                <Checkbox checked={perms.includes(p)} onChange={(e) => setPerms((x) => (e.target.checked ? [...x, p] : x.filter((y) => y !== p)))} />
                {PERM_LABEL(tx)[p] ?? p}
              </label>
            ))}
          </div>
        </fieldset>
      </div>
    </Modal>
  );
}
