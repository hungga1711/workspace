import Link from "next/link";
import { ArrowRightIcon, ClockIcon } from "@/components/app/icons";
import { cx } from "@/lib/ui";

/**
 * Home's "Chấm công hôm nay": where today stands at a glance, beside the greeting. Status only: the
 * button that clocks in or out stays in the top bar, one per screen; this links to the history on Thời gian.
 */
export function AttendanceToday({ state, title, detail, link }: { state: "none" | "in" | "done"; title: string; detail: string | null; link: string }) {
  return (
    <Link
      href="/app/time"
      className="bg-surface shadow-card hover:shadow-lift ease-out-soft group flex min-w-0 items-center gap-3 rounded-xl px-4 py-3 no-underline transition-shadow duration-300 max-sm:w-full"
    >
      <span
        aria-hidden="true"
        className={cx(
          "relative grid size-9 shrink-0 place-items-center rounded-md",
          state === "none" ? "bg-warn-wash text-warn" : state === "in" ? "bg-ok-wash text-ok" : "bg-hover text-ink-2",
        )}
      >
        <ClockIcon className="size-[18px]" />
        {state === "in" ? <span className="bg-ok ring-surface absolute -right-0.5 -top-0.5 size-2.5 rounded-full ring-2" /> : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cx("block truncate text-sm font-semibold", state === "none" ? "text-warn" : "text-ink")}>{title}</span>
        <span className="text-ink-2 block truncate text-xs tabular-nums">{detail ?? link}</span>
      </span>
      <ArrowRightIcon aria-hidden="true" className="text-ink-2 group-hover:text-ink size-4 shrink-0 transition-transform duration-200 group-hover:translate-x-0.5" />
    </Link>
  );
}
