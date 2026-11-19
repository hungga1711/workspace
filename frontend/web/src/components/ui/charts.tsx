"use client";

import { useId, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { cx } from "@/lib/ui";
import { chartable, firstShown } from "@/lib/metrics";

/*
 * Hand-built SVG charts (no chart library): blue series (a pale blue for the comparison), a deeper blue highlight, hover tooltip, and a hidden
 * data table for screen readers. Sizes are in viewBox units; the SVG scales to its container width.
 */

export interface Datum {
  label: string;
  value: number;
  /** Drawn in the accent colour (the one series or bar that matters). */
  highlight?: boolean;
}

function SrTable({ caption, rows }: { caption: string; rows: { label: string; value: string | number }[] }) {
  return (
    // The wrapper is what is visually hidden: a table ignores sr-only's 1px box and can widen a phone page.
    <div className="sr-only">
      <table>
        <caption>{caption}</caption>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <th scope="row">{r.label}</th>
              <td>{r.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Tip({ x, y, children }: { x: number; y: number; children: React.ReactNode }) {
  return (
    <div
      role="presentation"
      className="border-hairline bg-surface text-ink pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border px-2 py-1 text-xs shadow-sm"
      style={{ left: `${x}%`, top: `${y}%` }}
    >
      {children}
    </div>
  );
}

/** Smooth path through points (monotone-ish cubic, no overshoot below 0). */
function smooth(pts: [number, number][]) {
  if (pts.length < 2) return pts.length ? `M${pts[0]![0]},${pts[0]![1]}` : "";
  let d = `M${pts[0]![0]},${pts[0]![1]}`;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1]!;
    const [x1, y1] = pts[i]!;
    const cx1 = x0 + (x1 - x0) / 2;
    d += ` C${cx1},${y0} ${cx1},${y1} ${x1},${y1}`;
  }
  return d;
}

/** A soft area sparkline: trend at a glance (KPI tiles, table cells). */
export function AreaSpark({ values: all, label, className, highlight }: { values: number[]; label: string; className?: string; highlight?: boolean }) {
  const id = useId();
  // Leading empty periods go (at least four stay); with fewer than three periods with data there is no trend to draw.
  const values = all.slice(firstShown([all]));
  if (!chartable([values])) return null;
  const w = 100;
  const h = 28;
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => [values.length === 1 ? w / 2 : (i / (values.length - 1)) * w, h - 2 - (v / max) * (h - 4)] as [number, number]);
  // Too little data for a curve (fewer than 3 points, or fewer than 3 non-zero days): straight segments and dots,
  // so one busy day does not draw a bell curve.
  const sparse = values.length < 3 || values.filter((v) => v > 0).length < 3;
  const line = sparse ? pts.map(([x, y], i) => `${i ? "L" : "M"}${x},${y}`).join(" ") : smooth(pts);
  const area = pts.length && !sparse ? `${line} L${w},${h} L0,${h} Z` : "";
  const color = highlight ? "var(--accent-text)" : "var(--accent)";
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`${label}: ${values.join(", ")}`}
      aria-describedby={id}
      className={cx("block h-7 w-full overflow-visible", className)}
    >
      {area ? <path d={area} fill={color} fillOpacity={0.08} /> : null}
      <path d={line} fill="none" stroke={color} strokeOpacity={highlight ? 1 : 0.85} strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinecap="round" />
      {sparse ? pts.map(([x, y], i) => (values[i]! > 0 ? <ellipse key={i} cx={x} cy={y} rx={1.4} ry={2} fill={color} fillOpacity={highlight ? 1 : 0.7} /> : null)) : null}
      <desc id={id}>{values.join(", ")}</desc>
    </svg>
  );
}

/**
 * Vertical bars with rounded tops. One or two series: `data` (primary, ink) and optional `compare` (muted),
 * drawn side by side per label. `format` renders the tooltip value.
 */
export function Bars({
  data,
  compare,
  label,
  seriesLabels,
  format = String,
  height = 160,
  sparse,
}: {
  data: Datum[];
  compare?: number[];
  label: string;
  seriesLabels?: [string, string];
  format?: (n: number) => string;
  height?: number;
  /** Said instead of the chart when fewer than three periods have data (default: a generic sentence). */
  sparse?: React.ReactNode;
}) {
  const tr = useT();
  const [hover, setHover] = useState<number | null>(null);
  // Empty leading periods ("nothing happened yet") are dropped, keeping at least four, so a new workspace's
  // first week is not one bar after seven blanks.
  const series = [data.map((d) => d.value), ...(compare ? [compare] : [])];
  const lead = firstShown(series);
  if (lead) {
    data = data.slice(lead);
    compare = compare?.slice(lead);
  }
  // One or two periods with data are not a trend: a sentence says what there is.
  if (!chartable(series)) {
    return (
      <p className="text-ink-2 m-0 text-sm" data-testid="chart-sparse">
        {sparse ?? tr("ui.chartSparse")}
      </p>
    );
  }
  const w = 600;
  const h = height;
  // Axis labels sit under the SVG as HTML text: inside the scaled viewBox they shrank to ~6 px on phones.
  const pad = 4;
  const max = Math.max(1, ...data.map((d) => d.value), ...(compare ?? []));
  const slot = w / Math.max(1, data.length);
  const bw = Math.min(28, slot * (compare ? 0.32 : 0.55));
  const y = (v: number) => h - pad - (v / max) * (h - pad - 6);
  const bar = (x: number, v: number) => {
    const top = y(v);
    const r = Math.min(3, (h - pad - top) / 2);
    return `M${x},${h - pad} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${h - pad} Z`;
  };
  const hv = hover === null ? null : data[hover];
  return (
    <figure className="relative m-0">
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label} className="block h-auto w-full" onMouseLeave={() => setHover(null)}>
        {[0.5, 1].map((f) => (
          <line key={f} x1={0} x2={w} y1={y(max * f)} y2={y(max * f)} stroke="var(--hairline)" strokeDasharray="2 4" />
        ))}
        <line x1={0} x2={w} y1={h - pad} y2={h - pad} stroke="var(--hairline)" />
        {data.map((d, i) => {
          const x0 = i * slot + slot / 2 - (compare ? bw : bw / 2);
          return (
            <g key={d.label} onMouseEnter={() => setHover(i)} className="cursor-default">
              <rect x={i * slot} y={0} width={slot} height={h} fill="transparent" />
              <g className="animate-grow-y" style={{ transformBox: "fill-box", transformOrigin: "bottom", animationDelay: `${i * 30}ms` }}>
                {compare ? <path d={bar(x0 + bw + 2, compare[i] ?? 0)} fill="var(--accent)" fillOpacity={hover === i ? 0.35 : 0.22} /> : null}
                <path
                  d={bar(x0, d.value)}
                  fill={d.highlight ? "var(--accent-text)" : "var(--accent)"}
                  fillOpacity={d.highlight ? 1 : hover === null || hover === i ? 1 : 0.55}
                  className="transition-[fill-opacity] duration-150"
                />
              </g>
            </g>
          );
        })}
      </svg>
      <div className="text-ink-2 mt-1.5 grid text-center text-xs tabular-nums" style={{ gridTemplateColumns: `repeat(${data.length}, minmax(0, 1fr))` }} aria-hidden="true">
        {data.map((d, i) => (
          // Phones: every other label counted back from the last ("Tuần này" always shows), and the shown ones may spill
          // into the hidden neighbours' room ("01/09" whole rather than "01/…"); the last one stays inside the figure.
          <span key={d.label} className={cx("whitespace-nowrap", i === data.length - 1 && "max-sm:justify-self-end", (data.length - 1 - i) % 2 === 1 && "max-sm:invisible")}>
            {d.label}
          </span>
        ))}
      </div>
      {hv && hover !== null ? (
        <Tip x={((hover + 0.5) / data.length) * 100} y={(y(Math.max(hv.value, compare?.[hover] ?? 0)) / h) * 100}>
          <span className="font-medium">{hv.label}</span> · {seriesLabels ? `${seriesLabels[0]} ` : ""}
          <span className="tabular-nums">{format(hv.value)}</span>
          {compare ? (
            <>
              {" "}
              · {seriesLabels ? `${seriesLabels[1]} ` : ""}
              <span className="tabular-nums">{format(compare[hover] ?? 0)}</span>
            </>
          ) : null}
        </Tip>
      ) : null}
      {seriesLabels ? (
        <figcaption className="text-ink-2 mt-2 flex gap-4 text-xs">
          <span className="inline-flex items-center gap-1.5">
            <span className="bg-accent size-2 rounded-sm" aria-hidden="true" />
            {seriesLabels[0]}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="bg-accent/25 size-2 rounded-sm" aria-hidden="true" />
            {seriesLabels[1]}
          </span>
        </figcaption>
      ) : null}
      <SrTable
        caption={`${label} (${tr("ui.chartData")})`}
        rows={data.map((d, i) => ({ label: d.label, value: compare ? `${format(d.value)} / ${format(compare[i] ?? 0)}` : format(d.value) }))}
      />
    </figure>
  );
}

/** Tones a stacked bar or donut part can take; tool colours come from the bòn bon accents. */
export type PartTone = "ink" | "progress" | "accent" | "block" | "warn" | "ok" | "muted" | "sky" | "violet" | "rose" | "tangerine";
const TONE: Record<PartTone, string> = {
  ink: "var(--ink)",
  progress: "var(--progress)",
  accent: "var(--accent)",
  block: "var(--block)",
  warn: "var(--warn-fill)",
  ok: "var(--ok-fill)",
  muted: "var(--selected)",
  sky: "var(--sky)",
  violet: "var(--violet)",
  rose: "var(--rose)",
  tangerine: "var(--tangerine)",
};
export interface Part {
  label: string;
  value: number;
  tone?: PartTone;
}

/** One horizontal bar split into parts, with a legend underneath. */
export function StackBar({ parts, label, format = String, legend = true }: { parts: Part[]; label: string; format?: (n: number) => string; legend?: boolean }) {
  const tr = useT();
  const total = parts.reduce((s, p) => s + p.value, 0) || 1;
  return (
    <figure className="m-0" aria-label={label}>
      <div className="bg-hover flex h-2 w-full gap-0.5 overflow-hidden rounded-full" role="img" aria-label={label}>
        {parts
          .filter((p) => p.value > 0)
          .map((p) => (
            <span
              key={p.label}
              title={`${p.label}: ${format(p.value)}`}
              className="h-full first:rounded-l-full last:rounded-r-full"
              style={{ width: `${(p.value / total) * 100}%`, background: TONE[p.tone ?? "ink"] }}
            />
          ))}
      </div>
      {legend ? (
        <figcaption className="text-ink-2 mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {parts.map((p) => (
            <span key={p.label} className="inline-flex items-center gap-1.5">
              <span className="size-2 rounded-full" style={{ background: TONE[p.tone ?? "ink"] }} aria-hidden="true" />
              {p.label} <span className="text-ink tabular-nums">{format(p.value)}</span>
            </span>
          ))}
        </figcaption>
      ) : null}
      <SrTable caption={`${label} (${tr("ui.chartData")})`} rows={parts.map((p) => ({ label: p.label, value: format(p.value) }))} />
    </figure>
  );
}

/** A thin donut with the total (or a given value) in the middle. */
export function Donut({ parts, label, center, size = 120 }: { parts: Part[]; label: string; center?: React.ReactNode; size?: number }) {
  const tr = useT();
  const [hover, setHover] = useState<number | null>(null);
  const total = parts.reduce((s, p) => s + p.value, 0);
  const r = 15.9155; // circumference 100
  let acc = 0;
  return (
    <figure className="relative m-0 inline-grid place-items-center" style={{ width: size, height: size }}>
      <svg viewBox="0 0 36 36" role="img" aria-label={label} className="size-full -rotate-90" onMouseLeave={() => setHover(null)}>
        <circle cx={18} cy={18} r={r} fill="none" stroke="var(--hover)" strokeWidth={3.2} />
        {total > 0
          ? parts.map((p, i) => {
              const len = (p.value / total) * 100;
              const gap = parts.filter((q) => q.value > 0).length > 1 ? 0.8 : 0;
              const el = (
                <circle
                  key={p.label}
                  cx={18}
                  cy={18}
                  r={r}
                  fill="none"
                  stroke={TONE[p.tone ?? "ink"]}
                  strokeOpacity={hover === null || hover === i ? 1 : 0.35}
                  strokeWidth={hover === i ? 4 : 3.2}
                  strokeDasharray={`${Math.max(0, len - gap)} ${100 - Math.max(0, len - gap)}`}
                  strokeDashoffset={-acc}
                  onMouseEnter={() => setHover(i)}
                  className="transition-[stroke-opacity,stroke-width] duration-150"
                />
              );
              acc += len;
              return p.value > 0 ? el : null;
            })
          : null}
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">
        {hover !== null && parts[hover] ? (
          <div className="px-2">
            <div className="text-ink-2 truncate text-xs">{parts[hover]!.label}</div>
            <div className="text-lg font-semibold tabular-nums">{Math.round((parts[hover]!.value / (total || 1)) * 100)}%</div>
          </div>
        ) : (
          center
        )}
      </div>
      <SrTable caption={`${label} (${tr("ui.chartData")})`} rows={parts.map((p) => ({ label: p.label, value: p.value }))} />
    </figure>
  );
}

/** A slim progress bar with an optional marker (e.g. expected progress by now). */
export function Meter({ value, max = 100, marker, tone = "progress", label }: { value: number; max?: number; marker?: number; tone?: PartTone; label: string }) {
  const pct = Math.max(0, Math.min(100, (value / (max || 1)) * 100));
  return (
    <div className="bg-progress-track relative h-1.5 w-full rounded-full" role="meter" aria-label={label} aria-valuenow={value} aria-valuemin={0} aria-valuemax={max}>
      <span className="animate-grow-x absolute inset-y-0 left-0 origin-left rounded-full transition-[width] duration-500" style={{ width: `${pct}%`, background: TONE[tone] }} />
      {marker !== undefined ? (
        <span className="bg-ink-2 absolute -top-1 h-3.5 w-px" style={{ left: `${Math.max(0, Math.min(100, (marker / (max || 1)) * 100))}%` }} aria-hidden="true" />
      ) : null}
    </div>
  );
}
