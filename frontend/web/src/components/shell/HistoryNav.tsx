"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/i18n/client";
import { ChevronLeftIcon, ChevronRightIcon } from "@/components/app/icons";
import { goBack } from "@/lib/go-back";
import { btnGhost, btnSm, cx } from "@/lib/ui";

/** Inside the desktop app (frontend/desktop), which has no browser toolbar. False on the server and the first render. */
export function useDesktopApp() {
  const [desktop, setDesktop] = useState(false);
  useEffect(() => setDesktop("__TAURI_INTERNALS__" in window), []);
  return desktop;
}

/**
 * Back and Forward for the desktop app: a browser has its own buttons, the app's window does not, and
 * some screens have no other way back. Renders nothing in a browser.
 */
export function HistoryNav({ className }: { className?: string }) {
  const desktop = useDesktopApp();
  const router = useRouter();
  const t = useT();
  if (!desktop) return null;
  const icon = cx(btnGhost, btnSm, "text-ink-2 w-7 shrink-0 justify-center px-0");
  return (
    <span className={cx("flex shrink-0 items-center gap-0.5", className)}>
      <button type="button" className={icon} onClick={() => goBack(router)} title={t("shell.top.back")} aria-label={t("shell.top.back")}>
        <ChevronLeftIcon className="size-4" />
      </button>
      <button type="button" className={icon} onClick={() => router.forward()} title={t("shell.top.forward")} aria-label={t("shell.top.forward")}>
        <ChevronRightIcon className="size-4" />
      </button>
    </span>
  );
}
