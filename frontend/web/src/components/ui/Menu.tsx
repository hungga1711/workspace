"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { cx, menuItem, popover } from "@/lib/ui";
import { useClampX } from "./clamp";

export interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  icon?: React.ReactNode;
  /** Shown but not available to this viewer (selecting it explains why). */
  muted?: boolean;
}

/** Small popover menu with keyboard support (Esc closes, arrows move). */
export function Menu({
  trigger,
  items,
  align = "right",
  label,
  defaultOpen = false,
  sheetOnMobile = false,
  footer,
}: {
  trigger: React.ReactNode;
  items: MenuItem[];
  align?: "left" | "right";
  label: string;
  defaultOpen?: boolean;
  /** Phones: open as a sheet above the bottom bar (menus opened from the bottom bar's "+"). */
  sheetOnMobile?: boolean;
  /** Controls under the items (not menu items themselves): the account menu's theme and language. */
  footer?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const ref = useRef<HTMLDivElement>(null);
  // Esc and a chosen item hand focus back to the trigger; a dialog the item opens then restores focus there too.
  const backToTrigger = () => ref.current?.querySelector<HTMLButtonElement>("button[aria-haspopup=menu]")?.focus({ preventScroll: true });
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      setOpen(false);
      // A click on plain page content would leave focus nowhere (on <body>): keep it on the trigger instead.
      requestAnimationFrame(() => {
        const a = document.activeElement;
        if (!a || a === document.body || ref.current?.contains(a)) backToTrigger();
      });
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        backToTrigger();
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const items = Array.from(ref.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? []);
        const i = items.indexOf(document.activeElement as HTMLElement);
        items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
        e.preventDefault();
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", key);
    ref.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  const clamp = useClampX<HTMLDivElement>();
  return (
    <div ref={ref} className="relative">
      {/* A real box, not display:contents: a contents button cannot take focus, so Esc and a chosen item left focus on
          <body> (the Create and task "…" menus). */}
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex max-w-full rounded-md align-middle"
      >
        {trigger}
      </button>
      {/* Phones: a sheet over the page gets the drawers' 40% scrim, or it reads as part of the page under it. */}
      {open && sheetOnMobile ? <div aria-hidden="true" className="fixed inset-0 z-[29] bg-black/40 md:hidden" onClick={() => setOpen(false)} /> : null}
      <AnimatePresence>
        {open ? (
          <m.div
            ref={clamp}
            role="menu"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.1 } }}
            transition={{ duration: 0.14, ease: "easeOut" }}
            className={cx(
              popover,
              "absolute z-30 mt-1 min-w-48",
              !!footer && "min-w-64",
              align === "right" ? "right-0 origin-top-right" : "left-0 origin-top-left",
              sheetOnMobile && "max-md:fixed max-md:inset-x-3 max-md:bottom-20 max-md:top-auto max-md:origin-bottom max-md:p-1.5 max-md:[&_[role=menuitem]]:min-h-11",
            )}
          >
            {items.map((it) => (
              <button
                key={it.label}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  backToTrigger();
                  it.onSelect();
                }}
                className={cx(menuItem, it.danger && "text-block [&>svg]:text-block", it.muted && "text-ink-2")}
              >
                {it.icon}
                {it.label}
              </button>
            ))}
            {footer ? <div className="border-divider mt-1 border-t px-1 pb-0.5 pt-1.5">{footer}</div> : null}
          </m.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
