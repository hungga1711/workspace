import { AtIcon, BookmarkIcon, InboxIcon, ThreadIcon } from "@/components/app/icons";
import type { Tone } from "@/components/ui/Bento";

export type InboxTab = "unreads" | "threads" | "mentions" | "saved";
/** Each inbox view keeps one tone, on Tin nhắn's overview and on its own page (mentions are violet, as on Home). */
export const INBOX_MARK = {
  unreads: [InboxIcon, "sky"],
  threads: [ThreadIcon, "tangerine"],
  mentions: [AtIcon, "violet"],
  saved: [BookmarkIcon, "rose"],
} as const satisfies Record<InboxTab, readonly [unknown, Tone]>;
