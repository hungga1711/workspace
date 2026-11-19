"use client";

import { useEffect } from "react";
import { reportClientError } from "./report";

/** Error tracking in the browser: uncaught errors and unhandled promise rejections. */
export function ErrorReporter() {
  useEffect(() => {
    const onError = (ev: ErrorEvent) => reportClientError({ message: ev.message || String(ev.error), stack: ev.error?.stack, kind: "uncaught" });
    const onRejection = (ev: PromiseRejectionEvent) => {
      const r = ev.reason as { message?: string; stack?: string; status?: number } | undefined;
      if (r && typeof r.status === "number") return; // API errors are handled (and logged) where they happen
      reportClientError({ message: r?.message ?? String(ev.reason), stack: r?.stack, kind: "uncaught" });
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  return null;
}
