"use client";

import { useT, useFormat } from "@/lib/i18n/client";
import { useEffect } from "react";
import { api } from "@/lib/client";
import { Markdown } from "@/lib/markdown";
import { useDirectory } from "@/lib/people";
import { btn } from "@/lib/ui";
import { Drawer } from "@/components/ui/Drawer";
import { CATEGORY, type Announcement } from "./types";

/** Reads one announcement in full and records the read receipt. */
export function AnnouncementDrawer({ a, onClose, onRead, actions }: { a: Announcement; onClose: () => void; onRead?: (id: string) => void; actions?: React.ReactNode }) {
  const { ago, dayLabel, time } = useFormat();
  const tx = useT();
  const dir = useDirectory();
  useEffect(() => {
    if (a.readAt) return;
    void api(`employee/announcements/${a.id}/read`, { method: "POST" })
      .then(() => onRead?.(a.id))
      .catch(() => undefined);
  }, [a.id, a.readAt, onRead]);
  return (
    <Drawer title={a.title} onClose={onClose} actions={actions} padded>
      <p className="text-ink-2 mb-4 text-sm">
        {CATEGORY(tx)[a.category] ?? a.category} · {dir.name(a.authorId)} · {ago(a.publishAt)}
      </p>
      {a.eventAt ? (
        <p className="bg-brand-wash mb-4 rounded-lg px-3 py-2 text-sm">
          {tx("ann.announcementdrawer.thoi_gian")} <b>{tx("ann.announcementdrawer.luc", { p0: dayLabel(a.eventAt), p1: time(a.eventAt) })}</b>
        </p>
      ) : null}
      <div className="text-sm leading-relaxed">
        <Markdown source={a.body || tx("ann.announcementdrawer.khong_co_noi_dung")} />
      </div>
      {a.linkUrl ? (
        <p className="mt-5">
          <a className={btn} href={a.linkUrl} target="_blank" rel="noopener noreferrer">
            {tx("ann.announcementdrawer.mo_trang_dang_ky")}
          </a>
        </p>
      ) : null}
      {a.readCount !== undefined ? <p className="border-hairline text-ink-2 mt-6 border-t pt-3 text-xs">{tx("ann.announcementdrawer.nguoi_da_doc", { p0: a.readCount })}</p> : null}
    </Drawer>
  );
}
