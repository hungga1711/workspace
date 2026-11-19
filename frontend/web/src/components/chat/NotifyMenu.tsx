"use client";

import { useEffect, useRef, useState } from "react";
import { useFormat } from "@/lib/i18n/client";
import { BellIcon, BellOffIcon, CheckIcon } from "@/components/app/icons";
import { cx, menuItem, menuLabel, menuSep, popover } from "@/lib/ui";
import { useClampX } from "@/components/ui/clamp";

export type Notify = "all" | "mentions" | "none";
export interface NotifyState {
  notify: Notify | null;
  muted: boolean;
  mutedUntil: string | null;
}
export type NotifyPatch = { notify: Notify } | { muteFor: "1h" | "8h" | "24h" | "1w" | "forever" | "off" };

/**
 * Per-conversation notifications: every message, mentions only or nothing; or mute for an hour,
 * 8 hours, a day, a week, or until turned back on. The bell shows the state at a glance.
 */
export function NotifyMenu({ state, dm, onChange }: { state: NotifyState; dm: boolean; onChange: (p: NotifyPatch) => void }) {
  const { t, time, dayInline } = useFormat();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const clamp = useClampX<HTMLDivElement>();
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  // Channels notify on mentions by default; direct messages on every message.
  const level: Notify = state.notify ?? (dm ? "all" : "mentions");
  const until = state.mutedUntil && Date.parse(state.mutedUntil) > Date.now() ? new Date(state.mutedUntil) : null;
  const silent = state.muted || !!until;
  const pick = (p: NotifyPatch) => {
    setOpen(false);
    onChange(p);
  };
  const row = (on: boolean, label: string, hint: string | null, act: () => void) => (
    <button type="button" role="menuitemradio" aria-checked={on} onClick={act} className={cx(menuItem, "items-start py-2")}>
      <span className="mt-0.5 grid size-4 shrink-0 place-items-center">{on ? <CheckIcon className="text-brand-text size-4" /> : null}</span>
      <span className="min-w-0">
        <span className={cx("block", on && "font-semibold")}>{label}</span>
        {hint ? <span className="text-ink-2 block text-xs">{hint}</span> : null}
      </span>
    </button>
  );
  const label = silent ? (until ? t("chat.notify.mutedUntil", { when: `${dayInline(until)} ${time(until)}` }) : t("chat.notify.mutedForever")) : t(`chat.notify.level_${level}`);
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("chat.notify.button", { state: label })}
        title={label}
        className={cx(
          "aria-expanded:bg-selected aria-expanded:text-ink grid size-8 shrink-0 place-items-center rounded-md transition-colors",
          silent || level === "none" ? "bg-hover text-ink" : "text-ink-soft hover:bg-hover hover:text-ink",
        )}
      >
        {silent || level === "none" ? <BellOffIcon /> : <BellIcon />}
      </button>
      {open ? (
        <div ref={clamp} role="menu" aria-label={t("chat.notify.title")} className={cx(popover, "absolute right-0 top-9 z-30 grid w-72 gap-0.5")}>
          <p className={menuLabel}>{t("chat.notify.title")}</p>
          {row(level === "all", t("chat.notify.level_all"), t("chat.notify.hint_all"), () => pick({ notify: "all" }))}
          {dm ? null : row(level === "mentions", t("chat.notify.level_mentions"), t("chat.notify.hint_mentions"), () => pick({ notify: "mentions" }))}
          {row(level === "none", t("chat.notify.level_none"), t("chat.notify.hint_none"), () => pick({ notify: "none" }))}
          <hr className={menuSep} />
          <p className={menuLabel}>{t("chat.notify.pause")}</p>
          {silent ? row(false, t("chat.notify.unmute"), label, () => pick({ muteFor: "off" })) : null}
          {(["1h", "8h", "24h", "1w", "forever"] as const).map((k) => (
            <button key={k} type="button" role="menuitem" onClick={() => pick({ muteFor: k })} className={cx(menuItem, "pl-[38px]")}>
              {t(`chat.notify.for_${k}`)}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
