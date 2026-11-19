"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";
import { useFormat, useT } from "@/lib/i18n/client";
import { btn, btnDanger, btnPrimary, btnSm, cx, input } from "@/lib/ui";
import { McpMonogram } from "@/components/ai/McpMonogram";
import { ArrowRightIcon, BotIcon, DownloadIcon, LinkIcon, RefreshIcon, SparkleIcon } from "@/components/app/icons";
import { IconTile } from "@/components/ui/Bento";
import { Checkbox } from "@/components/ui/Checkbox";
import { useConfirm } from "@/components/ui/Confirm";
import { Field } from "@/components/ui/bits";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { Modal } from "@/components/ui/Modal";
import { tileOf, type HubConnection, type HubIntegration } from "@/components/integrations/types";

const card = "rounded-xl shadow-card bg-surface";
/** The integrations this build ships words for; one contributed since reads in the English its file carries. */
type Shipped = "github" | "gitlab" | "figma";
const shipped = (id: string): id is Shipped => id === "github" || id === "gitlab" || id === "figma";
const GROUPS = ["development", "design", "other"] as const;

/**
 * The integrations hub: every tool the workspace can connect, in one place. The tiles on top are the
 * hub's own integrations (GitHub, GitLab, Figma: one provider file each, contributed like any code); under them, the
 * ways in that already existed (task sync, tools for the company's AI, apps and agents, imports, API keys and
 * webhooks), linked rather than moved. Connecting takes a token, checked before it is saved and never shown again.
 */
export function IntegrationsHub() {
  const t = useT();
  const [data, setData] = useState<{ integrations: HubIntegration[]; connections: HubConnection[] } | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<HubIntegration | null>(null);
  const load = useCallback(() => {
    setFailed(false);
    Promise.all([api<{ integrations: HubIntegration[] }>("work/integrations"), api<{ connections: HubConnection[] }>("work/integrations/connections")])
      .then(([a, b]) => setData({ integrations: a.integrations, connections: b.connections }))
      .catch(() => setFailed(true));
  }, []);
  useEffect(load, [load]);
  const more = [
    { href: "/admin/workspace/integrations/task-sync", icon: <RefreshIcon />, tone: "sky", key: "taskSync" },
    { href: "/admin/workspace/ai", icon: <SparkleIcon />, tone: "violet", key: "aiTools" },
    { href: "/admin/workspace/mcp", icon: <BotIcon />, tone: "green", key: "agents" },
    { href: "#imp-h", icon: <DownloadIcon />, tone: "rose", key: "import" },
    { href: "#keys-h", icon: <LinkIcon />, tone: "tangerine", key: "developer" },
  ] as const;
  return (
    <section aria-labelledby="hub-h" className="grid min-w-0 gap-4">
      <div>
        <h2 id="hub-h" className="m-0 text-sm/6 font-semibold tracking-[-0.01em]">
          {t("hub.admin.title")}
        </h2>
        <p className="text-ink-2 m-0 text-sm">{t("hub.admin.lead")}</p>
      </div>
      {failed ? (
        <LoadFailed what={t("hub.admin.title")} onRetry={load} />
      ) : !data ? (
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3" aria-hidden="true">
          <span className="shimmer h-24 rounded-xl" />
          <span className="shimmer h-24 rounded-xl" />
          <span className="shimmer h-24 rounded-xl" />
        </div>
      ) : (
        GROUPS.map((g) => {
          const items = data.integrations.filter((i) => i.category === g);
          if (!items.length) return null;
          return (
            <div key={g} className="grid gap-2">
              <h3 className="text-ink-2 m-0 text-xs font-medium">{t(`hub.group.${g}`)}</h3>
              <ul className="m-0 grid list-none grid-cols-1 gap-2.5 p-0 sm:grid-cols-2 lg:grid-cols-3">
                {items.map((i) => {
                  const conns = data.connections.filter((c) => c.provider === i.id);
                  const tile = tileOf(i.id, i.name);
                  const broken = conns.find((c) => c.lastError);
                  return (
                    <li key={i.id} className={cx(card, "flex min-w-0 flex-col gap-3 p-3")}>
                      <div className="flex min-w-0 items-start gap-3">
                        <McpMonogram mono={tile.mono} tone={tile.tone} />
                        <div className="grid min-w-0 flex-1 gap-0.5">
                          <p className="text-ink m-0 flex min-w-0 items-center gap-2 text-sm font-semibold">
                            <span className="truncate">{i.name}</span>
                            {conns.length ? (
                              <span
                                className={cx(
                                  "inline-flex h-5 shrink-0 items-center rounded-full px-2 text-xs font-medium",
                                  broken ? "bg-warn-wash text-warn" : "bg-ok-wash text-ok",
                                )}
                              >
                                {t(broken ? "hub.admin.needsAttention" : "hub.admin.connected")}
                              </span>
                            ) : null}
                          </p>
                          <p className="text-ink-2 m-0 text-xs">{shipped(i.id) ? t(`hub.summary.${i.id}`) : i.summary}</p>
                        </div>
                      </div>
                      <div className="mt-auto flex min-w-0 items-center gap-2">
                        <p className="text-ink-2 m-0 min-w-0 flex-1 truncate text-xs" title={conns.map((c) => c.account).join(", ")}>
                          {conns.length ? conns.map((c) => (c.selfHosted ? `${c.account} · ${c.site.replace(/^https?:\/\//, "")}` : c.account)).join(", ") : ""}
                        </p>
                        <button type="button" className={cx(conns.length ? btn : btnPrimary, btnSm, "shrink-0")} onClick={() => setOpen(i)}>
                          {t(conns.length ? "hub.admin.manage" : "hub.admin.connect")}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })
      )}
      {/* What was already here, each where it lives. */}
      <div className="grid gap-2">
        <h3 className="text-ink-2 m-0 text-xs font-medium">{t("hub.group.more")}</h3>
        <ul className="m-0 grid list-none grid-cols-1 gap-2.5 p-0 sm:grid-cols-2 lg:grid-cols-3">
          {more.map((m) => {
            const body = (
              <>
                <IconTile tone={m.tone}>{m.icon}</IconTile>
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="text-ink text-sm font-semibold">{t(`hub.more.${m.key}.title`)}</span>
                  <span className="text-ink-2 text-xs">{t(`hub.more.${m.key}.hint`)}</span>
                </span>
                <ArrowRightIcon className="text-ink-2 mt-1 size-4 shrink-0" />
              </>
            );
            const cls = cx(card, "hover:bg-hover/60 flex h-full min-w-0 items-start gap-3 p-3 no-underline transition-colors");
            return (
              <li key={m.key}>
                {m.href.startsWith("#") ? (
                  <a href={m.href} className={cls}>
                    {body}
                  </a>
                ) : (
                  <Link href={m.href} className={cls}>
                    {body}
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      </div>
      <p className="text-ink-2 m-0 text-xs">{t("hub.admin.contribute")}</p>
      {open && data ? (
        <ConnectDialog
          integration={open}
          connections={data.connections.filter((c) => c.provider === open.id)}
          onClose={() => setOpen(null)}
          onChanged={() => {
            setOpen(null);
            load();
          }}
        />
      ) : null}
    </section>
  );
}

type Repo = { id: string; name: string };

/**
 * Connect, or look after, one integration. A new connection: the token (and, for a tool a company can host itself,
 * its address), checked before it is saved; then, where the tool has repositories, which of them are looked through
 * for pull requests that name a task. An existing one: its state, a new token, the repositories, disconnect.
 */
function ConnectDialog({
  integration: i,
  connections,
  onClose,
  onChanged,
}: {
  integration: HubIntegration;
  connections: HubConnection[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = useT();
  const { ago } = useFormat();
  const { confirm, dialog } = useConfirm();
  // A tool with one address has one connection; a self-hosted one may have several, and "add another" opens the form.
  const [conn, setConn] = useState<HubConnection | null>(connections[0] ?? null);
  const [token, setToken] = useState("");
  const [site, setSite] = useState("");
  const [inside, setInside] = useState(false);
  const [checked, setChecked] = useState<{ account: string; site: string } | null>(null);
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [picked, setPicked] = useState<string[]>(conn?.repos ?? []);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const body = { provider: i.id, token: token.trim(), ...(i.selfHosted && site.trim() ? { site: site.trim(), privateNetwork: inside } : {}) };

  // An existing connection: the repositories its token sees, to change the selection.
  useEffect(() => {
    if (!conn || !i.scansRepos) return;
    let off = false;
    setRepos(null);
    setPicked(conn.repos);
    void api<{ repos: Repo[] }>(`work/integrations/connections/${conn.id}/repos`)
      .then((r) => !off && setRepos(r.repos))
      .catch(() => !off && setRepos([]));
    return () => {
      off = true;
    };
  }, [conn, i.scansRepos]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error && e.message && !/^HTTP \d+/.test(e.message) ? e.message : t("hub.connect.failed"));
    }
    setBusy(false);
  };
  const check = () =>
    run(async () => {
      const r = await api<{ account: string; site: string; repos: Repo[] }>("work/integrations/check", { method: "POST", body });
      setChecked({ account: r.account, site: r.site });
      setRepos(r.repos);
    });
  const save = () =>
    run(async () => {
      if (conn)
        await api(`work/integrations/connections/${conn.id}`, {
          method: "PATCH",
          body: { ...(token.trim() ? { token: token.trim() } : {}), ...(i.scansRepos ? { repos: picked } : {}) },
        });
      else await api("work/integrations/connections", { method: "POST", body: { ...body, repos: picked } });
      onChanged();
    });
  const disconnect = async () => {
    if (!conn || !(await confirm({ title: t("hub.connect.disconnectTitle", { name: i.name }), body: t("hub.connect.disconnectBody"), danger: true }))) return;
    await run(async () => {
      await api(`work/integrations/connections/${conn.id}`, { method: "DELETE" });
      onChanged();
    });
  };
  const shownRepos = (repos ?? []).filter((r) => !filter.trim() || r.name.toLowerCase().includes(filter.trim().toLowerCase()));
  const canSave = conn ? true : !!checked;
  return (
    <Modal
      title={conn ? i.name : t("hub.connect.title", { name: i.name })}
      onClose={onClose}
      footer={
        <>
          {conn ? (
            <button type="button" className={cx(btnDanger, "mr-auto")} disabled={busy} onClick={() => void disconnect()}>
              {t("hub.connect.disconnect")}
            </button>
          ) : null}
          <button type="button" className={btn} onClick={onClose}>
            {t("common.cancel")}
          </button>
          {canSave ? (
            <button type="button" className={btnPrimary} disabled={busy} onClick={() => void save()}>
              {t(conn ? "common.save" : "hub.connect.save")}
            </button>
          ) : (
            <button type="button" className={btnPrimary} disabled={busy || token.trim().length < 8} onClick={() => void check()}>
              {t("hub.connect.check")}
            </button>
          )}
        </>
      }
    >
      {dialog}
      <div className="grid gap-4">
        {conn ? (
          <div className="grid gap-1">
            <p className="text-ink m-0 text-sm">
              {t("hub.connect.as", { account: conn.account })}
              {conn.selfHosted ? <span className="text-ink-2"> · {conn.site.replace(/^https?:\/\//, "")}</span> : null}
            </p>
            {conn.lastError ? (
              <p className="bg-warn-wash text-warn m-0 rounded-lg px-3 py-2 text-sm" role="status">
                {conn.lastError}
              </p>
            ) : conn.lastOkAt ? (
              <p className="text-ink-2 m-0 text-xs">{t("hub.connect.lastOk", { when: ago(conn.lastOkAt), n: conn.links })}</p>
            ) : null}
            {connections.length > 1 ? (
              <div className="mt-1 flex flex-wrap gap-1.5">
                {connections.map((c) => (
                  <button key={c.id} type="button" className={cx(btn, btnSm, c.id === conn.id && "bg-hover")} onClick={() => setConn(c)}>
                    {c.site.replace(/^https?:\/\//, "")}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : (
          <p className="text-ink-2 m-0 text-sm">{shipped(i.id) ? t(`hub.summary.${i.id}`) : i.summary}</p>
        )}
        {!conn && i.selfHosted ? (
          <>
            <Field label={t("hub.connect.site", { name: i.name })} hint={t("hub.connect.siteHint", { site: i.site.replace(/^https?:\/\//, "") })}>
              <input
                className={input}
                value={site}
                onChange={(e) => {
                  setSite(e.target.value);
                  setChecked(null);
                }}
                placeholder={i.site.replace(/^https?:\/\//, "")}
                inputMode="url"
                autoComplete="off"
              />
            </Field>
            {site.trim() ? (
              <Checkbox
                checked={inside}
                onChange={(e) => {
                  setInside(e.target.checked);
                  setChecked(null);
                }}
                label={t("hub.connect.inside")}
              />
            ) : null}
          </>
        ) : null}
        <Field label={t(conn ? "hub.connect.newToken" : "hub.connect.token")} hint={shipped(i.id) ? t(`hub.needs.${i.id}`) : i.tokenHelp.needs}>
          <input
            className={input}
            type="password"
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              setChecked(null);
            }}
            autoComplete="off"
            placeholder={conn ? t("hub.connect.keepToken") : ""}
          />
        </Field>
        <p className="text-ink-2 m-0 -mt-2 text-xs">
          <a href={i.tokenHelp.url} target="_blank" rel="noreferrer" className="font-medium">
            {t("hub.connect.howToken", { name: i.name })}
          </a>{" "}
          · {t("hub.connect.kept")}
        </p>
        {checked ? (
          <p className="bg-ok-wash text-ok m-0 rounded-lg px-3 py-2 text-sm" role="status">
            {t("hub.connect.checked", { account: checked.account })}
          </p>
        ) : null}
        {i.scansRepos && (conn || checked) ? (
          <fieldset className="m-0 grid min-w-0 gap-2 border-0 p-0">
            <legend className="p-0 text-sm font-medium">{t("hub.connect.repos")}</legend>
            <p className="text-ink-2 m-0 text-xs">{t("hub.connect.reposHint")}</p>
            {repos === null ? (
              <span className="shimmer h-9 rounded-lg" aria-hidden="true" />
            ) : repos.length || picked.length ? (
              <>
                {repos.length > 8 ? (
                  <input
                    className={cx(input, "h-9 text-sm")}
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder={t("hub.connect.reposFilter")}
                    aria-label={t("hub.connect.reposFilter")}
                  />
                ) : null}
                <ul className="border-hairline m-0 grid max-h-48 list-none gap-0.5 overflow-y-auto rounded-lg border p-1.5">
                  {/* Ones picked before stay listed even when the token no longer sees them, so they can be unticked. */}
                  {[...picked.filter((p) => !repos.some((r) => r.id === p)).map((p) => ({ id: p, name: p })), ...shownRepos].map((r) => (
                    <li key={r.id} className="min-w-0 px-1 py-0.5">
                      <Checkbox
                        checked={picked.includes(r.id)}
                        onChange={(e) => setPicked((l) => (e.target.checked ? [...l.filter((x) => x !== r.id), r.id] : l.filter((x) => x !== r.id)))}
                        label={r.name}
                      />
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="text-ink-2 m-0 text-sm">{t("hub.connect.reposNone")}</p>
            )}
          </fieldset>
        ) : null}
        {error ? (
          <p className="bg-block-wash text-block m-0 rounded-lg px-3 py-2 text-sm" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
