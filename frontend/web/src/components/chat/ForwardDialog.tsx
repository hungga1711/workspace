"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/client";
import { useT } from "@/lib/i18n/client";
import { ChannelAvatar, useDirectory } from "@/lib/people";
import { btn, btnPrimary, cx, input } from "@/lib/ui";
import { Modal } from "@/components/ui/Modal";
import type { ChannelSummary } from "@/components/shell/types";

/**
 * "Chuyển tiếp": pick a conversation you are in, add a note if you like, send. The copy
 * shows who wrote it and where; @mentions in it do not notify anyone again.
 */
export function ForwardDialog({
  messageId,
  preview,
  onClose,
  onDone,
}: {
  messageId: string;
  preview: string;
  onClose: () => void;
  onDone: (channelId: string, label: string) => void;
}) {
  const t = useT();
  const dir = useDirectory();
  const [channels, setChannels] = useState<ChannelSummary[] | null>(null);
  const [q, setQ] = useState("");
  const [pick, setPick] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    api<{ channels: ChannelSummary[] }>("chat/channels")
      .then((r) => setChannels(r.channels))
      .catch(() => setChannels([]));
  }, []);
  const label = (c: ChannelSummary) =>
    c.kind === "dm" ? dir.name(c.dmUserId ?? "") : c.kind === "group" ? (c.displayName ?? c.name ?? t("chat.forward.group")) : (c.displayName ?? `#${c.name}`);
  const shown = useMemo(() => {
    const list = (channels ?? []).sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""));
    const s = q.trim().toLowerCase();
    return (s ? list.filter((c) => label(c).toLowerCase().includes(s)) : list).slice(0, 50);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- label reads the directory, which is stable for the dialog's life
  }, [channels, q]);
  const send = async () => {
    if (!pick) return;
    setBusy(true);
    setError(false);
    try {
      await api(`chat/messages/${messageId}/forward`, { method: "POST", body: { channelId: pick, note } });
      const c = channels?.find((x) => x.id === pick);
      onDone(pick, c ? label(c) : "");
    } catch {
      setError(true);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={t("chat.forward.title")}
      onClose={onClose}
      footer={
        <>
          {error ? (
            <span role="alert" className="text-block mr-auto text-xs">
              {t("chat.forward.failed")}
            </span>
          ) : null}
          <button type="button" className={btn} onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className={btnPrimary} disabled={!pick || busy} onClick={() => void send()}>
            {t("chat.forward.send")}
          </button>
        </>
      }
    >
      <div className="grid gap-3">
        <input className={input} autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("chat.forward.search")} aria-label={t("chat.forward.search")} />
        <ul className="border-hairline m-0 max-h-64 list-none overflow-y-auto rounded-md border p-1" role="listbox" aria-label={t("chat.forward.to")}>
          {channels === null ? <li className="text-ink-2 px-2 py-1.5 text-sm">{t("common.loading")}</li> : null}
          {channels && !shown.length ? <li className="text-ink-2 px-2 py-1.5 text-sm">{t("chat.forward.none")}</li> : null}
          {shown.map((c) => (
            <li
              key={c.id}
              role="option"
              aria-selected={pick === c.id}
              tabIndex={0}
              onClick={() => setPick(c.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setPick(c.id);
                }
              }}
              className={cx("flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm", pick === c.id ? "bg-brand-wash text-ink font-medium" : "hover:bg-hover")}
            >
              <ChannelAvatar c={{ ...c, name: c.name ?? c.displayName ?? null }} size="sm" />
              <span className="min-w-0 flex-1 truncate">{label(c)}</span>
              {pick === c.id ? <span aria-hidden="true">✓</span> : null}
            </li>
          ))}
        </ul>
        <blockquote className="border-hairline text-ink-2 m-0 line-clamp-3 border-l-2 pl-3 text-sm">{preview}</blockquote>
        <input className={input} value={note} maxLength={4000} onChange={(e) => setNote(e.target.value)} placeholder={t("chat.forward.note")} aria-label={t("chat.forward.note")} />
      </div>
    </Modal>
  );
}
