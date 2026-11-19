"use client";

import { IconTile } from "@/components/ui/Bento";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/client";
import { useFormat, useT } from "@/lib/i18n/client";
import { finishInPopup, openBlank } from "@/lib/mcp-oauth";
import { monogramOf, type McpAuth, type McpPreset } from "@/lib/mcp-gallery";
import { btn, btnPrimary, btnSm, chip, chipAccent, chipBlock, chipOk, chipWarn, cx, mono } from "@/lib/ui";
import { Checkbox } from "@/components/ui/Checkbox";
import { Segmented } from "@/components/ui/Segmented";
import { McpMonogram } from "@/components/ai/McpMonogram";
import { ChevronDownIcon, InfoIcon, PlusIcon, TerminalIcon } from "@/components/app/icons";
import { useConfirm } from "@/components/ui/Confirm";
// Statically: the admin page has no first-load budget, and one chunk fewer keeps every route's webpack runtime smaller.
import { McpServerDialog } from "./McpServerDialog";
import { Gallery } from "./McpGallery";

export interface McpTool {
  name: string;
  title: string | null;
  description: string;
  readOnly: boolean;
  destructive: boolean;
  enabled: boolean;
  confirm: boolean;
}
export interface McpServer {
  id: string;
  slug: string;
  name: string;
  url: string;
  preset: string | null;
  auth: McpAuth;
  headerName: string | null;
  secretHint: string | null;
  oauthPerUser: boolean;
  oauthClientId: string | null;
  hasClientSecret: boolean;
  /** The company account is signed in (OAuth, company-level); null when that does not apply. */
  connected: boolean | null;
  audience: "everyone" | "departments" | "admins";
  departmentIds: string[];
  enabled: boolean;
  serverInfo: { name?: string; version?: string } | null;
  tools: McpTool[];
  test: { at: string; ok: boolean; error: string | null } | null;
  stats: { calls: number; failed: number; people: number };
}
export interface McpCall {
  id: string;
  at: string;
  userId: string;
  serverId: string | null;
  server: string;
  tool: string;
  feature: string;
  outcome: "ok" | "error" | "timeout" | "denied" | "declined" | "auth";
  ms: number;
}
export interface McpData {
  servers: McpServer[];
  calls: McpCall[];
  redirectUri: string;
}

const card = "rounded-xl shadow-card bg-surface";
const OUTCOME_CHIP: Record<McpCall["outcome"], string> = { ok: chipOk, error: chipBlock, timeout: chipWarn, denied: chipBlock, declined: chip, auth: chipWarn };

/**
 * Admin › Kết nối AI › Máy chủ MCP: the outside tools the company's AI may use (GitHub, Linear, Notion, an internal
 * server…). Add from the gallery or any URL, sign in (token or OAuth), pick which tools run on their own and which
 * ask the person first, and who may use each server; every call is listed below (who, which tool, outcome).
 */
export function McpServersAdmin({
  data,
  aiReady,
  departments,
  people,
}: {
  data: McpData;
  /** A model is connected. Without one the servers can be prepared, but nothing uses them yet. */
  aiReady: boolean;
  departments: { id: string; name: string }[];
  people: { userId: string; displayName: string }[];
}) {
  const t = useT();
  const { confirm, dialog } = useConfirm();
  const router = useRouter();
  const [editing, setEditing] = useState<{ server?: McpServer; preset?: McpPreset | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    setErr(null);
    try {
      await fn();
      router.refresh();
    } catch (e) {
      const b = (e as { body?: { message?: string } }).body;
      setErr(b?.message ?? t("mcpClient.failed"));
    } finally {
      setBusy(null);
    }
  };
  const connect = (s: McpServer) =>
    act(s.id, async () => {
      const win = openBlank();
      try {
        const r = await api<{ url: string }>(`ai/mcp/servers/${s.id}/oauth/start`, { method: "POST" });
        await finishInPopup(win, r.url);
      } catch (e) {
        win?.close();
        throw e;
      }
    });
  const names = new Map(people.map((p) => [p.userId, p.displayName]));
  return (
    <>
      {dialog}
      <section id="mcp" aria-labelledby="mcp-h" className="grid grid-cols-1 gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="grid min-w-0 flex-[1_1_18rem] gap-0.5">
            <h2 id="mcp-h" className="m-0 flex min-w-0 items-center gap-3 text-sm/6 font-semibold tracking-[-0.01em]">
              <IconTile tone="violet">
                <TerminalIcon />
              </IconTile>
              {t("mcpClient.title")}
            </h2>
            <p className="text-ink-2 m-0 text-sm">{t("mcpClient.sub")}</p>
          </div>
          {data.servers.length ? (
            <button type="button" className={btnPrimary} onClick={() => setEditing({})}>
              <PlusIcon />
              {t("mcpClient.add")}
            </button>
          ) : null}
        </div>

        {!aiReady ? (
          <p role="note" className="bg-hover/60 text-ink-2 m-0 flex items-start gap-2 rounded-lg p-3 text-sm">
            <InfoIcon className="mt-0.5 size-4 shrink-0" />
            {t("mcpClient.needsAi")}
          </p>
        ) : null}

        {data.servers.length === 0 ? (
          <Gallery onPick={(preset) => setEditing({ preset })} />
        ) : (
          <ul className="m-0 grid list-none gap-3 p-0">
            {data.servers.map((s) => (
              <ServerCard
                key={s.id}
                server={s}
                busy={busy === s.id}
                departments={departments}
                onTest={() => void act(s.id, () => api(`ai/mcp/servers/${s.id}/test`, { method: "POST" }))}
                onConnect={() => void connect(s)}
                onDisconnect={() => void act(s.id, () => api(`ai/mcp/servers/${s.id}/oauth`, { method: "DELETE" }))}
                onEdit={() => setEditing({ server: s })}
                onRemove={async () => {
                  if (await confirm({ title: t("mcpClient.removeConfirm", { name: s.name }), danger: true }))
                    void act(s.id, () => api(`ai/mcp/servers/${s.id}`, { method: "DELETE" }));
                }}
                onError={setErr}
              />
            ))}
          </ul>
        )}

        {err ? (
          <p role="alert" className="text-block m-0 text-sm">
            {err}
          </p>
        ) : null}

        {data.calls.length ? (
          <details className={cx(card, "group")}>
            <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
              <span className="flex-1">{t("mcpClient.calls.title")}</span>
              <ChevronDownIcon className="text-ink-2 size-4 transition-transform group-open:rotate-180" />
            </summary>
            <CallList calls={data.calls} names={names} />
          </details>
        ) : null}

        <p className="text-ink-2 m-0 text-xs">{t("mcpClient.privacy")}</p>

        {editing ? (
          <McpServerDialog
            server={editing.server}
            preset={editing.preset}
            departments={departments}
            redirectUri={data.redirectUri}
            onClose={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              router.refresh();
            }}
          />
        ) : null}
      </section>
    </>
  );
}

function ServerCard({
  server: s,
  busy,
  departments,
  onTest,
  onConnect,
  onDisconnect,
  onEdit,
  onRemove,
  onError,
}: {
  server: McpServer;
  busy: boolean;
  departments: { id: string; name: string }[];
  onTest: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onEdit: () => void;
  onRemove: () => void;
  onError: (e: string | null) => void;
}) {
  const t = useT();
  const { ago } = useFormat();
  const m = monogramOf(s.name, s.preset);
  // Tool choices show at once; the server's answer replaces them (or the old ones come back on failure).
  const [tools, setTools] = useState(s.tools);
  const [prevTools, setPrevTools] = useState(s.tools);
  if (prevTools !== s.tools) {
    setPrevTools(s.tools);
    setTools(s.tools);
  }
  const setTool = async (name: string, next: { enabled: boolean; confirm: boolean }) => {
    const before = tools;
    setTools((ts) => ts.map((x) => (x.name === name ? { ...x, ...next } : x)));
    onError(null);
    try {
      await api(`ai/mcp/servers/${s.id}/tools`, { method: "PUT", body: { tools: { [name]: next } } });
    } catch {
      setTools(before);
      onError(t("mcpClient.failed"));
    }
  };
  const companyOAuth = s.auth === "oauth" && !s.oauthPerUser;
  const status = !s.enabled
    ? { cls: chip, text: t("mcpClient.status.off") }
    : companyOAuth && !s.connected
      ? { cls: chipWarn, text: t("mcpClient.status.signIn") }
      : s.test && !s.test.ok
        ? { cls: chipBlock, text: t("mcpClient.status.error") }
        : s.test
          ? { cls: chipOk, text: t("mcpClient.status.ok") }
          : { cls: chip, text: t("mcpClient.status.untested") };
  const audience =
    s.audience === "departments"
      ? t("mcpClient.audienceList", {
          list:
            s.departmentIds
              .map((id) => departments.find((d) => d.id === id)?.name)
              .filter(Boolean)
              .join(", ") || "—",
        })
      : t(`mcpClient.audience.${s.audience}`);
  const enabled = tools.filter((x) => x.enabled).length;
  const asking = tools.filter((x) => x.enabled && x.confirm).length;
  return (
    <li className={cx(card, "grid min-w-0 gap-3 p-4")}>
      <div className="flex flex-wrap items-start gap-3">
        <McpMonogram mono={m.mono} tone={m.tone} />
        <div className="min-w-0 flex-[1_1_14rem]">
          <p className="m-0 flex flex-wrap items-center gap-2">
            <span className="font-semibold">{s.name}</span>
            <span className={status.cls}>{status.text}</span>
            {s.oauthPerUser ? <span className={chipAccent}>{t("mcpClient.perUserChip")}</span> : null}
          </p>
          <p className={cx(mono, "text-ink-2 m-0 mt-1 truncate text-xs")} title={s.url}>
            {s.url}
          </p>
          <p className="text-ink-2 m-0 mt-1 text-xs">
            {[
              s.serverInfo?.name ? `${s.serverInfo.name}${s.serverInfo.version ? ` ${s.serverInfo.version}` : ""}` : null,
              t(`mcpClient.authShort.${s.auth}`) + (s.secretHint ? ` (${s.secretHint})` : ""),
              audience,
              t("mcpClient.stats", { calls: s.stats.calls, failed: s.stats.failed, people: s.stats.people }),
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {companyOAuth ? (
            s.connected ? (
              <button type="button" className={cx(btn, btnSm)} disabled={busy} onClick={onDisconnect}>
                {t("mcpClient.signOut")}
              </button>
            ) : (
              <button type="button" className={cx(btnPrimary, btnSm)} disabled={busy} onClick={onConnect}>
                {t("mcpClient.signIn")}
              </button>
            )
          ) : s.auth === "oauth" && !s.tools.length ? (
            // A per-person server lists its tools once someone (the admin, here) signs in with their own account.
            <button type="button" className={cx(btn, btnSm)} disabled={busy} onClick={onConnect}>
              {t("mcpClient.signInMine")}
            </button>
          ) : null}
          <button type="button" className={cx(btn, btnSm)} disabled={busy} onClick={onTest}>
            {busy ? t("mcpClient.testing") : t("mcpClient.test")}
          </button>
          <button type="button" className={cx(btn, btnSm)} onClick={onEdit}>
            {t("mcpClient.edit")}
          </button>
          <button type="button" className={cx(btn, btnSm, "text-block hover:bg-block-wash")} onClick={onRemove}>
            {t("mcpClient.remove")}
          </button>
        </div>
      </div>
      {s.test && !s.test.ok ? (
        <p role="status" className="text-block m-0 text-xs [overflow-wrap:anywhere]">
          {t("mcpClient.testFail", { error: s.test.error ?? "" })}
        </p>
      ) : s.test ? (
        <p className="text-ink-2 m-0 text-xs">{t("mcpClient.testOk", { ago: ago(s.test.at) })}</p>
      ) : null}
      {tools.length ? (
        <details className="border-hairline group rounded-lg border">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm [&::-webkit-details-marker]:hidden">
            <span className="flex-1 font-medium">{t("mcpClient.tools.summary", { count: tools.length, enabled, asking })}</span>
            <ChevronDownIcon className="text-ink-2 size-4 transition-transform group-open:rotate-180" />
          </summary>
          <ul className="divide-divider-soft border-hairline m-0 list-none divide-y border-t p-0">
            {tools.map((x) => (
              <li key={x.name} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
                <div className="min-w-0 flex-[1_1_16rem]">
                  <Checkbox
                    checked={x.enabled}
                    onChange={(e) => void setTool(x.name, { enabled: e.currentTarget.checked, confirm: x.confirm })}
                    label={
                      <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <span className={cx(mono, "text-ink text-[13px]")}>{x.name}</span>
                        {x.readOnly ? <span className={chip}>{t("mcpClient.tools.readOnly")}</span> : null}
                        {x.destructive ? <span className={chipWarn}>{t("mcpClient.tools.destructive")}</span> : null}
                      </span>
                    }
                    hint={
                      x.title || x.description ? (
                        <span className="line-clamp-2">
                          {x.title ? `${x.title}. ` : ""}
                          {x.description}
                        </span>
                      ) : undefined
                    }
                  />
                </div>
                <Segmented
                  size="sm"
                  label={t("mcpClient.tools.mode", { name: x.name })}
                  value={x.confirm ? "confirm" : "auto"}
                  onChange={(v) => void setTool(x.name, { enabled: x.enabled, confirm: v === "confirm" })}
                  options={[
                    { value: "auto", label: t("mcpClient.tools.auto") },
                    { value: "confirm", label: t("mcpClient.tools.confirm") },
                  ]}
                  className={cx("max-sm:ml-7", !x.enabled && "pointer-events-none opacity-50")}
                />
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </li>
  );
}

function CallList({ calls, names }: { calls: McpCall[]; names: Map<string, string> }) {
  const t = useT();
  const { ago } = useFormat();
  return (
    <ul className="divide-divider-soft border-hairline m-0 list-none divide-y border-t p-0">
      {calls.map((c) => (
        <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
          <span className="text-ink min-w-0 flex-[1_1_14rem] truncate">
            <span className="font-medium">{c.server}</span>
            <span className="text-ink-2"> › </span>
            <span className={cx(mono, "text-[13px]")}>{c.tool}</span>
          </span>
          <span className="text-ink-2 min-w-0 truncate text-xs">
            {names.get(c.userId) ?? t("mcpClient.calls.someone")} · {t(`mcpClient.feature.${c.feature === "workflow_step" ? "workflow" : "assistant"}`)} · {ago(c.at)}
          </span>
          <span className={OUTCOME_CHIP[c.outcome]}>{t(`mcpClient.outcome.${c.outcome}`)}</span>
          <span className="text-ink-2 w-14 text-right text-xs tabular-nums">{c.outcome === "declined" ? "" : `${c.ms} ms`}</span>
        </li>
      ))}
    </ul>
  );
}
