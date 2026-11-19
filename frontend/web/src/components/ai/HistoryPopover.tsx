"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { cx } from "@/lib/ui";
import { ChevronDownIcon, ClockIcon, PlusIcon, SearchIcon } from "@/components/app/icons";
import { groupByDay, matches } from "./chatHistory";
import { TopicIcon } from "./TopicIcon";

interface Row {
  id: string;
  title: string;
  topic: string;
  lastAt: string;
}

/**
 * Hỏi đáp's history as a popover: on phones (no rail) and on desktop once the rail is folded. A search field, then the
 * conversations by day; picking one, Escape or a click outside closes it.
 */
export function HistoryPopover({ conversations, current, label, className }: { conversations: Row[]; current: string | null; label: string; className?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const groups = useMemo(() => groupByDay(conversations.filter((c) => matches(c.title || t("aiw.chat.untitled"), q))), [conversations, q, t]);
  return (
    <div ref={box} className={cx("relative min-w-0", className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
        className="text-ink hover:bg-hover flex h-8 max-w-full items-center gap-1.5 rounded-md px-2 text-sm font-medium transition-colors"
      >
        <ClockIcon className="text-ink-2 size-4 shrink-0" />
        <span className="truncate">{label}</span>
        <ChevronDownIcon className={cx("text-ink-2 size-3.5 shrink-0 transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label={t("aiw.chat.history")}
          className="bg-surface shadow-popover animate-rise absolute left-0 top-full z-30 mt-1 flex max-h-[min(32rem,70vh)] w-[min(22rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl"
        >
          <div className="border-divider flex items-center gap-1.5 border-b p-2">
            <label className="bg-ground focus-within:ring-edge flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 focus-within:ring-1">
              <SearchIcon className="text-ink-2 size-3.5 shrink-0" />
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t("aiw.chat.search")}
                aria-label={t("aiw.chat.search")}
                className="text-ink placeholder:text-ink-2 min-w-0 flex-1 bg-transparent text-[13px] outline-none"
              />
            </label>
            <Link
              href="/app/ai/ask"
              onClick={() => setOpen(false)}
              className="ring-hairline text-ink-soft hover:text-ink hover:bg-hover grid size-7 shrink-0 place-items-center rounded-md ring-1 [&_svg]:size-3.5"
              aria-label={t("aiw.chat.new")}
              title={t("aiw.chat.new")}
            >
              <PlusIcon />
            </Link>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
            {groups.length ? (
              groups.map(([g, rows]) => (
                <section key={g} aria-label={t(`aiw.chat.group.${g}`)}>
                  <h3 className="text-ink-2 m-0 px-2 pb-1 pt-3 text-xs font-medium">{t(`aiw.chat.group.${g}`)}</h3>
                  <ul className="m-0 grid list-none gap-px p-0">
                    {rows.map((c) => (
                      <li key={c.id}>
                        <Link
                          href={`/app/ai/ask?c=${c.id}`}
                          onClick={() => setOpen(false)}
                          aria-current={c.id === current ? "page" : undefined}
                          className={cx(
                            "flex h-8 items-center gap-2 rounded-md px-2 text-[13px] no-underline transition-colors",
                            c.id === current ? "bg-selected text-ink font-medium" : "text-ink-soft hover:bg-hover hover:text-ink",
                          )}
                        >
                          <TopicIcon topic={c.topic} className="text-ink-2 size-3.5 shrink-0" />
                          <span className="truncate">{c.title || t("aiw.chat.untitled")}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              ))
            ) : (
              <p className="text-ink-2 m-0 px-2 py-3 text-[13px]">{t("aiw.chat.noMatch")}</p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
