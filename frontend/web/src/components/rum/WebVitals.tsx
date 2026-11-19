"use client";

import { useReportWebVitals } from "next/web-vitals";
import { usePathname } from "next/navigation";
import { routeOf } from "@/lib/links";

const SENT = new Set(["LCP", "INP", "CLS", "TTFB", "FCP"]);

/** Real User Monitoring: LCP, INP, CLS, TTFB, FCP per route, device and network. */
export function WebVitals() {
  const path = usePathname();
  useReportWebVitals((m) => {
    // Next also reports its own timings (Next.js-hydration, -render…); the sink accepts Core Web Vitals only.
    if (!SENT.has(m.name)) return;
    const nav = navigator as Navigator & { connection?: { effectiveType?: string } };
    const body = JSON.stringify({
      name: m.name,
      value: Math.round(m.name === "CLS" ? m.value * 1000 : m.value),
      rating: m.rating,
      id: m.id,
      // Route template, not the raw URL: no ids or user data leave the browser.
      route: routeOf(path),
      device: matchMedia("(max-width: 767px)").matches ? "mobile" : "desktop",
      network: nav.connection?.effectiveType ?? "unknown",
    });
    if (!navigator.sendBeacon?.("/api/rum", body)) void fetch("/api/rum", { method: "POST", body, keepalive: true });
  });
  return null;
}
