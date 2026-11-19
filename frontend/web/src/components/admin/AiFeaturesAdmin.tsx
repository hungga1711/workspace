"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/client";
import { useT } from "@/lib/i18n/client";
import { cx } from "@/lib/ui";
import { AdminHeader } from "./AdminNav";
import { refreshAiStatus } from "@/app/admin/workspace/ai/actions";

export interface AiFeatureFlags {
  assistant: boolean;
  monitoring: boolean;
}

/**
 * Admin › AI: the two switches, both off until the company decides (the assistant through a provider it picks; the
 * extension monitoring, which is a form of staff monitoring). Saving writes the whole workspace config (optimistic
 * version, like Settings) and refreshes the AI status every page reads. The purge of everything the extension
 * recorded lives on the Danger zone tab.
 */
export function AiFeaturesAdmin({ version, config, flags }: { version: number; config: Record<string, unknown>; flags: AiFeatureFlags }) {
  const t = useT();
  const router = useRouter();
  const [v, setV] = useState(version);
  const [f, setF] = useState(flags);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (next: AiFeatureFlags) => {
    const prev = f;
    setF(next);
    setBusy(true);
    try {
      const features = { ...((config.features as Record<string, unknown>) ?? {}), ai: next };
      const r = await api<{ version: number }>("platform/workspace/config", { method: "PUT", body: { version: v, config: { ...config, features } } });
      setV(r.version);
      setMsg({ text: t("aiAdmin.saved"), tone: "ok" });
      await refreshAiStatus();
      router.refresh();
    } catch {
      setF(prev);
      setMsg({ text: t("aiAdmin.saveFailed"), tone: "err" });
    } finally {
      setBusy(false);
    }
  };
  const toggle = (on: boolean, onChange: (v: boolean) => void, label: string) => (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={busy}
      onClick={() => onChange(!on)}
      className={cx("relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-60", on ? "bg-brand" : "bg-hairline")}
    >
      <span className={cx("bg-surface absolute top-0.5 size-5 rounded-full shadow transition-all", on ? "left-[22px]" : "left-0.5")} />
    </button>
  );
  const row = (on: boolean, onChange: (v: boolean) => void, label: string, hint: string) => (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="grid gap-0.5">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-ink-2 text-xs">{hint}</span>
      </div>
      {toggle(on, onChange, label)}
    </div>
  );
  return (
    <section className="grid gap-4">
      <AdminHeader title={t("aiAdmin.title")} sub={t("aiAdmin.sub")} />
      <div className="bg-surface shadow-card divide-hairline grid divide-y rounded-xl px-4" aria-live="polite">
        {row(f.assistant, (on) => void save({ ...f, assistant: on }), t("aiAdmin.assistant"), t("aiAdmin.assistantHint"))}
        {row(f.monitoring, (on) => void save({ ...f, monitoring: on }), t("aiAdmin.insights"), t("aiAdmin.insightsHint"))}
      </div>
      {msg ? <p className={cx("m-0 text-sm", msg.tone === "ok" ? "text-ok" : "text-block")}>{msg.text}</p> : null}
      {!f.monitoring ? <p className="text-ink-2 m-0 text-xs">{t("aiAdmin.insightsOffNote")}</p> : null}
    </section>
  );
}
