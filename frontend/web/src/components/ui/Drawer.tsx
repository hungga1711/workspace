"use client";

import * as m from "motion/react-m";
import { useState } from "react";
import { useT } from "@/lib/i18n/client";
import { useDialog } from "@/components/app/useDialog";
import { CloseIcon, CopyIcon, PanelIcon } from "@/components/app/icons";
import { cx } from "@/lib/ui";
import { Portal } from "./Portal";

/** The header's round icon buttons ("Mở trang đầy đủ", copy link, ×). */
export const drawerTool = "text-ink-2 hover:bg-hover hover:text-ink grid size-8 shrink-0 place-items-center rounded-md transition-colors [&_svg]:size-4";

/**
 * The one detail overlay: every entity opened from a list — a task, an approval, a
 * meeting, a person, a channel's details/members/files/pins, a doc's history — slides in from the right over the
 * content and never pushes or re-centres it. 520px on desktop, a full-screen sheet on phones; one header everywhere
 * (title, extra `actions`, optional "Mở trang đầy đủ" link to `href`, optional copy-link for `copy`, ×; nothing else
 * goes in it). `footer` stays pinned under the scrolling body (a reply composer). From 1280px the scrim is a faint 8% veil,
 * so the page stays readable beside it; below that a 40% scrim. Focus is trapped, Esc and a click outside close it.
 * The body is a size container, so detail views lay out for the drawer's width (`@4xl:` etc.), not the window's.
 */
export function Drawer({
  title,
  onClose,
  children,
  actions,
  padded,
  href,
  copy,
  footer,
  label,
}: {
  title: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  /** Extra header buttons, placed before "Mở trang đầy đủ" and ×. */
  actions?: React.ReactNode;
  padded?: boolean;
  /** The entity's full page; adds the "Mở trang đầy đủ" icon (a real page load, so it is not intercepted again). */
  href?: string;
  /** A shareable address for "Sao chép link" (defaults to `href` when that is given). */
  copy?: string;
  footer?: React.ReactNode;
  /** Accessible name when `title` is not a string. */
  label?: string;
}) {
  const t = useT();
  const ref = useDialog<HTMLDivElement>(onClose);
  const [copied, setCopied] = useState(false);
  const link = copy ?? href;
  const copyLink = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(new URL(link, window.location.origin).toString());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked: the address bar has the same link */
    }
  };
  return (
    <Portal>
      <m.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.2 }}
        className="fixed inset-0 z-[60] bg-black/40 xl:bg-black/[0.08]"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
        aria-hidden="true"
      />
      <m.aside
        ref={ref}
        initial={{ x: "100%" }}
        animate={{ x: 0 }}
        transition={{ duration: 0.2, ease: [0.2, 0.7, 0.2, 1] }}
        role="dialog"
        aria-modal="true"
        aria-label={label ?? (typeof title === "string" ? title : undefined)}
        className="bg-surface shadow-drawer border-hairline fixed inset-y-0 right-0 z-[61] flex w-full flex-col sm:w-[520px] sm:border-l"
      >
        <header className="border-hairline flex min-h-12 shrink-0 items-center gap-1 border-b pl-4 pr-2">
          <h2 className="text-ink m-0 min-w-0 flex-1 truncate pr-2 text-[14px]/6 font-semibold">{title}</h2>
          {actions}
          {href ? (
            <a href={href} className={drawerTool} aria-label={t("peek.open")} title={t("peek.open")}>
              <PanelIcon />
            </a>
          ) : null}
          {link ? (
            <button
              type="button"
              className={cx(drawerTool, copied && "text-ok")}
              onClick={() => void copyLink()}
              aria-label={copied ? t("peek.copied") : t("peek.copy")}
              title={copied ? t("peek.copied") : t("peek.copy")}
            >
              <CopyIcon />
            </button>
          ) : null}
          <button type="button" onClick={onClose} aria-label={t("common.close")} title={t("common.close")} className={drawerTool}>
            <CloseIcon />
          </button>
        </header>
        <div className={cx("@container min-h-0 flex-1 overflow-y-auto overscroll-contain", padded && "p-5")}>{children}</div>
        {footer ? <div className="border-divider shrink-0 border-t p-3">{footer}</div> : null}
      </m.aside>
    </Portal>
  );
}
