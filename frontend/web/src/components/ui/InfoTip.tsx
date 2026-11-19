"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { InfoIcon } from "@/components/app/icons";

const WIDTH = 256;

/**
 * ⓘ next to a label: the explanation lives here instead of a paragraph on the page (copy rule 3, DESIGN.md).
 * Opens on hover, focus or click; Esc, a click outside or scrolling closes it. The text is also the button's
 * description (always in the DOM for screen readers). The bubble is only rendered while open and is placed
 * against the viewport (fixed), so it never widens the page on phones nor gets clipped by a card.
 */
export function InfoTip({ text, label, align = "left" }: { text: string; label?: string; align?: "left" | "right" }) {
  const tr = useT();
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const id = useId();
  const ref = useRef<HTMLSpanElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const open = pos !== null;
  const show = () => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.min(WIDTH, window.innerWidth - 16);
    const want = align === "left" ? r.left : r.right - width;
    setPos({ top: r.bottom + 6, left: Math.max(8, Math.min(want, window.innerWidth - width - 8)), width });
  };
  const hide = () => setPos(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && hide();
    const key = (e: KeyboardEvent) => e.key === "Escape" && hide();
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [open]);
  return (
    <span ref={ref} className="relative inline-flex align-middle" onMouseEnter={show} onMouseLeave={hide}>
      <button
        ref={btn}
        type="button"
        aria-label={label ? `${tr("ui.info")}: ${label}` : tr("ui.info")}
        aria-describedby={id}
        aria-expanded={open}
        onClick={() => (open ? hide() : show())}
        onFocus={show}
        onBlur={hide}
        // 16px icon, 24px target (WCAG 2.5.8), 44px on phones: the hit area reaches past the glyph without moving text.
        className="text-ink-2 hover:text-ink relative -m-1 grid size-6 place-items-center rounded-md transition-colors after:absolute after:-inset-1 after:content-[''] max-md:after:-inset-2.5 [&_svg]:size-3.5"
      >
        <InfoIcon />
      </button>
      <span id={id} className="sr-only">
        {text}
      </span>
      {pos ? (
        <span
          role="tooltip"
          aria-hidden="true"
          style={{ top: pos.top, left: pos.left, width: pos.width }}
          className="border-hairline bg-surface text-ink animate-pop shadow-popover fixed z-50 rounded-lg border p-3 text-xs/[1.5] font-normal max-md:text-[13px]/[1.5]"
        >
          {text}
        </span>
      ) : null}
    </span>
  );
}
