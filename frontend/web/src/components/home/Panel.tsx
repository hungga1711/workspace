import { cx } from "@/lib/ui";

/**
 * One frame for every Home widget: a hairline-bordered surface card (8px radius), with the title, an optional count and the actions on one
 * quiet header row. Same frame everywhere so Home reads as one calm surface.
 */
export function Panel({
  id,
  title,
  count,
  action,
  children,
  flush = false,
  className,
}: {
  id: string;
  title: React.ReactNode;
  count?: number;
  action?: React.ReactNode;
  children: React.ReactNode;
  /** Body without padding, for edge-to-edge lists. */
  flush?: boolean;
  className?: string;
}) {
  return (
    <section aria-labelledby={id} className={cx("bg-surface border-hairline min-w-0 overflow-hidden rounded-lg border", className)}>
      <header className="flex min-h-12 items-center gap-2 px-4 pb-1 pt-3 sm:px-5">
        <h2 id={id} className="min-w-0 truncate text-sm font-semibold">
          {title}
        </h2>
        {count !== undefined ? <span className="bg-hover text-ink-2 rounded-md px-1.5 text-xs font-medium tabular-nums">{count}</span> : null}
        {action ? <div className="ml-auto flex shrink-0 items-center gap-2 text-sm">{action}</div> : null}
      </header>
      <div className={flush ? "pb-2" : "px-5 pb-5 pt-1"}>{children}</div>
    </section>
  );
}
