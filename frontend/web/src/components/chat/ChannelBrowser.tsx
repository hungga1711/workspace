"use client";

import { ChannelAvatar } from "@/lib/people";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/client";
import { useFormat } from "@/lib/i18n/client";
import { btn, btnPrimary, cx, searchPill } from "@/lib/ui";
import { ArrowRightIcon, CheckIcon, ChevronDownIcon, ChevronLeftIcon, HashIcon, PlusIcon, SearchIcon } from "@/components/app/icons";
import { card, IconTile } from "@/components/ui/Bento";
import { SpotArea } from "@/components/ui/SpotArea";
import { PageHead } from "./PageHead";
import type { ChannelSummary } from "@/components/shell/types";
import { NewChannelModal } from "./NewConversation";

export interface BrowseChannel {
  id: string;
  name: string;
  displayName?: string | null;
  topic: string;
  memberCount?: number;
  lastMessageAt?: string | null;
}

/**
 * "Thêm kênh": create a channel, or join one of the public channels you're not in yet.
 * Channels you already belong to live in the sidebar, so they only show up here when you search.
 */
export function ChannelBrowser({ joined, browsable, archived }: { joined: ChannelSummary[]; browsable: BrowseChannel[]; archived: BrowseChannel[] }) {
  const router = useRouter();
  const { t, ago } = useFormat();
  const [q, setQ] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  type Row = BrowseChannel & { kind: string; member: boolean; archived?: boolean };
  const match = (c: Row) => !q || `${c.name} ${c.displayName ?? ""} ${c.topic}`.toLowerCase().includes(q.toLowerCase());
  const byName = (a: Row, b: Row) => (a.displayName || a.name).localeCompare(b.displayName || b.name, "vi");
  const mine: Row[] = joined.map((c) => ({
    id: c.id,
    name: c.name ?? "",
    displayName: c.displayName ?? null,
    topic: c.topic ?? "",
    kind: c.kind,
    member: true,
    lastMessageAt: c.lastMessageAt,
    memberCount: c.memberCount,
  }));
  const open: Row[] = browsable.map((b) => ({ ...b, kind: "public", member: false }));
  const old: Row[] = archived.map((b) => ({ ...b, kind: "public", member: false, archived: true }));
  const joinable = open.filter(match).sort(byName);
  const alreadyIn = q ? mine.filter(match).sort(byName) : [];
  const archivedRows = showArchived ? old.filter(match).sort(byName) : [];
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
  const list = (title: string, rows: Row[]) =>
    rows.length ? (
      <section className="grid gap-2.5" aria-label={title}>
        <h2 className="text-ink-2 m-0 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.08em]">
          {title} <span className="tabular-nums">{rows.length}</span>
        </h2>
        <ul className="divide-divider-soft bg-surface shadow-card m-0 list-none divide-y overflow-hidden rounded-xl p-0">
          {rows.map((c) => (
            <li key={c.id} className="hover:bg-hover/60 flex min-h-16 items-center gap-3 px-5 py-3 transition-colors max-sm:px-4">
              <ChannelAvatar c={{ kind: c.kind, name: c.name }} size="lg" className={c.archived ? "opacity-60" : undefined} />
              <span className="min-w-0 flex-1">
                <Link href={`/app/chat/${c.id}`} className="text-ink block truncate text-sm font-semibold tracking-[-0.01em] no-underline hover:underline">
                  {c.displayName || c.name}
                </Link>
                <span className="text-ink-2 flex min-w-0 flex-wrap gap-x-2 text-xs">
                  {c.topic ? <span className="min-w-0 max-w-full truncate">{c.topic}</span> : null}
                  {c.memberCount !== undefined ? <span className="tabular-nums">{t("chat.browser.members", { count: c.memberCount })}</span> : null}
                  {c.lastMessageAt ? <span>{t("chat.browser.active", { ago: ago(c.lastMessageAt) })}</span> : null}
                </span>
              </span>
              {c.member || c.archived ? (
                <Link href={`/app/chat/${c.id}`} className={cx(btn, "shrink-0 no-underline")}>
                  {t("common.open")}
                </Link>
              ) : (
                <button
                  type="button"
                  className={cx(btnPrimary, "shrink-0")}
                  disabled={busy === c.id}
                  onClick={() => void join(c.id)}
                  aria-label={t("chat.browser.joinName", { name: c.name ?? "" })}
                >
                  {busy === c.id ? t("chat.browser.joining") : t("common.join")}
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
    ) : null;
  return (
    <div className="min-h-0 overflow-auto">
      <SpotArea className="grid w-full gap-6 px-4 pb-10 pt-5 md:px-7 md:pt-7">
        <PageHead
          title={t("chat.browser.title")}
          lead={
            <Link href="/app/chat" className="text-ink-2 hover:bg-hover -ml-2 grid size-8 place-items-center rounded-md md:hidden" aria-label={t("common.back")}>
              <ChevronLeftIcon />
            </Link>
          }
        />
        <button type="button" onClick={() => setCreating(true)} className={cx(card, "group/tile flex items-center gap-4 rounded-xl px-5 py-4 text-left max-sm:px-4")}>
          <IconTile tone="green" className="size-10 rounded-[11px] [&_svg]:size-5">
            <PlusIcon />
          </IconTile>
          <span className="min-w-0 flex-1">
            <span className="text-ink block text-sm font-semibold tracking-[-0.01em]">{t("chat.index.createChannel")}</span>
            <span className="text-ink-2 block text-[13px]">{t("chat.browser.createHint")}</span>
          </span>
          <ArrowRightIcon className="text-ink-2 size-4 shrink-0 transition-transform group-hover/tile:translate-x-0.5" />
        </button>
        <label className={cx(searchPill, "min-h-10")}>
          <span className="sr-only">{t("chat.browser.find")}</span>
          <SearchIcon className="pointer-events-none size-4 shrink-0" />
          <input
            className="text-ink placeholder:text-ink-2 min-h-10 min-w-0 flex-1 bg-transparent outline-none"
            placeholder={t("chat.browser.placeholder")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        {list(t("chat.browser.canJoin"), joinable)}
        {joinable.length === 0 ? (
          <p className="bg-surface shadow-card text-ink-2 m-0 flex min-h-[4.75rem] items-center gap-3.5 rounded-xl px-5 py-4 text-[13px] max-sm:px-4">
            <IconTile tone="tangerine">{q ? <SearchIcon /> : <HashIcon />}</IconTile>
            <span className="min-w-0 flex-1 text-pretty">{q ? t("chat.browser.noMatch", { q }) : t("chat.browser.allJoined")}</span>
            {q ? null : (
              <span aria-hidden="true" className="bg-ok-wash text-ok ring-current/15 grid size-6 shrink-0 place-items-center rounded-full ring-1 ring-inset">
                <CheckIcon className="size-3.5" />
              </span>
            )}
          </p>
        ) : null}
        {list(t("chat.browser.joined"), alreadyIn)}
        {archived.length ? (
          <div className="grid gap-3">
            <button
              type="button"
              aria-pressed={showArchived}
              className="text-ink-2 hover:text-ink inline-flex w-fit items-center gap-1.5 text-[13px] font-medium"
              onClick={() => setShowArchived((v) => !v)}
            >
              {t("chat.browser.archived")} <span className="tabular-nums">{archived.length}</span>
              <ChevronDownIcon aria-hidden="true" className={cx("size-3.5 transition-transform", showArchived && "rotate-180")} />
            </button>
            {list(t("chat.browser.archived"), archivedRows)}
          </div>
        ) : null}
      </SpotArea>
      {creating ? <NewChannelModal onClose={() => setCreating(false)} /> : null}
    </div>
  );
}
