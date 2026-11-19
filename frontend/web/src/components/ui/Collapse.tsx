"use client";

import { useEffect, useState } from "react";
import { ChevronRightIcon } from "@/components/app/icons";
import { cx } from "@/lib/ui";

/**
 * A section that folds away (details live here so the page stays short). With an `id`, the open state follows the
 * URL hash (`#id` opens it, so a link can point at an open section) and opening it writes the hash.
 */
export function Collapse({
  title,
  meta,
  children,
  id,
  defaultOpen = false,
  lazy = true,
  className,
  flat = false,
}: {
  title: React.ReactNode;
  /** Muted text after the title (a count or a one-line summary). */
  meta?: React.ReactNode;
  children: React.ReactNode;
  id?: string;
  defaultOpen?: boolean;
  /** Mount the content only once it has been opened (default): folded details cost no requests or page weight. */
  lazy?: boolean;
  className?: string;
  /** A hairline row instead of a box: for a stack of folded areas on a flat page (Hồ sơ). */
  flat?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [seen, setSeen] = useState(defaultOpen || !lazy);
  // The body clips only while it animates; once open it shows overflow, so pickers, date fields and tips inside
  // can open past its edge.
  const [settled, setSettled] = useState(defaultOpen);
  // On load and on a later in-page link to `#id` (the hash changes without a reload).
  useEffect(() => {
    if (!id) return;
    const sync = () => {
      if (window.location.hash === `#${id}`) setOpen(true);
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, [id]);
  useEffect(() => {
    if (!open) return setSettled(false);
    setSeen(true);
    // After the 200 ms height transition (or at once when there is none: reduced motion).
    const t = setTimeout(() => setSettled(true), 220);
    return () => clearTimeout(t);
  }, [open]);
  return (
    <section id={id} className={cx(flat ? "border-hairline scroll-mt-20 border-b" : "border-hairline bg-surface rounded-lg border", className)}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          const v = !open;
          setOpen(v);
          if (id) history.replaceState(null, "", v ? `#${id}` : window.location.pathname + window.location.search);
        }}
        className={cx("hover:bg-hover/50 flex min-h-12 w-full items-center gap-2 rounded-lg text-left transition-colors", flat ? "-mx-2 w-[calc(100%+1rem)] px-2" : "px-4")}
      >
        <span className={cx("text-ink-2 transition-transform duration-150 [&_svg]:size-4", open && "rotate-90")} aria-hidden="true">
          <ChevronRightIcon />
        </span>
        <span className="shrink-0 whitespace-nowrap text-sm font-medium">{title}</span>
        {meta ? <span className="text-ink-2 min-w-0 truncate text-sm max-sm:hidden">{meta}</span> : null}
      </button>
      {/* grid-rows 0fr → 1fr animates the height without measuring. */}
      <div className={cx("grid transition-[grid-template-rows] duration-200 ease-out", open ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
        <div className={cx("min-h-0", open && settled ? "overflow-visible" : "overflow-hidden")} inert={!open}>
          {seen ? <div className={flat ? "pb-5 pt-1" : "border-hairline border-t p-4"}>{children}</div> : null}
        </div>
      </div>
    </section>
  );
}
