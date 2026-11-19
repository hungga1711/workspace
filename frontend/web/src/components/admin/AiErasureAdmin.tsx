"use client";

import { IconTile } from "@/components/ui/Bento";
import { TrashIcon } from "@/components/app/icons";
import { useState } from "react";
import { api } from "@/lib/client";
import { useFormat, useT } from "@/lib/i18n/client";
import { useDirectory } from "@/lib/people";
import { btn, btnDanger, btnSm, chip, chipOk, chipWarn, cx } from "@/lib/ui";
import { useConfirm } from "@/components/ui/Confirm";

export interface ErasureRequest {
  id: string;
  userId: string;
  note: string;
  status: "open" | "done" | "declined";
  requestedAt: string;
  handledAt: string | null;
}

/**
 * Admin › AI: staff's requests to delete their AI Insights data (Của tôi › AI › Yêu cầu xoá). "Xoá dữ liệu" removes
 * that person's conversations, messages, warnings and views; the ai module logs it in ai_audit.
 */
export function AiErasureAdmin({ requests: initial }: { requests: ErasureRequest[] }) {
  const t = useT();
  const { confirm, dialog } = useConfirm();
  const { ago } = useFormat();
  const dir = useDirectory();
  const [requests, setRequests] = useState(initial);
  const [error, setError] = useState(false);
  const handle = async (r: ErasureRequest, status: "done" | "declined") => {
    if (status === "done" && !(await confirm({ title: t("aiInsights.adminConfirm", { name: dir.name(r.userId) }), danger: true }))) return;
    setError(false);
    try {
      await api(`ai/oversight/erasure-requests/${r.id}`, { method: "POST", body: { status } });
      setRequests(requests.map((x) => (x.id === r.id ? { ...x, status, handledAt: new Date().toISOString() } : x)));
    } catch {
      setError(true);
    }
  };
  return (
    <>
      {dialog}
      <section className="grid gap-3" aria-labelledby="ai-erasure-h" data-testid="ai-erasure-admin">
        <div className="grid gap-1">
          <h2 id="ai-erasure-h" className="m-0 flex min-w-0 items-center gap-3 text-sm/6 font-semibold tracking-[-0.01em]">
            <IconTile tone="red">
              <TrashIcon />
            </IconTile>
            {t("aiInsights.adminTitle")}
          </h2>
          <p className="text-ink-2 m-0 text-sm">{t("aiInsights.adminLead")}</p>
        </div>
        {requests.length === 0 ? (
          <p className="text-ink-2 m-0 text-sm">{t("aiInsights.adminEmpty")}</p>
        ) : (
          <ul className="divide-divider-soft shadow-card bg-surface m-0 grid list-none divide-y rounded-xl p-0">
            {requests.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 text-sm">
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="font-medium">{dir.name(r.userId)}</span>
                  <span className="text-ink-2 text-xs">
                    {ago(r.requestedAt)}
                    {r.note ? ` · ${r.note}` : ""}
                  </span>
                </span>
                {r.status === "open" ? (
                  <>
                    <button type="button" className={cx(btnDanger, btnSm)} onClick={() => void handle(r, "done")}>
                      {t("aiInsights.adminDone")}
                    </button>
                    <button type="button" className={cx(btn, btnSm)} onClick={() => void handle(r, "declined")}>
                      {t("aiInsights.adminDecline")}
                    </button>
                  </>
                ) : (
                  <span className={r.status === "done" ? chipOk : r.status === "declined" ? chipWarn : chip}>{t(`aiInsights.adminStatus_${r.status}`)}</span>
                )}
              </li>
            ))}
          </ul>
        )}
        {error ? <p className="text-block m-0 text-xs">{t("aiInsights.failed")}</p> : null}
      </section>
    </>
  );
}
