"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { useFormat, useT } from "@/lib/i18n/client";
import { btn, btnPrimary, btnSm, cx, input } from "@/lib/ui";
import { Checkbox } from "@/components/ui/Checkbox";
import { useConfirm } from "@/components/ui/Confirm";
import { Field } from "@/components/ui/bits";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { RefreshIcon } from "@/components/app/icons";

export type SyncProvider = "asana" | "clickup" | "linear" | "jira";

export interface SyncConnection {
  id: string;
  provider: SyncProvider;
  name: string;
  site: string | null;
  accountEmail: string | null;
  scope: string[];
  enabled: boolean;
  lastRunAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  stats: { tasks?: number; fetched?: number; created?: number; updated?: number; unmatched?: number };
  projects: { externalId: string; projectId: string; name: string }[];
}
interface ExternalProject {
  id: string;
  name: string;
  key?: string | null;
}

const PROVIDERS: SyncProvider[] = ["asana", "clickup", "linear", "jira"];
export const PROVIDER_NAME: Record<SyncProvider, string> = { asana: "Asana", clickup: "ClickUp", linear: "Linear", jira: "Jira Cloud" };
/** Where each tool hands out the token (docs/integrations/task-sync.md has the steps). */
const TOKEN_URL: Record<SyncProvider, string> = {
  asana: "https://app.asana.com/0/my-apps",
  clickup: "https://app.clickup.com/settings/apps",
  linear: "https://linear.app/settings/account/security",
  jira: "https://id.atlassian.com/manage-profile/security/api-tokens",
};

const errorText = (e: unknown, fallback: string) => (e as { body?: { message?: string } })?.body?.message ?? fallback;

/** Admin › Integrations › Task sync: connections to Asana, ClickUp, Linear and Jira Cloud, read-only. */
export function TaskSyncAdmin({ connections }: { connections: SyncConnection[] | null }) {
  const tx = useT();
  const [adding, setAdding] = useState(connections !== null && connections.length === 0);
  if (!connections) return <LoadFailed what={tx("taskSync.title")} />;
  return (
    <div className="grid gap-4">
      <p className="text-ink-2 m-0 max-w-[65ch] text-sm">{tx("taskSync.intro")}</p>
      {connections.map((c) => (
        <ConnectionCard key={c.id} c={c} />
      ))}
      {adding ? (
        <ConnectForm onCancel={connections.length ? () => setAdding(false) : null} onDone={() => setAdding(false)} />
      ) : (
        <div>
          <button type="button" className={btn} onClick={() => setAdding(true)}>
            {tx("taskSync.connectAnother")}
          </button>
        </div>
      )}
    </div>
  );
}

function ConnectionCard({ c }: { c: SyncConnection }) {
  const tx = useT();
  const { ago } = useFormat();
  const router = useRouter();
  const { confirm, dialog } = useConfirm();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  const [choosing, setChoosing] = useState(false);
  const syncNow = async () => {
    setBusy(true);
    setNote(null);
    try {
      const r = await api<{ fetched: number; created: number; updated: number; error: string | null }>(`work/task-sync/${c.id}/run`, { method: "POST" });
      setNote(r.error ? { text: r.error, tone: "err" } : { text: tx("taskSync.ran", { fetched: r.fetched, created: r.created, updated: r.updated }), tone: "ok" });
      router.refresh();
    } catch (e) {
      setNote({ text: errorText(e, tx("taskSync.failed")), tone: "err" });
    } finally {
      setBusy(false);
    }
  };
  const setEnabled = async (enabled: boolean) => {
    await api(`work/task-sync/${c.id}`, { method: "PATCH", body: { enabled } }).catch(() => undefined);
    router.refresh();
  };
  const disconnect = async () => {
    const ok = await confirm({
      title: tx("taskSync.disconnectTitle", { name: c.name }),
      body: tx("taskSync.disconnectBody", { tool: PROVIDER_NAME[c.provider] }),
      confirmLabel: tx("taskSync.disconnect"),
      danger: true,
    });
    if (!ok) return;
    await api(`work/task-sync/${c.id}`, { method: "DELETE" }).catch(() => undefined);
    router.refresh();
  };
  const state = !c.enabled ? "paused" : c.lastError ? "error" : c.lastOkAt ? "ok" : "pending";
  return (
    <section className="bg-surface shadow-card grid gap-3 rounded-xl p-4" aria-label={c.name}>
      {dialog}
      <div className="flex flex-wrap items-start gap-3">
        <span className="bg-sky-wash text-sky-text grid size-9 shrink-0 place-items-center rounded-lg text-[13px] font-semibold">{PROVIDER_NAME[c.provider].slice(0, 2)}</span>
        <div className="min-w-0 flex-1">
          <h3 className="m-0 flex flex-wrap items-center gap-2 text-sm font-semibold">
            {c.name}
            <span
              className={cx(
                "rounded-md px-1.5 py-0.5 text-xs font-medium",
                state === "ok" ? "bg-ok-wash text-ok" : state === "error" ? "bg-block-wash text-block" : "bg-hover text-ink-2",
              )}
            >
              {tx(`taskSync.state.${state}`)}
            </span>
          </h3>
          <p className="text-ink-2 m-0 mt-0.5 text-sm">
            {c.lastRunAt ? tx("taskSync.lastRun", { when: ago(c.lastRunAt) }) : tx("taskSync.neverRun")}
            {" · "}
            {tx("taskSync.tasks", { count: c.stats.tasks ?? 0 })}
            {c.stats.unmatched ? ` · ${tx("taskSync.unmatched", { count: c.stats.unmatched })}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={cx(btn, btnSm)} onClick={() => void syncNow()} disabled={busy || !c.enabled}>
            <RefreshIcon className={busy ? "animate-spin" : undefined} />
            {busy ? tx("taskSync.syncing") : tx("taskSync.syncNow")}
          </button>
          <button type="button" className={cx(btn, btnSm)} onClick={() => setChoosing((v) => !v)} aria-expanded={choosing}>
            {tx("taskSync.choose")}
          </button>
          <button type="button" className={cx(btn, btnSm)} onClick={() => void setEnabled(!c.enabled)}>
            {c.enabled ? tx("taskSync.pause") : tx("taskSync.resume")}
          </button>
          <button type="button" className={cx(btn, btnSm, "text-block")} onClick={() => void disconnect()}>
            {tx("taskSync.disconnect")}
          </button>
        </div>
      </div>
      {c.lastError ? (
        <p className="bg-block-wash text-block m-0 rounded-lg px-3 py-2 text-sm" role="alert">
          {c.lastError}
        </p>
      ) : null}
      {note ? (
        <p className={cx("m-0 text-sm", note.tone === "ok" ? "text-ok" : "text-block")} role="status">
          {note.text}
        </p>
      ) : null}
      {c.projects.length ? (
        <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
          {c.projects.map((p) => (
            <li key={p.externalId}>
              <Link href={`/app/work/projects/${p.projectId}`} className="bg-hover text-ink inline-flex h-7 items-center rounded-md px-2 text-[13px] no-underline hover:underline">
                {p.name}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      {choosing ? <ChooseProjects connectionId={c.id} chosen={c.scope} onDone={() => setChoosing(false)} /> : null}
    </section>
  );
}

/** The saved token's projects, ticked as chosen; saving re-reads newly ticked ones from the start. */
function ChooseProjects({ connectionId, chosen, onDone }: { connectionId: string; chosen: string[]; onDone: () => void }) {
  const tx = useT();
  const router = useRouter();
  const [list, setList] = useState<ExternalProject[] | "failed">([]);
  const [picked, setPicked] = useState(new Set(chosen));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api<{ projects: ExternalProject[] }>(`work/task-sync/${connectionId}/projects`).then(
      (r) => live && setList(r.projects),
      (e: unknown) => {
        if (!live) return;
        setError(errorText(e, tx("taskSync.failed")));
        setList("failed");
      },
    );
    return () => {
      live = false;
    };
  }, [connectionId, tx]);
  const save = async () => {
    await api(`work/task-sync/${connectionId}`, { method: "PATCH", body: { scope: [...picked] } }).catch(() => undefined);
    onDone();
    router.refresh();
  };
  return (
    <div className="border-hairline grid gap-3 border-t pt-3">
      {list === "failed" ? <p className="text-block m-0 text-sm">{error}</p> : <ProjectList projects={list} picked={picked} onChange={setPicked} />}
      <div className="flex gap-2">
        <button type="button" className={cx(btnPrimary, btnSm)} onClick={() => void save()} disabled={list === "failed"}>
          {tx("taskSync.save")}
        </button>
        <button type="button" className={cx(btn, btnSm)} onClick={onDone}>
          {tx("taskSync.cancel")}
        </button>
      </div>
    </div>
  );
}

function ProjectList({ projects, picked, onChange }: { projects: ExternalProject[]; picked: Set<string>; onChange: (s: Set<string>) => void }) {
  const tx = useT();
  if (!projects.length) return <p className="text-ink-2 m-0 text-sm">{tx("taskSync.loadingProjects")}</p>;
  return (
    <fieldset className="m-0 grid max-h-72 gap-1 overflow-y-auto border-0 p-0">
      <legend className="mb-1 text-sm font-medium">{tx("taskSync.pick")}</legend>
      {projects.map((p) => (
        <Checkbox
          key={p.id}
          checked={picked.has(p.id)}
          onChange={(e) => {
            const n = new Set(picked);
            if (e.target.checked) n.add(p.id);
            else n.delete(p.id);
            onChange(n);
          }}
          label={
            <span className="min-w-0">
              {p.key ? <span className="text-ink-2 mr-1.5 font-mono text-xs">{p.key}</span> : null}
              {p.name}
            </span>
          }
        />
      ))}
    </fieldset>
  );
}

/** New connection: tool → token (and Jira's site and email) → check → choose → save. */
function ConnectForm({ onCancel, onDone }: { onCancel: (() => void) | null; onDone: () => void }) {
  const tx = useT();
  const router = useRouter();
  const [provider, setProvider] = useState<SyncProvider>("asana");
  const [token, setToken] = useState("");
  const [site, setSite] = useState("");
  const [email, setEmail] = useState("");
  const [projects, setProjects] = useState<ExternalProject[] | null>(null);
  const [picked, setPicked] = useState(new Set<string>());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const creds = { provider, token: token.trim(), ...(provider === "jira" ? { site: site.trim(), email: email.trim() } : {}) };
  const ready = token.trim().length >= 8 && (provider !== "jira" || (site.trim() && email.includes("@")));
  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ projects: ExternalProject[] }>("work/task-sync/test", { method: "POST", body: creds });
      setProjects(r.projects);
      setPicked(new Set(r.projects.slice(0, 1).map((p) => p.id)));
      if (!r.projects.length) setError(tx("taskSync.noProjects"));
    } catch (e) {
      setError(errorText(e, tx("taskSync.failed")));
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    setBusy(true);
    try {
      await api("work/task-sync", { method: "POST", body: { ...creds, scope: [...picked] } });
      onDone();
      router.refresh();
    } catch (e) {
      setError(errorText(e, tx("taskSync.failed")));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="bg-surface shadow-card grid gap-4 rounded-xl p-4" aria-labelledby="task-sync-connect">
      <h3 id="task-sync-connect" className="m-0 text-sm font-semibold">
        {tx("taskSync.connect")}
      </h3>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={tx("taskSync.tool")}>
        {PROVIDERS.map((p) => (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={provider === p}
            onClick={() => {
              setProvider(p);
              setProjects(null);
              setError(null);
            }}
            className={cx(btn, btnSm, provider === p && "bg-selected shadow-[0_0_0_1px_var(--edge)]")}
          >
            {PROVIDER_NAME[p]}
          </button>
        ))}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {provider === "jira" ? (
          <>
            <Field label={tx("taskSync.site")} hint={tx("taskSync.siteHint")}>
              <input id="task-sync-site" className={input} value={site} onChange={(e) => setSite(e.target.value)} placeholder="your-company.atlassian.net" autoComplete="off" />
            </Field>
            <Field label={tx("taskSync.email")} hint={tx("taskSync.emailHint")}>
              <input id="task-sync-email" className={input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
            </Field>
          </>
        ) : null}
        <Field label={tx("taskSync.token")} hint={tx(`taskSync.tokenHint.${provider}`)}>
          <input id="task-sync-token" className={input} type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" spellCheck={false} />
        </Field>
      </div>
      <p className="text-ink-2 m-0 text-sm">
        <a href={TOKEN_URL[provider]} target="_blank" rel="noreferrer noopener">
          {tx("taskSync.getToken", { tool: PROVIDER_NAME[provider] })} ↗
        </a>{" "}
        · {tx("taskSync.readOnly")}
      </p>
      {projects?.length ? <ProjectList projects={projects} picked={picked} onChange={setPicked} /> : null}
      {error ? (
        <p className="text-block m-0 text-sm" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {projects?.length ? (
          <button type="button" className={btnPrimary} onClick={() => void save()} disabled={busy || !picked.size}>
            {tx("taskSync.saveAndSync", { count: picked.size })}
          </button>
        ) : (
          <button type="button" className={btnPrimary} onClick={() => void check()} disabled={busy || !ready}>
            {busy ? tx("taskSync.checking") : tx("taskSync.check")}
          </button>
        )}
        {onCancel ? (
          <button type="button" className={btn} onClick={onCancel}>
            {tx("taskSync.cancel")}
          </button>
        ) : null}
      </div>
    </section>
  );
}
