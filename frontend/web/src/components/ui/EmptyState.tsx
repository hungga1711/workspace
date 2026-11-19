import { cx } from "@/lib/ui";

/** Hairline marks for the three kinds of empty: all done, nothing yet, filtered out. */
const MARKS = {
  done: (
    <>
      <circle cx="32" cy="32" r="22" />
      <path d="M22 32.5l7 7 13-14" />
      <path d="M8 14l2 2M56 50l-2-2M54 12l-3 3" opacity=".45" />
    </>
  ),
  none: (
    <>
      <rect x="14" y="16" width="36" height="32" rx="6" />
      <path d="M14 26h36M22 34h12M22 40h20" />
      <circle cx="21" cy="21" r=".5" />
      <circle cx="25" cy="21" r=".5" />
    </>
  ),
  filtered: (
    <>
      <path d="M12 16h40l-15 17v13l-10 5V33z" />
      <path d="M46 44l8 8M54 44l-8 8" opacity=".55" />
    </>
  ),
} as const;

/**
 * One empty-state look (copy rule 4): a hairline mark, one line (≤ 8 words), an optional hint and one action.
 * `compact` fits inside a card; the default is a dashed box for a whole section.
 */
export function EmptyState({
  kind = "none",
  title,
  hint,
  action,
  compact,
  className,
}: {
  kind?: keyof typeof MARKS;
  title: string;
  hint?: React.ReactNode;
  action?: React.ReactNode;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div className={cx("flex flex-col items-center text-center", compact ? "px-4 py-6" : "border-hairline rounded-xl border border-dashed px-6 py-12", className)}>
      <svg
        viewBox="0 0 64 64"
        aria-hidden="true"
        className={cx("text-ink-2/70", compact ? "mb-2 size-10" : "mb-3 size-14")}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {MARKS[kind]}
      </svg>
      <p className={cx("text-ink m-0 font-medium", compact ? "text-sm" : "text-base")}>{title}</p>
      {hint ? <p className="text-ink-2 m-0 mt-1 max-w-[42ch] text-sm">{hint}</p> : null}
      {action ? <div className="mt-4 flex justify-center gap-2">{action}</div> : null}
    </div>
  );
}
