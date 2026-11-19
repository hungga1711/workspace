"use client";

import { useRouter } from "next/navigation";
import { useMemo } from "react";

/**
 * Prefetch on intent: the main destinations are not prefetched with every page view (each would render
 * on the server for nothing), so before this a click waited for the server before anything changed. A pointer
 * resting on a link, a keyboard focus or a touch start comes 100–300 ms before the click; fetching the route's frame
 * then (its layouts down to its loading skeleton, router kind "auto", nothing of the page's data) lets the click
 * show the next screen's skeleton at once. Next dedupes repeated prefetches of one URL.
 */
export function useIntentPrefetch() {
  const router = useRouter();
  return useMemo(() => {
    const go = (href: string) => {
      try {
        // "auto": Next's own PrefetchKind.AUTO, which the public type does not export.
        router.prefetch(href, { kind: "auto" as never });
      } catch {
        /* a prefetch is only ever a head start */
      }
    };
    return (href: string) => ({
      onPointerEnter: () => go(href),
      onFocus: () => go(href),
      onTouchStart: () => go(href),
    });
  }, [router]);
}
