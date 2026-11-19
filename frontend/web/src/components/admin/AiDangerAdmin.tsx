"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/client";
import { useT } from "@/lib/i18n/client";
import { btnDanger, btnSm, cx } from "@/lib/ui";
import { useConfirm } from "@/components/ui/Confirm";
import { DangerRow, DangerZone } from "./DangerZone";

/** Admin › AI › Danger zone: the one-click purge of everything the extension recorded, behind typing the company name. */
export function AiDangerAdmin({ company }: { company: string }) {
  const t = useT();
  const router = useRouter();
  const { confirm, dialog } = useConfirm();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  const purge = async () => {
    const ok = await confirm({ title: t("aiAdmin.purge"), body: t("aiAdmin.purgeConfirm"), confirmLabel: t("aiAdmin.purgeCta"), danger: true, typeToConfirm: company });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await api<{ conversations: number; messages: number; tokens: number }>("ai/monitor/data", { method: "DELETE" });
      setMsg({ text: t("aiAdmin.purged", { conversations: r.conversations, tokens: r.tokens }), tone: "ok" });
      router.refresh();
    } catch {
      setMsg({ text: t("aiAdmin.purgeFailed"), tone: "err" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {dialog}
      <DangerZone title={t("admin.danger.title")}>
        <DangerRow
          title={t("aiAdmin.purge")}
          hint={t("aiAdmin.purgeHint")}
          action={
            <button type="button" className={cx(btnDanger, btnSm)} disabled={busy} onClick={() => void purge()}>
              {t("aiAdmin.purgeCta")}
            </button>
          }
        />
      </DangerZone>
      {msg ? (
        <p role="status" className={cx("m-0 text-sm", msg.tone === "ok" ? "text-ok" : "text-block")}>
          {msg.text}
        </p>
      ) : null}
    </>
  );
}
