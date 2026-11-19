"use client";

import { useState } from "react";
import { useT } from "@/lib/i18n/client";
import { btn, btnPrimary, cx, textarea } from "@/lib/ui";
import { Modal } from "./Modal";
import { Field } from "./bits";

/**
 * Asks why before a refusal (a leave or an approval request): the person reads it with the decision and plans around
 * it. Common reasons fill the box in one tap; the button stays off until there is a reason.
 */
export function ReasonDialog({ title, subject, onConfirm, onClose }: { title: string; subject?: string; onConfirm: (reason: string) => void; onClose: () => void }) {
  const t = useT();
  const [reason, setReason] = useState("");
  const quick = [t("ui.reason.quickBusy"), t("ui.reason.quickCoverage"), t("ui.reason.quickDetails")];
  const ok = reason.trim().length > 0;
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btn} onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className={btnPrimary} disabled={!ok} onClick={() => ok && onConfirm(reason.trim())}>
            {t("ui.reason.confirm")}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-3">
        {subject ? <p className="text-ink-2 m-0 text-sm">{subject}</p> : null}
        <Field label={t("ui.reason.label")}>
          <textarea id="reject-reason" className={cx(textarea, "min-h-24")} value={reason} maxLength={500} autoFocus onChange={(e) => setReason(e.target.value)} />
        </Field>
        <div className="flex flex-wrap gap-1.5">
          {quick.map((q) => (
            <button key={q} type="button" className="border-hairline text-ink-2 hover:bg-hover hover:text-ink rounded-full border px-2.5 py-1 text-xs" onClick={() => setReason(q)}>
              {q}
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}
