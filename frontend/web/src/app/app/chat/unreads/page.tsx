import { gw } from "@/lib/gateway";
import { readPage } from "@/lib/page-read";
import { ReadFailed } from "@/components/ui/ReadFailed";
import type { Message } from "@/components/chat/Conversation";
import { UnreadsList, type UnreadGroup } from "@/components/chat/SavedList";
import type { ChannelSummary } from "@/components/shell/types";
import type { Metadata } from "next";
import { getT } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("chat.lists.unreadsTitle") };
}

/**
 * "Chưa đọc" (Slack's All unreads, Lark's Unread filter): every conversation with new messages on one
 * page, direct messages first, muted ones left out, so a morning catch-up is one scroll.
 */
export default async function UnreadsPage() {
  const r = await readPage(gw<{ channels: ChannelSummary[] }>("/api/chat/channels"));
  if (!r.data) return <ReadFailed status={r.failed} />;
  const { channels } = r.data;
  const unread = channels
    .filter((c) => c.unread > 0 && !c.muted && c.notify !== "none")
    .sort((a, b) => Number(b.kind === "dm" || b.kind === "group") - Number(a.kind === "dm" || a.kind === "group") || b.mentions - a.mentions)
    .slice(0, 15);
  const groups: UnreadGroup[] = await Promise.all(
    unread.map(async (c) => {
      // One conversation's messages failing (a 429 among 15 parallel reads) leaves its card with a retry, not the page down.
      const messages = await gw<{ messages: Message[] }>(`/api/chat/channels/${c.id}/messages?after=${c.lastReadSeq}&limit=20`)
        .then((r) => r.messages)
        .catch(() => null);
      return {
        channel: { id: c.id, kind: c.kind, name: c.name, displayName: c.displayName ?? null, dmUserId: c.dmUserId },
        unread: c.unread,
        lastSeq: c.lastSeq,
        messages: messages?.filter((m) => !m.deletedAt) ?? null,
      };
    }),
  );
  return <UnreadsList groups={groups} />;
}
