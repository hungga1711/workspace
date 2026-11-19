"use client";

import { TASK_INTENT } from "@/components/workflows/intent";
import { useToast } from "@/components/ui/Toast";
import { aiProblem, budgetMessage } from "@/lib/ai-spend";
import { useVirtualizer } from "@tanstack/react-virtual";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api } from "@/lib/client";
import { useConnection } from "@/lib/connection";
import { useAiEnabled } from "@/lib/ai-context";
import { localDate } from "@/lib/format";
import { useFormat, useLocale, useMeetEnabled } from "@/lib/i18n/client";
import type { Locale } from "@/lib/i18n/config";
import { AvatarStack, useDirectory, ChannelAvatar } from "@/lib/people";
import { DmHeading } from "./DmHeading";
import { btn, btnPrimary, btnSm, cx } from "@/lib/ui";
import {
  ArrowDownIcon,
  AtIcon,
  BellIcon,
  BellOffIcon,
  BookmarkIcon,
  CopyIcon,
  EyeOffIcon,
  LinkIcon,
  PencilIcon,
  PanelIcon,
  PinIcon,
  ForwardIcon,
  CheckCircleIcon,
  ClockIcon,
  SearchIcon,
  StarIcon,
  ThreadIcon,
  TrashIcon,
  MoreIcon,
  VideoIcon,
  TranslateIcon,
  SparkleIcon,
  UsersIcon,
} from "@/components/app/icons";
import { Menu } from "@/components/ui/Menu";
import { CallButtons } from "@/components/call/CallButtons";
import { useRealtime } from "./useRealtime";
import { ScreenActions, ScreenCrumb } from "@/components/shell/ScreenTitle";
import { uploadChatFile, type Attachment } from "./attachments";
import { type LinkPreview } from "./LinkPreviews";
import { reactorsText } from "./reactors";
import { Composer } from "./Composer";
import { AiTurnView, answered, askMention, decideMention, rid, type AiTurn } from "./AiTurn";
import { MessageItem } from "./MessageItem";
import type { DetailsTab } from "./ChannelDetails";
import { type PollState } from "./Polls";
import { SignalChips } from "./SignalChips";
import { onScreen } from "./useLiveChannels";
import { NotifyMenu, type Notify, type NotifyPatch } from "./NotifyMenu";

// Panels and dialogs that open on demand load on demand: the conversation route keeps its JS budget.
const ThreadPanel = dynamic(() => import("./ThreadPanel").then((m) => m.ThreadPanel), { ssr: false });
const ChannelDetails = dynamic(() => import("./ChannelDetails").then((m) => m.ChannelDetails), { ssr: false });
const ChannelSettings = dynamic(() => import("./ChannelDrawers").then((m) => m.ChannelSettings), { ssr: false });
const PollDialog = dynamic(() => import("./PollDialog").then((m) => m.PollDialog), { ssr: false });
const ForwardDialog = dynamic(() => import("./ForwardDialog").then((m) => m.ForwardDialog), { ssr: false });
const MessageSheet = dynamic(() => import("./MessageSheet").then((m) => m.MessageSheet), { ssr: false });
const ChannelSearch = dynamic(() => import("./ChannelSearch").then((m) => m.ChannelSearch), { ssr: false });
const AssignDialog = dynamic(() => import("./AssignDialog").then((m) => m.AssignDialog), { ssr: false });

export interface Message {
  id: string;
  /** Pinned in the conversation; saved by me. */
  pinned?: boolean;
  saved?: boolean;
  channelId: string;
  seq: number;
  threadRootId: string | null;
  authorId: string;
  authorType: string;
  /** History imported from Slack: the author's name there when they are not a member here. */
  importAuthor?: string | null;
  body: string;
  mentions: string[];
  replyCount: number;
  lastReplyAt?: string | null;
  deletedAt: string | null;
  editedAt: string | null;
  createdAt: string;
  clientMsgId: string | null;
  /** `users`: who reacted (first 20, in order); `count` is the total. */
  reactions: { emoji: string; count: number; mine: boolean; users?: string[] }[];
  /** Link preview cards, filled in by the server shortly after posting (`message.previews`). */
  linkPreviews?: LinkPreview[];
  attachments?: Attachment[];
  pending?: boolean;
  failed?: boolean;
  /** A poll on this message (question, options, live counts). */
  poll?: PollState | null;
  /** Forwarded from another conversation (shown as "Chuyển tiếp từ …"). */
  forwardOf?: { messageId: string; channelId: string; channelKind: string; channelName: string | null; authorId: string; createdAt: string } | null;
}
export interface ChannelInfo {
  id: string;
  kind: string;
  name: string | null;
  /** How people read the channel ("Kỹ thuật"); null shows `name`. */
  displayName?: string | null;
  topic?: string;
  dmUserId: string | null;
  archived?: boolean;
  isDefault?: boolean;
  autoJoin?: boolean;
  canSetAutoJoin?: boolean;
  canManage?: boolean;
  starred?: boolean;
  muted?: boolean;
  notify?: Notify | null;
  mutedUntil?: string | null;
  member?: boolean;
  lastReadSeq?: number | null;
  /** Direct and group messages: how far each other member has read ("Đã xem"). */
  readers?: { userId: string; seq: number }[];
}

const QUICK = ["👍", "❤️", "😂", "🎉", "✅", "👀"];
// Shown with the app's own reaction art (ReactionArt).
/** One centred reading column: long lines stay readable on wide screens. */
const col = "mx-auto w-full max-w-[56rem]";
/** The header's icon buttons (search, call, details, ⋯): 32px, ink-soft at rest so they read as controls, not hints. */
const headBtn =
  "text-ink-soft hover:bg-hover hover:text-ink aria-pressed:bg-selected aria-pressed:text-ink aria-expanded:bg-selected aria-expanded:text-ink in-aria-expanded:bg-selected in-aria-expanded:text-ink grid size-8 shrink-0 place-items-center rounded-md transition-colors disabled:opacity-50";

/** Messages kept sorted by seq; realtime, retries and gap fetches all merge through here (dedupe by id / clientMsgId). */
function merge(list: Message[], incoming: Message[]): Message[] {
  const byId = new Map(list.filter((m) => !m.pending || !incoming.some((i) => i.clientMsgId && i.clientMsgId === m.clientMsgId)).map((m) => [m.id, m]));
  for (const m of incoming) if (!m.threadRootId) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => (a.pending ? 1 : 0) - (b.pending ? 1 : 0) || a.seq - b.seq);
}

/** Consecutive messages from one author within 5 minutes share a header. */
function startsGroup(prev: Message | undefined, m: Message): boolean {
  if (!prev) return true;
  if (prev.authorId !== m.authorId || prev.authorType === "system" || prev.importAuthor !== m.importAuthor) return true;
  if (localDate(prev.createdAt) !== localDate(m.createdAt)) return true;
  return new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() > 5 * 60_000;
}

export function Conversation({
  channel,
  initial,
  nextBefore,
  nextAfter,
  anchor,
  me,
  agents,
  memberIds,
  openThreadId,
}: {
  channel: ChannelInfo;
  initial: Message[];
  nextBefore: number | null;
  /** Cursor for newer pages when the log opened away from the newest message (a link, many unread); null at the newest. */
  nextAfter: number | null;
  /** The message the log opens at: a linked one (centred and highlighted) or the first unread (at the top). */
  anchor: { id: string; highlight: boolean } | null;
  me: string;
  agents: { id: string; name: string }[];
  memberIds: string[];
  openThreadId: string | null;
}) {
  const { dayLabel } = useFormat();
  const channelId = channel.id;
  const router = useRouter();
  const dir = useDirectory();
  // Company AI (@AI, agents, translate): hidden when no provider is configured.
  const aiOn = useAiEnabled();
  const names = dir.names;
  const f = useFormat();
  const { t, time } = f;
  const toast = useToast();
  const failed = () => toast({ message: t("common.actionFailed") });
  const [messages, setMessages] = useState<Message[]>(() => merge([], initial));
  const [pinsKey, setPinsKey] = useState(0);
  // The details drawer re-reads files when a message with attachments appears or is deleted.
  const withFiles = messages.filter((m) => !m.pending && m.attachments?.length);
  const filesKey = `${withFiles.length}:${withFiles.at(-1)?.id ?? ""}:${withFiles.filter((m) => m.deletedAt).length}`;
  const [before, setBefore] = useState(nextBefore);
  // Not null while the log shows an older stretch of the conversation: realtime messages wait for "Jump to latest"
  // (merging them would leave a hole), and scrolling down pages forward from here.
  const [after, setAfter] = useState(nextAfter);
  const detached = useRef(nextAfter !== null);
  detached.current = after !== null;
  // The message to bring into view once it is rendered, and the linked one shown highlighted for a moment.
  const [target, setTarget] = useState<{ id: string; align: "center" | "start" } | null>(anchor ? { id: anchor.id, align: anchor.highlight ? "center" : "start" } : null);
  const [focused, setFocused] = useState<string | null>(anchor?.highlight ? anchor.id : null);
  const [typing, setTyping] = useState<Record<string, number>>({});
  const [thread, setThread] = useState<string | null>(openThreadId);
  const [autoSummarize, setAutoSummarize] = useState(false);
  const [aiTurns, setAiTurns] = useState<AiTurn[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  // "Dịch": translations shown under messages (this view only); null text = working.
  const [translations, setTranslations] = useState<Record<string, { text: string | null; to: Locale }>>({});
  const [picker, setPicker] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [members, setMembers] = useState(memberIds);
  // Name, topic and archived state change live (channel settings), so they are local state.
  const [meta, setMeta] = useState({ name: channel.name, displayName: channel.displayName ?? null, topic: channel.topic ?? "", archived: !!channel.archived });
  const [settings, setSettings] = useState(false);
  const [prefs, setPrefs] = useState({ starred: !!channel.starred, muted: !!channel.muted, notify: channel.notify ?? null, mutedUntil: channel.mutedUntil ?? null });
  // "Tin mới" divider: where the viewer stopped reading when they opened the conversation (fixed for this visit).
  const [readMark, setReadMark] = useState(channel.lastReadSeq ?? null);
  const [showJump, setShowJump] = useState(false);
  // Messages from others that arrived while the reader was scrolled up: the pill counts them, reaching the bottom reads them.
  const [below, setBelow] = useState(0);
  const [bottomTick, setBottomTick] = useState(0);
  const [threadIncoming, setThreadIncoming] = useState<Message | null>(null);
  const [threadPreviews, setThreadPreviews] = useState<{ messageId: string; linkPreviews: LinkPreview[] } | null>(null);
  const [readers, setReaders] = useState(channel.readers ?? []);
  const [forwarding, setForwarding] = useState<Message | null>(null);
  // "Gửi sau": my messages waiting to go out in this conversation.
  const [scheduled, setScheduled] = useState<{ id: string; body: string; at: string }[]>([]);
  useEffect(() => {
    api<{ scheduled: { id: string; body: string; at: string }[] }>(`chat/scheduled?channelId=${channelId}`)
      .then((r) => setScheduled(r.scheduled))
      .catch(() => undefined);
  }, [channelId]);
  // A scheduled message that went out leaves the list when it arrives.
  useEffect(() => {
    if (!scheduled.length) return;
    const tick = setInterval(() => setScheduled((l) => l.filter((x) => Date.parse(x.at) > Date.now() - 30_000)), 15_000);
    return () => clearInterval(tick);
  }, [scheduled.length]);
  const [assigning, setAssigning] = useState<Message | null>(null);
  // "Nhắc tôi": in 20 minutes, an hour, three hours, tomorrow or next Monday at 9.
  const viewerLocale = useLocale();
  // Signal chips read "today"/"tomorrow" in the browser's clock and zone: rendered after mount only, so the server's
  // HTML (another clock, another zone) never disagrees with the first client render (React #418).
  const [mountedAt, setMountedAt] = useState<number | null>(null);
  useEffect(() => setMountedAt(Date.now()), []);
  const remindOptions = () => {
    const now = new Date();
    const at9 = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 9, 0, 0);
    const tomorrow = at9(new Date(now.getTime() + 86400_000));
    const monday = at9(new Date(now.getTime() + ((8 - now.getDay()) % 7 || 7) * 86400_000));
    return [
      { label: t("chat.remind.in20"), at: new Date(now.getTime() + 20 * 60_000) },
      { label: t("chat.remind.in1h"), at: new Date(now.getTime() + 3600_000) },
      { label: t("chat.remind.in3h"), at: new Date(now.getTime() + 3 * 3600_000) },
      { label: t("chat.remind.tomorrow"), at: tomorrow },
      { label: t("chat.remind.monday"), at: monday },
    ];
  };
  const translate = async (m: Message) => {
    const locale = viewerLocale;
    if (translations[m.id]) {
      setTranslations((cur) => {
        const n = { ...cur };
        delete n[m.id];
        return n;
      });
      return;
    }
    const text = m.body.replace(/<@([A-Za-z0-9_-]{1,64})>/g, (_, id: string) => `@${dir.name(id)}`);
    // Into the reader's own language; a Vietnamese reader translating Vietnamese text gets English.
    const vietnamese = /[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i.test(text);
    const to = locale === "vi" && vietnamese ? "en" : locale;
    setTranslations((cur) => ({ ...cur, [m.id]: { text: null, to } }));
    try {
      const r = await api<{ text: string }>("ai/translate", { method: "POST", body: { text: text.slice(0, 4000), to } });
      setTranslations((cur) => ({ ...cur, [m.id]: { text: r.text, to } }));
    } catch (e) {
      setTranslations((cur) => {
        const n = { ...cur };
        delete n[m.id];
        return n;
      });
      const st = (e as { status?: number }).status;
      setFlash(budgetMessage(t, e) ?? (st === 503 ? t("chat.translate.unavailable") : t("chat.translate.failed")));
    }
  };
  const remind = async (m: Message, at: Date) => {
    const text = m.body
      .replace(/<@([A-Za-z0-9_-]{1,64})>/g, (_, id: string) => `@${dir.name(id)}`)
      .replace(/\s+/g, " ")
      .trim();
    const title = `${dir.name(m.authorId)}: ${text || t("chat.remind.attachment")}`.slice(0, 200);
    try {
      await api("home/reminders", { method: "POST", body: { at: at.toISOString(), title, url: `/app/chat/${channelId}?m=${m.id}` } });
      setFlash(t("chat.remind.done", { when: `${time(at.toISOString())} ${dayLabel(at.toISOString())}` }));
    } catch {
      setFlash(t("chat.remind.failed"));
    }
  };
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(!anchor && nextAfter === null);
  const unreadHold = useRef(false);
  const lastTyping = useRef(0);
  // "Chi tiết" opens in the side drawer over the conversation (one detail pattern, nothing docks or
  // pushes the messages aside).
  const [details, setPanel] = useState<DetailsTab | null>(null);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 2500);
    return () => clearTimeout(t);
  }, [flash]);

  const lastSeq = useMemo(() => messages.filter((m) => !m.pending).at(-1)?.seq ?? 0, [messages]);
  // The "Tin mới" divider goes above the first unread message from someone else (my own messages after the mark are
  // not news to me, and may come first).
  const firstUnreadId = useMemo(
    () => (readMark === null ? null : (messages.find((m) => !m.pending && m.seq > readMark && m.authorId !== me)?.id ?? null)),
    [messages, readMark, me],
  );

  const recover = useCallback(async () => {
    if (detached.current) return; // the newest messages load with "Jump to latest"
    const r = await api<{ messages: Message[] }>(`chat/channels/${channelId}/messages?after=${lastSeq}&limit=100`);
    setMessages((cur) => merge(cur, r.messages));
  }, [channelId, lastSeq]);

  const refetch = (id: string) =>
    void api<{ root: Message }>(`chat/messages/${id}/thread`)
      .then((r) => setMessages((cur) => merge(cur, [r.root])))
      .catch(() => undefined);

  const rt = useRealtime(
    {
      "message.created": (m: Message) => {
        if (m.channelId !== channelId) return;
        if (m.threadRootId) {
          setThreadIncoming(m);
          return;
        } // the open thread panel merges it
        if ((!atBottom.current || detached.current) && m.authorId !== me) setBelow((n) => n + 1);
        if (detached.current) return;
        setMessages((cur) => {
          const known = cur.filter((x) => !x.pending).at(-1)?.seq ?? 0;
          if (m.seq > known + 1) void recover(); // a gap: fetch what we missed, never refetch everything
          return merge(cur, [m]);
        });
      },
      "message.updated": (m: Message) => m.channelId === channelId && setMessages((cur) => merge(cur, [m])),
      // Poll counts from anyone's vote; my own choices stay as I left them.
      "poll.updated": (d: { messageId: string; channelId: string; votes: { option: string; count: number }[]; voters: number }) =>
        d.channelId === channelId &&
        setMessages((cur) =>
          cur.map((x) =>
            x.id === d.messageId && x.poll
              ? { ...x, poll: { ...x.poll, voters: d.voters, votes: d.votes.map((v) => ({ ...v, mine: x.poll!.votes.find((o) => o.option === v.option)?.mine ?? false })) } }
              : x,
          ),
        ),
      "message.deleted": (d: { id: string }) => setMessages((cur) => cur.map((m) => (m.id === d.id ? { ...m, body: "", deletedAt: new Date().toISOString() } : m))),
      // Link previews arrive a moment after the message (the server fetches the pages); a thread reply's go to the panel.
      "message.previews": (d: { messageId: string; channelId: string; linkPreviews: LinkPreview[] }) => {
        if (d.channelId !== channelId) return;
        setMessages((cur) => cur.map((x) => (x.id === d.messageId ? { ...x, linkPreviews: d.linkPreviews } : x)));
        setThreadPreviews({ messageId: d.messageId, linkPreviews: d.linkPreviews });
      },
      // Reaction counts are per-viewer ("mine"), so refetch the message instead of trusting the payload.
      "reaction.updated": (d: { messageId: string }) => refetch(d.messageId),
      "thread.updated": (d: { rootId: string }) =>
        setMessages((cur) => cur.map((m) => (m.id === d.rootId ? { ...m, replyCount: m.replyCount + 1, lastReplyAt: new Date().toISOString() } : m))),
      "read.cursor": (d: { channelId: string; userId: string; seq: number }) =>
        d.channelId === channelId &&
        d.userId !== me &&
        setReaders((cur) => [...cur.filter((x) => x.userId !== d.userId), { userId: d.userId, seq: Math.max(d.seq, cur.find((x) => x.userId === d.userId)?.seq ?? 0) }]),
      typing: (d: { channelId: string; userId: string }) => d.channelId === channelId && setTyping((t) => ({ ...t, [d.userId]: Date.now() })),
      // Someone pinned or unpinned here: the message's flag and the pinned list follow.
      "pins.updated": (d: { channelId: string; messageId: string; pinned: boolean }) => {
        if (d.channelId !== channelId) return;
        setMessages((cur) => cur.map((x) => (x.id === d.messageId ? { ...x, pinned: d.pinned } : x)));
        setPinsKey((n) => n + 1);
      },
      // Read on another device: the sidebar's unread counts follow (this conversation's own reads are already shown).
      "read.updated": (d: { channelId: string }) => d.channelId !== channelId && router.refresh(),
      "read.all": () => router.refresh(),
      "channel.updated": (d: { id: string; name: string; displayName?: string | null; topic: string; archived: boolean }) => {
        if (d.id !== channelId) return;
        setMeta({ name: d.name, displayName: d.displayName ?? null, topic: d.topic, archived: d.archived });
        router.refresh(); // the sidebar lists channels by name and hides archived ones
      },
    },
    () => void recover(),
  );

  // Typing indicators expire after 4s.
  useEffect(() => {
    const t = setInterval(() => setTyping((cur) => Object.fromEntries(Object.entries(cur).filter(([, at]) => Date.now() - at < 4000))), 1000);
    return () => clearInterval(t);
  }, []);

  // Rows are keyed by message, not position: a page of older messages shifts every index, and measured heights kept
  // by index would then belong to other messages (the log jumped as they were re-measured).
  // The rows start below the log's header ("load older" or the conversation's start): the virtualizer has to know by
  // how much, or it takes rows just under the top edge for rows above it and shifts the view when they are measured.
  const listRef = useRef<HTMLDivElement>(null);
  const listTop = () => {
    const el = scrollRef.current;
    const list = listRef.current;
    return el && list ? Math.round(list.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop) : 0;
  };
  const [margin, setMargin] = useState(0);
  useLayoutEffect(() => {
    const m = listTop();
    if (m !== margin) setMargin(m);
  }, [margin, before]);
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 56,
    overscan: 12,
    scrollMargin: margin,
    getItemKey: (i) => messages[i]?.id ?? i,
  });
  // The true bottom. scrollToIndex lands on the estimated height (56px a row); the last rows are measured only once
  // painted, so the end moves under the reader and the newest message sat half under the edge. Scroll
  // to the index, then pin to scrollHeight over the next frames until it stops changing.
  // While pinning, the log's own scroll events (the virtualizer adjusts the offset as rows above are measured) must
  // not read as "the reader scrolled away" and stop the pin; a wheel or touch does.
  const pinning = useRef(false);
  const settleToEnd = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinning.current = true;
    atBottom.current = true;
    // Rows are measured as they paint and the virtualizer shifts the offset after each measure, so the end keeps
    // moving for a while: pin to the bottom every frame until the height has been still for ten frames (at most
    // ~1.5 s), unless the reader takes over.
    let frames = 0;
    let still = 0;
    let last = -1;
    const pin = () => {
      const e = scrollRef.current;
      if (!e || !pinning.current) return;
      e.scrollTop = e.scrollHeight;
      atBottom.current = true;
      const h = e.scrollHeight;
      still = h === last ? still + 1 : 0;
      last = h;
      if (++frames < 90 && still < 10) requestAnimationFrame(pin);
      else pinning.current = false;
    };
    requestAnimationFrame(pin);
  };
  const unpin = () => {
    pinning.current = false;
  };

  // Open at the newest message, or at the anchor: rows are measured after first paint, so settle the scroll twice.
  useEffect(() => {
    if (!atBottom.current) return;
    settleToEnd();
    // A second pass once the first page's images and previews have had time to size.
    const t = setTimeout(() => atBottom.current && settleToEnd(), 400);
    return () => clearTimeout(t);
  }, []);
  useLayoutEffect(() => {
    if (!target) return;
    const i = messages.findIndex((x) => x.id === target.id);
    if (i < 0) return;
    const go = () => virtualizer.scrollToIndex(i, { align: target.align });
    go();
    const t1 = setTimeout(go, 60),
      t2 = setTimeout(() => {
        go();
        setTarget(null);
      }, 300);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [target, messages, virtualizer]);
  useEffect(() => {
    if (!focused) return;
    const t = setTimeout(() => setFocused(null), 2500);
    return () => clearTimeout(t);
  }, [focused]);
  // Stick to the bottom when new messages arrive and the user is already there (not when a page of an older stretch
  // loads under the reader: that would run on to the end of it).
  useLayoutEffect(() => {
    if (atBottom.current && after === null && messages.length) settleToEnd();
  }, [messages.length, virtualizer, after]);

  // AI turns live below the virtual list, so follow them too while the viewer is at the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && atBottom.current && aiTurns.length) el.scrollTop = el.scrollHeight;
  }, [aiTurns]);

  // Mark read when the newest message is visible (monotonic server-side). The sidebar's unread count comes from the
  // server-rendered shell, so it is only wrong when the channel was unread when this page was rendered: refresh the
  // shell once for that case, never for every message that arrives while the reader is at the bottom (each refresh
  // re-runs every server component, including the member and channel lists).
  const sidebarStale = useRef<boolean | null>(null);
  // The sidebar counts this conversation's new messages only while the reader is scrolled away from them.
  useEffect(() => {
    const entry = { channelId, atBottom: () => atBottom.current };
    onScreen.current = entry;
    return () => {
      if (onScreen.current === entry) onScreen.current = null;
    };
  }, [channelId]);
  useEffect(() => {
    // Reading a public channel one hasn't joined (a permalink, a search hit) keeps no read position: the server refuses it.
    if (!atBottom.current || !lastSeq || unreadHold.current || channel.member === false) return;
    sidebarStale.current ??= lastSeq > (channel.lastReadSeq ?? 0);
    const t = setTimeout(
      () =>
        void api(`chat/channels/${channelId}/read`, { method: "POST", body: { seq: lastSeq } })
          .then(() => {
            if (!sidebarStale.current) return;
            sidebarStale.current = false;
            router.refresh();
          })
          .catch(() => undefined),
      600,
    );
    return () => clearTimeout(t);
  }, [lastSeq, channelId, channel.lastReadSeq, channel.member, router, bottomTick]);

  // One page request at a time: scroll events fire many times while the reader is near either end.
  const paging = useRef(false);
  // Older messages load above the reader: the message at the top of the view stays exactly where it is on screen.
  const keep = useRef<{ id: string; top: number; scrollTop: number } | null>(null);
  const topRow = () => {
    const el = scrollRef.current;
    if (!el) return null;
    const edge = el.getBoundingClientRect().top;
    for (const row of el.querySelectorAll<HTMLElement>("[data-mid]")) {
      const r = row.getBoundingClientRect();
      if (r.bottom > edge) return { id: row.dataset.mid!, top: r.top - edge };
    }
    return null;
  };
  const loadOlder = async () => {
    if (before === null || paging.current) return;
    paging.current = true;
    try {
      const r = await api<{ messages: Message[]; nextBefore: number | null }>(`chat/channels/${channelId}/messages?limit=50&before=${before}`);
      // Read where the reader is only now: they may have scrolled while the page was loading.
      const row = topRow();
      keep.current = row && scrollRef.current ? { ...row, scrollTop: scrollRef.current.scrollTop } : null;
      setMessages((cur) => merge(cur, r.messages));
      setBefore(r.nextBefore);
    } finally {
      paging.current = false;
    }
  };
  // Put the reader's message back where it was, before the page paints: its new offset is known from the row sizes
  // already measured (rows are keyed by message, so they keep their heights). The new rows above are measured as they
  // scroll in and the virtualizer shifts the view by exactly their change, since they sit above the reader. A frame-by-
  // frame hold would fight the wheel and give up as soon as the reader kept scrolling (the log would jump).
  const [, rerender] = useState(0);
  useLayoutEffect(() => {
    const want = keep.current;
    keep.current = null;
    const el = scrollRef.current;
    if (!want || !el) return;
    const i = messages.findIndex((x) => x.id === want.id);
    const item = i >= 0 ? virtualizer.measurementsCache[i] : undefined;
    if (!item) return;
    pinning.current = false;
    // What the reader scrolled while the page was on its way still counts.
    const drift = el.scrollTop - want.scrollTop;
    el.scrollTop = item.start - virtualizer.options.scrollMargin + listTop() - want.top + drift;
    // The virtualizer hears of the new offset only on the next scroll event, after this paint: tell it now so the
    // rows around the reader are the ones rendered (otherwise one frame shows the rows of the old offset).
    virtualizer.scrollOffset = el.scrollTop;
    rerender((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per loaded page
  }, [messages]);

  const loadNewer = async () => {
    if (after === null || paging.current) return;
    paging.current = true;
    try {
      const r = await api<{ messages: Message[] }>(`chat/channels/${channelId}/messages?limit=50&after=${after}`);
      setMessages((cur) => merge(cur, r.messages));
      // A short page is the newest one: from here the log is live again.
      setAfter(r.messages.length === 50 ? r.messages.at(-1)!.seq : null);
    } finally {
      paging.current = false;
    }
  };
  /** Replaces the log with the newest page (leaving an older stretch). */
  const loadLatest = async () => {
    const r = await api<{ messages: Message[]; nextBefore: number | null }>(`chat/channels/${channelId}/messages?limit=50`);
    atBottom.current = true;
    setMessages((cur) =>
      merge(
        cur.filter((m) => m.pending),
        r.messages,
      ),
    );
    setBefore(r.nextBefore);
    setAfter(null);
  };
  /** Shows a message in the log with what was said around it: in place when it is loaded, else a window around it. */
  const showMessage = async (id: string, highlight = true) => {
    const known = messages.some((x) => x.id === id);
    if (!known) {
      const r = await api<{ root: Message }>(`chat/messages/${encodeURIComponent(id)}/thread`).catch(() => null);
      if (!r || r.root.channelId !== channelId) return;
      const seq = r.root.seq;
      const [up, down] = await Promise.all([
        api<{ messages: Message[]; nextBefore: number | null }>(`chat/channels/${channelId}/messages?limit=25&before=${seq}`),
        api<{ messages: Message[] }>(`chat/channels/${channelId}/messages?limit=25&after=${seq - 1}`),
      ]);
      setMessages(merge([], [...up.messages, ...down.messages]));
      setBefore(up.nextBefore);
      setAfter(down.messages.length === 25 ? down.messages.at(-1)!.seq : null);
    }
    atBottom.current = false;
    setTarget({ id, align: "center" });
    if (highlight) setFocused(id);
  };

  // A call going on in this conversation (started here): shown under the header with a "join" button.
  const [live, setLive] = useState<{ code: string; participants: number } | null>(null);
  const meet = useMeetEnabled();
  useEffect(() => {
    // No LiveKit on this server: nothing can be live, so do not poll for it.
    if (!meet) return;
    let alive = true;
    const load = () => {
      if (document.visibilityState !== "visible") return;
      void api<{ live: { code: string; participants: number } | null }>(`work/meet/channels/${channelId}/live`)
        .then((r) => alive && setLive(r.live))
        .catch(() => undefined);
    };
    load();
    const timer = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [channelId, meet]);

  // Video call from the conversation: a room named after it, the link posted here, the call in a new tab.
  const [calling, setCalling] = useState(false);
  const startCall = async () => {
    setCalling(true);
    // Opened before the requests so the browser does not treat it as an unrequested pop-up.
    const tab = window.open("", "_blank");
    try {
      const name = channel.kind === "dm" ? dir.name(channel.dmUserId ?? "") : meta.displayName || `#${meta.name ?? ""}`;
      const room = await api<{ code: string }>("work/meet/rooms", { method: "POST", body: { title: t("chat.conv.callTitle", { name }), channelId } });
      await send(t("chat.conv.callStarted", { link: `${location.origin}/meet/${room.code}` }));
      if (tab) tab.location.href = `/meet/${room.code}`;
      else router.push(`/meet/${room.code}`);
    } catch {
      tab?.close();
    } finally {
      setCalling(false);
    }
  };

  const send = async (body: string, retryOf?: Message, attachments: Attachment[] = retryOf?.attachments ?? []) => {
    const clientMsgId = retryOf?.clientMsgId ?? rid();
    const temp: Message = retryOf ?? {
      id: clientMsgId,
      channelId,
      seq: Number.MAX_SAFE_INTEGER,
      threadRootId: null,
      authorId: me,
      authorType: "user",
      body,
      mentions: [],
      replyCount: 0,
      deletedAt: null,
      editedAt: null,
      createdAt: new Date().toISOString(),
      clientMsgId,
      reactions: [],
      attachments,
      pending: true,
    };
    // Writing from an older stretch: the message goes out at the end of the conversation, so show that.
    if (detached.current) await loadLatest().catch(() => undefined);
    setMessages((cur) =>
      merge(
        cur.filter((m) => m.id !== temp.id),
        [{ ...temp, pending: true, failed: false }],
      ),
    );
    atBottom.current = true;
    setBelow(0);
    try {
      const saved = await api<Message>(`chat/channels/${channelId}/messages`, { method: "POST", body: { body, clientMsgId, attachments: attachments.map((a) => a.fileId) } });
      setMessages((cur) =>
        merge(
          cur.filter((m) => m.id !== temp.id),
          [saved],
        ),
      );
    } catch {
      setMessages((cur) => cur.map((m) => (m.id === temp.id ? { ...m, failed: true } : m)));
    }
  };

  // Messages that failed while the link was down go out by themselves once it is back, oldest first.
  const link = useConnection();
  const sendRef = useRef(send);
  sendRef.current = send;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  useEffect(() => {
    if (link !== "ok") return;
    const failedOnes = messagesRef.current.filter((m) => m.failed);
    void (async () => {
      for (const m of failedOnes) await sendRef.current(m.body, m);
    })();
  }, [link]);

  /** Runs (or re-runs) one private AI turn; the answer lands inline in the log, like a chat assistant reply. */
  const ask = async (turn: AiTurn) => {
    const patch = (p: Partial<AiTurn>) => setAiTurns((cur) => cur.map((t) => (t.id === turn.id ? { ...t, ...p } : t)));
    const { tools: _t, sources: _s, confirm: _c, deciding: _d, ...asked } = turn;
    setAiTurns((cur) => [...cur.filter((t) => t.id !== turn.id), { ...asked, answer: null, error: null }]);
    atBottom.current = true;
    try {
      if (turn.agent) {
        const r = await api<{ visibility: string; answer: string; note?: string }>(`ai/agents/${turn.agent.id}/invoke`, {
          method: "POST",
          body: { channelId, prompt: turn.question || "status" },
        });
        // A public agent answer is posted to the channel by the server and arrives over realtime.
        if (r.visibility === "private") patch({ answer: `${r.answer}${r.note ? `\n\n${r.note}` : ""}` });
        else setAiTurns((cur) => cur.filter((t) => t.id !== turn.id));
      } else {
        // The assistant that reads the workspace (and this channel's latest messages) and may propose changes; the
        // answer stays private to the asker, and nothing is changed until they approve it on the card.
        patch(answered(await askMention(channelId, turn.question)));
      }
    } catch (e) {
      const err = e as { status?: number; body?: { error?: string; message?: string } };
      patch({
        error:
          err.body?.error === "agent_budget_exceeded"
            ? t("chat.ai.budget", { message: err.body.message ?? t("chat.ai.budgetDefault") })
            : (aiProblem(t, err) ?? t(err.status === 404 ? "chat.ai.agentGone" : "chat.ai.failed")),
      });
    }
  };

  /** The asker's answer to a confirm card: the change runs (or not) and the answer carries on; another card may follow. */
  const decideTurn = async (turn: AiTurn, approve: boolean) => {
    if (!turn.confirm) return;
    const patch = (p: Partial<AiTurn>) => setAiTurns((cur) => cur.map((x) => (x.id === turn.id ? { ...x, ...p } : x)));
    patch({ deciding: true, error: null });
    patch(await decideMention(turn, approve, t));
  };

  /** @AI and @Agent go to the AI module and answer privately; everything else is a message. */
  const submit = async (body: string, attachments: Attachment[] = []) => {
    setError(null);
    if (attachments.length) {
      void send(body, undefined, attachments);
      return;
    }
    // "@AI tạo task …" drafts a task even without a company AI: the draft falls back to simple rules.
    if (body.toLowerCase().startsWith("@ai ") && TASK_INTENT.test(body.slice(4))) {
      setAiTurns((cur) => [...cur, { id: rid(), agent: null, question: body.slice(4).trim(), answer: "", error: null, propose: true }]);
      atBottom.current = true;
      return;
    }
    const agent = agents.find((a) => body.toLowerCase().startsWith(`@${a.name.toLowerCase()}`));
    if (aiOn && (body.toLowerCase().startsWith("@ai ") || agent)) {
      try {
        localStorage.setItem("wos_tried_ai", "1");
      } catch {
        /* ignore */
      }
      const question = agent ? body.slice(agent.name.length + 1).trim() : body.slice(4).trim();
      void ask({ id: rid(), agent: agent ?? null, question, answer: null, error: null });
      return;
    }
    void send(body);
  };

  const hidePreviews = async (m: Message) => {
    setMessages((cur) => cur.map((x) => (x.id === m.id ? { ...x, linkPreviews: [] } : x)));
    await api(`chat/messages/${m.id}/previews`, { method: "DELETE" }).catch(() =>
      setMessages((cur) => cur.map((x) => (x.id === m.id ? { ...x, linkPreviews: m.linkPreviews } : x))),
    );
  };
  const react = async (m: Message, emoji: string) => {
    setPicker(null);
    const r = await api<Message>(`chat/messages/${m.id}/reactions`, { method: "POST", body: { emoji } });
    setMessages((cur) => merge(cur, [r]));
  };
  const setPref = async (patch: { starred: boolean }) => {
    setPrefs((p) => ({ ...p, ...patch }));
    try {
      await api(`chat/channels/${channelId}/prefs`, { method: "PUT", body: patch });
      router.refresh();
      setFlash(t(patch.starred ? "chat.conv.flash.starred" : "chat.conv.flash.unstarred"));
    } catch {
      setPrefs((p) => ({ ...p, starred: !patch.starred }));
      setError(t("chat.conv.error.prefs"));
    }
  };
  /** Notification level or a timed mute; the bell and sidebar follow the server's answer. */
  const setNotify = async (patch: NotifyPatch) => {
    try {
      const r = await api<{ starred: boolean; muted: boolean; notify: Notify | null; mutedUntil: string | null }>(`chat/channels/${channelId}/prefs`, {
        method: "PUT",
        body: patch,
      });
      setPrefs(r);
      router.refresh();
      setFlash("notify" in patch ? t(`chat.notify.done_${patch.notify}`) : patch.muteFor === "off" ? t("chat.conv.flash.unmuted") : t(`chat.notify.done_for_${patch.muteFor}`));
    } catch {
      setError(t("chat.conv.error.prefs"));
    }
  };

  const copyLink = async (m: Message) => {
    try {
      // The permalink resolves the message (or its thread) server-side; a #id anchor only worked while the row happened to be rendered.
      await navigator.clipboard.writeText(`${window.location.origin}/app/chat/m/${m.id}`);
      setFlash(t("chat.conv.flash.linkCopied"));
    } catch {
      setError(t("chat.conv.error.copyLink"));
    }
  };
  const markUnread = async (m: Message) => {
    await api(`chat/channels/${channelId}/unread`, { method: "POST", body: { seq: m.seq } });
    setReadMark(m.seq - 1);
    unreadHold.current = true; // don't immediately mark it read again
    setFlash(t("chat.conv.flash.markedUnread"));
    router.refresh();
  };
  const jumpToLatest = () => {
    atBottom.current = true;
    setShowJump(false);
    setBelow(0);
    setBottomTick((n) => n + 1);
    if (detached.current) {
      void loadLatest().catch(() => setError(t("common.actionFailed")));
      return;
    }
    const el = scrollRef.current;
    if (aiTurns.length && el) el.scrollTo({ top: el.scrollHeight });
    else settleToEnd();
  };
  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setFlash(t("chat.conv.flash.answerCopied"));
    } catch {
      setError(t("chat.conv.error.copy"));
    }
  };
  // Save and pin toggle, and show at once (filled button, "Đã ghim" on the message); undone if the server says no.
  const flag = (m: Message, k: "saved" | "pinned", on: boolean) => setMessages((cur) => cur.map((x) => (x.id === m.id ? { ...x, [k]: on } : x)));
  const save = async (m: Message) => {
    const on = !m.saved;
    flag(m, "saved", on);
    try {
      await api(`chat/messages/${m.id}/save`, { method: on ? "POST" : "DELETE" });
      setFlash(t(on ? "chat.conv.flash.saved" : "chat.conv.flash.unsaved"));
    } catch {
      flag(m, "saved", !on);
      setError(t("chat.conv.error.prefs"));
    }
  };
  const pin = async (m: Message) => {
    const on = !m.pinned;
    flag(m, "pinned", on);
    try {
      await api(`chat/messages/${m.id}/pin`, { method: on ? "POST" : "DELETE" });
      setPinsKey((n) => n + 1);
      setFlash(t(on ? "chat.conv.flash.pinned" : "chat.conv.flash.unpinned"));
    } catch {
      flag(m, "pinned", !on);
      setError(t("chat.conv.error.prefs"));
    }
  };
  const remove = async (m: Message) => {
    if (!window.confirm(t("chat.conv.confirmDelete"))) return;
    await api(`chat/messages/${m.id}`, { method: "DELETE" });
    setMessages((cur) => cur.map((x) => (x.id === m.id ? { ...x, body: "", deletedAt: new Date().toISOString() } : x)));
  };
  const saveEdit = async (m: Message, body: string) => {
    const r = await api<Message>(`chat/messages/${m.id}`, { method: "PATCH", body: { body } });
    setMessages((cur) => merge(cur, [r]));
    setEditing(null);
  };

  // A message's secondary actions: the toolbar's "⋯" menu on desktop, and the long-press sheet on touch screens.
  const moreItems = (m: Message, mine: boolean) => [
    { label: t(m.pinned ? "chat.conv.unpin" : "chat.conv.pin"), icon: <PinIcon className="size-4" />, onSelect: () => void pin(m) },
    ...(m.authorType === "user" && m.body ? [{ label: t("chat.assign.title"), icon: <CheckCircleIcon className="size-4" />, onSelect: () => setAssigning(m) }] : []),
    ...(m.body && aiOn ? [{ label: t("chat.translate.action"), icon: <TranslateIcon className="size-4" />, onSelect: () => void translate(m) }] : []),
    { label: t("chat.forward.title"), icon: <ForwardIcon className="size-4" />, onSelect: () => setForwarding(m) },
    { label: t("chat.conv.copyLink"), icon: <LinkIcon className="size-4" />, onSelect: () => void copyLink(m) },
    ...(!mine ? [{ label: t("chat.conv.markUnread"), icon: <EyeOffIcon className="size-4" />, onSelect: () => void markUnread(m) }] : []),
    ...(mine && m.authorType === "user"
      ? [
          ...(channel.member !== false && !meta.archived ? [{ label: t("common.edit"), icon: <PencilIcon className="size-4" />, onSelect: () => setEditing(m.id) }] : []),
          { label: t("common.delete"), icon: <TrashIcon className="size-4" />, danger: true, onSelect: () => void remove(m) },
        ]
      : []),
  ];
  // Touch screens have no hover toolbar: a long press on a message opens its actions as a sheet.
  const [sheetFor, setSheetFor] = useState<Message | null>(null);
  const [searching, setSearching] = useState(false);
  // A search result opens its message's thread (a reply opens the thread it belongs to).
  const openFound = async (messageId: string) => {
    setSearching(false);
    const r = await api<{ root: { threadRootId: string | null } }>(`chat/messages/${encodeURIComponent(messageId)}/thread`).catch(() => null);
    if (!r) return;
    // The thread opens beside the log, which shows where it started with what was said around it.
    void showMessage(r.root.threadRootId ?? messageId);
    setThread(r.root.threadRootId ?? messageId);
  };
  const wide = useWideScreen();
  // Phones: the "@AI" hint made the placeholder wrap onto a second line; the hint stays on wider screens.
  const phone = useMedia(PHONE);
  const press = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressHandlers = (m: Message) =>
    m.pending || m.deletedAt
      ? {}
      : {
          onPointerDown: (e: React.PointerEvent) => {
            if (e.pointerType !== "touch") return;
            press.current = setTimeout(() => {
              press.current = null;
              navigator.vibrate?.(10);
              setSheetFor(m);
            }, 450);
          },
          onPointerUp: () => press.current && clearTimeout(press.current),
          onPointerMove: () => press.current && clearTimeout(press.current),
          onPointerCancel: () => press.current && clearTimeout(press.current),
          // Android reports a long press as a context menu: show ours instead of the browser's.
          onContextMenu: (e: React.MouseEvent) => {
            if (window.matchMedia("(hover: none)").matches) e.preventDefault();
          },
        };

  // Agent messages are authored "agent:<id>"; the channel's agent list knows their names.
  const agentName = (authorId: string) => agents.find((a) => `agent:${a.id}` === authorId)?.name ?? "Agent";
  const typingNames = Object.keys(typing).filter((u) => u !== me);
  // "Đã gửi" / "Đã xem" under my last message in a DM or group.
  const lastSent = messages.filter((m) => !m.threadRootId).at(-1);
  const seenBy = lastSent && lastSent.authorId === me && !lastSent.pending ? readers.filter((x) => x.seq >= lastSent.seq) : [];
  const receipt =
    channel.kind !== "dm" && channel.kind !== "group"
      ? ""
      : !lastSent || lastSent.authorId !== me || lastSent.pending
        ? ""
        : seenBy.length === 0
          ? t("chat.conv.sent")
          : channel.kind === "dm"
            ? t("chat.conv.seen")
            : t("chat.conv.seenBy", { names: seenBy.map((x) => dir.short(x.userId)).join(", ") });
  const title = channel.kind === "dm" ? dir.name(channel.dmUserId ?? "") : meta.displayName || meta.name || t("chat.conv.title");
  // How the channel reads in a sentence: its written name ("Kỹ thuật"), else its handle with # ("#du-an-alpha").
  const spoken = channel.kind === "dm" || meta.displayName ? title : `#${title}`;

  // The conversation's actions: in its own header row on md+; on phones in the shell bar's actions slot (one header
  // row: breadcrumb + call + "⋯"), where star and notification choices fold into "⋯" (no second bell beside the global one).
  const quiet = prefs.notify === "none" || prefs.muted || (!!prefs.mutedUntil && Date.parse(prefs.mutedUntil) > Date.now());
  const callAction =
    channel.kind === "dm" && channel.dmUserId && channel.member !== false ? (
      // One person: ring them (voice or video) instead of posting a meeting link.
      <CallButtons userId={channel.dmUserId} />
    ) : meet && channel.member !== false && !meta.archived ? (
      <button type="button" onClick={() => void startCall()} disabled={calling} className={headBtn} aria-label={t("chat.conv.call")} title={t("chat.conv.call")}>
        <VideoIcon />
      </button>
    ) : null;
  const notifyAction = channel.member !== false ? <NotifyMenu state={prefs} dm={channel.kind === "dm" || channel.kind === "group"} onChange={(p) => void setNotify(p)} /> : null;
  // Phones only: their bar has no room for the header's star, bell, search and details icons, so those live here.
  // Members, pinned messages, files and settings are all in "Chi tiết".
  const phoneMenu = (
    <Menu
      sheetOnMobile
      label={t("chat.conv.more")}
      items={[
        ...(channel.member !== false
          ? [
              { label: t(prefs.starred ? "chat.conv.unstar" : "chat.conv.star"), icon: <StarIcon />, onSelect: () => void setPref({ starred: !prefs.starred }) },
              // The bell's choices, flattened: the phone bar has room for the global bell only.
              quiet
                ? {
                    label: t("chat.notify.unmute"),
                    icon: <BellIcon />,
                    onSelect: () => void setNotify(prefs.muted || prefs.mutedUntil ? { muteFor: "off" } : { notify: "all" }),
                  }
                : { label: t("chat.notify.level_none"), icon: <BellOffIcon />, onSelect: () => void setNotify({ notify: "none" }) },
              ...(channel.kind !== "dm" && channel.kind !== "group" && !quiet && prefs.notify !== "mentions"
                ? [{ label: t("chat.notify.level_mentions"), icon: <AtIcon />, onSelect: () => void setNotify({ notify: "mentions" }) }]
                : []),
            ]
          : []),
        { label: t("chat.search.action"), icon: <SearchIcon />, onSelect: () => setSearching(true) },
        { label: t("chat.details.title"), icon: <PanelIcon />, onSelect: () => setPanel("about") },
      ]}
      trigger={
        <span title={t("chat.conv.more")} className={cx(headBtn, "[&_path]:stroke-[3]")}>
          <MoreIcon />
        </span>
      }
    />
  );

  return (
    <div className="flex h-full min-h-0 min-w-0">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={t("chat.conv.region", { title })}>
        {/* The bar's breadcrumb names the conversation (a DM's page <title> is generic). */}
        <ScreenCrumb label={title} />
        <ScreenActions>
          {callAction}
          {phoneMenu}
        </ScreenActions>
        {/* Outside the header, which phones hide: every screen keeps its h1. */}
        <h1 className="sr-only">{title}</h1>
        <header className="border-hairline border-b max-md:hidden">
          <div className={cx(col, "flex min-h-12 items-center gap-2 px-3 py-1.5 md:gap-3 md:px-5")}>
            {/* The conversation's name leads its own row (a lone "#" or topic reads as a broken header):
                a muted "#" and the channel name, or the person's face and name in a DM. */}
            {channel.kind === "dm" && channel.dmUserId ? (
              <DmHeading userId={channel.dmUserId} name={title} />
            ) : (
              <p className="text-ink m-0 flex min-w-0 max-w-[45%] shrink-0 items-center gap-2 text-[15px] font-semibold tracking-[-0.015em]">
                <ChannelAvatar c={{ kind: channel.kind, name: meta.name ?? null }} size="sm" />
                <span className="truncate">{meta.displayName ?? meta.name ?? title}</span>
              </p>
            )}
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              {channel.member !== false ? (
                <button
                  type="button"
                  onClick={() => void setPref({ starred: !prefs.starred })}
                  aria-pressed={prefs.starred}
                  aria-label={t(prefs.starred ? "chat.conv.unstar" : "chat.conv.star")}
                  title={t(prefs.starred ? "chat.conv.unstar" : "chat.conv.starHint")}
                  className={cx("hover:bg-hover -ml-1 grid size-7 shrink-0 place-items-center rounded-md", prefs.starred ? "text-signal" : "text-ink-2")}
                >
                  <StarIcon className={cx("size-3.5", prefs.starred && "fill-current")} />
                </button>
              ) : null}
              {prefs.muted ? <BellOffIcon className="text-ink-2 size-3.5 shrink-0" /> : null}
              {rt.status === "offline" ? (
                <p className="text-warn m-0 truncate text-xs">{t("chat.conv.offline")}</p>
              ) : meta.topic ? (
                <p className="text-ink-2 m-0 truncate text-[13px]" title={meta.topic}>
                  {meta.topic}
                </p>
              ) : null}
            </div>
            {channel.kind !== "dm" ? (
              <button
                type="button"
                onClick={() => setPanel("members")}
                className="hover:bg-hover flex h-8 shrink-0 items-center gap-2 rounded-md pl-1 pr-2.5 transition-colors max-sm:hidden"
                aria-label={t("chat.conv.members", { count: members.length })}
              >
                <AvatarStack ids={members} max={3} />
                <span className="text-ink-soft hidden text-[13px] font-medium tabular-nums sm:inline">{members.length}</span>
              </button>
            ) : null}
            <button type="button" onClick={() => setSearching(true)} aria-label={t("chat.search.action")} title={t("chat.search.action")} className={headBtn}>
              <SearchIcon />
            </button>
            {callAction}
            {notifyAction}
            <button
              type="button"
              onClick={() => setPanel(details ? null : "about")}
              aria-pressed={!!details}
              aria-label={t("chat.details.title")}
              title={t("chat.details.title")}
              className={headBtn}
            >
              <PanelIcon />
            </button>
          </div>
        </header>
        {live ? (
          <div role="status" className="bg-accent-wash border-hairline flex items-center gap-3 border-b px-4 py-2 text-sm">
            <VideoIcon className="text-accent-text size-4" />
            <span className="text-accent-text min-w-0 flex-1 font-medium">{t("chat.conv.liveCall", { count: live.participants })}</span>
            <a href={`/meet/${live.code}`} target="_blank" rel="noreferrer" className={cx(btnPrimary, "min-h-8 px-3 text-sm")}>
              {t("chat.conv.joinCall")}
            </a>
          </div>
        ) : null}

        <div
          // The log keeps its place itself (see loadOlder); the browser's own anchoring would fight it.
          className="min-h-0 flex-1 overflow-auto [overflow-anchor:none]"
          ref={scrollRef}
          onWheel={unpin}
          onTouchStart={unpin}
          onKeyDown={unpin}
          onScroll={(e) => {
            const el = e.currentTarget;
            if (pinning.current) {
              atBottom.current = true;
              return;
            }
            const was = atBottom.current;
            atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            // Back at the newest message: what arrived meanwhile is read now, not on the next message.
            if (atBottom.current && !was) {
              setBelow(0);
              setBottomTick((n) => n + 1);
            }
            setShowJump(!atBottom.current && el.scrollHeight - el.scrollTop - el.clientHeight > 400);
            if (el.scrollTop < 200) void loadOlder();
            if (after !== null && el.scrollHeight - el.scrollTop - el.clientHeight < 400) void loadNewer();
          }}
          role="log"
          aria-live="polite"
          aria-relevant="additions"
        >
          {before !== null ? (
            <p className="py-2 text-center">
              <button type="button" className={btn} onClick={() => void loadOlder()}>
                {t("chat.conv.loadOlder")}
              </button>
            </p>
          ) : (
            // The start of the conversation, centred: its mark, its name, who it is for, one line, and the one thing
            // to do first. With nothing said yet it sits in the middle of the pane, not in its top-left corner.
            <div className={cx(col, "flex flex-col items-center px-5 pb-6 pt-10 text-center", messages.length === 0 && "min-h-full justify-center pt-6")}>
              <ChannelAvatar
                c={{ kind: channel.kind, name: meta.name ?? null, dmUserId: channel.dmUserId ?? null }}
                size="xl"
                className={cx("mb-4", channel.kind !== "dm" && "ring-hairline text-2xl ring-1 ring-inset")}
              />
              <p className="font-display m-0 max-w-full text-balance text-[22px]/[1.2] font-semibold tracking-[-0.03em] [overflow-wrap:anywhere]">
                {channel.kind === "dm" ? spoken : (meta.displayName ?? meta.name ?? title)}
              </p>
              {channel.kind === "public" || channel.kind === "private" ? (
                <p className="text-ink-2 m-0 mt-2 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[13px]">
                  <span className="bg-selected text-ink-soft inline-flex h-6 items-center rounded-full px-2.5 font-medium">
                    {t(channel.kind === "private" ? "chat.newChat.private" : "chat.newChat.public")}
                  </span>
                  <span>{t("chat.conv.members", { count: members.length })}</span>
                </p>
              ) : null}
              <p className="text-ink-2 m-0 mt-3 max-w-md text-pretty text-sm/[1.5]">
                {channel.kind === "dm" ? t("chat.conv.startDm", { name: title }) : t("chat.conv.startChannel", { name: spoken, topic: meta.topic })}
              </p>
              {channel.kind !== "dm" && channel.member !== false && !meta.archived ? (
                <button type="button" className={cx(btn, "mt-5")} onClick={() => setPanel("members")}>
                  <UsersIcon className="size-4" />
                  {t("chat.drawers.addPeople")}
                </button>
              ) : null}
            </div>
          )}
          <div ref={listRef} className="relative" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((v) => {
              const m = messages[v.index]!;
              const prev = messages[v.index - 1];
              const head = startsGroup(prev, m);
              const newDay = !prev || dayLabel(prev.createdAt) !== dayLabel(m.createdAt);
              const mine = m.authorId === me;
              const mentioned = m.mentions.includes(me);
              const firstUnread = m.id === firstUnreadId;
              return (
                <div
                  key={m.id}
                  data-index={v.index}
                  data-mid={m.id}
                  ref={virtualizer.measureElement}
                  // Each row's transform is its own stacking context, so a menu or emoji grid opened in it would sit
                  // under the rows that follow: lift the row whose popover is open.
                  className={cx("absolute inset-x-0 top-0 has-[[aria-expanded=true]]:z-20", picker === m.id && "z-20")}
                  style={{ transform: `translateY(${v.start - virtualizer.options.scrollMargin}px)` }}
                >
                  {newDay ? (
                    <div className={cx(col, "flex items-center gap-3 px-5 pb-1 pt-4")} role="separator">
                      <span className="bg-hairline h-px flex-1" />
                      <span className="text-ink-2 text-xs font-medium">{f.dayLabel(m.createdAt)}</span>
                      <span className="bg-hairline h-px flex-1" />
                    </div>
                  ) : null}
                  {firstUnread ? (
                    <div className={cx(col, "flex items-center gap-3 px-5 pb-1 pt-2")} role="separator" aria-label={t("chat.conv.newMessages")}>
                      <span className="bg-signal/50 h-px flex-1" />
                      <span className="text-signal-text text-xs font-semibold">{t("chat.conv.newMessages")}</span>
                    </div>
                  ) : null}
                  <MessageItem
                    m={m}
                    me={me}
                    head={head}
                    agentName={agentName}
                    className={cx(col, "px-5")}
                    tone={focused === m.id ? "focused" : mentioned ? "mentioned" : "default"}
                    editing={editing === m.id}
                    onSaveEdit={(b) => void saveEdit(m, b)}
                    onCancelEdit={() => setEditing(null)}
                    picker={picker === m.id}
                    onPicker={(open) => setPicker(open ? m.id : null)}
                    onReact={(e) => void react(m, e)}
                    onThread={() => setThread(m.id)}
                    onSave={() => void save(m)}
                    remindItems={remindOptions().map((o) => ({ label: o.label, onSelect: () => void remind(m, o.at) }))}
                    moreItems={moreItems(m, mine)}
                    onHidePreviews={mine ? () => void hidePreviews(m) : undefined}
                    onPoll={(poll) => setMessages((cur) => cur.map((x) => (x.id === m.id ? { ...x, poll } : x)))}
                    translation={translations[m.id]}
                    rowProps={pressHandlers(m)}
                    extra={
                      <>
                        {!m.deletedAt &&
                        !m.pending &&
                        m.authorType === "user" &&
                        (mine || mentioned || channel.kind === "dm") &&
                        mountedAt !== null &&
                        mountedAt - Date.parse(m.createdAt) < 14 * 86400_000 ? (
                          <SignalChips
                            messageId={m.id}
                            channelId={channelId}
                            text={m.body}
                            assigneeId={mentioned ? me : (m.mentions.find((x) => x !== me && !x.startsWith("agent:")) ?? me)}
                            mine={mine}
                          />
                        ) : null}
                        {m.failed ? (
                          <p className="text-block mt-1 flex items-center gap-2 text-sm">
                            {t("chat.conv.sendFailed")}{" "}
                            <button type="button" className="underline" onClick={() => void send(m.body, m)}>
                              {t("chat.conv.resend")}
                            </button>
                          </p>
                        ) : null}
                        {m.authorType === "system" && m.replyCount > 0 && aiOn ? (
                          // Onboarding step 4 (design Issue 6): the welcome thread invites a first AI action.
                          <p className="mt-2">
                            <button
                              type="button"
                              className={cx(btn, btnSm)}
                              onClick={() => {
                                setThread(m.id);
                                setAutoSummarize(true);
                              }}
                            >
                              <SparkleIcon className="size-4" aria-hidden="true" />
                              {t("chat.conv.tryAi")}
                            </button>
                          </p>
                        ) : null}
                      </>
                    }
                  />
                </div>
              );
            })}
          </div>
          {aiTurns.length ? (
            <div className={cx(col, "grid gap-3 px-5 pt-3")}>
              {aiTurns.map((t) => (
                <AiTurnView
                  key={t.id}
                  turn={t}
                  me={me}
                  names={names}
                  onRetry={() => void ask(t)}
                  onDecide={t.confirm && !t.deciding ? (approve) => decideTurn(t, approve) : undefined}
                  onCopy={(a) => void copyText(a)}
                  onHide={() => setAiTurns((cur) => cur.filter((x) => x.id !== t.id))}
                />
              ))}
            </div>
          ) : null}
          <div className="h-6" />
        </div>

        <div className={cx(col, "relative px-4 pb-4 md:px-5")}>
          {/* Floats over the log's bottom spacer, so an idle conversation doesn't reserve a blank line. */}
          <p className="text-ink-2 pointer-events-none absolute -top-5 left-5 text-xs md:left-6" aria-live="polite">
            {typingNames.length ? t("chat.conv.typing", { names: typingNames.map((u) => dir.short(u)).join(", ") }) : ""}
          </p>
          {receipt && !typingNames.length ? (
            <p className={cx("pointer-events-none absolute -top-5 right-5 text-xs md:right-6", seenBy.length ? "text-ok" : "text-ink-2")} data-testid="receipt">
              {seenBy.length ? "✓✓ " : "✓ "}
              {receipt}
            </p>
          ) : null}
          {showJump || below > 0 || after !== null ? (
            <button
              type="button"
              onClick={jumpToLatest}
              className="border-hairline bg-surface hover:bg-hover shadow-popover absolute -top-12 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-md border px-3.5 py-1.5 text-sm font-medium"
            >
              <ArrowDownIcon className="size-3.5" />
              {below > 0 ? t("chat.conv.newBelow", { count: below }) : t("chat.conv.jumpLatest")}
            </button>
          ) : null}
          {error ? (
            <p className="text-block mb-1 text-sm" role="alert">
              {error}
            </p>
          ) : null}
          {flash ? (
            <p className="text-ok mb-1 text-sm" role="status">
              {flash}
            </p>
          ) : null}
          {meta.archived ? (
            <div className="border-hairline bg-hover flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3 text-sm" role="note">
              <span className="flex-1">{t("chat.conv.archived")}</span>
              {channel.canManage ? (
                <button
                  type="button"
                  className={btn}
                  onClick={() =>
                    void api(`chat/channels/${channelId}`, { method: "PATCH", body: { archived: false } })
                      .then((r) => {
                        const u = r as { name: string; displayName?: string | null; topic: string; archived: boolean };
                        setMeta({ name: u.name, displayName: u.displayName ?? null, topic: u.topic, archived: u.archived });
                        router.refresh();
                      })
                      .catch(failed)
                  }
                >
                  {t("chat.conv.restore")}
                </button>
              ) : null}
            </div>
          ) : channel.member === false ? (
            <div className="border-hairline bg-hover flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3 text-sm" role="note">
              <span className="min-w-0 flex-1">{t("chat.conv.notMember")}</span>
              <button
                type="button"
                className={btnPrimary}
                onClick={() =>
                  void api(`chat/channels/${channelId}/join`, { method: "POST" })
                    .then(() => router.refresh())
                    .catch(failed)
                }
              >
                {t("chat.conv.joinChannel")}
              </button>
            </div>
          ) : (
            <>
              {scheduled.length ? (
                <ul className="m-0 mb-2 grid list-none gap-1 p-0" aria-label={t("chat.scheduled.title")}>
                  {scheduled.map((x) => (
                    <li key={x.id} className="bg-hover flex items-center gap-2 rounded-md px-3 py-1.5 text-xs">
                      <ClockIcon className="text-ink-2 size-3.5 shrink-0" />
                      <span className="text-ink-2 shrink-0">{t("chat.scheduled.at", { when: `${time(x.at)} ${dayLabel(x.at)}` })}</span>
                      <span className="min-w-0 flex-1 truncate">{x.body.replace(/<@([A-Za-z0-9_-]{1,64})>/g, (_, id: string) => `@${dir.name(id)}`)}</span>
                      <button
                        type="button"
                        className="text-brand-text shrink-0 font-medium hover:underline"
                        onClick={() =>
                          void api(`chat/scheduled/${x.id}`, { method: "DELETE" })
                            .then(() => setScheduled((l) => l.filter((y) => y.id !== x.id)))
                            .catch(failed)
                        }
                      >
                        {t("chat.scheduled.cancel")}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              <Composer
                onPoll={() => setPolling(true)}
                onSchedule={async (body, at) => {
                  try {
                    const r = await api<{ id: string; at: string }>(`chat/channels/${channelId}/scheduled`, { method: "POST", body: { body, at: at.toISOString() } });
                    setScheduled((l) => [...l, { id: r.id, body, at: r.at }].sort((a, b) => a.at.localeCompare(b.at)));
                    setFlash(t("chat.scheduled.done", { when: `${time(r.at)} ${dayLabel(r.at)}` }));
                  } catch {
                    setFlash(t("chat.scheduled.failed"));
                  }
                }}
                placeholder={t(aiOn && !phone ? "chat.conv.placeholder" : "chat.conv.placeholderNoAi", { target: spoken })}
                candidates={[
                  ...members.map((id) => ({ id, name: dir.name(id) })),
                  ...(aiOn ? [...agents.map((a) => ({ id: `agent:${a.id}`, name: a.name, agent: true })), { id: "ai", name: "AI", agent: true }] : []),
                ]}
                onTyping={() => {
                  if (Date.now() - lastTyping.current > 3000) {
                    rt.emit("typing", { channelId });
                    lastTyping.current = Date.now();
                  }
                }}
                onSubmit={(b, files) => void submit(b, files)}
                onUpload={(file) => uploadChatFile(channelId, file)}
                draftKey={channelId}
                onEditLast={() => {
                  const last = [...messages].reverse().find((x) => x.authorId === me && x.authorType === "user" && !x.deletedAt && !x.pending);
                  if (last) setEditing(last.id);
                }}
              />
            </>
          )}
        </div>
      </section>
      {/* Wide screens: the thread is a pane beside the conversation; narrower ones open it as a drawer over it. */}
      {thread ? (
        <ThreadPanel
          key={thread}
          rootId={thread}
          docked={wide}
          canReply={channel.member !== false && !meta.archived}
          channelId={channelId}
          me={me}
          incoming={threadIncoming}
          previews={threadPreviews}
          autoSummarize={autoSummarize}
          onClose={() => {
            setThread(null);
            setAutoSummarize(false);
          }}
        />
      ) : null}
      {details ? (
        <ChannelDetails
          channel={channel}
          title={title}
          topic={meta.topic}
          members={members}
          tab={details}
          onTab={setPanel}
          onMembersChange={setMembers}
          onClose={() => setPanel(null)}
          onOpenPin={(id) => {
            setPanel(null);
            setThread(id);
          }}
          onSettings={
            channel.canManage
              ? () => {
                  setPanel(null);
                  setSettings(true);
                }
              : undefined
          }
          filesKey={filesKey}
          pinsKey={pinsKey}
        />
      ) : null}
      {assigning ? (
        <AssignDialog
          message={assigning}
          channelId={channelId}
          onClose={() => setAssigning(null)}
          onDone={(code) => {
            setAssigning(null);
            setFlash(t("chat.assign.done", { code }));
          }}
        />
      ) : null}
      {polling ? <PollDialog channelId={channelId} onClose={() => setPolling(false)} /> : null}
      {searching ? <ChannelSearch channelId={channelId} spoken={spoken} onOpen={(id) => void openFound(id)} onClose={() => setSearching(false)} /> : null}
      {sheetFor ? (
        <MessageSheet
          title={t("chat.conv.messageActions")}
          quick={QUICK}
          onReact={(e) => void react(sheetFor, e)}
          onMoreReactions={() => setPicker(sheetFor.id)}
          onClose={() => setSheetFor(null)}
          reactions={sheetFor.reactions.map((r) => ({
            emoji: r.emoji,
            // The emoji leads the row already: names only.
            text: reactorsText(t, r.users ?? [], r.count, me, dir.name),
          }))}
          actions={[
            { label: t("chat.conv.replyThread"), icon: <ThreadIcon className="size-4" />, onSelect: () => setThread(sheetFor.id) },
            ...(sheetFor.body ? [{ label: t("chat.conv.copyText"), icon: <CopyIcon className="size-4" />, onSelect: () => void copyText(sheetFor.body) }] : []),
            {
              label: t(sheetFor.saved ? "chat.conv.unsaveMessage" : "chat.conv.saveMessage"),
              icon: <BookmarkIcon className="size-4" />,
              onSelect: () => void save(sheetFor),
            },
            ...moreItems(sheetFor, sheetFor.authorId === me),
          ]}
        />
      ) : null}
      {forwarding ? (
        <ForwardDialog
          messageId={forwarding.id}
          preview={forwarding.body}
          onClose={() => setForwarding(null)}
          onDone={(_, label) => {
            setForwarding(null);
            setFlash(t("chat.forward.done", { where: label }));
          }}
        />
      ) : null}
      {settings ? (
        <ChannelSettings
          channelId={channelId}
          isDefault={!!channel.isDefault}
          autoJoin={channel.canSetAutoJoin ? { on: !!channel.autoJoin } : null}
          meta={meta}
          onClose={() => setSettings(false)}
          onSaved={(m) => {
            setMeta({ ...m, displayName: m.displayName ?? null });
            setSettings(false);
            setFlash(t(m.archived ? "chat.conv.flash.archived" : "chat.conv.flash.settingsSaved"));
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}

const WIDE = "(min-width: 1280px)";
const PHONE = "(max-width: 639px)";
/** Whether a media query matches now (follows resizes); false on the server. */
function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const q = window.matchMedia(query);
      q.addEventListener("change", cb);
      return () => q.removeEventListener("change", cb);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
/** Whether the window is wide enough for a thread pane beside the conversation. */
const useWideScreen = () => useMedia(WIDE);
