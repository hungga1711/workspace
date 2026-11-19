"use client";

import { useCallback, useEffect, useState } from "react";
import { useFormat, useLocale, useT } from "@/lib/i18n/client";
import { INTL_TAG } from "@/lib/i18n/config";
import { dateTimeMedium } from "@/lib/format";
import { api } from "@/lib/client";
import { btn, btnSm, cx, mono } from "@/lib/ui";
import { InfoIcon } from "@/components/app/icons";
import { McpConnect } from "@/components/mcp/McpConnect";
import { errorKey, toolLabel, type McpCall } from "@/components/mcp/labels";
import { PanelCard } from "./AccountSettings";

interface Grant {
  id: string;
  clientName: string;
  redirectHost: string | null;
  permissions: string[];
  createdAt: string;
  lastUsedAt: string | null;
}
interface Key {
  id: string;
  name: string;
  prefix: string;
  permissions: string[];
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

type Load<T> = { state: "loading" } | { state: "failed" } | { state: "ok"; data: T };

/** A read that may fail on its own: the section says so with a retry, the rest of the page stays. */
function useLoad<T>(path: string): [Load<T>, () => void] {
  const [v, setV] = useState<Load<T>>({ state: "loading" });
  const load = useCallback(() => {
    setV({ state: "loading" });
    api<T>(path)
      .then((data) => setV({ state: "ok", data }))
      .catch(() => setV({ state: "failed" }));
  }, [path]);
  useEffect(load, [load]);
  return [v, load];
}

export function SectionFailed({ onRetry }: { onRetry: () => void }) {
  const t = useT();
  return (
    <p role="status" className="text-ink-2 m-0 flex items-center gap-1.5 text-sm">
      <InfoIcon className="size-4 shrink-0" />
      <span>{t("mcpServer.load.failed")}</span>
      <button type="button" onClick={onRetry} className="text-ink font-medium underline-offset-2 hover:underline">
        {t("mcpServer.load.retry")}
      </button>
    </p>
  );
}

/**
 * Hồ sơ › AI agent: connect Claude, ChatGPT, Cursor or VS Code with the MCP address (OAuth, no key), the apps and
 * personal keys acting as me with revoke, and what they did lately (tool names and results only).
 */
export function AgentConnections() {
  const t = useT();
  const { ago } = useFormat();
  const intlTag = INTL_TAG[useLocale()];
  const [grants, reloadGrants] = useLoad<{ grants: Grant[] }>("identity/me/oauth/grants");
  const [keys, reloadKeys] = useLoad<{ keys: Key[] }>("identity/me/api-keys");
  const [activity, reloadActivity] = useLoad<{ calls: McpCall[] }>("identity/me/mcp/activity");
  const [error, setError] = useState(false);

  const revoke = async (name: string, path: string, reload: () => void) => {
    if (!window.confirm(t("mcpServer.connected.revokeConfirm", { name }))) return;
    setError(false);
    await api(path, { method: "DELETE" }).catch(() => setError(true));
    reload();
  };

  type Row = { id: string; name: string; kind: "oauth" | "key"; detail: string | null; permissions: number; lastUsedAt: string | null; createdAt: string; revoke: () => void };
  const rows: Row[] = [
    ...(grants.state === "ok"
      ? grants.data.grants.map((g) => ({
          id: g.id,
          name: g.clientName,
          kind: "oauth" as const,
          detail: g.redirectHost,
          permissions: g.permissions.length,
          lastUsedAt: g.lastUsedAt,
          createdAt: g.createdAt,
          revoke: () => void revoke(g.clientName, `identity/me/oauth/grants/${g.id}`, reloadGrants),
        }))
      : []),
    ...(keys.state === "ok"
      ? keys.data.keys
          .filter((k) => !k.revokedAt)
          .map((k) => ({
            id: k.id,
            name: k.name,
            kind: "key" as const,
            detail: `wos_${k.prefix}_…`,
            permissions: k.permissions.length,
            lastUsedAt: k.lastUsedAt,
            createdAt: k.createdAt,
            revoke: () => void revoke(k.name, `identity/me/api-keys/${k.id}`, reloadKeys),
          }))
      : []),
  ];

  return (
    <>
      <PanelCard>
        <McpConnect keysHref="/app/me?tab=security" />
      </PanelCard>
      <PanelCard>
        <div className="grid min-w-0 gap-3">
          <div>
            <h2 className="m-0 text-[15px] font-semibold">{t("mcpServer.connected.title")}</h2>
            <p className="text-ink-2 m-0 mt-0.5 text-[13px]">{t("mcpServer.connected.desc")}</p>
          </div>
          {error ? (
            <p className="text-block m-0 text-sm" role="alert">
              {t("mcpServer.connected.revokeFailed")}
            </p>
          ) : null}
          {grants.state === "failed" || keys.state === "failed" ? (
            <SectionFailed
              onRetry={() => {
                if (grants.state === "failed") reloadGrants();
                if (keys.state === "failed") reloadKeys();
              }}
            />
          ) : null}
          {rows.length ? (
            <ul className="m-0 grid list-none gap-1.5 p-0">
              {rows.map((r) => (
                <li key={r.id} className="border-hairline flex min-w-0 items-center gap-3 rounded-md border px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-medium">{r.name}</span>
                      <span className="bg-selected text-ink-soft shrink-0 rounded-md px-1.5 py-0.5 text-xs">
                        {r.kind === "oauth" ? t("mcpServer.connected.oauth") : t("mcpServer.connected.key")}
                      </span>
                    </span>
                    <span className="text-ink-2 block truncate text-xs">
                      {[
                        r.lastUsedAt ? t("mcpServer.connected.lastUsed", { ago: ago(r.lastUsedAt) }) : t("mcpServer.connected.neverUsed"),
                        t("mcpServer.connected.perms", { count: r.permissions }),
                        r.detail,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  <button type="button" className={cx(btn, btnSm, "shrink-0")} onClick={r.revoke}>
                    {t("mcpServer.connected.revoke")}
                  </button>
                </li>
              ))}
            </ul>
          ) : grants.state === "ok" && keys.state === "ok" ? (
            <p className="text-ink-2 m-0 text-sm">{t("mcpServer.connected.empty")}</p>
          ) : null}
        </div>
      </PanelCard>
      <PanelCard>
        <div className="grid min-w-0 gap-3">
          <div>
            <h2 className="m-0 text-[15px] font-semibold">{t("mcpServer.activity.title")}</h2>
            <p className="text-ink-2 m-0 mt-0.5 text-[13px]">{t("mcpServer.activity.desc")}</p>
          </div>
          {activity.state === "failed" ? <SectionFailed onRetry={reloadActivity} /> : null}
          {activity.state === "ok" && !activity.data.calls.length ? <p className="text-ink-2 m-0 text-sm">{t("mcpServer.activity.empty")}</p> : null}
          {activity.state === "ok" && activity.data.calls.length ? (
            <ul className="divide-divider-soft m-0 grid list-none divide-y p-0">
              {activity.data.calls.slice(0, 20).map((c) => (
                <li key={c.id} className="flex min-w-0 items-center gap-3 py-2 text-sm">
                  <span className={cx("size-2 shrink-0 rounded-full", c.ok ? "bg-ok" : "bg-block")} aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{toolLabel(t, c.tool)}</span>
                    <span className="text-ink-2 block truncate text-xs">
                      {[c.clientName ?? t(`mcpServer.via.${c.via}`), c.ok ? null : c.error ? t(`mcpServer.errors.${errorKey(c.error)}`) : t("mcpServer.activity.failed")]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  <span className={cx(mono, "text-ink-2 shrink-0 text-xs")} title={new Date(c.at).toLocaleString(intlTag, dateTimeMedium)}>
                    {ago(c.at)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </PanelCard>
    </>
  );
}
