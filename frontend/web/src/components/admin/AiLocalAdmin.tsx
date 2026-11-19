"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { api } from "@/lib/client";
import { useFormat, useT } from "@/lib/i18n/client";
import { btn, btnPrimary, btnSm, chip, chipOk, cx } from "@/lib/ui";
import { BotIcon, RefreshIcon, ScreenIcon, UsersIcon } from "@/components/app/icons";
import { IconTile } from "@/components/ui/Bento";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { Picker } from "@/components/ui/Picker";
import { useToast } from "@/components/ui/Toast";
import { refreshAiStatus } from "@/app/admin/workspace/ai/actions";
import type { ConnectDevice } from "@/components/ai-hub/ConnectView";

export interface LocalServer {
  id: string;
  name: string;
  baseUrl: string;
  models: string[];
  connected: boolean;
}
export interface LocalOverview {
  computers: { connected: number; online: number; people: number };
  workflow: number;
  guard: number;
  usagePeople: number;
  extensionPeople: number;
  found: { id: string; name: string; kind: string; computers: number }[];
  mine: ConnectDevice[];
  answering: { id: string; at: { device: string; ai: string } | null; online: boolean }[];
  /** People answering their own questions with their own computer's AI, and whether the company allows it. */
  personal: { allowed: boolean; people: number };
}

/**
 * Admin › AI: the AI that is already running, found instead of typed in. Model servers on the workspace server
 * itself (Ollama, LM Studio…) and the AI on the admin's own connected computer each take one click to answer for the
 * assistant; below, how many staff computers are connected and what was found on them. Keys, addresses and the other
 * ways to connect stay in the list under this card.
 */
export function AiLocalAdmin({ servers, overview, assistant }: { servers: LocalServer[] | null; overview: LocalOverview | null; assistant: boolean }) {
  const t = useT();
  const { time } = useFormat();
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [model, setModel] = useState<Record<string, string>>({});
  const [personal, setPersonal] = useState(overview?.personal.allowed ?? true);

  // Computers connect and go to sleep while this page is open; no polling, the admin re-reads it when they want to.
  const [checking, startCheck] = useTransition();
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const check = () =>
    startCheck(() => {
      router.refresh();
      setCheckedAt(new Date());
    });

  const allowPersonal = async (allow: boolean) => {
    setPersonal(allow);
    try {
      await api("ai/local/connect/personal-policy", { method: "PUT", body: { allow } });
      await refreshAiStatus();
      router.refresh();
    } catch {
      setPersonal(!allow);
      toast({ message: t("aiConnect.admin.personalFailed") });
    }
  };

  const done = async (name: string) => {
    toast({ message: t("aiConnect.admin.used", { name }) });
    await refreshAiStatus();
    router.refresh();
  };
  const run = async (key: string, name: string, call: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await call();
      await done(name);
    } catch {
      toast({ message: t("aiConnect.admin.useFailed") });
    } finally {
      setBusy(null);
    }
  };
  const picker = (key: string, models: string[]) =>
    models.length > 1 ? (
      <Picker
        label={t("aiConnect.admin.model")}
        variant="button"
        align="right"
        value={model[key] ?? models[0]!}
        options={models.map((m) => ({ value: m, label: m }))}
        onChange={(v) => setModel((x) => ({ ...x, [key]: v }))}
      />
    ) : null;
  const rowCls = "flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 py-2.5";
  const groupTitle = "text-ink-2 m-0 pt-3 text-xs font-semibold";
  const inUse = (dev: string, ai: string) => !!overview?.answering.some((a) => a.at?.device === dev && a.at.ai === ai);

  return (
    <section className="bg-surface shadow-card grid min-w-0 gap-1 rounded-xl p-5 max-sm:p-4" aria-labelledby="ai-local-h" data-testid="ai-local">
      <h2 id="ai-local-h" className="m-0 flex items-center gap-3 text-sm font-semibold tracking-[-0.01em]">
        <IconTile tone="sky">
          <ScreenIcon />
        </IconTile>
        <span className="min-w-0 flex-1">{t("aiConnect.admin.title")}</span>
        {checkedAt ? <span className="text-ink-2 text-xs font-normal max-sm:hidden">{t("aiConnect.checkedAt", { time: time(checkedAt) })}</span> : null}
        <button type="button" className={cx(btn, btnSm)} disabled={checking} onClick={check} data-testid="ai-local-recheck">
          <RefreshIcon className={cx("size-3.5", checking && "animate-spin")} />
          {t("aiConnect.recheck")}
        </button>
      </h2>
      <p className="text-ink-2 m-0 mt-1 max-w-2xl text-sm">{t("aiConnect.admin.lead")}</p>

      {assistant ? (
        <>
          <h3 className={groupTitle}>{t("aiConnect.admin.server")}</h3>
          {servers === null ? (
            <LoadFailed />
          ) : servers.length ? (
            <ul className="divide-divider-soft m-0 grid list-none divide-y p-0">
              {servers.map((s) => (
                <li key={s.id} className={rowCls} data-testid="local-server">
                  <BotIcon className="text-ink-2 size-4 shrink-0" />
                  <span className="min-w-0 flex-1 basis-40">
                    <span className="text-ink block truncate text-sm font-medium">{s.name}</span>
                    <span className="text-ink-2 block truncate text-xs">{new URL(s.baseUrl).host}</span>
                  </span>
                  {s.connected ? (
                    <span className={chipOk}>{t("aiConnect.admin.inUse")}</span>
                  ) : (
                    <>
                      {picker(s.id, s.models)}
                      <button
                        type="button"
                        className={cx(btnPrimary, btnSm)}
                        disabled={busy === s.id}
                        onClick={() =>
                          void run(s.id, s.name, () =>
                            api("ai/connections", { method: "POST", body: { mode: "selfhost", baseUrl: s.baseUrl, modelSmart: model[s.id] ?? s.models[0] } }),
                          )
                        }
                      >
                        {t("aiConnect.admin.use")}
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-ink-2 m-0 py-2 text-sm">{t("aiConnect.admin.serverNone")}</p>
          )}

          <h3 className={groupTitle}>{t("aiConnect.admin.mine")}</h3>
          {overview === null ? (
            <LoadFailed />
          ) : overview.mine.some((d) => d.found.length) ? (
            <>
              <ul className="divide-divider-soft m-0 grid list-none divide-y p-0">
                {overview.mine.flatMap((d) =>
                  d.found.map((f) => {
                    const key = `${d.device}/${f.id}`;
                    return (
                      <li key={key} className={rowCls} data-testid="local-device-ai">
                        <span aria-hidden="true" className={cx("size-2 shrink-0 rounded-full", d.online ? "bg-ok-fill" : "bg-hairline")} />
                        <span className="min-w-0 flex-1 basis-40">
                          <span className="text-ink block truncate text-sm font-medium">{f.name}</span>
                          <span className="text-ink-2 block truncate text-xs">
                            {d.device}
                            {d.online ? "" : ` · ${t("aiConnect.admin.mineOffline")}`}
                          </span>
                        </span>
                        {inUse(d.device, f.id) ? (
                          <span className={chipOk}>{t("aiConnect.admin.inUse")}</span>
                        ) : (
                          <>
                            {picker(key, f.models ?? [])}
                            <button
                              type="button"
                              className={cx(btn, btnSm)}
                              disabled={busy === key || !d.online}
                              onClick={() =>
                                void run(key, f.name, () =>
                                  api("ai/local/connect/use", {
                                    method: "POST",
                                    body: { device: d.device, ai: f.id, ...(f.kind === "server" ? { model: model[key] ?? f.models?.[0] } : {}) },
                                  }),
                                )
                              }
                            >
                              {t("aiConnect.admin.use")}
                            </button>
                          </>
                        )}
                      </li>
                    );
                  }),
                )}
              </ul>
              <p className="text-ink-2 m-0 text-xs">{t("aiConnect.admin.deviceNote")}</p>
            </>
          ) : (
            <p className="text-ink-2 m-0 flex flex-wrap items-center gap-x-3 gap-y-2 py-2 text-sm">
              {t("aiConnect.admin.mineNone")}
              <Link href="/app/ai/connect" className={cx(btn, btnSm, "no-underline")}>
                {t("aiConnect.admin.openConnect")}
              </Link>
            </p>
          )}
        </>
      ) : null}

      {assistant && overview ? (
        <>
          <h3 className={groupTitle}>{t("aiConnect.admin.personal")}</h3>
          <div className="grid min-w-0 gap-1 py-2" data-testid="ai-personal">
            <label className="text-ink flex min-h-8 items-start gap-2.5 text-sm">
              <input type="checkbox" className="accent-brand mt-0.5 size-4 shrink-0" checked={personal} onChange={(e) => void allowPersonal(e.target.checked)} />
              <span className="min-w-0">
                {t("aiConnect.admin.personalAllow")}
                {personal && overview.personal.people ? <span className="text-ink-2"> · {t("aiConnect.admin.personalPeople", { count: overview.personal.people })}</span> : null}
              </span>
            </label>
            <p className="text-ink-2 pl-6.5 m-0 text-xs">{t("aiConnect.admin.personalNote")}</p>
          </div>
        </>
      ) : null}

      <h3 className={groupTitle}>{t("aiConnect.admin.team")}</h3>
      {overview === null ? (
        <LoadFailed />
      ) : overview.computers.connected ? (
        <div className="grid min-w-0 gap-2 py-2">
          <p className="text-ink m-0 flex items-center gap-2 text-sm">
            <UsersIcon className="text-ink-2 size-4 shrink-0" />
            {t("aiConnect.admin.teamLine", { people: overview.computers.people, computers: overview.computers.online })}
          </p>
          <p className="text-ink-2 m-0 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            <span>
              <span className="text-ink font-medium tabular-nums">{overview.workflow}</span> {t("aiConnect.admin.teamWorkflow")}
            </span>
            <span>
              <span className="text-ink font-medium tabular-nums">{overview.guard}</span> {t("aiConnect.admin.teamGuard")}
            </span>
            <span>
              <span className="text-ink font-medium tabular-nums">{overview.usagePeople}</span> {t("aiConnect.admin.teamUsage")}
            </span>
            <span>
              <span className="text-ink font-medium tabular-nums">{overview.extensionPeople}</span> {t("aiConnect.admin.teamExt")}
            </span>
          </p>
          {overview.found.length ? (
            <p className="m-0 flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="text-ink-2 mr-1 text-xs">{t("aiConnect.admin.teamFound")}</span>
              {overview.found.map((f) => (
                <span key={f.id} className={chip}>
                  {f.name} <span className="text-ink-2 font-normal tabular-nums">{f.computers}</span>
                </span>
              ))}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="text-ink-2 m-0 flex flex-wrap items-center gap-x-3 gap-y-2 py-2 text-sm">
          {t("aiConnect.admin.teamNone")}
          <Link href="/app/ai/connect" className={cx(btn, btnSm, "no-underline")}>
            {t("aiConnect.admin.openConnect")}
          </Link>
        </p>
      )}
    </section>
  );
}
