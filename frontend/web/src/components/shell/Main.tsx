"use client";

import { usePathname, useSelectedLayoutSegments } from "next/navigation";
import { useRef } from "react";
import { cx } from "@/lib/ui";
import { workTabOf } from "@/components/work/workTabAlias";

/** Chat conversations and a whiteboard use the full height edge to edge; every other screen gets the page column. */
export const fullBleed = (path: string) => path.startsWith("/app/chat/") || path.startsWith("/app/ai/ask") || path.startsWith("/app/work/whiteboards/");
/** A document page reads as paper: white edge to edge instead of the grey canvas under cards. */
const paper = (path: string) => /^\/app\/work\/docs\/[^/]+/.test(path);
/** The page column: 24px sides on desktop, 16px on phones; content starts 16px (phones) / 20px (desktop) under the
 * top bar and pages add no top padding of their own. */
// 1600px: narrower, every table, board and report sits in a strip with empty sides on a wide screen.
const pageColumn = "mx-auto w-full max-w-[1600px] px-4 md:px-7";
/** The calendar keeps the whole width : a week of seven columns wants every pixel it can get. */
const wide = (path: string) => workTabOf(path) === "calendar";

/**
 * The content. Full-bleed screens (a conversation, the assistant) fill the window exactly: on desktop the viewport
 * minus the 48px bar; on phones minus the 56px bar and the bottom tabs.
 */
export function Main({ children }: { children: React.ReactNode }) {
  const url = usePathname();
  // A peek (app/app/@peek) puts its own address in the bar while the page under it stays. Going by the address, the
  // page remounted behind the overlay and replayed its fade-up, a visible jump.
  // So: the page actually shown in this slot, and its last own address while a peek covers it.
  const shown = `/app${useSelectedLayoutSegments()
    .filter((s) => !s.startsWith("(") && !s.startsWith("__"))
    .map((s) => `/${s}`)
    .join("")}`;
  const own = safeDecode(url) === safeDecode(shown);
  const last = useRef(url);
  if (own) last.current = url;
  const path = last.current;
  const full = fullBleed(path);
  const main = (
    <main
      id="main"
      // Target of the skip link and of focus when a dialog's opener is gone; never a Tab stop itself.
      tabIndex={-1}
      // A new destination fades up; the key keeps that to real navigation, not to every re-render.
      key={full ? undefined : path}
      className={cx(
        "min-w-0 outline-none",
        // Full-bleed: an exact height, never grown by flex (flex-1 let the panel's min-height stretch it past the
        // viewport and pushed the composer off-screen); only the screen's own list scrolls inside it.
        full
          ? "bg-surface h-[calc(100dvh-56px-4rem-env(safe-area-inset-bottom))] flex-none overflow-hidden md:h-[calc(100dvh-48px)]"
          : cx("animate-page flex-1", pageColumn, wide(path) && "max-w-none", "pb-[calc(5.5rem+env(safe-area-inset-bottom))] pt-4 md:pb-10 md:pt-5"),
      )}
    >
      {children}
    </main>
  );
  return paper(path) ? <div className="bg-surface flex min-w-0 flex-1 flex-col">{main}</div> : main;
}

function safeDecode(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
