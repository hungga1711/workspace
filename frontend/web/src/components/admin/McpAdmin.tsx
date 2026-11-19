"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useFormat, useLocale, useT } from "@/lib/i18n/client";
import { INTL_TAG } from "@/lib/i18n/config";
import { dateTimeMedium } from "@/lib/format";
import { api } from "@/lib/client";
import { btn, btnSm, card, cardHead, cardTitle, cx, mono, table } from "@/lib/ui";
import { Segmented } from "@/components/ui/Segmented";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { useMcpUrl } from "@/components/mcp/McpConnect";
import { CopyButton } from "@/components/ui/CopyButton";
import { errorKey, toolLabel, type McpCall } from "@/components/mcp/labels";
import { useConfirm } from "@/components/ui/Confirm";

export interface McpConnections {
  grants: {
    id: string;
    clientName: string;
    redirectHost: string | null;
    permissions: string[];
    userId: string;
    userName: string | null;
    createdAt: string;
    lastUsedAt: string | null;
  }[];
  keys: { id: string; name: string; prefix: string; permissions: string[]; userId: string; userName: string | null; createdAt: string; lastUsedAt: string | null }[];
  canRevoke: boolean;
}
export interface McpActivity {
  days: number;
  totals: { calls: number; failed: number; people: number; apps: number };
  byTool: { tool: string; calls: number; failed: number }[];
  byPerson: { userId: string | null; userName: string | null; calls: number; lastAt: string }[];
  byClient: { client: string; via: McpCall["via"]; calls: number }[];
  calls: McpCall[];
  nextBefore: string | null;
}

/** Admin › AI agent: the MCP address, totals, top tools, people and apps, the call log, and every live connection. */
export function McpAdmin({
  connections,
  activity,
  days,
  tool,
}: {
  connections: McpConnections | "denied" | null;
  activity: McpActivity | "denied" | null;
  days: string;
  tool: string | null;
}) {
  const t = useT();
  const url = useMcpUrl();
  const href = (d: string, tl: string | null) => `/admin/workspace/mcp?days=${d}${tl ? `&tool=${tl}` : ""}`;
  return (
    <div className="grid min-w-0 gap-5">
      <section className={cx(card, "grid gap-2 p-4")}>
        <p className="m-0 text-sm font-medium">{t("mcpServer.url.label")}</p>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <code className={cx(mono, "bg-ground min-w-0 flex-1 truncate rounded-md px-3 py-2 text-[13px]")} title={url}>
            {url}
          </code>
          <CopyButton text={url} />
        </div>
        <p className="text-ink-2 m-0 text-xs">{t("mcpServer.admin.howTo")}</p>
      </section>

      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Segmented
          label={t("mcpServer.admin.period")}
          value={days}
          size="sm"
          options={(["1", "7", "30", "90"] as const).map((d) => ({ value: d, label: t(`mcpServer.admin.days_${d}`), href: href(d, tool) }))}
        />
        {tool ? (
          <Link href={href(days, null)} className={cx(btn, btnSm, "no-underline")}>
            {toolLabel(t, tool)} × <span className="sr-only">{t("mcpServer.admin.clearFilter")}</span>
          </Link>
        ) : null}
      </div>

      {activity && activity !== "denied" ? (
        <Activity key={`${days}:${tool ?? ""}`} a={activity} days={days} tool={tool} href={href} />
      ) : (
        <LoadFailed what={t("mcpServer.admin.log")} />
      )}
      {connections && connections !== "denied" ? <Connections c={connections} /> : <LoadFailed what={t("mcpServer.admin.connections")} />}
    </div>
  );
}

function Activity({ a, days, tool, href }: { a: McpActivity; days: string; tool: string | null; href: (d: string, tl: string | null) => string }) {
  const t = useT();
  const { ago } = useFormat();
  const intlTag = INTL_TAG[useLocale()];
  const [calls, setCalls] = useState(a.calls);
  const [next, setNext] = useState(a.nextBefore);
  const [moreFailed, setMoreFailed] = useState(false);
  const more = async () => {
    if (!next) return;
    try {
      const r = await api<McpActivity>(`identity/mcp/activity?days=${days}${tool ? `&tool=${tool}` : ""}&before=${encodeURIComponent(next)}`);
      setCalls((x) => [...x, ...r.calls]);
      setNext(r.nextBefore);
      setMoreFailed(false);
    } catch {
      setMoreFailed(true);
    }
  };
  const max = Math.max(1, ...a.byTool.map((x) => x.calls));
  const stats: [string, number, boolean][] = [
    [t("mcpServer.admin.calls"), a.totals.calls, false],
    [t("mcpServer.admin.people"), a.totals.people, false],
    [t("mcpServer.admin.apps"), a.totals.apps, false],
    [t("mcpServer.admin.failedCalls"), a.totals.failed, a.totals.failed > 0],
  ];
  return (
    <>
      <section className={cx(card, "divide-divider-soft grid grid-cols-2 sm:grid-cols-4 sm:divide-x")} aria-label={t("mcpServer.admin.calls")}>
        {stats.map(([label, n, bad]) => (
          <div key={label} className="grid gap-0.5 px-4 py-3">
            <span className="text-ink-2 text-xs">{label}</span>
            <span className={cx("font-display text-xl font-semibold tabular-nums", bad ? "text-block" : "text-ink")}>{n.toLocaleString()}</span>
          </div>
        ))}
      </section>

      <div className="grid min-w-0 items-start gap-5 lg:grid-cols-3">
        <section className={cx(card, "min-w-0")}>
          <div className={cardHead}>
            <h2 className={cardTitle}>{t("mcpServer.admin.byTool")}</h2>
          </div>
          <ul className="m-0 grid list-none gap-2 p-4">
            {a.byTool.length ? (
              a.byTool.slice(0, 8).map((x) => (
                <li key={x.tool} className="grid gap-1 text-sm">
                  <span className="flex items-center gap-2">
                    <Link href={href(days, x.tool)} className="min-w-0 flex-1 truncate no-underline hover:underline">
                      {toolLabel(t, x.tool)}
                    </Link>
                    <span className="text-ink-2 text-xs tabular-nums">{x.calls}</span>
                  </span>
                  <span className="bg-progress-track block h-1.5 overflow-hidden rounded-full">
                    <span className="bg-progress block h-full rounded-full" style={{ width: `${Math.round((100 * x.calls) / max)}%` }} />
                  </span>
                </li>
              ))
            ) : (
              <li className="text-ink-2 text-sm">{t("mcpServer.admin.empty")}</li>
            )}
          </ul>
        </section>
        <section className={cx(card, "min-w-0")}>
          <div className={cardHead}>
            <h2 className={cardTitle}>{t("mcpServer.admin.byPerson")}</h2>
          </div>
          <ul className="divide-divider-soft m-0 list-none divide-y px-4 py-1">
            {a.byPerson.slice(0, 8).map((x) => (
              <li key={x.userId ?? "none"} className="flex items-center gap-2 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{x.userName ?? t("mcpServer.admin.unknownPerson")}</span>
                <span className="text-ink-2 text-xs tabular-nums">{x.calls}</span>
              </li>
            ))}
            {a.byPerson.length ? null : <li className="text-ink-2 py-3 text-sm">{t("mcpServer.admin.empty")}</li>}
          </ul>
        </section>
        <section className={cx(card, "min-w-0")}>
          <div className={cardHead}>
            <h2 className={cardTitle}>{t("mcpServer.admin.byClient")}</h2>
          </div>
          <ul className="divide-divider-soft m-0 list-none divide-y px-4 py-1">
            {a.byClient.slice(0, 8).map((x) => (
              <li key={`${x.client}:${x.via}`} className="flex items-center gap-2 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{x.client === x.via ? t(`mcpServer.via.${x.via}`) : x.client}</span>
                <span className="text-ink-2 text-xs tabular-nums">{x.calls}</span>
              </li>
            ))}
            {a.byClient.length ? null : <li className="text-ink-2 py-3 text-sm">{t("mcpServer.admin.empty")}</li>}
          </ul>
        </section>
      </div>

      <section className="grid min-w-0 gap-2">
        <h2 className="m-0 text-sm font-semibold">{t("mcpServer.admin.log")}</h2>
        {calls.length ? (
          <div tabIndex={0} aria-label={t("mcpServer.admin.log")} className="min-w-0 overflow-x-auto rounded-xl">
            <table className={table}>
              <thead>
                <tr>
                  <th className="max-sm:hidden">{t("mcpServer.admin.when")}</th>
                  <th>{t("mcpServer.admin.who")}</th>
                  <th className="max-lg:hidden">{t("mcpServer.admin.app")}</th>
                  <th>{t("mcpServer.admin.tool")}</th>
                  <th>{t("mcpServer.admin.result")}</th>
                  <th className="text-right max-md:hidden">{t("mcpServer.admin.duration")}</th>
                </tr>
              </thead>
              <tbody>
                {calls.map((c) => (
                  <tr key={c.id}>
                    <td className="text-ink-2 whitespace-nowrap tabular-nums max-sm:hidden" title={new Date(c.at).toLocaleString(intlTag, dateTimeMedium)}>
                      {ago(c.at)}
                    </td>
                    {/* Below 1024px the app goes under the person (and on phones the time too), so the log fits without scrolling. */}
                    <td>
                      {c.userName ?? (c.via === "workspace_key" ? t("mcpServer.via.workspace_key") : t("mcpServer.admin.unknownPerson"))}
                      <span className="text-ink-2 block text-xs lg:hidden">
                        {c.clientName ?? t(`mcpServer.via.${c.via}`)}
                        <span className="sm:hidden"> · {ago(c.at)}</span>
                      </span>
                    </td>
                    <td className="max-lg:hidden">{c.clientName ?? t(`mcpServer.via.${c.via}`)}</td>
                    <td>{toolLabel(t, c.tool)}</td>
                    <td>
                      <span className={cx("inline-flex items-center gap-1.5", c.ok ? "text-ok" : "text-block")}>
                        <span className={cx("size-2 rounded-full", c.ok ? "bg-ok" : "bg-block")} aria-hidden="true" />
                        {c.ok ? t("mcpServer.activity.ok") : t(`mcpServer.errors.${errorKey(c.error ?? "failed")}`)}
                      </span>
                    </td>
                    <td className="text-ink-2 text-right tabular-nums max-md:hidden">{c.durationMs < 1000 ? `${c.durationMs} ms` : `${(c.durationMs / 1000).toFixed(1)} s`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-ink-2 m-0 text-sm">{t("mcpServer.admin.empty")}</p>
        )}
        {moreFailed ? <p className="text-block m-0 text-sm">{t("mcpServer.load.failed")}</p> : null}
        {next ? (
          <div>
            <button type="button" className={cx(btn, btnSm)} onClick={() => void more()}>
              {t("mcpServer.admin.more")}
            </button>
          </div>
        ) : null}
      </section>
    </>
  );
}

function Connections({ c }: { c: McpConnections }) {
  const t = useT();
  const { confirm, dialog } = useConfirm();
  const { ago } = useFormat();
  const router = useRouter();
  const [error, setError] = useState(false);
  const rows = [
    ...c.grants.map((g) => ({
      id: g.id,
      kind: "oauth" as const,
      name: g.clientName,
      person: g.userName,
      perms: g.permissions.length,
      lastUsedAt: g.lastUsedAt,
      path: `identity/oauth/grants/${g.id}`,
    })),
    ...c.keys.map((k) => ({
      id: k.id,
      kind: "key" as const,
      name: k.name,
      person: k.userName,
      perms: k.permissions.length,
      lastUsedAt: k.lastUsedAt,
      path: `identity/api-keys/${k.id}`,
    })),
  ].sort((a, b) => (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? ""));
  const revoke = async (r: (typeof rows)[number]) => {
    if (!(await confirm({ title: t("mcpServer.admin.revokeConfirm", { name: r.name, person: r.person ?? t("mcpServer.admin.unknownPerson") }), danger: true }))) return;
    setError(false);
    await api(r.path, { method: "DELETE" })
      .then(() => router.refresh())
      .catch(() => setError(true));
  };
  return (
    <>
      {dialog}
      <section className="grid min-w-0 gap-2">
        <h2 className="m-0 text-sm font-semibold">{t("mcpServer.admin.connections")}</h2>
        {error ? (
          <p className="text-block m-0 text-sm" role="alert">
            {t("mcpServer.connected.revokeFailed")}
          </p>
        ) : null}
        {rows.length ? (
          <ul className="bg-surface shadow-card divide-divider-soft m-0 list-none divide-y overflow-hidden rounded-xl p-0">
            {rows.map((r) => (
              <li key={`${r.kind}:${r.id}`} className="flex min-w-0 items-center gap-3 px-4 py-2.5 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-medium">{r.person ?? t("mcpServer.admin.unknownPerson")}</span>
                    <span className="text-ink-2 truncate">· {r.name}</span>
                  </span>
                  <span className="text-ink-2 block truncate text-xs">
                    {[
                      r.kind === "oauth" ? t("mcpServer.connected.oauth") : t("mcpServer.connected.key"),
                      t("mcpServer.connected.perms", { count: r.perms }),
                      r.lastUsedAt ? t("mcpServer.connected.lastUsed", { ago: ago(r.lastUsedAt) }) : t("mcpServer.connected.neverUsed"),
                    ].join(" · ")}
                  </span>
                </span>
                {c.canRevoke ? (
                  <button type="button" className={cx(btn, btnSm, "shrink-0")} onClick={() => void revoke(r)}>
                    {t("mcpServer.connected.revoke")}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-ink-2 m-0 text-sm">{t("mcpServer.admin.connectionsEmpty")}</p>
        )}
      </section>
    </>
  );
}
