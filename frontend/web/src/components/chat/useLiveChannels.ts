"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { connectRealtime, releaseRealtime } from "@/lib/realtime";
import type { ChannelSummary } from "@/components/shell/types";
import { withIncoming, withRead, type Incoming } from "./liveChannels";

/** The conversation on screen (set by Conversation): its new messages count as unread only while the reader is scrolled up. */
export const onScreen: { current: { channelId: string; atBottom: () => boolean } | null } = { current: null };

// The sidebar and the chat index both listen: a new conversation refreshes the shell once, not once per list.
let pending: ReturnType<typeof setTimeout> | undefined;
let refresh: () => void = () => undefined;
const refreshSoon = () => {
  if (pending) return;
  pending = setTimeout(() => {
    pending = undefined;
    refresh();
  }, 800);
};

/**
 * The sidebar's channel list kept live from the app's one realtime connection: a message elsewhere bumps that
 * conversation's unread (and mention) count in place, and a conversation the list does not know yet (a new DM, a
 * channel someone added me to) refreshes the shell once. The server-rendered list stays the source of truth: every
 * refresh replaces these local counts.
 */
export function useLiveChannels(channels: ChannelSummary[], me: string): ChannelSummary[] {
  const [live, setLive] = useState(channels);
  useEffect(() => setLive(channels), [channels]);
  const router = useRouter();
  const known = useRef(new Set<string>());
  known.current = new Set(channels.map((c) => c.id));

  useEffect(() => {
    let off = () => undefined as void;
    let cancelled = false;
    let started = false;
    refresh = () => router.refresh();
    const start = () => {
      started = true;
      void connectRealtime().then((s) => {
        if (cancelled) return;
        const created = (m: Incoming) => {
          if (!m?.channelId || m.authorId === me) return;
          if (!known.current.has(m.channelId)) return refreshSoon();
          // The open conversation marks itself read while its newest message is in view; counting it here would flash a badge.
          if (onScreen.current?.channelId === m.channelId && onScreen.current.atBottom()) return;
          setLive((cur) => withIncoming(cur, m, me));
        };
        // Read here or on another device: the server says what is left unread.
        const read = (d: { channelId: string; unread?: number }) => setLive((cur) => withRead(cur, d));
        const joined = (d: { channelId: string }) => !known.current.has(d.channelId) && refreshSoon();
        s.on("message.created", created);
        s.on("read.updated", read);
        s.on("channel.joined", joined);
        off = () => {
          s.off("message.created", created);
          s.off("read.updated", read);
          s.off("channel.joined", joined);
        };
      });
    };
    // Like the call listener: join the shared connection once the page is idle, never before first paint.
    const idle = window.requestIdleCallback ? window.requestIdleCallback(start, { timeout: 3000 }) : window.setTimeout(start, 1500);
    return () => {
      cancelled = true;
      if (window.cancelIdleCallback) window.cancelIdleCallback(idle);
      else window.clearTimeout(idle);
      off();
      if (started) releaseRealtime();
    };
  }, [me, router]);

  return live;
}
