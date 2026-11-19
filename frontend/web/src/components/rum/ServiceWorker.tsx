"use client";

import { useEffect } from "react";

/**
 * Registers /sw.js in production so the installed app shows an offline page and reuses cached
 * build assets. Push subscription (lib/push.ts) reuses the same registration.
 */
export function ServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    // The dev server never runs a worker; drop one a production build left on the same origin (localhost).
    if (process.env.NODE_ENV !== "production") {
      void navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => void r.unregister()));
      return;
    }
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }, []);
  return null;
}
