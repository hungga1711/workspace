"use client";

import { useState } from "react";
import { useT } from "@/lib/i18n/client";
import { authCard, btn, btnPrimary, cx } from "@/lib/ui";

interface Props {
  request: { clientId: string; redirectUri: string; codeChallenge: string; state: string | undefined; resource: string | undefined };
  client: { name: string; redirectHost: string };
  who: string;
  perms: { id: string; label: string; write: boolean }[];
  presets: { read: string[]; write: string[] };
  initialPreset: "read" | "write";
  reconnect: boolean;
}

/**
 * The consent card: which app, as whom, where it returns, what it may do (two presets, or a list), allow or deny.
 * The answer goes to identity through the BFF; the browser then follows the address identity returns, which is
 * always one the client registered (a custom scheme such as cursor:// leaves this page in place, hence "done").
 */
export function ConsentForm({ request, client, who, perms, presets, initialPreset, reconnect }: Props) {
  const t = useT();
  const [preset, setPreset] = useState<"read" | "write" | "custom">(initialPreset);
  const [chosen, setChosen] = useState<string[]>(presets[initialPreset]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [done, setDone] = useState<"allowed" | "denied" | null>(null);

  const pick = (p: "read" | "write") => {
    setPreset(p);
    setChosen(presets[p]);
  };
  const answer = async (approve: boolean) => {
    setBusy(true);
    setError(false);
    try {
      const res = await fetch("/api/proxy/identity/oauth/authorize", {
        method: "POST",
        headers: { "content-type": "application/json", "x-wos-csrf": "1" },
        body: JSON.stringify({ ...request, codeChallengeMethod: "S256", permissions: approve ? chosen : [], approve }),
      });
      const body = (await res.json().catch(() => null)) as { redirectTo?: string } | null;
      if (!res.ok || !body?.redirectTo) throw new Error(String(res.status));
      setDone(approve ? "allowed" : "denied");
      window.location.assign(body.redirectTo);
    } catch {
      setError(true);
      setBusy(false);
    }
  };

  if (done)
    return (
      <div className={cx(authCard, "!shadow-hero")} role="status">
        <p className="m-0 text-sm">{done === "allowed" ? t("mcpServer.consent.done", { client: client.name }) : t("mcpServer.consent.denied")}</p>
      </div>
    );

  const option = (key: "read" | "write", title: string, hint: string) => (
    <label
      className={cx(
        "flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5 text-sm",
        preset === key ? "border-ink bg-hover" : "border-hairline hover:bg-hover",
        !presets[key].length && "pointer-events-none opacity-50",
      )}
    >
      <input type="radio" name="preset" className="mt-1" checked={preset === key} disabled={!presets[key].length} onChange={() => pick(key)} />
      <span>
        <span className="block font-medium">{title}</span>
        <span className="text-ink-2 block text-xs">{hint}</span>
      </span>
    </label>
  );

  return (
    <div className={cx(authCard, "!shadow-hero grid gap-5")}>
      <div className="grid gap-1.5">
        <h1 className="font-display m-0 text-lg/7 font-semibold tracking-tight [overflow-wrap:anywhere]">{t("mcpServer.consent.title", { client: client.name })}</h1>
        <p className="text-ink-2 m-0 text-sm">{t("mcpServer.consent.signedInAs", { name: who })}</p>
      </div>
      <p className="m-0 text-sm">{t("mcpServer.consent.acts")}</p>
      {perms.length ? (
        <fieldset className="m-0 grid gap-2 border-0 p-0">
          <legend className="sr-only">{t("mcpServer.consent.custom")}</legend>
          {option("read", t("mcpServer.consent.presetRead"), t("mcpServer.consent.presetReadHint"))}
          {option("write", t("mcpServer.consent.presetWrite"), t("mcpServer.consent.presetWriteHint"))}
          <details className="group" open={preset === "custom"}>
            <summary className="text-ink-2 hover:text-ink cursor-pointer list-none py-1 text-xs font-medium [&::-webkit-details-marker]:hidden">
              {t("mcpServer.consent.custom")} ›
            </summary>
            <div className="border-hairline mt-1 grid max-h-56 gap-1 overflow-auto rounded-md border p-2 text-sm">
              {perms.map((p) => (
                <label key={p.id} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={chosen.includes(p.id)}
                    onChange={(e) => {
                      setPreset("custom");
                      setChosen((x) => (e.target.checked ? [...x, p.id] : x.filter((y) => y !== p.id)));
                    }}
                  />
                  {p.label}
                </label>
              ))}
            </div>
          </details>
        </fieldset>
      ) : (
        <p className="text-block m-0 text-sm">{t("mcpServer.consent.noPerms")}</p>
      )}
      <div className="bg-ground text-ink-2 grid gap-1 rounded-md px-3 py-2.5 text-xs">
        <span className="[overflow-wrap:anywhere]">{t("mcpServer.consent.redirect", { host: client.redirectHost })}</span>
        {reconnect ? <span>{t("mcpServer.consent.reconnect")}</span> : null}
        <span>{t("mcpServer.consent.unverified")}</span>
      </div>
      {error ? (
        <p className="text-block m-0 text-sm" role="alert">
          {t("mcpServer.consent.failed")}
        </p>
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        <button type="button" className={cx(btn, "min-h-10")} disabled={busy} onClick={() => void answer(false)}>
          {t("mcpServer.consent.deny")}
        </button>
        <button type="button" className={cx(btnPrimary, "min-h-10")} disabled={busy || !chosen.length} onClick={() => void answer(true)}>
          {t("mcpServer.consent.allow")}
        </button>
      </div>
      <p className="text-ink-2 m-0 text-center text-xs">{t("mcpServer.consent.revokeHint")}</p>
    </div>
  );
}
