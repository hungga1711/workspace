"use client";

import * as m from "motion/react-m";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useT } from "@/lib/i18n/client";
import { useDialog } from "@/components/app/useDialog";
import { CheckIcon, CloseIcon, CopyIcon, LinkIcon, PanelIcon } from "@/components/app/icons";
import { cx } from "@/lib/ui";
import { drawerTool } from "./Drawer";
import { Portal } from "./Portal";

/**
 * The centred view of a record opened from a list, a board, Home or chat. A task carries too much (description,
 * subtasks, files, discussion, a dozen properties) for the 520px side drawer, so it gets a wide dialog; a request
 * (`size="medium"`) is a decision someone waits on, so it opens in the middle of the screen too, not at the edge.
 * Same header as `Drawer` (context title, "Mở trang đầy đủ", copy link, ×); Esc, the scrim and back close it. With a
 * `code` (a task), the code itself is the link to the full page and a labelled "Copy link" sits by the close button.
 * Phones: full screen.
 */
export function PeekModal({
  title,
  href,
  size = "wide",
  flush = false,
  code,
  context,
  children,
}: {
  title: string;
  /** The record's code, shown as the link to its full page with copy-link next to it (replaces the header icons). */
  code?: string;
  /** Shown after the code ("T-062 · Website"). */
  context?: string;
  href: string;
  size?: "wide" | "medium";
  /** The content lays itself out edge to edge and scrolls its own columns (the task's body and its properties panel). */
  flush?: boolean;
  children: React.ReactNode;
}) {
  const t = useT();
  const router = useRouter();
  const close = () => router.back();
  const ref = useDialog<HTMLDivElement>(close);
  const [copied, setCopied] = useState(false);
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(new URL(href, window.location.origin).toString());
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
        transition={{ duration: 0.15 }}
        className="fixed inset-0 z-[70] grid place-items-center bg-black/50 md:p-6"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) close();
        }}
      >
        <m.div
          ref={ref}
          initial={{ opacity: 0, scale: 0.98, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.18, ease: [0.2, 0.7, 0.2, 1] }}
          role="dialog"
          aria-modal="true"
          aria-label={title}
          className={cx(
            "bg-surface shadow-popover flex h-dvh w-full flex-col overflow-hidden md:rounded-2xl",
            size === "wide" ? "md:h-[min(920px,calc(100dvh-3rem))] md:max-w-[1200px]" : "md:h-auto md:max-h-[calc(100dvh-3rem)] md:max-w-[760px]",
          )}
        >
          <header className="bg-surface border-divider flex min-h-14 shrink-0 items-center gap-1 border-b pl-6 pr-3">
            {code ? (
              <h2 className="text-ink-2 m-0 flex min-w-0 flex-1 items-center gap-1 pr-2 text-sm font-medium">
                {/* A real page load, so the intercepting route does not open the dialog again. */}
                <a
                  href={href}
                  title={t("peek.open")}
                  className="text-ink-2 hover:text-ink shrink-0 font-mono text-[13px] no-underline underline-offset-2 transition-colors hover:underline"
                >
                  {code}
                </a>
                {context ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="min-w-0 truncate">{context}</span>
                  </>
                ) : null}
              </h2>
            ) : (
              <>
                <h2 className="text-ink-2 m-0 min-w-0 flex-1 truncate pr-2 text-sm font-medium">{title}</h2>
                <a href={href} className={drawerTool} aria-label={t("peek.open")} title={t("peek.open")}>
                  <PanelIcon />
                </a>
                <button
                  type="button"
                  className={cx(drawerTool, copied && "text-ok")}
                  onClick={() => void copyLink()}
                  aria-label={copied ? t("peek.copied") : t("peek.copy")}
                  title={copied ? t("peek.copied") : t("peek.copy")}
                >
                  <CopyIcon />
                </button>
              </>
            )}
            {code ? (
              // Spelled out, not a bare icon by the code: a bare icon is easy to miss.
              <button
                type="button"
                className={cx(
                  "hover:bg-hover hover:text-ink inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium transition-colors [&_svg]:size-4",
                  copied ? "text-ok" : "text-ink-soft",
                )}
                onClick={() => void copyLink()}
                aria-live="polite"
              >
                {copied ? <CheckIcon /> : <LinkIcon />}
                {copied ? t("peek.copied") : t("peek.copy")}
              </button>
            ) : null}
            <button type="button" onClick={close} aria-label={t("common.close")} title={t("common.close")} className={drawerTool}>
              <CloseIcon />
            </button>
          </header>
          <div className={cx("@container min-h-0 flex-1", flush ? "overflow-hidden" : "overflow-y-auto overscroll-contain px-4 py-5 md:px-7 md:py-6")}>{children}</div>
        </m.div>
      </m.div>
    </Portal>
  );
}
