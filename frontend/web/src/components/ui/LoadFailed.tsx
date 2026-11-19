"use client";

import { useRouter } from "next/navigation";
import { InfoIcon } from "@/components/app/icons";
import { useT } from "@/lib/i18n/client";
import { cx } from "@/lib/ui";

/**
 * Stands in for a section whose read failed, so one flaky side list says so instead of crashing the page or passing
 * for an empty list. Retry re-runs the server reads without a full reload.
 */
export function LoadFailed({
  what,
  className,
  onRetry,
}: {
  what?: string;
  className?: string;
  /** Client-fetched sections retry their own read instead of refreshing the page. */ onRetry?: () => void;
}) {
  const t = useT();
  const router = useRouter();
  return (
    <p role="status" className={cx("text-ink-2 flex items-center gap-1.5 text-sm", className)}>
      <InfoIcon className="size-4 shrink-0" />
      <span className="min-w-0">
        {what ? `${what}: ` : null}
        {t("ui.loadFailed.body")}
      </span>
      <button
        type="button"
        onClick={() => (onRetry ? onRetry() : router.refresh())}
        className="text-ink hover:text-signal shrink-0 whitespace-nowrap font-medium underline-offset-2 hover:underline"
      >
        {t("common.retry")}
      </button>
    </p>
  );
}
