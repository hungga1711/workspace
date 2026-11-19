"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { btn, cx, menuItem, menuLabel, popover } from "@/lib/ui";
import { propertyValue } from "@/components/ui/PropertyRow";
import { CheckIcon, ChevronDownIcon } from "@/components/app/icons";
import { useClampX } from "./clamp";

export interface PickerOption {
  value: string;
  label: string;
  icon?: React.ReactNode;
  /** Extra words the filter matches (e.g. an email). */
  keywords?: string;
  /** Section heading shown above the first option of each group (hidden while filtering). */
  group?: string;
}

/** Short lists (up to 9) pick with their number key while open, shown at the row's end when `numbered`. */

/**
 * The one select of the app (a listbox, no native <select>): the trigger shows the value, the popover
 * lists the options with a check on the current one; long lists get a filter box (type to narrow, arrows move,
 * Enter picks, Esc closes).
 *
 * Variants: "property" (ghost value in a property list), "button" (outline toolbar button, e.g. a filter),
 * "field" (full-width form field, replaces a native select in forms), "title" (a page title that opens a menu).
 */
export function Picker({
  label,
  value,
  options,
  onChange,
  disabled,
  title,
  placeholder,
  align = "left",
  side = "bottom",
  variant = "property",
  prefix,
  onOpen,
  footer,
  id,
  className,
  triggerClassName,
  menuClassName,
  heading,
  numbered,
  renderOption,
}: {
  label: string;
  value: string;
  options: PickerOption[];
  onChange: (v: string) => void;
  disabled?: boolean;
  title?: string;
  placeholder?: string;
  align?: "left" | "right";
  /** Open the list upwards (a picker at the bottom of the screen, e.g. in a composer). */
  side?: "bottom" | "top";
  variant?: "property" | "button" | "field" | "title" | "crumb";
  /** Muted text before the value on a toolbar button (e.g. "Loại:"). */
  prefix?: string;
  /** Called when the list opens (load options lazily). */
  onOpen?: () => void;
  /** Extra rows under the options (e.g. a link "Trang dự án →"). */
  footer?: React.ReactNode;
  id?: string;
  className?: string;
  /** Replaces the variant's trigger look (e.g. the task's status as a filled button). */
  triggerClassName?: string;
  /** Replaces the popover's width (e.g. "w-full" to match a full-width trigger). */
  menuClassName?: string;
  /** A heading above the options (e.g. "Đổi trạng thái"). */
  heading?: string;
  /** Show each option's number key (1–9) at the end of its row. */
  numbered?: boolean;
  /** Draws an option's label in the list (e.g. a task status as its coloured pill). */
  renderOption?: (o: PickerOption) => React.ReactNode;
}) {
  const tx = useT();
  const [open, setOpen] = useState(false);
  const clamp = useClampX<HTMLDivElement>();
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const listId = useId();
  const searchable = options.length > 7;
  const shown = q ? options.filter((o) => `${o.label} ${o.keywords ?? ""}`.toLowerCase().includes(q.toLowerCase())) : options;
  const current = options.find((o) => o.value === value);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", away);
    setHi(
      Math.max(
        0,
        options.findIndex((o) => o.value === value),
      ),
    );
    if (!searchable) ref.current?.querySelector<HTMLElement>("[role=listbox]")?.focus();
    return () => document.removeEventListener("mousedown", away);
  }, [open, options, value, searchable]);
  // Long lists (15-minute time slots, people) open on the current value and follow the arrow keys.
  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLElement>(`[data-i="${hi}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, hi]);
  // Keyboard users land back on the trigger after choosing or Esc, not on <body> (WCAG 2.4.3).
  const backToTrigger = () => ref.current?.querySelector<HTMLButtonElement>("button[aria-haspopup=listbox]")?.focus();
  const pick = (v: string) => {
    setOpen(false);
    setQ("");
    backToTrigger();
    if (v !== value) onChange(v);
  };
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      setOpen(false);
      backToTrigger();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setHi((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % Math.max(1, shown.length));
    } else if (e.key === "Enter" && shown[hi]) {
      e.preventDefault();
      pick(shown[hi].value);
    } else if (!searchable && /^[1-9]$/.test(e.key) && options[Number(e.key) - 1]) {
      e.preventDefault();
      pick(options[Number(e.key) - 1]!.value);
    }
  };
  const trigger =
    triggerClassName ??
    (variant === "button"
      ? cx(btn, "h-8 min-h-0 max-w-64 gap-1.5 px-2.5 max-md:h-9")
      : variant === "field"
        ? "flex min-h-8 w-full items-center gap-2 rounded-md border border-hairline bg-surface px-2.5 text-left text-sm text-ink transition-colors hover:bg-hover/50 aria-expanded:border-ink-2 max-md:min-h-10"
        : variant === "crumb"
          ? "flex h-8 max-w-full items-center gap-1 rounded-md px-2 text-sm font-medium text-ink-2 transition-colors hover:bg-hover hover:text-ink"
          : variant === "title"
            ? // A view switcher: the view's name at 15px semibold with its icon and a chevron, a quiet hover
              // fill; no outlined box at title size.
              "flex h-8 max-w-full items-center gap-2 rounded-md px-2 text-base font-semibold text-ink transition-colors hover:bg-ink/[0.06] aria-expanded:bg-ink/[0.06]"
            : propertyValue);
  return (
    // Title and crumb pickers hang their hover fill 8px into the margin (on the root, so the text never truncates early).
    <div ref={ref} className={cx("relative min-w-0", variant === "field" && "w-full", variant === "crumb" && "-mx-2", className)}>
      <button
        type="button"
        id={id}
        // The name carries what the button shows (WCAG 2.5.3, label in name): "Role: Admin", not just "Role".
        aria-label={`${label}: ${[prefix, current?.label ?? placeholder ?? "—"].filter(Boolean).join(" ")}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        title={title}
        onClick={() => {
          if (!open) onOpen?.();
          setOpen((v) => !v);
        }}
        className={cx(trigger, "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent")}
      >
        {prefix ? <span className="text-ink-soft font-normal">{prefix}</span> : null}
        {variant === "crumb" ? null : current?.icon}
        {/* The title's text (not its hover box, which hangs 8px out) is what lines up with every page title. */}
        <span data-page-title={variant === "title" ? "" : undefined} className={cx("min-w-0 truncate", variant === "field" && "flex-1", !current && "text-ink-2")}>
          {current?.label ?? placeholder ?? "—"}
        </span>
        {variant === "button" || variant === "field" || triggerClassName ? (
          <ChevronDownIcon className={cx("size-3.5 shrink-0", triggerClassName ? "opacity-80" : "text-ink-2")} />
        ) : null}
        {variant === "title" ? <ChevronDownIcon className="text-ink-2 size-4 shrink-0" /> : null}
        {variant === "crumb" ? <ChevronDownIcon className="text-ink-2 size-3.5 shrink-0" /> : null}
      </button>
      {open ? (
        <div
          ref={clamp}
          className={cx(
            popover,
            "animate-pop absolute z-40",
            side === "top" ? "bottom-full mb-1" : "top-full mt-1",
            menuClassName ?? (variant === "field" ? "w-full min-w-48" : "w-64"),
            align === "right" ? "right-0" : "left-0",
          )}
          onKeyDown={keys}
          // Inside a <label> (Field), a click in the popover would "activate" the label, which re-clicks the
          // trigger and reopens the list: cancel that (links in the popover still navigate).
          onClick={(e) => !(e.target as HTMLElement).closest("a") && e.preventDefault()}
        >
          {heading ? <p className={cx(menuLabel, "pb-1")}>{heading}</p> : null}
          {searchable ? (
            <input
              autoFocus
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setHi(0);
              }}
              placeholder={tx("ui.filter")}
              aria-label={tx("ui.filter")}
              aria-controls={listId}
              className="border-hairline mb-1 h-8 w-full border-b bg-transparent px-2 text-sm outline-none"
            />
          ) : null}
          <div id={listId} role="listbox" aria-label={label} tabIndex={-1} className="max-h-72 overflow-y-auto outline-none">
            {shown.map((o, i) => [
              o.group && !q && o.group !== shown[i - 1]?.group ? (
                <p key={`g:${o.group}`} role="presentation" className={cx(menuLabel, i > 0 && "border-hairline mt-1 border-t pt-2")}>
                  {o.group}
                </p>
              ) : null,
              <div
                key={o.value}
                role="option"
                data-i={i}
                aria-selected={o.value === value}
                onMouseEnter={() => setHi(i)}
                onClick={() => pick(o.value)}
                className={cx(menuItem, "cursor-pointer", i === hi && "bg-ink/[0.06]")}
              >
                {o.icon}
                {renderOption ? <span className="flex min-w-0 flex-1">{renderOption(o)}</span> : <span className="min-w-0 flex-1 truncate">{o.label}</span>}
                {o.value === value ? <CheckIcon className="text-ink size-4" /> : null}
                {numbered && !q && i < 9 ? (
                  <kbd className="text-ink-2 border-hairline grid size-5 place-items-center rounded border font-sans text-[11px] tabular-nums max-md:hidden">{i + 1}</kbd>
                ) : null}
              </div>,
            ])}
            {shown.length === 0 ? <p className="text-ink-2 m-0 px-2 py-1.5 text-sm">{tx("ui.noMatch")}</p> : null}
          </div>
          {footer ? <div className="border-hairline -mx-1 mt-1 border-t px-1 pt-1">{footer}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
