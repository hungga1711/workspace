"use client";

import { useEffect, useRef, useState } from "react";
import { btn, btnGhost, cx } from "@/lib/ui";
import { ChevronDownIcon, CloseIcon, SearchIcon } from "@/components/app/icons";
import { useT } from "@/lib/i18n/client";
import { useClampX } from "@/components/ui/clamp";

/**
 * A view's secondary controls behind one button (Lọc, Hiển thị): the toolbar stays one row and
 * the options are a click away. A count on the button says how many filters are on.
 */
export function ToolbarPopover({
  label,
  count = 0,
  icon,
  align = "right",
  children,
}: {
  label: string;
  count?: number;
  icon?: React.ReactNode;
  align?: "left" | "right";
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      // Pickers inside the panel render their list in a portal: a click there is still "inside".
      if (ref.current?.contains(t) || t.closest?.("[data-popover-portal]")) return;
      setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !e.defaultPrevented && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const clamp = useClampX<HTMLDivElement>();
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-label={count ? `${label} (${count})` : label}
        // Phones show the icon alone: the tooltip names it for pointer users too.
        title={label}
        className={cx(btn, "h-9 min-h-0 gap-1.5 max-sm:px-2.5", count > 0 && "border-ink/40")}
        onClick={() => setOpen(!open)}
      >
        {icon}
        <span className={cx(icon ? "max-sm:sr-only" : null)}>{label}</span>
        {count > 0 ? <span className="bg-ink text-surface h-4.5 min-w-4.5 grid place-items-center rounded-full px-1 text-xs tabular-nums">{count}</span> : null}
        <ChevronDownIcon className="size-3.5 max-sm:hidden" />
      </button>
      {open ? (
        <div
          ref={clamp}
          role="dialog"
          aria-label={label}
          className={cx(
            "bg-surface shadow-popover border-hairline animate-rise absolute top-11 z-30 grid w-80 max-w-[calc(100vw-1rem)] gap-3 rounded-lg border p-3",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

/** One labelled row inside a popover: the name on the left, its control on the right. */
export function PopoverRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-ink-2 min-w-0 text-xs">{label}</span>
      {/* One width for every control in the panel, so the rows line up; wide enough for "Thứ tự thủ công". */}
      <div className="w-48 shrink-0 [&>div>button]:w-full [&>div>button]:justify-between [&>div]:w-full">{children}</div>
    </div>
  );
}

/**
 * Search that costs one icon in the toolbar until it is needed: the button opens a field, Esc or an empty blur
 * closes it again. A search in progress keeps the field open.
 */
export function SearchToggle({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const t = useT();
  const [open, setOpen] = useState(Boolean(value));
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) ref.current?.focus();
  }, [open]);
  if (!open && !value)
    return (
      <button type="button" aria-label={label} title={label} className={cx(btnGhost, "text-ink-2 h-9 min-h-0 w-9 px-0")} onClick={() => setOpen(true)}>
        <SearchIcon />
      </button>
    );
  // Same look as the top bar's search pill (hairline, soft fill, icon, key hint), so it reads as search, not a form field.
  return (
    <label className="border-hairline bg-hover/60 hover:border-edge focus-within:border-accent focus-within:bg-surface animate-rise flex h-9 min-w-0 flex-1 cursor-text items-center gap-2 rounded-md border pl-2.5 pr-1.5 transition-[border-color,background-color,box-shadow] focus-within:shadow-[0_0_0_3px_var(--accent-wash)] sm:w-60 sm:flex-none">
      <SearchIcon className="text-ink-2 size-4 shrink-0" />
      <input
        ref={ref}
        type="search"
        aria-label={label}
        placeholder={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => !value && setOpen(false)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          onChange("");
          setOpen(false);
        }}
        className="text-ink placeholder:text-ink-2 min-w-0 flex-1 bg-transparent text-sm outline-none max-md:text-base [&::-webkit-search-cancel-button]:hidden"
      />
      {value ? (
        <button
          type="button"
          aria-label={t("ui.clear")}
          title={t("ui.clear")}
          className="text-ink-2 hover:bg-ink/[0.06] hover:text-ink grid size-6 shrink-0 place-items-center rounded-sm"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            onChange("");
            ref.current?.focus();
          }}
        >
          <CloseIcon className="size-3.5" />
        </button>
      ) : (
        <kbd className="border-hairline bg-surface text-ink-2 rounded-sm border px-1 font-sans text-[11px] font-medium leading-4 max-md:hidden">Esc</kbd>
      )}
    </label>
  );
}
