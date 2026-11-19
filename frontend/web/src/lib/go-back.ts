import type { useRouter } from "next/navigation";

/**
 * Back to the previous screen, or to `fallback` when there is none (a meeting opened in its own window, a link
 * opened from outside). On its own so the meeting page, which ships only its own strings, does not pull in the
 * desktop app's Back and Forward buttons.
 */
export function goBack(router: ReturnType<typeof useRouter>, fallback = "/app/home") {
  if (window.history.length > 1) router.back();
  else router.push(fallback);
}
