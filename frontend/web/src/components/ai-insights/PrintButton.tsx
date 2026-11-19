"use client";

import { useT } from "@/lib/i18n/client";
import { btnPrimary, btnSm, cx } from "@/lib/ui";
import { DownloadIcon } from "@/components/app/icons";

/** The browser's print dialog, which also saves the one-page report as PDF (no PDF library shipped). */
export function PrintButton() {
  const t = useT();
  return (
    <button type="button" className={cx(btnPrimary, btnSm, "print:hidden")} onClick={() => window.print()}>
      <DownloadIcon className="size-4" />
      {t("aiInsights.report.print")}
    </button>
  );
}
