import { card, cx } from "@/lib/ui";
import type { Hue } from "@/lib/hue";
import { CheckIcon } from "@/components/app/icons";
import { IconTile, type Tone } from "@/components/ui/Bento";

/*
 * Tiến độ's shared pieces. Every block on the four tabs is the same white
 * 1px-ring panel with the same header:
 * a tinted icon, a 15px title, a round count, and anything else on the right. Inside a list, a state is a dot and
 * quiet text (`HealthText`), never a coloured lozenge: with a whole company behind schedule, lozenges on every row
 * made the page red from top to bottom and nothing stood out. Red is kept for the figure that is the problem.
 */

export const panel = `${card} min-w-0 p-4`;

export function PanelHead({
  id,
  title,
  count,
  icon,
  tone,
  children,
  className,
}: {
  id?: string;
  /** Kept for callers; the flat header draws no tile. */
  hue?: Hue;
  icon?: React.ReactNode;
  /** With `icon`: leads the title with Home's tinted icon tile. Without it the header stays flat. */
  tone?: Tone;
  title: React.ReactNode;
  count?: number | string;
  /** Right side: a link, a filter, a legend. */
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={cx("mb-3 flex flex-wrap items-center gap-x-2.5 gap-y-2", !!(tone && icon) && "mb-4 min-h-8 gap-x-3", className)}>
      {tone && icon ? <IconTile tone={tone}>{icon}</IconTile> : null}
      <h2 id={id} className={cx("text-ink m-0 scroll-mt-16 text-sm", tone && icon ? "font-semibold tracking-[-0.01em]" : "font-medium")}>
        {title}
      </h2>
      {count !== undefined ? <span className="text-ink-2 text-xs tabular-nums">{count}</span> : null}
      {children ? <div className="ml-auto flex min-w-0 flex-wrap items-center gap-2">{children}</div> : null}
    </header>
  );
}

export type HealthKind = "ok" | "risk" | "late" | "none";
const DOT: Record<HealthKind, string> = { ok: "bg-ok-fill", risk: "bg-warn-fill", late: "bg-block", none: "bg-edge" };

/** A state in a row: a coloured dot and the words in quiet ink. */
export function HealthText({ kind, children, className, title }: { kind: HealthKind; children: React.ReactNode; className?: string; title?: string }) {
  return (
    <span className={cx("text-ink-soft inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs", className)} title={title}>
      <span aria-hidden="true" className={cx("size-2 shrink-0 rounded-full", DOT[kind])} />
      {children}
    </span>
  );
}

/**
 * A calm empty state for Work's views (Home's quiet strip): one slim card, never a tall dashed box. A
 * tinted icon tile (a green tick when all is clear), the title, one quiet line, and the one action on the right.
 */
export function SlimEmpty({
  title,
  children,
  action,
  icon,
  tone = "green",
  className,
}: {
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
  /** Defaults to a tick (all clear). */
  icon?: React.ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <div className={cx("bg-surface shadow-card flex min-h-[4.75rem] min-w-0 flex-wrap items-center gap-x-3.5 gap-y-3 rounded-xl px-5 py-4 max-sm:px-4", className)}>
      <IconTile tone={tone}>{icon ?? <CheckIcon />}</IconTile>
      <span className="min-w-[min(100%,14rem)] flex-1 leading-[1.35]">
        <span className="text-ink block text-sm font-semibold tracking-[-0.01em]">{title}</span>
        {children ? <span className="text-ink-2 block text-[13px]">{children}</span> : null}
      </span>
      {action ? <span className="flex shrink-0 items-center gap-2">{action}</span> : null}
    </div>
  );
}

/** Work's page title row (Home's): a tight display title. */
export function HeadTitle({ title, as: Tag = "p", hidden, className }: { title: React.ReactNode; as?: "h1" | "h2" | "p"; hidden?: boolean; className?: string }) {
  return (
    <div className={cx("min-w-0", className)}>
      <Tag aria-hidden={hidden || undefined} className="font-display text-ink m-0 text-balance text-[28px]/[1.15] font-semibold tracking-[-0.035em] max-sm:text-2xl/[1.2]">
        {title}
      </Tag>
    </div>
  );
}

export interface Stat {
  label: string;
  value: React.ReactNode;
  icon: React.ReactNode;
  tone: Tone;
  /** The figure is the problem (red); only for a real non-zero problem. */
  alert?: boolean;
  /** A zero or nothing to say: grey icon tile and a muted figure. */
  quiet?: boolean;
  title?: string;
}

/**
 * A strip of headline figures (Home's quiet strip): cells split by hairlines in one card, each a tinted
 * icon tile, a short label and one big tabular figure. Two across on phones, all across from 640px.
 */
export function StatStrip({ items, label, className }: { items: Stat[]; label: string; className?: string }) {
  const cols = items.length >= 5 ? "md:grid-cols-5" : items.length === 4 ? "sm:grid-cols-4" : items.length === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2";
  return (
    <section aria-label={label} className={cx("bg-hairline shadow-card stagger grid grid-cols-2 gap-px overflow-hidden rounded-xl", cols, className)}>
      {items.map((s, i) => (
        // Two across on phones: an odd last cell takes the whole row rather than leaving a grey hole.
        <div
          key={s.label}
          title={s.title}
          className={cx(
            "bg-surface flex min-w-0 flex-col gap-3 px-5 py-4 max-sm:gap-2 max-sm:px-4 max-sm:py-3",
            items.length % 2 === 1 && i === items.length - 1 && (items.length >= 5 ? "max-md:col-span-2" : "max-sm:col-span-2"),
          )}
        >
          <span className="flex min-w-0 items-center gap-2.5">
            <IconTile tone={s.tone} className={cx("size-7 rounded-lg [&_svg]:size-3.5", s.quiet && "bg-hover text-ink-2")}>
              {s.icon}
            </IconTile>
            <span className="text-ink-2 line-clamp-3 text-[13px] leading-tight">{s.label}</span>
          </span>
          <span
            className={cx(
              "font-display text-[30px]/none font-semibold tabular-nums tracking-[-0.045em] max-sm:text-[26px]/none",
              s.alert ? "text-block" : s.quiet ? "text-ink-2" : "text-ink",
            )}
          >
            {s.value}
          </span>
        </div>
      ))}
    </section>
  );
}
