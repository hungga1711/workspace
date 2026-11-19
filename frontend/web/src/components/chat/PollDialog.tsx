"use client";

import { useState } from "react";
import { api } from "@/lib/client";
import { useT } from "@/lib/i18n/client";
import { btn, btnPrimary, input } from "@/lib/ui";
import { Modal } from "@/components/ui/Modal";
import { Field } from "@/components/ui/bits";
import { Checkbox } from "@/components/ui/Checkbox";
import { CloseIcon, PlusIcon } from "@/components/app/icons";

export function PollDialog({ channelId, threadRootId = null, onClose }: { channelId: string; threadRootId?: string | null; onClose: () => void }) {
  const t = useT();
  const [q, setQ] = useState("");
  const [opts, setOpts] = useState(["", ""]);
  const [multi, setMulti] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    const options = opts.map((o) => o.trim()).filter(Boolean);
    if (!q.trim() || options.length < 2) {
      setError(t("chat.poll.need"));
      return;
    }
    setBusy(true);
    try {
      await api(`chat/channels/${channelId}/polls`, { method: "POST", body: { question: q.trim(), options, multi, threadRootId } });
      onClose();
    } catch {
      setError(t("chat.poll.failed"));
      setBusy(false);
    }
  };
  return (
    <Modal
      title={t("chat.poll.create")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btn} onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className={btnPrimary} disabled={busy} onClick={() => void create()}>
            {t("chat.poll.send")}
          </button>
        </>
      }
    >
      <div className="grid gap-3">
        <Field label={t("chat.poll.question")} error={error}>
          <input className={input} value={q} maxLength={300} autoFocus onChange={(e) => setQ(e.target.value)} placeholder={t("chat.poll.questionHint")} />
        </Field>
        <fieldset className="m-0 grid gap-2 border-0 p-0">
          <legend className="mb-1 text-sm font-medium">{t("chat.poll.options")}</legend>
          {opts.map((o, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                className={input}
                value={o}
                maxLength={120}
                aria-label={t("chat.poll.option", { n: i + 1 })}
                placeholder={t("chat.poll.option", { n: i + 1 })}
                onChange={(e) => setOpts((cur) => cur.map((x, j) => (j === i ? e.target.value : x)))}
              />
              {opts.length > 2 ? (
                <button
                  type="button"
                  className="text-ink-2 hover:text-ink grid size-8 shrink-0 place-items-center"
                  aria-label={t("chat.poll.removeOption")}
                  onClick={() => setOpts((cur) => cur.filter((_, j) => j !== i))}
                >
                  <CloseIcon className="size-4" />
                </button>
              ) : null}
            </div>
          ))}
          {opts.length < 10 ? (
            <button type="button" className="text-brand-text flex items-center gap-1 justify-self-start text-sm font-medium" onClick={() => setOpts((cur) => [...cur, ""])}>
              <PlusIcon className="size-3.5" />
              {t("chat.poll.addOption")}
            </button>
          ) : null}
        </fieldset>
        <Checkbox checked={multi} onChange={(e) => setMulti(e.target.checked)} label={t("chat.poll.allowMulti")} />
      </div>
    </Modal>
  );
}
