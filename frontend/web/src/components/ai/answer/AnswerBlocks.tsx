"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bars } from "@/components/ui/charts";
import { useFormat } from "@/lib/i18n/client";
import { cx } from "@/lib/ui";
import type { AnswerBlock, ChartBlock, Drill, TableBlock } from "./types";

/**
 * An answer's charts and tables, drawn with the app's own SVG charts (components/ui/charts), no chart
 * library. A bar or a row with somewhere to go opens that screen, or puts a follow-up question in the composer.
 */
export function AnswerBlocks({ blocks, onAsk }: { blocks: AnswerBlock[]; onAsk?: ((text: string) => void) | undefined }) {
  if (!blocks.length) return null;
  return (
    <div className="mt-3 grid min-w-0 gap-3">
      {blocks.map((b) => (
        <figure key={b.id} className="border-hairline bg-surface m-0 min-w-0 rounded-xl border p-3" data-block={b.kind}>
          {b.title ? <figcaption className="text-ink mb-2 text-[13px] font-medium">{b.title}</figcaption> : null}
          {b.kind === "table" ? <Table block={b} onAsk={onAsk} /> : b.chart === "trend" ? <Trend block={b} /> : <HBars block={b} onAsk={onAsk} />}
        </figure>
      ))}
    </div>
  );
}

const unitOf = (b: ChartBlock, n: string) => (b.unit === "$" ? `$${n}` : b.unit ? `${n}${b.unit}` : n);

/** Periods in order: the app's bar chart, the second series (added) beside the first (done). */
function Trend({ block }: { block: ChartBlock }) {
  const fmt = useFormat();
  const compare = block.rows.some((r) => r.compare !== undefined) ? block.rows.map((r) => r.compare ?? 0) : undefined;
  return (
    <Bars
      data={block.rows.map((r) => ({ label: r.label, value: r.value, ...(r.highlight ? { highlight: true } : {}) }))}
      {...(compare ? { compare } : {})}
      {...(block.series && compare ? { seriesLabels: block.series } : {})}
      label={block.title}
      height={120}
      format={(n) => unitOf(block, fmt.number(n))}
    />
  );
}

/** Where a drill goes: a link to a screen, a button that asks, or plain content. */
function DrillTo({
  drill,
  onAsk,
  className,
  children,
  label,
}: {
  drill?: Drill | undefined;
  onAsk?: ((text: string) => void) | undefined;
  className: string;
  children: React.ReactNode;
  label?: string;
}) {
  if (drill?.url)
    return (
      <Link href={drill.url} className={cx(className, "hover:bg-hover focus-visible:bg-hover no-underline")} aria-label={label}>
        {children}
      </Link>
    );
  if (drill?.ask && onAsk)
    return (
      <button type="button" className={cx(className, "hover:bg-hover focus-visible:bg-hover text-left")} onClick={() => onAsk(drill.ask!)} title={drill.ask} aria-label={label}>
        {children}
      </button>
    );
  return <div className={className}>{children}</div>;
}

/** Categories (people, departments, models), one row each: the label, a bar to scale and the figure. */
function HBars({ block, onAsk }: { block: ChartBlock; onAsk?: ((text: string) => void) | undefined }) {
  const fmt = useFormat();
  const max = Math.max(1, ...block.rows.map((r) => Math.max(r.value, r.compare ?? 0)));
  const two = block.rows.some((r) => r.compare !== undefined);
  return (
    <>
      <ul className="m-0 grid list-none gap-0.5 p-0" aria-label={block.title}>
        {block.rows.map((r, i) => (
          <li key={`${r.label}-${i}`} className="min-w-0">
            <DrillTo
              drill={r.drill}
              onAsk={onAsk}
              label={`${r.label}: ${unitOf(block, fmt.number(r.value))}`}
              className="text-ink grid w-full min-w-0 grid-cols-[minmax(0,9rem)_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-1.5 py-1 text-xs max-sm:grid-cols-[minmax(0,6.5rem)_minmax(0,1fr)_auto]"
            >
              <span className={cx("truncate", r.highlight && "font-medium")}>{r.label}</span>
              <span className="grid gap-0.5" aria-hidden="true">
                <span className="bg-ink/[0.05] block h-2 overflow-hidden rounded-full">
                  <span className={cx("block h-full rounded-full", r.highlight ? "bg-accent-text" : "bg-accent")} style={{ width: `${(r.value / max) * 100}%` }} />
                </span>
                {two ? (
                  <span className="block h-1 overflow-hidden rounded-full">
                    <span className="bg-accent/30 block h-full rounded-full" style={{ width: `${((r.compare ?? 0) / max) * 100}%` }} />
                  </span>
                ) : null}
              </span>
              <span className="text-ink-soft text-right tabular-nums">
                {unitOf(block, fmt.number(r.value))}
                {two ? <span className="text-ink-2"> · {fmt.number(r.compare ?? 0)}</span> : null}
              </span>
            </DrillTo>
          </li>
        ))}
      </ul>
      {block.series && two ? (
        <p className="text-ink-2 m-0 mt-2 flex gap-4 text-xs">
          <span className="inline-flex items-center gap-1.5">
            <span className="bg-accent size-2 rounded-sm" aria-hidden="true" />
            {block.series[0]}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="bg-accent/30 size-2 rounded-sm" aria-hidden="true" />
            {block.series[1]}
          </span>
        </p>
      ) : null}
    </>
  );
}

/** Rows and columns; a row with somewhere to go opens it (its first cell is the link, for keyboards and readers). */
function Table({ block, onAsk }: { block: TableBlock; onAsk?: ((text: string) => void) | undefined }) {
  const { t, number } = useFormat();
  const router = useRouter();
  const cell = (v: string | number | null) => (v === null ? "–" : typeof v === "number" ? number(v) : v);
  const [first, ...rest] = block.columns;
  if (!first) return null;
  return (
    <div className="-mx-3 overflow-x-auto px-3">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="text-ink-2 border-hairline border-b">
            {block.columns.map((c) => (
              <th key={c.key} scope="col" className={cx("whitespace-nowrap px-1.5 py-1.5 font-medium", c.num ? "text-right" : "text-left")}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((r, i) => (
            <tr
              key={i}
              className={cx("border-divider border-b last:border-0", (r.drill?.url || (r.drill?.ask && onAsk)) && "hover:bg-hover cursor-pointer")}
              onClick={(e) => {
                // The first cell's own link or button handles its click; elsewhere the row stands for it.
                if ((e.target as HTMLElement).closest("a,button")) return;
                if (r.drill?.url) router.push(r.drill.url);
                else if (r.drill?.ask && onAsk) onAsk(r.drill.ask);
              }}
            >
              <th scope="row" className={cx("max-w-[16rem] px-1.5 py-1.5 text-left font-normal", r.highlight && "font-medium")}>
                {r.drill?.url ? (
                  <Link href={r.drill.url} className="text-ink line-clamp-2 no-underline hover:underline">
                    {cell(r.cells[first.key] ?? null)}
                  </Link>
                ) : r.drill?.ask && onAsk ? (
                  <button type="button" className="text-ink line-clamp-2 text-left hover:underline" onClick={() => onAsk(r.drill!.ask!)} title={r.drill.ask}>
                    {cell(r.cells[first.key] ?? null)}
                  </button>
                ) : (
                  <span className="line-clamp-2">{cell(r.cells[first.key] ?? null)}</span>
                )}
              </th>
              {rest.map((c) => (
                <td
                  key={c.key}
                  className={cx("text-ink-soft whitespace-nowrap px-1.5 py-1.5", c.num ? "text-right tabular-nums" : "text-left", r.highlight && c.num && "text-ink font-medium")}
                >
                  {cell(r.cells[c.key] ?? null)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {block.more ? <p className="text-ink-2 m-0 mt-1.5 text-xs">{t("aiw.answer.moreRows", { count: block.more })}</p> : null}
    </div>
  );
}
