"use client";

import { forwardRef } from "react";
import { cx } from "@/lib/ui";

/**
 * The app's checkbox: a real <input type=checkbox> (forms, keyboard, `getByRole("checkbox")` all work) drawn as a
 * 16 px rounded square, ink when checked with a drawn check; the hit area is 24 px (44 px on phones). With `label`, the whole row is clickable.
 */
export const Checkbox = forwardRef<
  HTMLInputElement,
  Omit<React.InputHTMLAttributes<HTMLInputElement>, "type" | "size"> & { label?: React.ReactNode; hint?: React.ReactNode; boxClassName?: string }
>(function Checkbox({ label, hint, className, boxClassName, ...props }, ref) {
  // The real input is a transparent square larger than the drawing (24px, 44px on phones, WCAG 2.5.8) centred on
  // it, so a thumb does not have to land on 16px; the visible box is a sibling styled from the input's state.
  const box = (
    // Without a label, `className` styles this wrapper (a caller's `relative z-10`), never the input: a positioning
    // class on the input would take it out of its centred `absolute` and push the drawn box down the row.
    <span className={cx("relative inline-grid size-4 shrink-0 place-items-center", boxClassName, !label && className)}>
      <input
        ref={ref}
        type="checkbox"
        {...props}
        className={cx(
          "peer absolute left-1/2 top-1/2 z-[1] m-0 size-6 -translate-x-1/2 -translate-y-1/2 cursor-pointer appearance-none rounded-[5px] opacity-0 max-md:size-11",
          "focus-visible:outline-none disabled:cursor-not-allowed",
        )}
      />
      <span
        aria-hidden="true"
        className={cx(
          "border-ink-2/50 bg-surface pointer-events-none size-4 rounded-[5px] border transition-colors",
          "peer-checked:border-brand peer-checked:bg-brand peer-indeterminate:border-brand peer-indeterminate:bg-brand",
          "peer-focus-visible:outline-ink peer-focus-visible:outline-solid peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-disabled:opacity-50",
        )}
      />
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        className="text-on-brand peer-checked:[&_path]:animate-check pointer-events-none absolute size-3 opacity-0 peer-checked:opacity-100"
      >
        <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="24" />
      </svg>
    </span>
  );
  if (!label) return box;
  return (
    <label className={cx("text-ink flex cursor-pointer items-start gap-2.5 text-sm/5", props.disabled && "cursor-not-allowed opacity-60", className)}>
      <span className="pt-0.5">{box}</span>
      <span className="min-w-0">
        {label}
        {hint ? <span className="text-ink-2 block text-xs/[1.45]">{hint}</span> : null}
      </span>
    </label>
  );
});
