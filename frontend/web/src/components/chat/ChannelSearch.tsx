"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import { useFormat } from "@/lib/i18n/client";
import { useDirectory } from "@/lib/people";
import { cx, input, skeleton } from "@/lib/ui";
import { Drawer } from "@/components/ui/Drawer";
import { SearchIcon } from "@/components/app/icons";
import { RichText } from "./RichText";

interface Hit {
  entity_id: string;
  body: string;
  created_at: string;
}

/**
 * "Tìm trong kênh": full-text search over one conversation (the same index and permission check as ⌘K). A result
 * opens the message with its thread beside the conversation.
 */
export function ChannelSearch({ channelId, spoken, onOpen, onClose }: { channelId: string; spoken: string; onOpen: (messageId: string) => void; onClose: () => void }) {
  const { t, time, dayLabel } = useFormat();
  const dir = useDirectory();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [failed, setFailed] = useState(false);
  const box = useRef<HTMLInputElement>(null);
  // After the drawer's focus trap has placed focus on its first control: the box is what people came for.
  useEffect(() => {
    const id = setTimeout(() => box.current?.focus(), 30);
    return () => clearTimeout(id);
  }, []);
  useEffect(() => {
    const text = q.trim();
    if (text.length < 2) {
      setHits(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      setFailed(false);
      api<{ hits: (Hit & { entity_type: string })[] }>(`chat/search?types=message&channelId=${encodeURIComponent(channelId)}&q=${encodeURIComponent(text)}`)
        .then((r) => live && setHits(r.hits.filter((h) => h.entity_type === "message")))
        .catch(() => live && (setFailed(true), setHits([])));
    }, 220);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q, channelId]);

  return (
    <Drawer title={t("chat.search.title", { name: spoken })} onClose={onClose}>
      <div className="grid gap-3 p-4">
        <label className="relative block">
          <span className="sr-only">{t("chat.search.label")}</span>
          <SearchIcon className="text-ink-2 pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2" aria-hidden="true" />
          <input ref={box} className={cx(input, "pl-9")} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("chat.search.placeholder")} type="search" />
        </label>
        {hits === null ? (
          <p className="text-ink-2 m-0 text-sm">{t("chat.search.hint")}</p>
        ) : failed ? (
          <p className="text-block m-0 text-sm" role="alert">
            {t("chat.search.failed")}
          </p>
        ) : hits.length === 0 ? (
          <p className="text-ink-2 m-0 text-sm">{t("chat.search.none", { q: q.trim() })}</p>
        ) : (
          <ul className="m-0 grid list-none gap-0.5 p-0" aria-label={t("chat.search.results", { count: hits.length })}>
            {hits.map((h) => (
              <li key={h.entity_id}>
                <button type="button" onClick={() => onOpen(h.entity_id)} className="hover:bg-hover grid w-full gap-0.5 rounded-lg px-3 py-2 text-left">
                  <span className="text-ink-2 text-xs tabular-nums">
                    {dayLabel(h.created_at)} · {time(h.created_at)}
                  </span>
                  <span className="line-clamp-3 text-sm">
                    <RichText text={h.body} names={dir.names} compact />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {hits === null && q.trim().length >= 2 ? <span className={skeleton} /> : null}
      </div>
    </Drawer>
  );
}
