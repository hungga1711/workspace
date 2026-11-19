"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/client";
import { Avatar, useDirectory, ChannelAvatar } from "@/lib/people";
import { btn, btnPrimary, btnSm, cardLink, cx } from "@/lib/ui";
import { useFormat } from "@/lib/i18n/client";
import { useAiEnabled } from "@/lib/ai-context";
import { useOpenAsks } from "@/components/workflows/useOpenAsks";
import { ArrowRightIcon, BotIcon, ChatIcon, ChevronDownIcon, FolderIcon, HashIcon, InboxIcon, PlusIcon, SparkleIcon, UsersIcon } from "@/components/app/icons";
import { card, IconTile, Tile, tileRow } from "@/components/ui/Bento";
import { SpotArea } from "@/components/ui/SpotArea";
import { useNewParam } from "@/lib/deeplink";
import type { ChannelSummary } from "@/components/shell/types";
import { NewChannelModal, NewDmModal } from "./NewConversation";
import { useLiveChannels } from "./useLiveChannels";
import { PageHead } from "./PageHead";
import { INBOX_MARK } from "./inbox";
import { channelTitle } from "@/components/home/channelTitle";

type Brief = { id: string; name: string; displayName?: string | null; topic: string };

/**
 * Tin nhắn: the same overview on every width, so the sidebar and the phone's bottom bar lead to the same place: the four inbox views, what is unread (mentions
 * first), recent conversations, people to message and channels to join. `?new=dm|channel` opens its dialog first.
 */
export function ChatIndex({ channels: rendered, browsable, archived = [] }: { channels: ChannelSummary[]; browsable: Brief[]; archived?: Brief[] }) {
  const dir = useDirectory();
  // Live like the sidebar (the phone has no sidebar: this list is its only view of what is unread).
  const channels = useLiveChannels(rendered, dir.me);
  const router = useRouter();
  const { t, ago } = useFormat();
  const aiOn = useAiEnabled();
  // A task's agent waiting for answers: temporary items, the phone's only way to them (the sidebar has them too).
  const asks = useOpenAsks();
  const [dmLink, setDmLink] = useNewParam("dm");
  const [channelLink, setChannelLink] = useNewParam("channel");
  const [modal, setModal] = useState<"channel" | "dm" | null>(dmLink ? "dm" : channelLink ? "channel" : null);
  const [busy, setBusy] = useState<string | null>(null);
  const close = () => {
    setModal(null);
    setDmLink(false);
    setChannelLink(false);
  };
  const join = async (id: string) => {
    setBusy(id);
    try {
      await api(`chat/channels/${id}/join`, { method: "POST" });
      router.push(`/app/chat/${id}`);
      router.refresh();
    } finally {
      setBusy(null);
    }
  };
  const dmWith = async (userId: string) => {
    setBusy(userId);
    try {
      const r = await api<{ id: string }>("chat/dms", { method: "POST", body: { userId } });
      router.push(`/app/chat/${r.id}`);
      router.refresh();
    } finally {
      setBusy(null);
    }
  };
  const label = (c: ChannelSummary) => (c.kind === "dm" ? dir.name(c.dmUserId ?? "") : (channelTitle(c) ?? t("chat.index.group")));
  const recentFirst = (a: ChannelSummary, b: ChannelSummary) => Date.parse(b.lastMessageAt ?? "0") - Date.parse(a.lastMessageAt ?? "0");
  const unread = channels.filter((c) => c.unread > 0).sort((a, b) => b.mentions - a.mentions || recentFirst(a, b));
  const recent = channels.filter((c) => c.unread === 0).sort(recentFirst);
  const totalUnread = unread.reduce((n, c) => n + c.unread, 0);
  // Colleagues without a DM yet: the easiest first conversation to start.
  const talked = new Set(channels.filter((c) => c.kind === "dm").map((c) => c.dmUserId));
  const people = dir.people.filter((p) => p.userId !== dir.me && !talked.has(p.userId)).slice(0, 6);

  const rows = (list: ChannelSummary[]) => (
    <ul className="m-0 mt-3 grid list-none grid-cols-[minmax(0,1fr)] gap-0.5 p-0">
      {list.map((c) => (
        <li key={c.id}>
          <Link href={`/app/chat/${c.id}`} className={cx(tileRow, "text-ink group/row min-h-14 no-underline")}>
            <ChannelAvatar c={{ ...c, name: c.name ?? c.displayName ?? null }} size="md" />
            <span className="min-w-0 flex-1">
              <span className={cx("block truncate text-sm", c.unread > 0 ? "font-semibold" : "font-medium")}>{label(c)}</span>
              <span className="text-ink-2 block truncate text-xs">
                {c.unread > 0
                  ? `${c.mentions > 0 ? t("chat.index.mentionsPrefix", { count: c.mentions }) : ""}${t("chat.index.unread", { count: c.unread })}`
                  : c.topic || (c.kind === "dm" ? t("chat.index.dm") : c.memberCount ? t("chat.index.members", { count: c.memberCount }) : t("chat.index.channel"))}
              </span>
            </span>
            {/* The line under the name already counts the unread messages; only a mention earns a mark. */}
            {c.mentions > 0 ? <span className="bg-block ring-block/20 size-2 shrink-0 rounded-full ring-4" aria-hidden="true" /> : null}
            {c.lastMessageAt ? (
              <time dateTime={c.lastMessageAt} className="text-ink-2 shrink-0 text-right text-xs tabular-nums sm:w-20">
                {ago(c.lastMessageAt)}
              </time>
            ) : null}
            <ArrowRightIcon
              aria-hidden="true"
              className="text-ink-2 size-3.5 shrink-0 opacity-0 transition-[opacity,transform] group-hover/row:translate-x-0.5 group-hover/row:opacity-100 max-sm:hidden"
            />
          </Link>
        </li>
      ))}
    </ul>
  );
  const views = [
    ["unreads", "/app/chat/unreads", "chat.lists.unreadsTitle", totalUnread],
    ["threads", "/app/chat/threads", "chat.index.threads", 0],
    ["mentions", "/app/chat/mentions", "chat.index.mentions", 0],
    ["saved", "/app/chat/saved", "chat.index.saved", 0],
  ] as const;

  return (
    <div>
      <SpotArea className="flex flex-col gap-6 max-md:gap-4">
        <PageHead
          title={totalUnread ? t("chat.index.unread", { count: totalUnread }) : t(channels.length ? "chat.index.allReadShort" : "shell.nav.inbox")}
          meta={totalUnread ? t("chat.index.inChats", { count: unread.length }) : channels.length ? null : t("chat.index.startShort")}
          actions={
            <>
              <button type="button" className={btnPrimary} onClick={() => setModal("dm")}>
                <PlusIcon className="size-4" />
                {t("chat.index.newMessage")}
              </button>
              <button type="button" className={btn} onClick={() => setModal("channel")}>
                <HashIcon className="size-4" />
                {t("chat.index.createChannel")}
              </button>
            </>
          }
        />
        <nav className="grid grid-cols-2 gap-3 xl:grid-cols-4" aria-label={t("chat.index.shortcuts")}>
          {views.map(([id, href, l, n]) => {
            const [I, tone] = INBOX_MARK[id];
            return (
              <Link
                key={href}
                href={href}
                className={cx(card, "text-ink group/tile flex min-h-[4.25rem] items-center gap-3 rounded-xl px-4 py-3 no-underline max-sm:gap-2.5 max-sm:px-3")}
              >
                <IconTile tone={tone}>
                  <I />
                </IconTile>
                <span className="line-clamp-2 min-w-0 flex-1 text-sm font-semibold leading-snug tracking-[-0.01em]">{t(l)}</span>
                {n > 0 ? (
                  <span className="font-display text-ink text-xl/none font-semibold tabular-nums tracking-[-0.03em]">{n}</span>
                ) : (
                  <ArrowRightIcon aria-hidden="true" className="text-ink-2 size-4 shrink-0 transition-transform group-hover/tile:translate-x-0.5 max-sm:hidden" />
                )}
              </Link>
            );
          })}
        </nav>

        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="grid min-w-0 grid-cols-1 content-start gap-4">
            {asks.length > 0 ? (
              <Tile id="asks-h" title={t("shell.nav.asking")} icon={<BotIcon />} tone="violet">
                <ul className="m-0 mt-3 grid list-none grid-cols-[minmax(0,1fr)] gap-0.5 p-0">
                  {asks.map((a) => (
                    <li key={a.id}>
                      <Link href={`/app/chat/ask/${a.runId}`} className={cx(tileRow, "text-ink group/row min-h-14 no-underline")}>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold">
                            {t(a.kind === "approval" ? "workflows.ask.approvalItem" : "workflows.ask.item", { code: a.taskCode })}
                          </span>
                          <span className="text-ink-2 block truncate text-xs">{a.taskTitle}</span>
                        </span>
                        <span className="bg-signal size-2 shrink-0 rounded-full" aria-hidden="true" />
                        <time dateTime={a.askedAt} className="text-ink-2 shrink-0 text-right text-xs tabular-nums sm:w-20">
                          {ago(a.askedAt)}
                        </time>
                      </Link>
                    </li>
                  ))}
                </ul>
              </Tile>
            ) : null}
            {unread.length > 0 ? (
              <Tile id="unread-h" title={t("chat.index.unreadTitle")} icon={<InboxIcon />} tone="sky" link={{ href: "/app/chat/unreads", label: t("chat.lists.unreadsTitle") }}>
                {rows(unread)}
              </Tile>
            ) : null}
            <Tile
              id="recent-h"
              title={t(unread.length ? "chat.index.others" : "chat.index.recent")}
              icon={<ChatIcon />}
              tone="green"
              link={{ href: "/app/chat/browse", label: t("chat.index.browseAll") }}
            >
              {recent.length ? rows(recent) : <p className="text-ink-2 m-0 mt-3 text-[13px]">{t(channels.length ? "chat.index.allUnreadAbove" : "chat.index.noChannels")}</p>}
            </Tile>
          </div>

          <aside className="grid min-w-0 grid-cols-1 content-start gap-4" aria-label={t("chat.index.suggestions")}>
            {people.length > 0 ? (
              <Tile id="people-h" title={t("chat.index.dmColleague")} icon={<UsersIcon />} tone="rose">
                <ul className="m-0 mt-3 grid list-none grid-cols-[minmax(0,1fr)] gap-0.5 p-0">
                  {people.map((p) => (
                    <li key={p.userId}>
                      <button
                        type="button"
                        disabled={busy === p.userId}
                        onClick={() => void dmWith(p.userId)}
                        className={cx(tileRow, "group/row w-full text-left disabled:opacity-60")}
                      >
                        <Avatar id={p.userId} size="sm" />
                        <span className="min-w-0 flex-1 truncate text-sm">{p.displayName}</span>
                        <span className="text-ink-2 group-hover/row:text-accent-text text-xs font-medium transition-colors">{t("chat.index.message")}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </Tile>
            ) : null}
            {browsable.length > 0 ? (
              <Tile id="browse-h" title={t("chat.index.joinable")} icon={<HashIcon />} tone="tangerine">
                <ul className="m-0 mt-3 grid list-none grid-cols-[minmax(0,1fr)] gap-0.5 p-0">
                  {browsable.slice(0, 6).map((b) => (
                    <li key={b.id} className={cx(tileRow, "hover:bg-transparent")}>
                      <ChannelAvatar c={{ kind: "public", name: b.name, dmUserId: null }} size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{channelTitle(b)}</span>
                        {b.topic ? <span className="text-ink-2 block truncate text-xs">{b.topic}</span> : null}
                      </span>
                      <button type="button" className={cx(btn, btnSm)} disabled={busy === b.id} onClick={() => void join(b.id)}>
                        {t("common.join")}
                      </button>
                    </li>
                  ))}
                </ul>
                {browsable.length > 6 ? (
                  <Link href="/app/chat/browse" className={cx(cardLink, "mt-2 inline-block")}>
                    {t("chat.index.moreChannels", { count: browsable.length - 6 })}
                  </Link>
                ) : null}
              </Tile>
            ) : null}
            {archived.length > 0 ? (
              <details className="bg-surface shadow-card group/arch rounded-xl px-5 py-3.5 max-sm:px-4">
                <summary className="flex min-h-8 cursor-pointer list-none items-center gap-3 text-sm font-semibold tracking-[-0.01em] [&::-webkit-details-marker]:hidden">
                  <IconTile tone="violet">
                    <FolderIcon />
                  </IconTile>
                  <span className="min-w-0 flex-1 truncate">{t("chat.index.archived")}</span>
                  <span className="text-ink-2 text-xs font-medium tabular-nums">{archived.length}</span>
                  <ChevronDownIcon aria-hidden="true" className="text-ink-2 size-4 transition-transform group-open/arch:rotate-180" />
                </summary>
                <ul className="m-0 mt-2 grid list-none grid-cols-[minmax(0,1fr)] gap-0.5 p-0">
                  {archived.map((b) => (
                    <li key={b.id}>
                      <Link href={`/app/chat/${b.id}`} className={cx(tileRow, "text-ink-soft min-h-10 text-sm no-underline")}>
                        <HashIcon className="text-ink-2 size-4 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">{channelTitle(b)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            {aiOn && !people.length && !browsable.length && !archived.length ? (
              <p className="bg-surface shadow-card text-ink-2 m-0 flex items-center gap-3 rounded-xl px-5 py-4 text-[13px]">
                <IconTile tone="violet">
                  <SparkleIcon />
                </IconTile>
                <span className="min-w-0 flex-1">
                  {t("chat.index.aiTipBefore")}
                  <b className="text-ink font-semibold">@AI</b>
                  {t("chat.index.aiTipAfter")}
                </span>
              </p>
            ) : null}
          </aside>
        </div>
      </SpotArea>
      {modal === "channel" ? <NewChannelModal onClose={close} /> : null}
      {modal === "dm" ? <NewDmModal onClose={close} /> : null}
    </div>
  );
}
