"use client";

import * as m from "motion/react-m";
import { useEffect, useRef } from "react";
import { useT } from "@/lib/i18n/client";
import { CloseIcon, SparkleIcon } from "@/components/app/icons";
import { drawerTool } from "@/components/ui/Drawer";
import { Portal } from "@/components/ui/Portal";
import TaskChat from "./TaskChat";

/**
 * "Hỏi AI" on a task: the person's private chat about the task, opened from the button by the title and
 * docked at the right edge, so the task stays in view beside it (over the task popup too). No scrim and no click-away:
 * people read the task while they ask. Esc and × close it; Esc stops here so it does not also close the popup under it.
 * Loaded on demand with the chat, never with the task screen. Phones: the whole screen.
 */
export default function TaskAskSheet({ code, onClose, ...chat }: Omit<React.ComponentProps<typeof TaskChat>, "onClose" | "docked"> & { onClose: () => void }) {
  const t = useT();
  const ref = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    // Captured on window, before the popup's own Esc listener on document.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing) return;
      e.stopPropagation();
      close.current();
    };
    window.addEventListener("keydown", onKey, true);
    const frame = requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>("textarea,button")?.focus());
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKey, true);
      previous?.focus();
    };
  }, []);
  return (
    <Portal>
      <m.aside
        ref={ref}
        initial={{ x: "100%" }}
        animate={{ x: 0 }}
        transition={{ duration: 0.2, ease: [0.2, 0.7, 0.2, 1] }}
        role="dialog"
        aria-label={t("taskChat.titleOf", { code })}
        className="bg-surface shadow-popover border-hairline fixed inset-0 z-[80] flex flex-col md:inset-y-2 md:left-auto md:right-2 md:w-[420px] md:rounded-xl md:border"
      >
        <header className="border-hairline flex min-h-14 shrink-0 items-center gap-2.5 border-b pl-4 pr-2 pt-[env(safe-area-inset-top)]">
          <span aria-hidden="true" className="bg-violet-wash text-violet-text grid size-7 shrink-0 place-items-center rounded-lg [&_svg]:size-4">
            <SparkleIcon />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-ink m-0 truncate text-sm font-semibold">{t("taskChat.sheetTitle")}</h2>
            <p className="text-ink-2 m-0 truncate font-mono text-xs uppercase tracking-[0.06em]">{code}</p>
          </div>
          <button type="button" onClick={onClose} aria-label={t("common.close")} title={t("common.close")} className={drawerTool}>
            <CloseIcon />
          </button>
        </header>
        <TaskChat {...chat} code={code} onClose={onClose} docked />
      </m.aside>
    </Portal>
  );
}
