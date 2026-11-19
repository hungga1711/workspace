import { cx } from "@/lib/ui";
import { CheckIcon } from "@/components/app/icons";
import { IconTile, card, type Tone } from "@/components/ui/Bento";

/**
 * A page's opening line in Home's voice: a tight display
 * title that says the one thing worth knowing, an optional quiet line under it, the page's actions on the right.
 * Used by AI's sections, Hồ sơ, Chấm công and Danh bạ. Server-safe. The title is an h2: the page's h1 stays the
 * screen reader's (PageHeader / AiFrame).
 */
export function Intro({ title, sub, actions, id, className }: { title: React.ReactNode; sub?: React.ReactNode; actions?: React.ReactNode; id?: string; className?: string }) {
  return (
    <header className={cx("flex min-w-0 flex-wrap items-end justify-between gap-x-8 gap-y-3", className)}>
      <div className="min-w-[min(100%,18rem)] flex-1">
        <h2 id={id} className="font-display text-ink m-0 text-balance text-[28px]/[1.15] font-semibold tracking-[-0.035em] max-sm:text-2xl/[1.2]">
          {title}
        </h2>
        {sub ? <p className="text-ink-2 m-0 mt-1.5 max-w-3xl text-sm">{sub}</p> : null}
      </div>
      {actions ? <div className="flex min-w-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** A tile's header row: the tone's icon tile, a 14px title, an optional count and whatever sits on the right. */
export function TileHead({ id, icon, title, count, right }: { id: string; icon: React.ReactNode; title: React.ReactNode; count?: React.ReactNode; right?: React.ReactNode }) {
  return (
    <header className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-2">
      {icon}
      <h3 id={id} className="m-0 min-w-0 flex-1 truncate text-sm font-semibold tracking-[-0.01em]">
        {title}
        {count !== undefined && count !== null ? <span className="text-ink-2 ml-2 font-normal tabular-nums">{count}</span> : null}
      </h3>
      {right ? <div className="flex min-w-0 flex-wrap items-center gap-2">{right}</div> : null}
    </header>
  );
}

/** Nothing to show: one slim calm line with a green tick, never a tall empty box. */
export function AllClear({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={cx("text-ink-2 m-0 flex items-center gap-2.5 text-[13px]", className)}>
      <span aria-hidden="true" className="bg-ok-wash text-ok ring-current/15 grid size-6 shrink-0 place-items-center rounded-full ring-1 ring-inset">
        <CheckIcon className="size-3.5" />
      </span>
      {children}
    </p>
  );
}

/** One stat tile: a tinted icon tile and a short label over one big tabular figure (Home's tile figure, smaller). */
export function Stat({
  icon,
  tone,
  label,
  n,
  alert,
  className,
}: {
  icon: React.ReactNode;
  tone: Tone;
  label: string;
  n: React.ReactNode;
  /** A real non-zero problem: the figure turns red. */
  alert?: boolean;
  className?: string;
}) {
  return (
    <div className={cx(card, "flex min-w-0 flex-col rounded-xl p-4 max-sm:p-3.5", className)}>
      <span className="flex min-w-0 items-center gap-2.5">
        <IconTile tone={tone}>{icon}</IconTile>
        <span className="text-ink-2 min-w-0 truncate text-[13px]">{label}</span>
      </span>
      <span className={cx("font-display mt-3 text-[32px]/none font-semibold tabular-nums tracking-[-0.045em] max-sm:text-[28px]/none", alert ? "text-block" : "text-ink")}>
        {n}
      </span>
    </div>
  );
}
