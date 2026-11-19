"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/client";
import { useFormat, useT } from "@/lib/i18n/client";
import { Avatar, AvatarStack, ChannelAvatar, useDirectory } from "@/lib/people";
import { btnGhost, btnSm, cx } from "@/lib/ui";
import { ArrowRightIcon, CheckIcon, ChevronLeftIcon, HashIcon, LockIcon, ThreadIcon } from "@/components/app/icons";
import { card, IconTile } from "@/components/ui/Bento";
import { INBOX_MARK, type InboxTab } from "./inbox";
import { SpotArea } from "@/components/ui/SpotArea";
import { RichText } from "./RichText";
import { PageHead } from "./PageHead";
import { Tabs } from "@/components/ui/Tabs";
import { LoadFailed } from "@/components/ui/LoadFailed";
import type { Message } from "./Conversation";

export interface ChannelRef {
  id: string;
  kind: string;
  name: string | null;
  displayName?: string | null;
  dmUserId: string | null;
}
export interface ThreadItem {
  root: Message;
  channel: ChannelRef | null;
  lastReply: { authorId: string; body: string; createdAt: string } | null;
  participants: string[];
}

const INBOX: {
  id: InboxTab;
  key: "chat.lists.tabUnreads" | "chat.lists.tabThreads" | "chat.lists.tabMentions" | "chat.lists.tabSaved";
  title: "chat.lists.unreadsTitle" | "chat.lists.threadsTitle" | "chat.lists.mentionsTitle" | "chat.lists.savedTitle";
}[] = [
  { id: "unreads", key: "chat.lists.tabUnreads", title: "chat.lists.unreadsTitle" },
  { id: "threads", key: "chat.lists.tabThreads", title: "chat.lists.threadsTitle" },
  { id: "mentions", key: "chat.lists.tabMentions", title: "chat.lists.mentionsTitle" },
  { id: "saved", key: "chat.lists.tabSaved", title: "chat.lists.savedTitle" },
];
/** The lists' column: Home's left-aligned reading width. */
const column = "w-full max-w-3xl px-4 md:px-7";
/** One white card of message rows, drawn by its hairline ring. */
const listCard = "divide-divider-soft bg-surface shadow-card m-0 list-none divide-y overflow-hidden rounded-xl p-0";

/**
 * Hộp thư: one header over the four cross-channel views (unread, threads, mentions, saved), each still
 * its own URL; the open tab carries its count, the page's one action sits on the right.
 */
function InboxHeader({ active, count, action }: { active: InboxTab; count?: number; action?: React.ReactNode }) {
  const t = useT();
  return (
    <>
      <div className={cx(column, "pt-5 md:pt-7")}>
        <PageHead
          title={t("chat.lists.inboxTitle")}
          lead={
            <Link href="/app/chat" className="text-ink-2 hover:bg-hover -ml-2 grid size-8 place-items-center rounded-md md:hidden" aria-label={t("common.back")}>
              <ChevronLeftIcon />
            </Link>
          }
          actions={action}
        />
      </div>
      {/* Only the tab row stays while the list scrolls: the title would take a fifth of a phone's screen. */}
      <div className={cx(column, "bg-panel sticky top-0 z-10 pt-3")}>
        <div className="border-divider border-b">
          <Tabs
            label={t("chat.lists.inboxTitle")}
            active={active}
            tabs={INBOX.map((x) => ({ key: x.id, label: t(x.key), href: `/app/chat/${x.id}`, count: x.id === active && count ? count : undefined }))}
          />
        </div>
      </div>
    </>
  );
}

function Where({ c }: { c: ChannelRef | null | undefined }) {
  const dir = useDirectory();
  const t = useT();
  if (!c) return null;
  if (c.kind === "dm") return <span className="text-ink-2 inline-flex items-center gap-1 text-xs">{t("chat.lists.dmWith", { name: dir.name(c.dmUserId ?? "") })}</span>;
  const I = c.kind === "private" ? LockIcon : HashIcon;
  return (
    <span className="text-ink-2 inline-flex items-center gap-0.5 text-xs font-medium">
      <I className="size-3" />
      {c.displayName || c.name}
    </span>
  );
}

/** An empty view is one slim calm card (Home's quiet strip): the view's tinted icon, the one-line explanation, a tick. */
function Empty({ tab, children }: { tab: InboxTab; children: React.ReactNode }) {
  const [I, tone] = INBOX_MARK[tab];
  return (
    <div className={cx(column, "pt-5")}>
      <div className="bg-surface shadow-card flex min-h-[4.75rem] items-center gap-3.5 rounded-xl px-5 py-4 max-sm:px-4">
        <IconTile tone={tone}>
          <I />
        </IconTile>
        <p className="text-ink-2 m-0 min-w-0 flex-1 text-pretty text-[13px]/[1.5]">{children}</p>
        <span aria-hidden="true" className="bg-ok-wash text-ok ring-current/15 grid size-6 shrink-0 place-items-center rounded-full ring-1 ring-inset">
          <CheckIcon className="size-3.5" />
        </span>
      </div>
    </div>
  );
}

function MessageRow({ m, channel, highlight }: { m: Message; channel?: ChannelRef | null; highlight?: boolean }) {
  const dir = useDirectory();
  const f = useFormat();
  const author = m.authorType === "system" ? "system" : m.authorId;
  return (
    // The whole row opens the message, but the body can hold its own links (mentions, URLs) and an <a> inside an <a>
    // is invalid HTML (a hydration error): one link stretched under the row, the body's own links on top of it.
    <li
      className={cx(
        "text-ink has-[>a:hover]:bg-hover/60 relative grid grid-cols-[32px_minmax(0,1fr)] gap-3 px-5 py-3.5 transition-colors max-sm:px-4",
        highlight && "bg-signal-wash/40 shadow-[inset_2px_0_0_var(--color-accent)]",
      )}
    >
      <Link
        href={`/app/chat/${m.channelId}?m=${m.id}`}
        aria-label={`${dir.name(author)}: ${m.body.slice(0, 80)}`}
        className="focus-visible:outline-accent absolute inset-0 focus-visible:outline-2 focus-visible:-outline-offset-2"
      />
      <span className="pointer-events-none contents [&_a]:pointer-events-auto [&_a]:relative">
        <Avatar id={author} size="md" />
        <span className="min-w-0">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-sm font-semibold">{dir.name(author)}</span>
            <Where c={channel} />
            {m.threadRootId ? <span className="text-ink-2 text-xs">{f.t("chat.lists.inThread")}</span> : null}
            <span className="text-ink-2 ml-auto text-xs tabular-nums">
              {f.dayLabel(m.createdAt)} {f.time(m.createdAt)}
            </span>
          </span>
          <span className="mt-0.5 block whitespace-pre-wrap text-sm/[1.5] [overflow-wrap:anywhere]">
            <RichText text={m.body} names={dir.names} me={dir.me} />
          </span>
        </span>
      </span>
    </li>
  );
}

export function SavedList({ messages }: { messages: (Message & { channel?: ChannelRef | null })[] }) {
  const t = useT();
  return (
    <div className="min-h-0 overflow-auto">
      <InboxHeader active="saved" count={messages.length} />
      {messages.length === 0 ? (
        <Empty tab="saved">{t("chat.lists.savedEmpty")}</Empty>
      ) : (
        <div className={cx(column, "pb-10 pt-4")}>
          <ul className={listCard}>
            {messages.map((m) => (
              <MessageRow key={m.id} m={m} channel={m.channel} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function MentionsList({ messages }: { messages: (Message & { channel: ChannelRef | null })[] }) {
  const dir = useDirectory();
  const t = useT();
  return (
    <div className="min-h-0 overflow-auto">
      <InboxHeader active="mentions" count={messages.length} />
      {messages.length === 0 ? (
        <Empty tab="mentions">{t("chat.lists.mentionsEmpty", { name: dir.name(dir.me) })}</Empty>
      ) : (
        <div className={cx(column, "pb-10 pt-4")}>
          <ul className={listCard}>
            {messages.map((m) => (
              <MessageRow key={m.id} m={m} channel={m.channel} highlight={Date.now() - Date.parse(m.createdAt) < 86400_000} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function ThreadsList({ threads }: { threads: ThreadItem[] }) {
  const { dayLabel } = useFormat();
  const dir = useDirectory();
  const { t: tr, ago, time } = useFormat();
  return (
    <div className="min-h-0 overflow-auto">
      <InboxHeader active="threads" count={threads.length} />
      {threads.length === 0 ? (
        <Empty tab="threads">{tr("chat.lists.threadsEmpty")}</Empty>
      ) : (
        <SpotArea className={cx(column, "pb-10 pt-4")}>
          <ul className="m-0 grid list-none gap-3 p-0">
            {threads.map((t) => (
              <li key={t.root.id} className={cx(card, "group/row overflow-hidden rounded-xl")}>
                <Link href={`/app/chat/${t.root.channelId}?m=${t.root.id}`} className="text-ink relative z-[1] block no-underline">
                  <div className="flex min-h-11 items-center gap-2 px-5 pt-3 max-sm:px-4">
                    <Where c={t.channel} />
                    <span className="flex-1" />
                    <AvatarStack ids={t.participants} max={4} />
                  </div>
                  <div className="grid grid-cols-[32px_minmax(0,1fr)] gap-3 px-5 pb-4 pt-2 max-sm:px-4">
                    <Avatar id={t.root.authorId} size="md" />
                    <span className="min-w-0">
                      <span className="flex items-baseline gap-2">
                        <span className="text-sm font-semibold">{dir.name(t.root.authorId)}</span>
                        <span className="text-ink-2 text-xs tabular-nums">
                          {dayLabel(t.root.createdAt)} {time(t.root.createdAt)}
                        </span>
                      </span>
                      <span className="line-clamp-3 block text-sm/[1.5]">
                        <RichText text={t.root.body} names={dir.names} me={dir.me} compact />
                      </span>
                    </span>
                  </div>
                  <div className="border-divider-soft flex flex-wrap items-center gap-x-2.5 gap-y-1 border-t px-5 py-2.5 text-[13px] max-sm:px-4">
                    <span className="bg-tangerine-wash text-tangerine-text ring-current/10 inline-flex min-h-6 items-center gap-1.5 rounded-full px-2 text-xs font-semibold tabular-nums ring-1 ring-inset">
                      <ThreadIcon className="size-3.5" />
                      {tr("chat.lists.replies", { count: t.root.replyCount })}
                    </span>
                    {t.lastReply ? (
                      <span className="text-ink-2 min-w-0 flex-1 truncate">
                        <span className="text-ink-soft font-medium">{dir.name(t.lastReply.authorId)}</span>: <RichText text={t.lastReply.body} names={dir.names} compact />
                      </span>
                    ) : (
                      <span className="flex-1" />
                    )}
                    {t.root.lastReplyAt ? <span className="text-ink-2 text-xs tabular-nums">{ago(t.root.lastReplyAt)}</span> : null}
                    <ArrowRightIcon aria-hidden="true" className="text-ink-2 size-3.5 shrink-0 transition-transform group-hover/row:translate-x-0.5" />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </SpotArea>
      )}
    </div>
  );
}

export interface UnreadGroup {
  channel: ChannelRef;
  unread: number;
  lastSeq: number;
  /** Null when that conversation's messages did not load: the card still shows, with a retry. */
  messages: Message[] | null;
}

/** Every conversation with new messages, one card each; "Đã đọc" clears a card, "Đánh dấu tất cả" clears the page. */
export function UnreadsList({ groups: initial }: { groups: UnreadGroup[] }) {
  const t = useT();
  const dir = useDirectory();
  const router = useRouter();
  const [groups, setGroups] = useState(initial);
  const total = groups.reduce((n, g) => n + g.unread, 0);
  const markRead = async (g: UnreadGroup) => {
    setGroups((cur) => cur.filter((x) => x.channel.id !== g.channel.id));
    await api(`chat/channels/${g.channel.id}/read`, { method: "POST", body: { seq: g.lastSeq } }).catch(() => undefined);
    router.refresh();
  };
  const markAll = async () => {
    setGroups([]);
    await api("chat/read-all", { method: "POST" }).catch(() => undefined);
    router.refresh();
  };
  const name = (c: ChannelRef) => (c.kind === "dm" ? dir.name(c.dmUserId ?? "") : c.displayName || c.name || "");
  return (
    <div className="min-h-0 overflow-auto">
      <InboxHeader
        active="unreads"
        count={total}
        action={
          groups.length ? (
            <button type="button" className={cx(btnGhost, btnSm)} onClick={() => void markAll()}>
              <CheckIcon className="size-4" />
              {t("chat.lists.markAllRead")}
            </button>
          ) : null
        }
      />
      {groups.length === 0 ? (
        <Empty tab="unreads">{t("chat.lists.unreadsEmpty")}</Empty>
      ) : (
        <div className={cx(column, "grid gap-4 pb-10 pt-4")}>
          {groups.map((g) => (
            <section key={g.channel.id} className="bg-surface shadow-card overflow-hidden rounded-xl" aria-label={g.channel.name ?? t("chat.lists.dmWith", { name: "" })}>
              <div className="border-divider-soft flex min-h-14 items-center gap-3 border-b px-5 py-2.5 max-sm:px-4">
                <ChannelAvatar c={{ kind: g.channel.kind, name: g.channel.displayName || g.channel.name, dmUserId: g.channel.dmUserId }} size="md" />
                <Link href={`/app/chat/${g.channel.id}`} className="text-ink group/name flex min-w-0 items-center gap-1 text-sm font-semibold tracking-[-0.01em] no-underline">
                  {g.channel.kind === "private" ? <LockIcon className="text-ink-2 size-3.5 shrink-0" /> : null}
                  <span className="truncate group-hover/name:underline">{name(g.channel)}</span>
                </Link>
                <span className="bg-sky-wash text-sky-text ring-current/10 inline-flex min-h-6 shrink-0 items-center rounded-full px-2 text-xs font-medium tabular-nums ring-1 ring-inset">
                  {t("chat.lists.newCount", { count: g.unread })}
                </span>
                <span className="flex-1" />
                <button type="button" onClick={() => void markRead(g)} className={cx(btnGhost, btnSm, "shrink-0")}>
                  <CheckIcon className="size-3.5" />
                  <span className="max-sm:sr-only">{t("chat.lists.markRead")}</span>
                </button>
              </div>
              {g.messages === null ? (
                <LoadFailed className="px-5 py-3" />
              ) : g.messages.length ? (
                <ul className="divide-divider-soft m-0 list-none divide-y p-0">
                  {g.messages.map((m) => (
                    <MessageRow key={m.id} m={m} />
                  ))}
                </ul>
              ) : null}
              {g.messages && g.unread > g.messages.length ? (
                // Replies inside threads count as new too but are not listed here: open the channel for them.
                <Link
                  href={`/app/chat/${g.channel.id}`}
                  className="border-divider-soft text-accent-text hover:bg-hover/60 group/more flex items-center gap-1.5 border-t px-5 py-2.5 text-[13px] font-medium no-underline transition-colors max-sm:px-4"
                >
                  {g.messages.length ? t("chat.lists.openForMore", { count: g.unread - g.messages.length }) : t("chat.lists.openForReplies")}
                  <ArrowRightIcon aria-hidden="true" className="size-3.5 transition-transform group-hover/more:translate-x-0.5" />
                </Link>
              ) : null}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
