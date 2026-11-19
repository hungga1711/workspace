import { cx } from "@/lib/ui";

/**
 * The one mark for a task or person's state, 8px, told apart by shape as well as colour (WCAG 1.4.1: red and amber
 * look alike to many people): ● late (red circle), ▲ at risk (amber triangle), ■ blocked (red square),
 * ● done/on track (green), ● nothing to report (grey). Always beside a word or a number that says the same; the mark
 * is decoration (aria-hidden). A plain server-safe component: views anywhere (Home, Tiến độ, lists) reuse it.
 */
export type StatusKind = "late" | "risk" | "blocked" | "ok" | "muted";

const SHAPE: Record<StatusKind, string> = {
  late: "bg-block rounded-full",
  risk: "bg-warn [clip-path:polygon(50%_0,100%_100%,0_100%)]",
  blocked: "bg-block rounded-[1.5px]",
  ok: "bg-ok rounded-full",
  muted: "bg-ink-2/40 rounded-full",
};

/** Class names only, for places that draw the mark on an existing element. */
const statusMark = (kind: StatusKind) => cx("inline-block size-2 shrink-0", SHAPE[kind]);

export function StatusMark({ kind, className }: { kind: StatusKind; className?: string }) {
  return <span aria-hidden="true" className={cx(statusMark(kind), className)} />;
}
