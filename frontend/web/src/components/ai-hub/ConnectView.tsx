"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import { useFormat, useT } from "@/lib/i18n/client";
import { AI_SITES } from "@/lib/ai-sites";
import { btn, btnGhost, btnPrimary, btnSm, card, chip, chipOk, chipWarn, cx, mono } from "@/lib/ui";
import { CheckIcon, CopyIcon, DownloadIcon, RefreshIcon, ScreenIcon, ShieldIcon, SparkleIcon, TrendIcon, WorkflowIcon } from "@/components/app/icons";
import { IconTile } from "@/components/ui/Bento";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { Picker } from "@/components/ui/Picker";
import { useToast } from "@/components/ui/Toast";
import { refreshAiStatus } from "@/app/admin/workspace/ai/actions";

export interface FoundAi {
  id: string;
  name: string;
  kind: "agent" | "server";
  cloud: boolean;
  hook?: boolean;
  models?: string[];
}
export interface ConnectDevice {
  device: string;
  os: string;
  online: boolean;
  lastSeenAt: string | null;
  found: FoundAi[];
  state: { workflow: boolean; usage: boolean; guard: boolean };
  prefer: string;
  keyPrefix: string;
}
export interface ConnectData {
  devices: ConnectDevice[];
  sensitiveMode: "warn" | "redact" | "block";
  monitoring: boolean;
  assistant: boolean;
  extension: { createdAt: string; lastSeenAt: string | null } | null;
  usageAt: string | null;
  answers: { device: string; ai: string }[];
  canManage: boolean;
  /** My own AI for my own questions; `company` names the company's connections. */
  personal: { allowed: boolean; choice: { device: string; ai: string; model: string } | null; active: boolean; company: string[] };
}

/** What the command needs from a personal key: read the task a workflow runs on and report its steps. */
const KEY_PERMISSIONS = ["task.read", "task.edit", "project.read"];

/**
 * AI › Connect: the AI on a person's own computer, connected once for four things (workflows, answers, token counts,
 * the safety net). One button makes a personal key and shows one line to paste; the program it starts finds the AI
 * that is installed, so nobody picks from a list or types an address. Each of the four cards says in a sentence
 * whether it works and what the next step is.
 */
export function ConnectView({ initial, origin, providers }: { initial: ConnectData; origin: string; providers: string[] }) {
  const t = useT();
  const { ago, time } = useFormat();
  const toast = useToast();
  const router = useRouter();
  const [d, setD] = useState(initial);
  const [failed, setFailed] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [os, setOs] = useState<"mac" | "win">("mac");
  // Off until the person asks: the line then only runs the program in the window they pasted it in.
  const [autostart, setAutostart] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [extCode, setExtCode] = useState<string | null>(null);
  // The command on screen: the key it carries and the computers that were already on when it was made.
  const pending = useRef<{ prefix: string; known: Set<string> } | null>(null);

  useEffect(() => {
    if (/Windows/i.test(navigator.userAgent)) setOs("win");
  }, []);

  const load = useCallback(
    () =>
      api<ConnectData>("ai/local/connect")
        .then((r) => {
          setFailed(false);
          setD(r);
          return r;
        })
        .catch(() => {
          setFailed(true);
          return null;
        }),
    [],
  );

  // No polling: the person checks when they ran the command (or want fresh status). The computer the command was
  // pasted on is the one signing in with its key, so one that reconnects under the same name (removed a moment ago,
  // or run again with a new code) counts too.
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const check = async () => {
    setChecking(true);
    const r = await load();
    setChecking(false);
    if (!r) return;
    setCheckedAt(new Date());
    const wait = pending.current;
    const fresh = wait && r.devices.find((x) => x.online && ((!!wait.prefix && x.keyPrefix === wait.prefix) || !wait.known.has(x.device)));
    if (fresh) {
      pending.current = null;
      setCode(null);
      toast({ message: t("aiConnect.connectedToast", { device: fresh.device }) });
      router.refresh();
    } else if (wait) toast({ message: t("aiConnect.notYetConnected") });
  };

  const connect = async () => {
    setBusy(true);
    try {
      const { grantable } = await api<{ grantable: string[] }>("identity/me/api-keys");
      const permissions = KEY_PERMISSIONS.filter((p) => grantable.includes(p));
      const r = await api<{ key: string }>("identity/me/api-keys", {
        method: "POST",
        body: { name: `AI connect · ${new Date().toISOString().slice(0, 10)}`, permissions: permissions.length ? permissions : grantable.slice(0, 1) },
      });
      // Computers that were already on are not "the new one", unless they sign in with this key.
      pending.current = { prefix: /^wos_([a-f0-9]{8})_/.exec(r.key)?.[1] ?? "", known: new Set(d.devices.filter((x) => x.online).map((x) => x.device)) };
      setCode(`${origin}#${r.key}`);
    } catch {
      toast({ message: t("aiConnect.keyFailed") });
    } finally {
      setBusy(false);
    }
  };

  const file = "workspace-connect.mjs";
  const command = code
    ? os === "win"
      ? `curl.exe -fsSL ${origin}/runner/${file} -o ${file}; node ${file} "${code}"${autostart ? " --install" : ""}`
      : `curl -fsSL ${origin}/runner/${file} -o ${file} && node ${file} "${code}"${autostart ? " --install" : ""}`
    : "";
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const remove = async (dev: ConnectDevice) => {
    if (!window.confirm(t("aiConnect.removeConfirm", { device: dev.device }))) return;
    try {
      await api(`ai/local/connect/devices/${encodeURIComponent(dev.device)}`, { method: "DELETE" });
      // The key it signed in with is what keeps its program working: revoke exactly that one.
      if (dev.keyPrefix) {
        const { keys } = await api<{ keys: { id: string; prefix: string; revokedAt: string | null }[] }>("identity/me/api-keys");
        const key = keys.find((k) => k.prefix === dev.keyPrefix && !k.revokedAt);
        if (key) await api(`identity/me/api-keys/${key.id}`, { method: "DELETE" });
      }
      toast({ message: t("aiConnect.removed", { device: dev.device }) });
    } catch {
      setFailed(true);
    }
    void load();
  };

  const prefer = async (dev: ConnectDevice, value: string) => {
    setD((x) => ({ ...x, devices: x.devices.map((y) => (y.device === dev.device ? { ...y, prefer: value } : y)) }));
    await api(`ai/local/connect/devices/${encodeURIComponent(dev.device)}`, { method: "PUT", body: { prefer: value } }).catch(() => setFailed(true));
  };

  const use = async (dev: ConnectDevice, ai: FoundAi) => {
    try {
      await api("ai/local/connect/use", { method: "POST", body: { device: dev.device, ai: ai.id } });
      toast({ message: t("aiConnect.ask.used", { ai: ai.name }) });
      await load();
      // The rest of the app learns that an AI answers now (the assistant, @AI, the task panels).
      await refreshAiStatus();
      router.refresh();
    } catch {
      toast({ message: t("aiConnect.ask.useFailed") });
    }
  };

  // My own questions: the company's AI ("") or one found on my computers ("<device>\n<ai>\n<model>").
  const choose = async (value: string) => {
    const [device, ai, model] = value.split("\n");
    try {
      if (!value) await api("ai/local/connect/personal", { method: "DELETE" });
      else await api("ai/local/connect/personal", { method: "PUT", body: { device, ai, ...(model ? { model } : {}) } });
      toast({ message: value ? t("aiConnect.ask.mineSaved", { ai: optionLabel(value) }) : t("aiConnect.ask.mineCompany") });
      await load();
      await refreshAiStatus();
      router.refresh();
    } catch {
      toast({ message: t("aiConnect.ask.useFailed") });
    }
  };

  const extConnect = async () => {
    try {
      const r = await api<{ token: string }>("ai/monitor/connection", { method: "POST" });
      setExtCode(`${origin}#${r.token}`);
      void load();
    } catch {
      setFailed(true);
    }
  };

  const live = d.devices.filter((x) => x.online);
  const withAi = live.find((x) => x.found.length);
  // The AI a computer's workflows use: what its owner picked, else the first agent, else the first model server.
  const aiOf = (dev: ConnectDevice) => dev.found.find((f) => f.id === dev.prefer.split(":")[0]) ?? dev.found.find((f) => f.kind === "agent") ?? dev.found[0];
  const answering = d.answers[0];
  const hooked = live.find((x) => x.state.guard);
  const sites = `${AI_SITES.slice(0, 4).join(", ")} ${t("aiConnect.sitesMore", { count: AI_SITES.length - 4 })}`;

  const status = (state: "on" | "partly" | "off") => (
    <span className={state === "on" ? chipOk : state === "partly" ? chipWarn : chip}>
      {t(state === "on" ? "aiConnect.ready" : state === "partly" ? "aiConnect.partly" : "aiConnect.notYet")}
    </span>
  );
  const head = (id: string, tone: "sky" | "violet" | "tangerine" | "green", icon: React.ReactNode, title: string, state: "on" | "partly" | "off") => (
    <h2 id={id} className="m-0 flex min-w-0 items-center gap-3 text-sm font-semibold tracking-[-0.01em]">
      <IconTile tone={tone}>{icon}</IconTile>
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {status(state)}
    </h2>
  );
  const tile = "grid min-w-0 content-start gap-2.5 p-5 max-sm:p-4";
  const line = "text-ink m-0 text-sm";
  const sub = "text-ink-2 m-0 text-sm";

  const own = d.personal;
  const company = own.company.length ? own.company : providers;
  // Every AI on my computers, each model of a model server on its own: what my own questions may go to.
  const mineOptions = d.devices.flatMap((dev) =>
    dev.found.flatMap((f) =>
      (f.kind === "server" ? (f.models ?? []) : [""]).map((m) => ({
        value: `${dev.device}\n${f.id}\n${m}`,
        label: [f.name, m].filter(Boolean).join(" · "),
        // One group per computer, so a long computer name is a heading and not cut off in every row.
        group: dev.online ? dev.device : `${dev.device} (${t("aiConnect.admin.mineOffline")})`,
        keywords: dev.device,
      })),
    ),
  );
  const chosen = own.choice ? `${own.choice.device}\n${own.choice.ai}\n${own.choice.model}` : "";
  const optionLabel = (v: string) => mineOptions.find((o) => o.value === v)?.label ?? v.split("\n")[1] ?? "";
  const mineOn = own.allowed && !!own.choice && own.active;
  const mineAway = own.allowed && !!own.choice && !own.active;
  const askState: "on" | "partly" | "off" = !d.assistant ? "off" : mineOn || company.length || answering ? "on" : mineAway ? "partly" : "off";
  const guardBrowser = !!d.extension?.lastSeenAt;
  const guardState: "on" | "partly" | "off" = !d.monitoring ? "off" : guardBrowser && hooked ? "on" : guardBrowser || live.length ? "partly" : "off";

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4" data-testid="ai-connect">
      {/* The one step. */}
      <section className={cx(card, "grid min-w-0 gap-4 p-6 max-sm:p-4")} aria-labelledby="connect-h">
        <div className="flex min-w-0 flex-wrap items-center gap-x-6 gap-y-3">
          <div className="min-w-0 flex-1 basis-80">
            <h2 id="connect-h" className="m-0 flex items-center gap-3 text-base font-semibold tracking-[-0.01em]">
              <IconTile tone="sky">
                <ScreenIcon />
              </IconTile>
              {t("aiConnect.title")}
            </h2>
            <p className={cx(sub, "mt-2 max-w-2xl")}>{t("aiConnect.lead")}</p>
          </div>
          <button type="button" className={cx(btnPrimary, "min-h-9 px-3.5")} disabled={busy} onClick={() => void connect()} data-testid="connect-start">
            {live.length ? t("aiConnect.another") : t("aiConnect.connect")}
          </button>
        </div>

        {code ? (
          <div className="border-divider grid min-w-0 gap-3 border-t pt-4" data-testid="connect-command">
            <ol className="text-ink-soft m-0 grid list-decimal gap-1 pl-5 text-sm">
              <li>{t("aiConnect.step1")}</li>
              <li>{t("aiConnect.step2")}</li>
              <li>{t("aiConnect.step3")}</li>
            </ol>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
              <div role="group" aria-label="OS" className="bg-hover inline-flex rounded-md p-0.5">
                {(["mac", "win"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={os === k}
                    onClick={() => setOs(k)}
                    className={cx("min-h-7 rounded-[5px] px-2.5 text-[13px] max-md:min-h-9", os === k ? "bg-surface text-ink shadow-card font-medium" : "text-ink-2")}
                  >
                    {t(k === "mac" ? "aiConnect.osMac" : "aiConnect.osWin")}
                  </button>
                ))}
              </div>
              <label className="text-ink-soft inline-flex min-h-8 items-center gap-2">
                <input type="checkbox" className="accent-brand size-4" checked={autostart} onChange={(e) => setAutostart(e.target.checked)} />
                {t("aiConnect.autostart")}
              </label>
            </div>
            <div className="bg-term ring-term-ring flex min-w-0 items-start gap-2 rounded-xl py-3 pl-4 pr-2 ring-1">
              <code className="text-term-ink min-w-0 flex-1 break-all font-mono text-[12.5px]/6" data-testid="connect-line">
                {command}
              </code>
              <button type="button" className={cx(btn, btnSm, "shrink-0")} onClick={() => copy(command)}>
                {copied ? <CheckIcon /> : <CopyIcon />}
                {copied ? t("aiConnect.copied") : t("aiConnect.copy")}
              </button>
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
              <button type="button" className={cx(btnPrimary, "min-h-9 px-3.5")} disabled={checking} onClick={() => void check()} data-testid="connect-check">
                <RefreshIcon className={cx("size-4", checking && "animate-spin")} />
                {t("aiConnect.ranIt")}
              </button>
              <span className="text-ink-2 text-sm" role="status">
                {checkedAt ? t("aiConnect.checkedAt", { time: time(checkedAt) }) : t("aiConnect.waiting")}
              </span>
            </div>
            <p className="text-ink-2 m-0 text-xs">
              {t("aiConnect.needNode")} {t("aiConnect.codeOnce")}
            </p>
          </div>
        ) : null}

        {failed ? <LoadFailed onRetry={() => void load()} /> : null}

        {d.devices.length ? (
          <div className="border-divider grid min-w-0 gap-1 border-t pt-4">
            <div className="flex min-w-0 items-center gap-2">
              <h3 className="text-ink-2 m-0 flex-1 text-xs font-semibold">{t("aiConnect.computers")}</h3>
              {checkedAt && !code ? <span className="text-ink-2 text-xs">{t("aiConnect.checkedAt", { time: time(checkedAt) })}</span> : null}
              {code ? null : (
                <button type="button" className={cx(btnGhost, btnSm)} disabled={checking} onClick={() => void check()} data-testid="connect-recheck">
                  <RefreshIcon className={cx("size-3.5", checking && "animate-spin")} />
                  {t("aiConnect.recheck")}
                </button>
              )}
            </div>
            <ul className="divide-divider-soft m-0 grid list-none divide-y p-0">
              {d.devices.map((dev) => (
                <li key={dev.device} className="grid min-w-0 gap-2 py-3" data-testid="connect-device">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                    <span aria-hidden="true" className={cx("size-2 shrink-0 rounded-full", dev.online ? "bg-ok-fill" : "bg-hairline")} />
                    <span className="text-ink min-w-0 truncate text-sm font-medium">{dev.device}</span>
                    <span className="text-ink-2 text-xs">{dev.online ? t("aiConnect.online") : dev.lastSeenAt ? t("aiConnect.offline", { when: ago(dev.lastSeenAt) }) : ""}</span>
                    <button type="button" className={cx(btnGhost, btnSm, "ml-auto")} onClick={() => void remove(dev)}>
                      {t("aiConnect.remove")}
                    </button>
                  </div>
                  {dev.found.length ? (
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5 pl-5">
                      {dev.found.map((f) => (
                        <span key={f.id} className={chip} title={f.models?.join(", ")}>
                          {f.name}
                          {f.models?.length ? <span className="text-ink-2 font-normal"> · {t("aiConnect.models", { count: f.models.length })}</span> : null}
                        </span>
                      ))}
                      {dev.found.length > 1 ? (
                        <span className="text-ink-2 ml-1 inline-flex items-center gap-1 text-xs">
                          {t("aiConnect.runsWith")}
                          <Picker
                            label={t("aiConnect.runsWith")}
                            variant="button"
                            value={dev.prefer.split(":")[0] ?? ""}
                            options={[{ value: "", label: t("aiConnect.firstFound") }, ...dev.found.map((f) => ({ value: f.id, label: f.name }))]}
                            onChange={(v) => void prefer(dev, v)}
                          />
                        </span>
                      ) : null}
                    </div>
                  ) : dev.online ? (
                    <p className="text-ink-2 m-0 pl-5 text-xs">{t("aiConnect.foundNone")}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      {/* The four things the connection is for. */}
      <div className="grid min-w-0 gap-4 md:grid-cols-2">
        <section className={cx(card, tile)} aria-labelledby="c-workflow-h" data-testid="connect-workflow">
          {head("c-workflow-h", "violet", <WorkflowIcon />, t("aiConnect.workflow.title"), withAi ? "on" : live.length ? "partly" : "off")}
          <p className={sub}>{t("aiConnect.workflow.lead")}</p>
          <p className={line}>
            {withAi
              ? t("aiConnect.workflow.on", { ai: aiOf(withAi)?.name ?? "", device: withAi.device })
              : live[0]
                ? t("aiConnect.workflow.noAi", { device: live[0].device })
                : t("aiConnect.workflow.off")}
          </p>
          <Link href="/app/ai/workflows" className={cx(btn, btnSm, "justify-self-start no-underline")}>
            {t("aiConnect.workflow.open")}
          </Link>
        </section>

        <section className={cx(card, tile)} aria-labelledby="c-ask-h" data-testid="connect-ask">
          {head("c-ask-h", "sky", <SparkleIcon />, t("aiConnect.ask.title"), askState)}
          <p className={sub}>{t("aiConnect.ask.lead")}</p>
          <p className={line} data-testid="connect-ask-line">
            {!d.assistant
              ? t("aiConnect.ask.switchOff")
              : mineOn
                ? t("aiConnect.ask.mineOn", { ai: optionLabel(chosen), device: own.choice!.device })
                : mineAway
                  ? t(company.length || answering ? "aiConnect.ask.mineAway" : "aiConnect.ask.mineAwayNone", { device: own.choice!.device })
                  : answering
                    ? t("aiConnect.ask.onDevice", { device: answering.device })
                    : company.length
                      ? t("aiConnect.ask.on", { ai: company.join(", ") })
                      : d.canManage
                        ? t("aiConnect.ask.off")
                        : t("aiConnect.ask.offStaff")}
          </p>
          {/* Which AI answers my own questions: the company's, or one on my own computers. */}
          {d.assistant && own.allowed && mineOptions.length ? (
            <div className="text-ink-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm" data-testid="connect-mine">
              <span>{t("aiConnect.ask.mine")}</span>
              <Picker
                label={t("aiConnect.ask.mine")}
                variant="button"
                className="min-w-0 max-w-full"
                menuClassName="w-72 max-w-[calc(100vw-2rem)]"
                value={chosen}
                options={[{ value: "", label: company.length ? t("aiConnect.ask.company", { ai: company.join(", ") }) : t("aiConnect.ask.companyNone") }, ...mineOptions]}
                onChange={(v) => void choose(v)}
              />
            </div>
          ) : d.assistant && !own.allowed && own.choice ? (
            <p className="text-ink-2 m-0 text-xs">{t("aiConnect.ask.mineLocked")}</p>
          ) : null}
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {/* An admin's own computer may answer for the company: one click per AI found on it. */}
            {d.assistant && d.canManage && !company.length && !answering
              ? live.flatMap((dev) =>
                  dev.found.map((f) => (
                    <button
                      key={`${dev.device}/${f.id}`}
                      type="button"
                      className={cx(btnPrimary, btnSm)}
                      title={t("aiConnect.ask.useHint", { device: dev.device })}
                      onClick={() => void use(dev, f)}
                    >
                      {t("aiConnect.ask.use", { ai: f.name })}
                    </button>
                  )),
                )
              : null}
            {(company.length || answering || mineOn) && d.assistant ? (
              <Link href="/app/ai/ask" className={cx(btn, btnSm, "no-underline")}>
                {t("aiConnect.ask.open")}
              </Link>
            ) : null}
            {d.canManage ? (
              <Link href="/admin/workspace/ai" className={cx(btnGhost, btnSm, "no-underline")}>
                {t("aiConnect.ask.admin")}
              </Link>
            ) : null}
          </div>
        </section>

        <section className={cx(card, tile)} aria-labelledby="c-usage-h" data-testid="connect-usage">
          {head("c-usage-h", "tangerine", <TrendIcon />, t("aiConnect.usage.title"), live.some((x) => x.state.usage) ? "on" : "off")}
          <p className={sub}>{t("aiConnect.usage.lead")}</p>
          <p className={line}>
            {live.some((x) => x.state.usage) ? (d.usageAt ? t("aiConnect.usage.on", { when: ago(d.usageAt) }) : t("aiConnect.usage.onNoData")) : t("aiConnect.usage.off")}
          </p>
          <Link href="/app/ai/adoption/usage" className={cx(btn, btnSm, "justify-self-start no-underline")}>
            {t("aiConnect.usage.open")}
          </Link>
        </section>

        <section className={cx(card, tile)} aria-labelledby="c-guard-h" data-testid="connect-guard">
          {head("c-guard-h", "green", <ShieldIcon />, t("aiConnect.guard.title"), guardState)}
          <p className={sub}>{t("aiConnect.guard.lead")}</p>
          {d.monitoring ? (
            <>
              <p className={cx(line, "font-medium")}>{t(`aiConnect.guard.mode.${d.sensitiveMode}`)}</p>
              <dl className="m-0 grid min-w-0 gap-2 text-sm">
                <div className="grid min-w-0 gap-0.5">
                  <dt className="text-ink-2 text-xs font-semibold">{t("aiConnect.guard.browser")}</dt>
                  <dd className="text-ink m-0">
                    {guardBrowser
                      ? t("aiConnect.guard.browserOn", { when: ago(d.extension!.lastSeenAt!) })
                      : d.extension
                        ? t("aiConnect.guard.browserWaiting")
                        : t("aiConnect.guard.browserOff", { sites })}
                  </dd>
                </div>
                <div className="grid min-w-0 gap-0.5">
                  <dt className="text-ink-2 text-xs font-semibold">{t("aiConnect.guard.computer")}</dt>
                  <dd className="text-ink m-0">
                    {hooked
                      ? t("aiConnect.guard.computerOn", { device: hooked.device })
                      : live[0]
                        ? t("aiConnect.guard.computerPartly", { device: live[0].device })
                        : t("aiConnect.guard.computerOff")}
                  </dd>
                </div>
              </dl>
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <a href="/downloads/workspace-ai.zip" download className={cx(btn, btnSm, "no-underline")}>
                  <DownloadIcon />
                  {t("aiConnect.guard.install")}
                </a>
                <button type="button" className={cx(guardBrowser ? btnGhost : btnPrimary, btnSm)} onClick={() => void extConnect()} data-testid="ext-code-btn">
                  {d.extension ? t("aiConnect.guard.newCode") : t("aiConnect.guard.getCode")}
                </button>
              </div>
              {/* The extension is not in a store yet: without these steps people download the zip and stop there. */}
              {guardBrowser ? null : (
                <div className="grid min-w-0 gap-1" data-testid="ext-how">
                  <span className="text-ink-2 text-xs font-semibold">{t("aiConnect.guard.howTitle")}</span>
                  <ol className="text-ink-soft m-0 grid list-decimal gap-1 pl-5 text-sm">
                    <li>{t("aiConnect.guard.how1")}</li>
                    <li>{t("aiConnect.guard.how2")}</li>
                    <li>{t("aiConnect.guard.how3")}</li>
                    <li>{t("aiConnect.guard.how4")}</li>
                  </ol>
                </div>
              )}
              {extCode ? (
                <div className="bg-ground grid min-w-0 gap-1.5 rounded-lg p-3">
                  <span className="text-ink-2 text-xs font-medium">{t("aiConnect.guard.codeLabel")}</span>
                  <span className="flex min-w-0 items-start gap-2">
                    <code className={cx(mono, "min-w-0 flex-1 break-all text-xs")} data-testid="ext-code">
                      {extCode}
                    </code>
                    <button type="button" className={cx(btn, btnSm, "shrink-0")} aria-label={t("aiConnect.copy")} onClick={() => copy(extCode)}>
                      <CopyIcon />
                    </button>
                  </span>
                </div>
              ) : null}
            </>
          ) : (
            <p className={line}>{t("aiConnect.guard.monitoringOff")}</p>
          )}
        </section>
      </div>
    </div>
  );
}
