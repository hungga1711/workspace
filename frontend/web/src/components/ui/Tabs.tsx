"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { useSlider } from "./slider";
import { useT } from "@/lib/i18n/client";
import { cx } from "@/lib/ui";

export interface TabItem {
  key: string;
  label: string;
  href: string;
  count?: number;
  /** A shorter label for phones (below 640px), so a row of tabs fits 360px without scrolling. */
  short?: string;
}

/**
 * Page-level navigation between sibling views: muted medium labels, the current one ink semibold with a
 * 2px ink rule sitting on the header's hairline. For in-content filters use `Segmented` instead.
 * Scrolls sideways on phones, never the page. The first label sits flush with the content's left edge (labels are
 * 20px apart, no side padding), so tabs line up with the cards below them.
 */
export function Tabs({
  tabs,
  active,
  label,
  className,
  onSelect,
}: {
  tabs: TabItem[];
  active: string;
  label?: string;
  className?: string;
  /** Called on click, before navigation (mark the tab at once while the next view loads). */
  onSelect?: (key: string) => void;
}) {
  const tr = useT();
  const nav = useRef<HTMLElement>(null);
  useEffect(() => scrollToCurrent(nav.current), [active]);
  // The 2px rule slides from the old tab to the new one (a CSS transition on a measured bar); before it is
  // measured, and without JS, each tab draws its own rule.
  const bar = useSlider(nav, "[aria-current=page]", active);
  return (
    <nav ref={nav} className={cx("no-scrollbar relative -mb-px flex min-w-0 max-w-full gap-4 overflow-x-auto", className)} aria-label={label ?? tr("ui.tabs")}>
      {tabs.map((t) => {
        const on = t.key === active;
        return (
          <Link
            key={t.key}
            href={t.href}
            onClick={onSelect ? () => onSelect(t.key) : undefined}
            aria-current={on ? "page" : undefined}
            className={cx(
              "relative flex h-9 shrink-0 items-center gap-1.5 text-sm no-underline transition-colors duration-100 max-md:h-11",
              "after:absolute after:inset-x-0 after:bottom-0 after:h-px after:transition-colors",
              on ? cx("text-ink font-medium", bar ? "after:bg-transparent" : "after:bg-ink") : "text-ink-2 hover:text-ink after:bg-transparent",
            )}
          >
            {t.short ? (
              <>
                <span className="max-sm:hidden">{t.label}</span>
                <span className="sm:hidden">{t.short}</span>
              </>
            ) : (
              t.label
            )}
            {t.count ? <span className={cx("bg-hover rounded-sm px-1.5 text-xs tabular-nums max-md:text-[13px]", on ? "text-ink" : "text-ink-2")}>{t.count}</span> : null}
          </Link>
        );
      })}
      {bar ? (
        <span
          aria-hidden="true"
          className={cx("bg-ink pointer-events-none absolute bottom-0 left-0 h-px", bar.moved && "transition-[transform,width] duration-200 ease-[var(--ease-out-soft)]")}
          style={{ transform: `translateX(${bar.x}px)`, width: Math.max(0, bar.w) }}
        />
      ) : null}
    </nav>
  );
}

/** Scrolls a horizontal tab bar (not the page) so its current tab is visible. */
function scrollToCurrent(bar: HTMLElement | null) {
  const cur = bar?.querySelector<HTMLElement>("[aria-current=page]");
  if (!bar || !cur) return;
  const b = bar.getBoundingClientRect();
  const c = cur.getBoundingClientRect();
  if (c.left < b.left || c.right > b.right) bar.scrollLeft += c.left - b.left - 16;
}
