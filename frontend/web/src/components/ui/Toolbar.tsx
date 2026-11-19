"use client";

import Link from "next/link";
import { cx } from "@/lib/ui";

/**
 * The one control row above a page's content (≤ 6 controls): scope / tabs on the left, view switch, filters and
 * the page's single primary action on the right. Wraps to at most two lines on phones.
 */
export function Toolbar({ left, right, label, className }: { left?: React.ReactNode; right?: React.ReactNode; label?: string; className?: string }) {
  return (
    <div role="toolbar" aria-label={label} className={cx("mb-4 flex flex-wrap items-center gap-2", className)}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">{left}</div>
      <div className="ml-auto flex flex-wrap items-center gap-2">{right}</div>
    </div>
  );
}

/**
 * Icon-only segmented switch (view: board / list / Gantt). Each option has a tooltip and an aria-label. With
 * `href`s the options are links (current one `aria-current="page"`); with `onChange` they are a radio group.
 */
export function IconSwitch<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string; icon: React.ReactNode; href?: string }[];
  onChange?: (v: T) => void;
  label: string;
}) {
  return (
    <div role={options.some((o) => o.href) ? "group" : "radiogroup"} aria-label={label} className="bg-hover inline-flex items-center gap-0.5 rounded-full p-0.5">
      {options.map((o) => {
        const on = o.value === value;
        const cls = cx("grid h-7 w-8 place-items-center rounded-full transition-colors [&_svg]:size-4", on ? "bg-surface text-ink shadow-raised" : "text-ink-2 hover:text-ink");
        return o.href ? (
          <Link key={o.value} href={o.href} aria-current={on ? "page" : undefined} aria-label={o.label} title={o.label} className={cx(cls, "no-underline")}>
            {o.icon}
          </Link>
        ) : (
          <button key={o.value} type="button" role="radio" aria-checked={on} aria-label={o.label} title={o.label} onClick={() => onChange?.(o.value)} className={cls}>
            {o.icon}
          </button>
        );
      })}
    </div>
  );
}
