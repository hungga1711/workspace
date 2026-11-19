"use client";

import { numberFormat } from "@/lib/intl";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useLocale } from "@/lib/i18n/client";
import { INTL_TAG } from "@/lib/i18n/config";
import { card, cx } from "@/lib/ui";
import { AreaSpark } from "@/components/ui/charts";

/*
 * Tiến độ's page frame: one reading column with a sticky index on
 * the left, a short title, a strip of figures with a rule above each, then flat sections divided by hairlines and
 * flat tables. No cards, no icon tiles; colour only in charts, identity marks and the figure that is the problem.
 */

/**
 * The frame of a Tiến độ tab: a title row with the tab's actions on the right, then the tab's
 * panels stacked 16px apart. No index, no sticky column: every tab is short enough to scan.
 */
export function ReportPage({ title, actions, children }: { title: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="font-display text-ink m-0 min-w-0 text-[22px]/7 font-medium tracking-[-0.02em]">{title}</h2>
        {actions ? <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </div>
  );
}

/** Counts a figure up from 0 on first paint (≤ 600 ms); instant under reduced motion. */
function useCountUp(target: number) {
  const [n, setN] = useState(target);
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return setN(target);
    done.current = true;
    if (typeof window === "undefined" || window.matchMedia("(prefers-reduced-motion: reduce)").matches || target === 0) return setN(target);
    const t0 = performance.now();
    const dur = Math.min(600, 250 + Math.abs(target) * 8);
    let raf = 0;
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / dur);
      setN(Math.round(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    setN(0);
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return n;
}
function Count({ n }: { n: number }) {
  const tag = INTL_TAG[useLocale()];
  return <>{numberFormat(tag).format(useCountUp(n))}</>;
}

export interface Figure {
  label: string;
  value: React.ReactNode;
  /** "bad" draws the rule above in red and the value in red (only for a real non-zero problem); "quiet" a hairline rule. */
  tone?: "default" | "bad" | "quiet";
  /** Change against the previous period, written beside the value. */
  delta?: { value: number; goodWhen?: "up" | "down" };
  spark?: number[];
  href?: string;
}

/** The figures that head a tab, in one panel: label, value and change, a sparkline where there is history. */
export function Figures({ items, label }: { items: Figure[]; label: string }) {
  const tag = INTL_TAG[useLocale()];
  return (
    <section aria-label={label} className={cx(card, "grid grid-cols-2 gap-x-6 gap-y-4 p-4 sm:grid-cols-3 lg:grid-cols-5")}>
      {items.map((f) => {
        const tone = f.tone ?? "default";
        const inner = (
          <>
            <span className="text-ink-2 block text-xs">{f.label}</span>
            <span className="mt-0.5 flex items-baseline gap-2">
              <b className={cx("font-display text-[28px]/9 font-medium tabular-nums tracking-[-0.025em]", tone === "bad" ? "text-block" : "text-ink")}>
                {typeof f.value === "number" ? <Count n={f.value} /> : f.value}
              </b>
              {f.delta && f.delta.value ? (
                <span
                  className={cx(
                    "text-xs font-medium tabular-nums",
                    f.delta.goodWhen && (f.delta.goodWhen === "up" ? f.delta.value < 0 : f.delta.value > 0) ? "text-block" : "text-ink-2",
                  )}
                >
                  {f.delta.value > 0 ? "+" : "−"}
                  {numberFormat(tag).format(Math.abs(f.delta.value))}
                </span>
              ) : null}
            </span>
            {f.spark && f.spark.length > 1 ? <AreaSpark values={f.spark} label={f.label} className="mt-2 h-6" highlight={tone === "bad"} /> : null}
          </>
        );
        return f.href ? (
          <Link key={f.label} href={f.href} className="block min-w-0 no-underline">
            {inner}
          </Link>
        ) : (
          <div key={f.label} className="min-w-0">
            {inner}
          </div>
        );
      })}
    </section>
  );
}

/** A panel: a 14px title with a quiet count and whatever sits on the right, then its content. */
export function ReportSection({
  id,
  title,
  count,
  right,
  children,
  className,
}: {
  id: string;
  title: React.ReactNode;
  count?: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className={cx(card, "min-w-0 scroll-mt-16 p-4", className)}>
      <div className="mb-3 flex flex-wrap items-center gap-x-2.5 gap-y-2">
        <h3 id={`${id}-h`} className="text-ink m-0 text-sm font-medium">
          {title}
        </h3>
        {count !== undefined ? <span className="text-ink-2 text-xs tabular-nums">{count}</span> : null}
        {right ? <div className="ml-auto flex min-w-0 flex-wrap items-center gap-2">{right}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** A quiet link at a section's right ("Tất cả →"). */
export function SectionLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="text-accent-text text-xs font-medium no-underline hover:underline">
      {children}
    </Link>
  );
}

/* Flat tables: 12px medium heads over a hairline, 13px rows on soft dividers, numbers right and tabular. */
export const flatTable =
  "w-full border-collapse text-[13px] tabular-nums [&_tbody_tr]:transition-colors [&_tbody_tr]:duration-100 [&_th]:border-b [&_th]:border-hairline [&_th]:pb-2 [&_th]:pr-3 [&_th]:text-left [&_th]:text-xs [&_th]:font-medium [&_th]:text-ink-2 [&_th]:whitespace-nowrap [&_td]:border-b [&_td]:border-divider-soft [&_td]:py-2 [&_td]:pr-3 [&_td]:align-middle [&_td]:whitespace-nowrap [&_tr:last-child_td]:border-b-0 [&_th:last-child]:pr-0 [&_td:last-child]:pr-0";
export const colRight = "text-right";
/** The name cell: takes the room left, wraps, 500 weight, with a 12px muted second line. */
export const colName = "w-full min-w-48 font-medium whitespace-normal! [&_small]:text-ink-2 [&_small]:block [&_small]:text-xs [&_small]:font-normal";
/** A 120px bar with its figure. */
export function BarCell({ pct, className }: { pct: number | null | undefined; className?: string }) {
  if (pct == null) return <span className="text-ink-2">–</span>;
  return (
    <span className={cx("inline-flex w-[120px] items-center gap-2", className)}>
      <span className="bg-progress-track block h-1 flex-1 overflow-hidden rounded-full">
        <span className="bg-progress animate-grow-x block h-full origin-left rounded-full" style={{ width: `${pct}%` }} />
      </span>
      <span className="text-ink-soft w-9 text-right text-xs">{pct}%</span>
    </span>
  );
}

/** "Xem thêm 84 người": the quiet row under a table that only shows its first page. */
export function MoreButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="text-accent-text mt-2.5 text-xs font-medium hover:underline">
      {children}
    </button>
  );
}

/** Keeps the first page of a long list until asked for the rest. */
export function usePaged<T>(all: T[], first: number) {
  const [open, setOpen] = useState(false);
  const ref = useRef(all.length);
  // A new list (a filter changed) starts folded again.
  if (ref.current !== all.length) {
    ref.current = all.length;
    if (open) setOpen(false);
  }
  return { rows: open ? all : all.slice(0, first), more: Math.max(0, all.length - first), open, toggle: () => setOpen((v) => !v) };
}
