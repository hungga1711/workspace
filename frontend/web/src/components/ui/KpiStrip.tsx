"use client";

import { numberFormat } from "@/lib/intl";
import Link from "next/link";
import { useCountUp } from "./useCountUp";
import { cx } from "@/lib/ui";
import { HUE, iconTile, type Hue } from "@/lib/hue";
import { useLocale, useT } from "@/lib/i18n/client";
import { INTL_TAG } from "@/lib/i18n/config";
import { AreaSpark } from "./charts";
import { InfoTip } from "./InfoTip";

export interface Kpi {
  label: string;
  /** A number counts up on first view; a string is shown as is; null (no data yet) reads "chưa có", muted. */
  value: number | string | null;
  /** Formats a numeric value (default: locale integer). */
  format?: (n: number) => string;
  /** Small muted text after the value (unit or context, ≤ 3 words). */
  unit?: string;
  /** "bad" (red dot) / "warn" (amber dot) only when the value is a real non-zero problem; the numeral stays ink. */
  tone?: "default" | "bad" | "warn";
  /** Change vs the previous period; `goodWhen` says which direction is good (colours only the bad way). */
  delta?: { value: number; suffix?: string; goodWhen?: "up" | "down" };
  spark?: number[];
  href?: string;
  /** Explanation behind an ⓘ (instead of a paragraph on the page). */
  info?: string;
  /** A 16px icon shown in a tinted tile beside the label. */
  icon?: React.ReactNode;
  /** The tile's hue; by default red for a "bad" problem, orange for "warn", else blue. */
  hue?: Hue;
}

/** A value that is not a number yet (null, "—", "–", empty): said in words, never a big dash or a 0%. */
const blank = (v: Kpi["value"]) => v === null || (typeof v === "string" && ["", "—", "–", "-"].includes(v.trim()));

function Value({ k }: { k: Kpi }) {
  const tr = useT();
  // In the app's language, not the browser's: "6.533" beside "11.139.393", never "6,533".
  const tag = INTL_TAG[useLocale()];
  const num = typeof k.value === "number" ? k.value : null;
  const shown = useCountUp(num ?? 0);
  if (blank(k.value)) return <span className="text-ink-2 text-sm">{tr("ui.noData")}</span>;
  // A problem figure takes its tone's colour, so late and
  // blocked counts stand out from the neutral ones at a glance; zero stays muted and neutral figures stay ink.
  const tone = num === 0 ? "text-ink-2" : alarm(k) ? (k.tone === "bad" ? "text-block" : "text-warn") : "text-ink";
  return (
    <span className={cx("font-display text-[28px]/9 font-semibold tabular-nums tracking-[-0.02em] max-md:text-2xl/8", tone)}>
      {num === null ? (k.value as string) : (k.format ?? ((n: number) => numberFormat(tag).format(Math.round(n))))(shown)}
    </span>
  );
}

/** A tile flags a problem only when its tone says so and the value is a real non-zero number. */
const alarm = (k: Kpi) => (k.tone === "bad" || k.tone === "warn") && typeof k.value === "number" && k.value !== 0;

function Delta({ d, value }: { d: NonNullable<Kpi["delta"]>; value: Kpi["value"] }) {
  const tag = INTL_TAG[useLocale()];
  // No change, or a first period (the whole value is the "change": there was nothing before to compare with).
  if (!d.value || (typeof value === "number" && d.value === value)) return null;
  const up = d.value > 0;
  const bad = d.goodWhen ? (d.goodWhen === "up" ? !up : up) : false;
  return (
    <span className="text-ink-2 inline-flex items-center gap-0.5 text-xs font-medium tabular-nums">
      <span aria-hidden="true" className={bad ? "text-block" : undefined}>
        {up ? "▲" : "▼"}
      </span>
      {numberFormat(tag).format(Math.abs(d.value))}
      {d.suffix ?? ""}
    </span>
  );
}

/**
 * One row of headline numbers (the only KPI look in the app): 12px label, 28px medium tabular value, an optional
 * delta and sparkline. Tiles share hairlines like a segmented card; they wrap to 2 columns on phones. Zero tiles
 * hide when three others have a number (`keepZeros` to keep them), "—" reads "chưa có", a first period has no delta.
 */
export function KpiStrip({ items: all, label, className, keepZeros = false }: { items: Kpi[]; label?: string; className?: string; keepZeros?: boolean }) {
  // Zero tiles go when at least three others carry a number (a row of "0" is noise); a strip that is all zero
  // keeps them, so the reader sees "nothing yet" rather than an empty card.
  const nonZero = all.filter((k) => !(k.value === 0 || blank(k.value))).length;
  const items = keepZeros || nonZero < 3 ? all : all.filter((k) => k.value !== 0);
  const n = items.length;
  const cols = n >= 6 ? "md:grid-cols-3 xl:grid-cols-6" : n === 5 ? "md:grid-cols-5" : n === 4 ? "md:grid-cols-4" : n === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2";
  // Below the breakpoint the strip is 2 columns: an odd last tile spans the row so no empty grey cell shows.
  const span = n === 3 ? "max-sm:col-span-2" : "max-md:col-span-2";
  return (
    <section aria-label={label} className={cx("grid grid-cols-2 gap-3 max-md:gap-2", cols, className)}>
      {items.map((k, i) => {
        // A linked tile is one big target (a stretched link), with the ⓘ above it: never a button inside a link.
        const name = k.href ? (
          <Link href={k.href} className="text-ink-soft inline-flex min-h-6 items-center no-underline before:absolute before:inset-0 before:content-['']">
            {k.label}
          </Link>
        ) : (
          k.label
        );
        const hue: Hue = k.hue ?? (alarm(k) ? (k.tone === "bad" ? "red" : "orange") : "blue");
        return (
          <div
            key={k.label}
            className={cx(
              "bg-surface shadow-card relative flex min-w-0 flex-col rounded-lg px-4 py-3",
              k.href && "hover:bg-hover/60 transition-colors",
              n % 2 === 1 && i === n - 1 && span,
            )}
          >
            <span className="text-ink-soft flex min-h-7 items-center gap-2 text-[13px]/[1.4] font-medium">
              {k.icon ? (
                <span aria-hidden="true" className={cx(iconTile, k.value === 0 ? HUE.grey : HUE[hue])}>
                  {k.icon}
                </span>
              ) : (
                <span
                  aria-hidden="true"
                  className={cx("size-2 shrink-0 rounded-full", hue === "red" ? "bg-block" : hue === "orange" ? "bg-warn-fill" : hue === "green" ? "bg-ok-fill" : "bg-accent")}
                />
              )}
              {name}
              {k.info ? (
                <span className="relative z-10">
                  <InfoTip text={k.info} label={k.label} />
                </span>
              ) : null}
            </span>
            <span className="mt-2 flex items-baseline gap-1.5">
              <Value k={k} />
              {k.unit && !blank(k.value) ? <span className="text-ink-2 text-xs">{k.unit}</span> : null}
              {k.delta && !blank(k.value) ? <Delta d={k.delta} value={k.value} /> : null}
            </span>
            {k.spark && k.spark.length > 1 ? <AreaSpark values={k.spark} label={k.label} className="mt-2" /> : null}
          </div>
        );
      })}
    </section>
  );
}
