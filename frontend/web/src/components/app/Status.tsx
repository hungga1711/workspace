"use client";

import { useT } from "@/lib/i18n/client";
import { isDnd, useStatus } from "@/lib/status";
import { cx } from "@/lib/ui";
import { MoonIcon } from "./icons";

export function StatusBadge({ userId, className }: { userId: string; className?: string }) {
  const { get } = useStatus();
  const t = useT();
  const s = get(userId);
  if (!s) return null;
  const dnd = isDnd(s);
  const label = [s.text, dnd ? t("status.dnd") : ""].filter(Boolean).join(" · ");
  if (!s.emoji && !dnd && !s.text) return null;
  return (
    <span className={cx("inline-flex shrink-0 items-center gap-0.5 text-sm leading-none", className)} title={label} aria-label={label} role="img">
      {s.emoji ? <span aria-hidden="true">{s.emoji}</span> : null}
      {dnd ? <MoonIcon className="text-ink-2 size-3.5" aria-hidden="true" /> : null}
    </span>
  );
}
