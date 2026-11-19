"use client";

import { cx } from "@/lib/ui";
import { FlagIcon } from "@/components/app/icons";
import { useFormat } from "@/lib/i18n/client";

/** Status pill: neutral tints only; amber stays reserved for "needs you" (DESIGN.md). */
const STATUS_TONE: Record<string, string> = {
  todo: "bg-hover text-ink-2",
  in_progress: "bg-accent-wash text-accent-text",
  review: "bg-tint-3 text-ink",
  done: "bg-ok-wash text-ok",
  cancelled: "bg-hover text-ink-2 line-through",
  pending: "bg-hover text-ink",
  approved: "bg-ok-wash text-ok",
  rejected: "bg-block-wash text-block",
  draft: "bg-hover text-ink-2",
  published: "bg-ok-wash text-ok",
};
const REVIEW_STATES = ["pending", "approved", "rejected", "draft", "published"] as const;

export function StatusPill({ status }: { status: string }) {
  const f = useFormat();
  const text = (REVIEW_STATES as readonly string[]).includes(status) ? f.t(`ui.status.${status as (typeof REVIEW_STATES)[number]}`) : f.status(status);
  return <span className={cx("inline-flex shrink-0 items-center rounded-md px-2 py-0.5 text-xs font-medium", STATUS_TONE[status] ?? "bg-hover text-ink-2")}>{text}</span>;
}

/** Priority: urgent/high are text in block red with a flag mark; lower ones stay quiet. */
export function PriorityTag({ priority }: { priority: string }) {
  const f = useFormat();
  if (priority !== "urgent" && priority !== "high") return <span className="text-ink-2 text-xs">{f.priority(priority)}</span>;
  return (
    // Red stays for urgent (and for blocked/overdue elsewhere); high reads in ink so red keeps its meaning.
    <span className={cx("inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium", priority === "urgent" ? "text-block" : "text-ink")}>
      <FlagIcon className={cx("size-3", priority === "urgent" && "fill-current")} aria-hidden="true" />
      {f.priority(priority)}
    </span>
  );
}

/** Blocked tasks carry the reason as a tooltip and accessible label. */
export function BlockedTag({ reason }: { reason: string | null | undefined }) {
  const { t } = useFormat();
  if (!reason) return null;
  return (
    <span title={reason} aria-label={t("ui.blockedReason", { reason })} className="text-ink-soft inline-flex shrink-0 items-center gap-1.5 text-xs">
      {/* Status reads as a red dot + quiet word (like every other status), not red text; the reason is the tooltip. */}
      <span className="bg-block size-1.5 rounded-full" aria-hidden="true" />
      {t("ui.blocked")}
    </span>
  );
}

/** Label colours: the same label always gets the same colour, picked from the "bòn bon" accents. */
const LABEL_TONES = [
  "bg-sky-wash text-sky-text",
  "bg-rose-wash text-rose-text",
  "bg-accent-wash text-accent-text",
  "bg-tangerine-wash text-tangerine-text",
  "bg-violet-wash text-violet-text",
  "bg-brand-wash text-brand-text",
];

export function Label({ children }: { children: React.ReactNode }) {
  const key = typeof children === "string" ? children.toLowerCase() : "";
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return <span className={`${LABEL_TONES[h % LABEL_TONES.length]} inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium`}>{children}</span>;
}

export function Empty({ title, children, action, icon }: { title: string; children?: React.ReactNode; action?: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div className="border-hairline rounded-xl border border-dashed px-6 py-10 text-center">
      {icon ? <div className="border-hairline bg-surface text-ink-2 mx-auto mb-3 grid size-10 place-items-center rounded-lg border [&_svg]:size-5">{icon}</div> : null}
      <p className="font-medium">{title}</p>
      {children ? <p className="text-ink-2 mx-auto mt-1 max-w-[46ch]">{children}</p> : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

export function PageHead({ title, sub, actions }: { title: string; sub?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <header className="mb-4 flex flex-wrap items-end gap-3">
      {/* The title keeps at least 16rem; on a phone the actions wrap below it instead of squeezing it. */}
      <div className="min-w-0 flex-[1_1_16rem]">
        <h1 className="font-display text-xl/tight font-semibold tracking-[-0.01em]">{title}</h1>
        {sub ? <p className="text-ink-2 mt-1 text-sm">{sub}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string | null; children: React.ReactNode }) {
  return (
    <label className="grid min-w-0 content-start gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {error ? <span className="text-block text-xs">{error}</span> : hint ? <span className="text-ink-2 text-xs">{hint}</span> : null}
    </label>
  );
}
