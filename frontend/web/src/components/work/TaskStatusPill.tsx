import { cx } from "@/lib/ui";

/**
 * A task's status as a soft tinted pill, the one look for status everywhere. Colour carries the
 * status, no dot or ring icon (they clutter the page). Done is green, review amber,
 * in progress blue, to do neutral, cancelled muted and struck through.
 */
export function statusTone(status: string) {
  return status === "done"
    ? "bg-ok-wash text-ok"
    : status === "in_progress"
      ? "bg-accent-wash text-accent-text"
      : status === "review"
        ? "bg-warn-wash text-warn"
        : status === "cancelled"
          ? "bg-ink/[0.04] text-ink-2 line-through decoration-ink-2/60"
          : "bg-ink/[0.06] text-ink-soft";
}

export function TaskStatusPill({ status, label, size = "sm", className }: { status: string; label: string; size?: "sm" | "md"; className?: string }) {
  return (
    <span
      className={cx(
        "inline-flex shrink-0 items-center whitespace-nowrap font-medium",
        size === "md" ? "h-7 rounded-full px-2.5 text-[13px]" : "h-5 rounded-md px-1.5 text-xs",
        statusTone(status),
        className,
      )}
    >
      {label}
    </span>
  );
}
