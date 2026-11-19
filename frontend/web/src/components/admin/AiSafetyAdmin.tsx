"use client";

import { IconTile } from "@/components/ui/Bento";
import { ShieldIcon } from "@/components/app/icons";
import { useState } from "react";
import { api } from "@/lib/client";
import { useT } from "@/lib/i18n/client";
import { btn, btnGhost, btnSm, cx, input, tag } from "@/lib/ui";

export type SensitiveMode = "warn" | "redact" | "block";
export interface AiSafetyPolicy {
  detail: "topic" | "summary";
  captureResponses: boolean;
  retentionDays: number;
  sensitiveMode: SensitiveMode;
}
export interface AiKeyword {
  id: string;
  term: string;
  label: string;
}

/**
 * Admin › AI › the safety net: what the browser extension does when a prompt carries an ID number, a card, a
 * secret, a bank account, a contact list or one of the company's own words (client names, project codes) —
 * ask first, replace it with a placeholder the person sees before sending, or stop the send. The extension
 * downloads the mode and the words on its next batch; only counts come back, never the text.
 */
export function AiSafetyAdmin({ policy, keywords }: { policy: AiSafetyPolicy; keywords: AiKeyword[] }) {
  const t = useT();
  const [p, setP] = useState(policy);
  const [list, setList] = useState(keywords);
  const [term, setTerm] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  const run = async (fn: () => Promise<void>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      setMsg({ text: ok, tone: "ok" });
    } catch (e) {
      setMsg({ text: (e as { status?: number }).status === 409 ? t("aiSafety.exists") : t("aiAdmin.saveFailed"), tone: "err" });
    } finally {
      setBusy(false);
    }
  };
  const setMode = (sensitiveMode: SensitiveMode) =>
    run(async () => {
      const r = await api<{ policy: AiSafetyPolicy }>("ai/policy", { method: "PUT", body: { ...p, sensitiveMode } });
      setP(r.policy);
    }, t("aiAdmin.saved"));
  const add = () => {
    const value = term.trim();
    if (value.length < 2) return;
    void run(async () => {
      const r = await api<{ keyword: AiKeyword }>("ai/policy/keywords", { method: "POST", body: { term: value } });
      setList((l) => [...l, r.keyword].sort((a, b) => a.term.localeCompare(b.term)));
      setTerm("");
    }, t("aiAdmin.saved"));
  };
  const remove = (id: string) =>
    run(async () => {
      await api(`ai/policy/keywords/${id}`, { method: "DELETE" });
      setList((l) => l.filter((k) => k.id !== id));
    }, t("aiAdmin.saved"));
  return (
    <section className="grid gap-4" aria-labelledby="ai-safety-h">
      <div className="grid gap-1">
        <h2 id="ai-safety-h" className="m-0 flex min-w-0 items-center gap-3 text-sm/6 font-semibold tracking-[-0.01em]">
          <IconTile tone="green">
            <ShieldIcon />
          </IconTile>
          {t("aiSafety.title")}
        </h2>
        <p className="text-ink-2 m-0 text-sm">{t("aiSafety.sub")}</p>
      </div>
      <fieldset className="bg-surface shadow-card divide-hairline m-0 grid divide-y rounded-xl px-4" disabled={busy}>
        <legend className="sr-only">{t("aiSafety.mode")}</legend>
        {(["warn", "redact", "block"] as const).map((m) => (
          <label key={m} className="flex cursor-pointer items-start gap-3 py-3">
            <input type="radio" name="sensitive-mode" className="mt-1" checked={p.sensitiveMode === m} onChange={() => void setMode(m)} />
            <span className="grid gap-0.5">
              <span className="text-sm font-medium">{t(`aiSafety.modes.${m}`)}</span>
              <span className="text-ink-2 text-xs">{t(`aiSafety.modesHint.${m}`)}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="bg-surface shadow-card grid gap-3 rounded-xl p-4">
        <div className="grid gap-0.5">
          <p className="m-0 text-sm font-medium">{t("aiSafety.keywords")}</p>
          <p className="text-ink-2 m-0 text-xs">{t("aiSafety.keywordsHint")}</p>
        </div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <input
            className={cx(input, "max-w-xs")}
            value={term}
            maxLength={120}
            onChange={(e) => setTerm(e.target.value)}
            placeholder={t("aiSafety.keywordPlaceholder")}
            aria-label={t("aiSafety.keywords")}
          />
          <button type="submit" className={cx(btn, btnSm)} disabled={busy || term.trim().length < 2}>
            {t("aiSafety.add")}
          </button>
        </form>
        {list.length ? (
          <ul className="m-0 flex list-none flex-wrap gap-2 p-0" aria-label={t("aiSafety.keywords")}>
            {list.map((k) => (
              <li key={k.id} className={tag}>
                {k.term}
                <button
                  type="button"
                  className={cx(btnGhost, "min-h-0 px-1 py-0 text-xs")}
                  disabled={busy}
                  onClick={() => void remove(k.id)}
                  aria-label={t("aiSafety.remove", { term: k.term })}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-ink-2 m-0 text-xs">{t("aiSafety.none")}</p>
        )}
      </div>
      {msg ? (
        <p className={cx("m-0 text-sm", msg.tone === "ok" ? "text-ok" : "text-block")} aria-live="polite">
          {msg.text}
        </p>
      ) : null}
    </section>
  );
}
