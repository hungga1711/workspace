"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";
import { useT } from "@/lib/i18n/client";
import { IconTile } from "@/components/ui/Bento";
import { LockIcon } from "@/components/app/icons";
import { Checkbox } from "@/components/ui/Checkbox";
import { Picker } from "@/components/ui/Picker";
import { cx } from "@/lib/ui";
import type { AiSafetyPolicy } from "./AiSafetyAdmin";

/**
 * Admin › AI › Privacy: what managers can read of a person's AI conversations (topic only, a summary, or the full
 * text), whether answers are kept, and for how long.
 * Each change saves on its own; people see the same policy on Hồ sơ › Quyền riêng tư & AI.
 */
export function AiReadPolicyAdmin({ policy }: { policy: AiSafetyPolicy }) {
  const t = useT();
  const router = useRouter();
  const [p, setP] = useState(policy);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  const save = async (next: AiSafetyPolicy) => {
    const prev = p;
    setP(next);
    setBusy(true);
    try {
      const r = await api<{ policy: AiSafetyPolicy }>("ai/policy", { method: "PUT", body: next });
      setP(r.policy);
      setMsg({ text: t("aiAdmin.saved"), tone: "ok" });
      router.refresh();
    } catch {
      setP(prev);
      setMsg({ text: t("aiAdmin.saveFailed"), tone: "err" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="grid gap-4" aria-labelledby="ai-read-h">
      <div className="grid gap-1">
        <h2 id="ai-read-h" className="m-0 flex min-w-0 items-center gap-3 text-sm/6 font-semibold tracking-[-0.01em]">
          <IconTile tone="sky">
            <LockIcon />
          </IconTile>
          {t("aiw.o.policyTitle")}
        </h2>
        <p className="text-ink-2 m-0 text-sm">{t("aiw.o.policyNote")}</p>
      </div>
      <fieldset className="bg-surface shadow-card divide-hairline m-0 grid divide-y rounded-xl px-4" disabled={busy}>
        <legend className="sr-only">{t("aiw.o.policyDetail")}</legend>
        {(["topic", "summary"] as const).map((d) => (
          <label key={d} className="flex cursor-pointer items-start gap-3 py-3">
            <input type="radio" name="read-detail" className="mt-1" checked={p.detail === d} onChange={() => void save({ ...p, detail: d })} />
            <span className="text-sm">{t(`aiw.detail.${d}`)}</span>
          </label>
        ))}
      </fieldset>
      <div className="bg-surface shadow-card flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-xl px-4 py-3">
        <Checkbox checked={p.captureResponses} disabled={busy} onChange={(e) => void save({ ...p, captureResponses: e.target.checked })} label={t("aiw.o.policyResponses")} />
        <div className="flex items-center gap-2 text-sm">
          <span className="text-ink-2">{t("aiw.o.policyRetention")}</span>
          <Picker
            className="min-w-28 shrink-0"
            label={t("aiw.o.policyRetention")}
            value={String(p.retentionDays)}
            onChange={(v) => void save({ ...p, retentionDays: Number(v) })}
            options={[30, 90, 180, 365].map((d) => ({ value: String(d), label: t("aiw.o.days", { count: d }) }))}
          />
        </div>
      </div>
      {msg ? (
        <p role="status" className={cx("m-0 text-sm", msg.tone === "ok" ? "text-ok" : "text-block")}>
          {msg.text}
        </p>
      ) : null}
    </section>
  );
}
