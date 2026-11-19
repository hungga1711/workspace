"use client";

import { usePathname } from "next/navigation";
import { fullBleed } from "@/components/shell/Main";
import { cx } from "@/lib/ui";

/**
 * One pane: the conversation fills the panel (the conversation list lives in the sidebar). Threads and details open
 * in the side drawer over it, so nothing here changes width.
 */
export function ChatShell({ children }: { children: React.ReactNode }) {
  // The start screen (/app/chat) is an ordinary page on the ground; conversations are one white working surface.
  const path = usePathname();
  const full = fullBleed(path);
  // The inbox lists and Thêm kênh are pages of cards (Home's look), so they sit on the canvas, not the white surface.
  const lists = /^\/app\/chat\/(browse|unreads|threads|mentions|saved)\/?$/.test(path);
  return <div className={cx("grid h-full min-h-0 grid-cols-1", full && (lists ? "bg-panel" : "bg-surface"))}>{children}</div>;
}
