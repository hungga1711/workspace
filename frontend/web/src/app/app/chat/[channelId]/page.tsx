import { notFound, unstable_rethrow } from "next/navigation";
import { ReadFailed } from "@/components/ui/ReadFailed";
import { gw, GatewayError } from "@/lib/gateway";
import { readSession } from "@/lib/session";
import { Conversation, type ChannelInfo, type Message } from "@/components/chat/Conversation";
import type { ChannelSummary } from "@/components/shell/types";
import type { Metadata } from "next";
import { getT } from "@/lib/i18n/server";
import { gwOnce } from "@/lib/gateway";

export async function generateMetadata({ params }: { params: Promise<{ channelId: string }> }): Promise<Metadata> {
  const { channelId } = await params;
  const t = await getT();
  const info = await gwOnce<{ kind: string; name: string | null; displayName?: string | null }>(`/api/chat/channels/${channelId}`).catch(() => null);
  if (!info) return {};
  return { title: info.kind === "dm" ? t("chat.index.dm") : (info.displayName ?? `#${info.name}`) };
}

export default async function ChannelPage({ params, searchParams }: { params: Promise<{ channelId: string }>; searchParams: Promise<{ m?: string }> }) {
  const { channelId } = await params;
  const { m } = await searchParams;
  try {
    const [target, session, agents, info, list, members] = await Promise.all([
      // A link to a message that is gone (or elsewhere) still opens the conversation.
      m ? focusTarget(m, channelId).catch(() => null) : null,
      readSession(),
      gw<{ agents: { id: string; name: string }[] }>("/api/identity/agents").catch(() => ({ agents: [] })),
      gwOnce<{
        id: string;
        kind: string;
        name: string | null;
        displayName?: string | null;
        topic: string;
        archived: boolean;
        isDefault: boolean;
        autoJoin?: boolean;
        canSetAutoJoin?: boolean;
        canManage: boolean;
        readers?: { userId: string; seq: number }[];
      }>(`/api/chat/channels/${channelId}`),
      // The sidebar list and the member ids only dress the conversation (DM name, star, mute, mentions); a failed read
      // of either must not take the open channel down with it.
      gw<{ channels: ChannelSummary[] }>("/api/chat/channels").catch(() => null),
      gw<{ userIds: string[] }>(`/api/chat/channels/${channelId}/members`).catch(() => null),
    ]);
    // DMs are named after the other person, which only the sidebar list knows.
    const mine = list?.channels.find((c) => c.id === channelId);
    const dmUserId = mine?.dmUserId ?? null;
    // Where the log opens: around a linked message; at the first unread when there are more than the newest page
    // shows (a reader back from holiday starts where they stopped, not at the bottom of 250 messages); else the newest.
    const unreadFrom = mine && !target && mine.lastSeq - mine.lastReadSeq > UNREAD_WINDOW ? mine.lastReadSeq + 1 : null;
    const page = target
      ? await around(channelId, target.seq, 25, 25)
      : unreadFrom !== null
        ? await around(channelId, unreadFrom, 10, 50)
        : { ...(await gw<{ messages: Message[]; nextBefore: number | null }>(`/api/chat/channels/${channelId}/messages?limit=50`)), nextAfter: null };
    const anchor = target
      ? { id: target.id, highlight: true }
      : unreadFrom !== null
        ? (() => {
            const unread = page.messages.filter((x) => x.seq >= unreadFrom);
            const first = unread.find((x) => x.authorId !== session?.userId) ?? unread[0];
            return first ? { id: first.id, highlight: false } : null;
          })()
        : null;
    const channel: ChannelInfo = {
      id: info.id,
      kind: info.kind,
      name: info.name,
      displayName: info.displayName ?? null,
      topic: info.topic,
      dmUserId,
      archived: info.archived,
      isDefault: info.isDefault,
      autoJoin: info.autoJoin ?? false,
      canSetAutoJoin: info.canSetAutoJoin ?? false,
      canManage: info.canManage,
      starred: !!mine?.starred,
      muted: !!mine?.muted,
      notify: mine?.notify ?? null,
      mutedUntil: mine?.mutedUntil ?? null,
      // Without the list, membership falls back to the channel's member ids (and, failing those too, to member: the
      // send itself is checked server-side, a wrong "join" bar would not be).
      member: list ? !!mine : (members?.userIds.includes(session?.userId ?? "") ?? true),
      lastReadSeq: mine?.lastReadSeq ?? null,
      readers: info.readers ?? [],
    };
    return (
      <Conversation
        // A link to another message in the conversation already open opens it afresh, at that message.
        key={m ? `${channelId}:${m}` : channelId}
        channel={channel}
        initial={page.messages}
        nextBefore={page.nextBefore}
        nextAfter={page.nextAfter}
        anchor={anchor}
        me={session!.userId}
        agents={agents.agents}
        memberIds={members?.userIds ?? []}
        openThreadId={target?.thread ?? null}
      />
    );
  } catch (e) {
    // Sign-in and 2FA redirects pass through; only a channel that is not there is a 404. A busy or restarting server
    // shows a retry in the conversation's place instead of the error screen (the sidebar keeps working).
    unstable_rethrow(e);
    if (e instanceof GatewayError && e.status === 404) notFound();
    return <ReadFailed status={e instanceof GatewayError ? e.status : 500} />;
  }
}

/** More unread than this opens the log at the first unread message instead of the newest. */
const UNREAD_WINDOW = 40;

/**
 * The message a link points at (a reminder, a saved item, a task's source, a permalink): the log centres its top-level
 * message and the side panel opens its thread (to read the replies or start some).
 */
async function focusTarget(id: string, channelId: string): Promise<{ id: string; seq: number; thread: string | null } | null> {
  type Row = { id: string; channelId: string; seq: number; threadRootId: string | null };
  const msg = await gw<{ root: Row }>(`/api/chat/messages/${encodeURIComponent(id)}/thread`).then((r) => r.root);
  if (msg.channelId !== channelId) return null;
  if (!msg.threadRootId) return { id: msg.id, seq: msg.seq, thread: msg.id };
  const root = await gw<{ root: Row }>(`/api/chat/messages/${encodeURIComponent(msg.threadRootId)}/thread`).then((r) => r.root);
  return { id: root.id, seq: root.seq, thread: root.id };
}

/** A window of the log around `seq`: `older` messages before it, then it and up to `newer - 1` after; `nextAfter` is
 * the cursor for newer pages, null when the window reaches the newest message. */
async function around(channelId: string, seq: number, older: number, newer: number) {
  const [up, down] = await Promise.all([
    gw<{ messages: Message[]; nextBefore: number | null }>(`/api/chat/channels/${channelId}/messages?limit=${older}&before=${seq}`),
    gw<{ messages: Message[] }>(`/api/chat/channels/${channelId}/messages?limit=${newer}&after=${seq - 1}`),
  ]);
  return { messages: [...up.messages, ...down.messages], nextBefore: up.nextBefore, nextAfter: down.messages.length === newer ? down.messages.at(-1)!.seq : null };
}
