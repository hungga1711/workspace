"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { useFormat, useT } from "@/lib/i18n/client";
import { useDirectory } from "@/lib/people";
import { btn, btnSm, chipAccent, cx } from "@/lib/ui";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { AnnouncementDrawer } from "./AnnouncementDrawer";
import { CATEGORY, type Announcement } from "./types";

/** The reader's announcements, newest first with pinned ones on top; unread ones are marked until opened. */
export function AnnouncementsFeed({ items: initial, canPublish, open: openId }: { items: Announcement[]; canPublish: boolean; open: string | null }) {
  const t = useT();
  const { ago } = useFormat();
  const dir = useDirectory();
  const [items, setItems] = useState(initial);
  const [open, setOpen] = useState<Announcement | null>(() => initial.find((a) => a.id === openId) ?? null);
  const onRead = useCallback((id: string) => setItems((l) => l.map((a) => (a.id === id ? { ...a, readAt: new Date().toISOString() } : a))), []);
  const unread = items.filter((a) => !a.readAt).length;
  return (
    <div className="grid max-w-3xl gap-4">
      <PageHeader
        title={t("shell.nav.announcements")}
        meta={unread ? t("ann.feed.unread", { count: unread }) : undefined}
        actions={
          canPublish ? (
            <Link href="/admin/workspace/announcements" className={cx(btn, btnSm, "no-underline")}>
              {t("ann.feed.manage")}
            </Link>
          ) : undefined
        }
      />
      {items.length === 0 ? (
        <EmptyState title={t("ann.feed.empty")} />
      ) : (
        <ul className="bg-surface shadow-card divide-divider-soft m-0 grid list-none divide-y overflow-hidden rounded-xl p-0">
          {items.map((a) => (
            <li key={a.id}>
              <button type="button" onClick={() => setOpen(a)} className="hover:bg-hover/60 flex w-full min-w-0 items-start gap-3 px-4 py-3 text-left">
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className={cx("truncate text-sm", a.readAt ? "text-ink-soft" : "text-ink font-semibold")}>{a.title}</span>
                  <span className="text-ink-2 text-xs max-sm:line-clamp-2 sm:truncate">
                    {CATEGORY(t)[a.category] ?? a.category} · {dir.name(a.authorId)} · {ago(a.publishAt)}
                    {a.pinned ? ` · ${t("ann.feed.pinned")}` : ""}
                  </span>
                </span>
                {a.readAt ? null : <span className={cx(chipAccent, "shrink-0")}>{t("ann.feed.new")}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {open ? <AnnouncementDrawer a={open} onClose={() => setOpen(null)} onRead={onRead} /> : null}
    </div>
  );
}
