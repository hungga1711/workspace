"use client";

import Link from "next/link";
import { useRef } from "react";
import { cx } from "@/lib/ui";
import { useSlider } from "./slider";

export interface SegmentedOption<V extends string = string> {
  value: V;
  label: string;
  icon?: React.ReactNode;
  count?: number;
  /** Render as a link (URL-driven filters); otherwise a button calling onChange. */
  href?: string;
  /** Icon-only segment: the label becomes the tooltip and accessible name. */
  iconOnly?: boolean;
}

/**
 * In-content filter: a muted pill track, the current option a raised white pill. For page-level
 * navigation between sibling views use `Tabs`. Buttons form a radio group; links mark the current one.
 */
export function Segmented<V extends string>({
  label,
  value,
  options,
  onChange,
  size = "md",
  className,
  phoneGrid,
}: {
  label: string;
  value: V;
  options: SegmentedOption<V>[];
  onChange?: (v: V) => void;
  size?: "sm" | "md";
  className?: string;
  /** Phones: the options sit in a grid of this many columns instead of one row that would be cut off. */
  phoneGrid?: 2 | 3;
}) {
  const links = options.some((o) => o.href);
  const track = useRef<HTMLDivElement>(null);
  // The raised pill slides between options (measured, CSS transition); unmeasured, the current option paints it.
  const pill = useSlider(track, "[aria-checked=true],[aria-current=true]", value);
  const item = (on: boolean, iconOnly?: boolean) =>
    cx(
      "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-[5px] no-underline transition-colors duration-100 [&_svg]:size-3.5",
      size === "sm" ? "h-6 text-xs" : "h-7 text-sm",
      iconOnly ? (size === "sm" ? "w-6" : "w-7") : "px-2",
      on ? cx("text-ink font-medium", !pill && "bg-surface shadow-raised", phoneGrid && "max-sm:bg-surface max-sm:shadow-raised") : "text-ink-2 hover:text-ink",
      phoneGrid && "max-sm:min-w-0 max-sm:px-1.5",
      "relative z-[1]",
    );
  const inner = (o: SegmentedOption<V>) => (
    <>
      {o.icon}
      {o.iconOnly ? <span className="sr-only">{o.label}</span> : o.label}
      {o.count !== undefined ? <span className="text-ink-2 text-xs tabular-nums">{o.count}</span> : null}
    </>
  );
  return (
    <div
      ref={track}
      role={links ? "group" : "radiogroup"}
      aria-label={label}
      className={cx(
        "bg-hover relative inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-md p-0.5",
        // The sliding pill only moves along one row, so the grid marks the current option itself.
        phoneGrid === 2 && "max-sm:grid max-sm:w-full max-sm:grid-cols-2",
        phoneGrid === 3 && "max-sm:grid max-sm:w-full max-sm:grid-cols-3",
        className,
      )}
    >
      {pill ? (
        <span
          aria-hidden="true"
          className={cx(
            "bg-surface shadow-raised pointer-events-none absolute left-0 top-0.5 rounded-[5px]",
            phoneGrid && "max-sm:hidden",
            pill.moved && "transition-[transform,width] duration-200 ease-[var(--ease-out-soft)]",
          )}
          style={{ transform: `translateX(${pill.x}px)`, width: pill.w, height: pill.h }}
        />
      ) : null}
      {options.map((o) => {
        const on = o.value === value;
        return o.href ? (
          <Link key={o.value} href={o.href} aria-current={on ? "true" : undefined} title={o.iconOnly ? o.label : undefined} className={item(on, o.iconOnly)}>
            {inner(o)}
          </Link>
        ) : (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            title={o.iconOnly ? o.label : undefined}
            onClick={() => onChange?.(o.value)}
            className={item(on, o.iconOnly)}
          >
            {inner(o)}
          </button>
        );
      })}
    </div>
  );
}
