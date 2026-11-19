import { routeOf } from "@/lib/links";

/** The reference an error is filed under (C-XXXXXXXX): shown on the error screen, searched in Admin › Lỗi trình duyệt. */
export const mintErrorCode = () => `C-${Math.random().toString(36).slice(2, 10).toUpperCase().padEnd(8, "0")}`;

/** Sends one browser error to /api/client-errors: the route template (ids stripped) for grouping, the real path for the admin. */
let sent = 0;
export function reportClientError(e: {
  message: string;
  stack?: string | undefined;
  componentStack?: string | undefined;
  digest?: string | undefined;
  kind: "uncaught" | "boundary";
}) {
  if (typeof window === "undefined" || sent >= 5) return; // a broken page must not flood the log
  sent++;
  const body = JSON.stringify({ ...e, digest: e.digest ?? mintErrorCode(), route: routeOf(location.pathname), path: location.pathname });
  if (!navigator.sendBeacon?.("/api/client-errors", new Blob([body], { type: "application/json" })))
    void fetch("/api/client-errors", { method: "POST", body, keepalive: true }).catch(() => undefined);
}
