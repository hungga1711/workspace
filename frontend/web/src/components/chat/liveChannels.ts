import type { ChannelSummary } from "@/components/shell/types";

/** What the server sends with `message.created`, as far as the channel lists care. */
export interface Incoming {
  channelId: string;
  authorId: string;
  threadRootId: string | null;
  mentions?: string[];
  createdAt?: string;
}

/** A message from someone else: one more unread (and mention), and a top-level one moves the conversation up. */
export function withIncoming(list: ChannelSummary[], m: Incoming, me: string): ChannelSummary[] {
  return list.map((c) =>
    c.id === m.channelId
      ? {
          ...c,
          unread: c.unread + 1,
          mentions: c.mentions + (m.mentions?.includes(me) ? 1 : 0),
          lastMessageAt: m.threadRootId ? c.lastMessageAt : (m.createdAt ?? new Date().toISOString()),
        }
      : c,
  );
}

/** Read here or on another device: the server says what is left unread; nothing left means no mentions either. */
export function withRead(list: ChannelSummary[], d: { channelId: string; unread?: number }): ChannelSummary[] {
  return list.map((c) => (c.id === d.channelId ? { ...c, unread: d.unread ?? 0, mentions: d.unread ? c.mentions : 0 } : c));
}
