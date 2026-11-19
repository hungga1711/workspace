"use client";

import * as m from "motion/react-m";
import { useT } from "@/lib/i18n/client";
import { useDialog } from "@/components/app/useDialog";
import { CloseIcon } from "@/components/app/icons";
import { cx } from "@/lib/ui";
import { Portal } from "./Portal";

/** Accessible centered dialog: focus trap, Esc, focus restore. */
export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean }) {
  const t = useT();
  const ref = useDialog<HTMLDivElement>(onClose);
  return (
    <Portal>
      <m.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.15 }}
        className="fixed inset-0 z-[70] grid place-items-center bg-black/50 p-4"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <m.div
          ref={ref}
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          role="dialog"
          aria-modal="true"
          aria-label={title}
          className={cx("bg-surface shadow-popover border-hairline flex max-h-[90dvh] w-full flex-col overflow-hidden rounded-2xl border", wide ? "max-w-2xl" : "max-w-md")}
        >
          {/* A tool's dialog: a 48px titled header on a rule, the body, the actions on a quiet footer strip. */}
          <header className="border-hairline flex min-h-12 items-center justify-between gap-3 border-b px-5">
            <h2 className="text-ink m-0 text-sm/6 font-semibold">{title}</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label={t("common.close")}
              className="text-ink-2 hover:bg-hover hover:text-ink -mr-2 grid size-8 place-items-center rounded-md"
            >
              <CloseIcon />
            </button>
          </header>
          <div className="overflow-auto px-5 py-4">{children}</div>
          {footer ? <footer className="border-hairline bg-hover/50 flex justify-end gap-2 border-t px-5 py-3">{footer}</footer> : null}
        </m.div>
      </m.div>
    </Portal>
  );
}
