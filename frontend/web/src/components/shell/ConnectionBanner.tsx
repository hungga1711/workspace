"use client";

import { useEffect, useState } from "react";
import { useConnection } from "@/lib/connection";
import { useT } from "@/lib/i18n/client";
import { CloudOffIcon } from "@/components/app/icons";
import { cx } from "@/lib/ui";

/**
 * A dark (inverted) bar just under the top bar while the app cannot reach the server, or after the session ended: the
 * one strong mark on a quiet screen, so it is noticed. It floats over the top edge of the content (nothing moves, the
 * screen stays as it was) and stays with the top bar. Same in the
 * browser and the desktop app.
 *
 * Offline, a link to another screen would fail (the router falls back to a full page load, which shows the browser's
 * or the webview's error page instead of the app), so links stay put and the bar says why.
 */
export function ConnectionBanner() {
  const c = useConnection();
  const t = useT();
  const [nudge, setNudge] = useState(0);
  useEffect(() => {
    if (c !== "offline") return;
    const hold = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]");
      if (!(a instanceof HTMLAnchorElement) || a.target === "_blank" || a.hasAttribute("download") || a.origin !== location.origin) return;
      if (a.pathname === location.pathname && a.search === location.search) return;
      // Capture on document runs before React's handlers on the root, so the router never starts the navigation.
      e.preventDefault();
      e.stopPropagation();
      setNudge((n) => n + 1);
    };
    document.addEventListener("click", hold, true);
    return () => document.removeEventListener("click", hold, true);
  }, [c]);
  if (c === "ok") return null;
  const signIn = `/login?next=${encodeURIComponent(typeof location === "undefined" ? "/app/home" : location.pathname + location.search)}`;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="connection-banner"
      className="bg-ink text-surface shadow-popover absolute inset-x-0 top-full flex min-h-8 items-center justify-center gap-2 px-4 py-1 text-center text-[13px] font-medium print:hidden"
    >
      {c === "expired" ? (
        <>
          <span>{t("ui.connection.expired")}</span>
          <a href={signIn} className="text-surface font-semibold underline underline-offset-2">
            {t("ui.connection.signIn")}
          </a>
        </>
      ) : (
        <>
          <CloudOffIcon className="size-4 shrink-0" />
          {/* Re-keyed on each held click: the line fades in again, so the click visibly answered. */}
          <span key={nudge} className={cx(nudge > 0 && "motion-safe:animate-pop")}>
            {t(c === "offline" ? "ui.connection.offline" : "ui.connection.lost")}
          </span>
        </>
      )}
    </div>
  );
}
