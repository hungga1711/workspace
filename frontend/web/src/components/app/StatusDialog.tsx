"use client";

import { useRef, useState } from "react";
import { api } from "@/lib/client";
import { useT } from "@/lib/i18n/client";
import { isDnd, useStatus, type UserStatus } from "@/lib/status";
import { btn, btnPrimary, cx, input } from "@/lib/ui";
import { Picker } from "@/components/ui/Picker";
import { Checkbox } from "@/components/ui/Checkbox";
import { Modal } from "@/components/ui/Modal";
import { Field } from "@/components/ui/bits";

// The "set a status" dialog, split from the badge so it loads only when opened (it is not on every page).
const PRESETS = [
  { emoji: "📅", key: "meeting", hours: 1 },
  { emoji: "🍜", key: "lunch", hours: 1 },
  { emoji: "🎯", key: "focus", hours: 2, dnd: true },
  { emoji: "🚗", key: "commuting", hours: 1 },
  { emoji: "🏠", key: "remote", hours: 0 },
  { emoji: "✈️", key: "travel", hours: 0 },
  { emoji: "🤒", key: "sick", hours: 0 },
] as const;

const CLEAR = ["30m", "1h", "4h", "today", "week", "never"] as const;
function clearAt(k: (typeof CLEAR)[number]): string | null {
  const now = new Date();
  if (k === "30m") return new Date(now.getTime() + 30 * 60_000).toISOString();
  if (k === "1h") return new Date(now.getTime() + 3_600_000).toISOString();
  if (k === "4h") return new Date(now.getTime() + 4 * 3_600_000).toISOString();
  if (k === "today") return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59).toISOString();
  if (k === "week") {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59);
    d.setDate(d.getDate() + ((7 - d.getDay()) % 7));
    return d.toISOString();
  }
  return null;
}

/** Set a status (presets or custom) and Do not disturb. */
export function StatusDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { get, set, me } = useStatus();
  const cur = me ? get(me) : null;
  const [emoji, setEmoji] = useState(cur?.emoji ?? "💬");
  const [text, setText] = useState(cur?.text ?? "");
  const textRef = useRef<HTMLInputElement>(null);
  const [clear, setClear] = useState<(typeof CLEAR)[number]>("today");
  const [dnd, setDnd] = useState(isDnd(cur));
  const [busy, setBusy] = useState(false);
  const save = async (body: { emoji: string; text: string; clearAt: string | null; dndUntil: string | null } | null) => {
    setBusy(true);
    try {
      if (body) {
        await api("chat/me/status", { method: "PUT", body });
        if (me) set({ userId: me, ...body } as UserStatus);
      } else {
        await api("chat/me/status", { method: "DELETE" });
        set(null);
      }
      onClose();
    } catch {
      setBusy(false);
    }
  };
  const until = clearAt(clear);
  return (
    <Modal
      title={t("status.title")}
      onClose={onClose}
      footer={
        <>
          {cur ? (
            <button type="button" className={cx(btn, "mr-auto")} disabled={busy} onClick={() => void save(null)}>
              {t("status.clear")}
            </button>
          ) : null}
          <button type="button" className={btn} onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className={btnPrimary}
            disabled={busy}
            onClick={() =>
              void save({ emoji: text || dnd ? emoji : "", text, clearAt: until, dndUntil: dnd ? (until ?? new Date(Date.now() + 8 * 3_600_000).toISOString()) : null })
            }
          >
            {t("status.save")}
          </button>
        </>
      }
    >
      <div className="grid gap-4">
        <div className="flex items-center gap-2">
          <input
            className={cx(input, "w-14 text-center text-lg")}
            value={emoji}
            aria-label={t("status.emoji")}
            onChange={(e) => {
              // The small box holds the emoji only: words typed into it move to the status text (and the caret
              // follows) instead of being cut to a few characters without a word.
              const { emoji: e2, rest } = splitEmoji(e.target.value);
              setEmoji(e2);
              if (rest) {
                setText((x) => `${x}${rest}`.slice(0, 100));
                textRef.current?.focus();
              }
            }}
          />
          <input
            ref={textRef}
            className={input}
            value={text}
            maxLength={100}
            placeholder={t("status.placeholder")}
            aria-label={t("status.text")}
            onChange={(e) => setText(e.target.value)}
            autoFocus
          />
        </div>
        <div className="grid gap-1" role="group" aria-label={t("status.presets")}>
          {PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              className="hover:bg-hover flex items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm"
              onClick={() => {
                setEmoji(p.emoji);
                setText(t(`status.preset_${p.key}`));
                setClear(p.hours === 1 ? "1h" : p.hours === 2 ? "4h" : "today");
                setDnd("dnd" in p ? p.dnd : false);
              }}
            >
              <span className="text-base">{p.emoji}</span>
              {t(`status.preset_${p.key}`)}
            </button>
          ))}
        </div>
        <Field label={t("status.clearAfter")}>
          <Picker
            variant="field"
            label={t("status.clearAfter")}
            value={clear}
            onChange={(v) => setClear(v as (typeof CLEAR)[number])}
            options={CLEAR.map((k) => ({ value: k, label: t(`status.clear_${k}`) }))}
          />
        </Field>
        <Checkbox checked={dnd} onChange={(e) => setDnd(e.target.checked)} label={<b className="font-medium">{t("status.dndToggle")}</b>} hint={t("status.dndHint")} />
      </div>
    </Modal>
  );
}

/** Emoji code points (with their joiners, variation selectors and skin tones) vs anything else; the server keeps 16. */
function splitEmoji(v: string): { emoji: string; rest: string } {
  let emoji = "";
  let rest = "";
  for (const ch of v) {
    if (/\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|\u200d|\ufe0f|\u20e3/u.test(ch)) {
      if (emoji.length + ch.length <= 16) emoji += ch;
    } else rest += ch;
  }
  return { emoji, rest };
}
