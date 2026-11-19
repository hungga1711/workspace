import { IconTile, type Tone } from "@/components/ui/Bento";
import { CheckIcon } from "@/components/app/icons";
import { cx } from "@/lib/ui";

/*
 * Quản trị's pieces in the Home look: white cards on the canvas drawn by a hairline ring (never a
 * border), each section led by a tinted icon tile, and an empty list as one slim calm line instead of a tall dashed
 * box. Server-safe: server pages and the client admin screens share them.
 */

/** A settings card or a table's frame: white, 12px corners, a hairline ring. */
export const adminCard = "bg-surface rounded-xl shadow-card";
/** A list of rows in one card, split by soft hairlines. */
export const adminList = "bg-surface shadow-card divide-divider-soft m-0 list-none divide-y overflow-hidden rounded-xl p-0";
/** A table's scroll frame (the table inside draws no ring of its own: the frame clips it). */
export const adminTableFrame = "bg-surface shadow-card overflow-x-auto rounded-xl";

/** A section's title row: tinted icon tile, 14px title with one muted line under it, actions on the right. */
export function SectionHead({
  id,
  title,
  sub,
  icon,
  tone = "sky",
  actions,
  className,
}: {
  id?: string;
  title: React.ReactNode;
  sub?: React.ReactNode;
  icon?: React.ReactNode;
  tone?: Tone;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("mb-3 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2", className)}>
      {icon ? <IconTile tone={tone}>{icon}</IconTile> : null}
      <div className="min-w-[min(100%,12rem)] flex-1">
        <h2 id={id} className="m-0 flex items-center gap-1.5 text-sm/6 font-semibold tracking-[-0.01em]">
          {title}
        </h2>
        {sub ? <p className="text-ink-2 m-0 text-[13px]/[1.45]">{sub}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/**
 * Nothing in a list yet: one slim card with a calm mark and one line (a hint under it when there is one), never a
 * tall blank box. `clear` shows the green tick (all done, nothing waiting); otherwise the mark is a quiet grey.
 */
export function CalmEmpty({
  title,
  hint,
  action,
  clear = false,
  className,
}: {
  title: string;
  hint?: React.ReactNode;
  action?: React.ReactNode;
  clear?: boolean;
  className?: string;
}) {
  return (
    <div className={cx(adminCard, "flex min-h-16 min-w-0 flex-wrap items-center gap-x-3.5 gap-y-2 px-5 py-3.5 max-sm:px-4", className)}>
      <span
        aria-hidden="true"
        className={cx("ring-current/15 grid size-6 shrink-0 place-items-center rounded-full ring-1 ring-inset", clear ? "bg-ok-wash text-ok" : "bg-hover text-ink-2")}
      >
        <CheckIcon className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1 leading-[1.35]">
        <span className="block text-sm font-medium">{title}</span>
        {hint ? <span className="text-ink-2 block text-[13px]">{hint}</span> : null}
      </span>
      {action ? <span className="shrink-0">{action}</span> : null}
    </div>
  );
}
