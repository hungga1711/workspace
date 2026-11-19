"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { useFormat, useMeetEnabled, useT } from "@/lib/i18n/client";
import { btn, btnSm, cx } from "@/lib/ui";
import { CopyIcon, VideoIcon } from "@/components/app/icons";
import type { MeetRoomInfo } from "./types";

import { openMeeting } from "./open";

export function MeetNowButton({ eventId, title, className, label }: { eventId?: string; title?: string; className?: string; label?: string }) {
  const t = useT();
  const { time } = useFormat();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const meet = useMeetEnabled();
  // No LiveKit on this server: the meeting still has its agenda, minutes and calendar entry, just no video room.
  if (!meet) return null;
  return (
    <button
      type="button"
      className={className ?? btn}
      disabled={busy}
      onClick={() => {
        setBusy(true);
        openMeeting(router, eventId ? { eventId } : { title: title ?? t("meet.quickTitle", { time: time(new Date()) }) }).catch(() => setBusy(false));
      }}
    >
      <VideoIcon className="size-4" />
      {busy ? t("meet.starting") : (label ?? t("meet.startNow"))}
    </button>
  );
}

/** The video meetings I started recently, each with its link to share again. */
export function RecentRooms() {
  const t = useT();
  const { ago } = useFormat();
  const meet = useMeetEnabled();
  const [rooms, setRooms] = useState<MeetRoomInfo[] | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    if (!meet) return;
    api<{ rooms: MeetRoomInfo[] }>("work/meet/rooms")
      .then((r) => setRooms(r.rooms.filter((x) => !x.eventId).slice(0, 4)))
      .catch(() => setRooms([]));
  }, [meet]);
  if (!meet || !rooms?.length) return null;
  const copy = async (code: string) => {
    await navigator.clipboard.writeText(`${location.origin}/meet/${code}`).catch(() => undefined);
    setCopied(code);
    setTimeout(() => setCopied(null), 2000);
  };
  return (
    <section className="mb-5" aria-label={t("meet.recent")}>
      <h2 className="text-ink-2 mb-2 text-sm font-semibold">{t("meet.recent")}</h2>
      <ul className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(min(100%,22rem),1fr))] gap-2 p-0">
        {rooms.map((r) => (
          <li key={r.id} className="bg-surface border-hairline flex min-w-0 flex-wrap items-center gap-3 rounded-xl border px-3 py-2.5">
            <span className="bg-accent-wash text-accent-text grid size-9 shrink-0 place-items-center rounded-lg">
              <VideoIcon className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <Link href={`/meet/${r.code}`} className="text-ink block truncate font-medium no-underline hover:underline">
                {r.title}
              </Link>
              <span className="text-ink-2 block truncate font-mono text-xs">
                {r.code} · {ago(r.lastUsedAt)}
              </span>
            </span>
            <button type="button" className={cx(btn, btnSm)} aria-expanded={open === r.code} onClick={() => setOpen(open === r.code ? null : r.code)}>
              {t("meet.recordings")}
            </button>
            <button type="button" className={cx(btn, btnSm)} onClick={() => void copy(r.code)} aria-label={`${t("meet.copyLink")}: ${r.title}`}>
              <CopyIcon className="size-3.5" />
              <span className="max-sm:sr-only" aria-live="polite">
                {copied === r.code ? t("meet.linkCopied") : t("meet.copyLink")}
              </span>
            </button>
            {open === r.code ? <Recordings code={r.code} /> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

interface Recording {
  id: string;
  status: "recording" | "processing" | "ready" | "failed";
  startedAt: string;
  size: number | null;
  url: string | null;
}

/** A room's recordings; each plays straight from object storage (R2) through a short-lived link. */
function Recordings({ code }: { code: string }) {
  const t = useT();
  const { dayLabel, time } = useFormat();
  const [list, setList] = useState<Recording[] | null>(null);
  useEffect(() => {
    api<{ recordings: Recording[] }>(`work/meet/rooms/${code}/recordings`)
      .then((r) => setList(r.recordings))
      .catch(() => setList([]));
  }, [code]);
  if (!list) return null;
  return (
    <ul className="m-0 grid w-full list-none gap-1 p-0 pl-12 text-sm">
      {list.length === 0 ? <li className="text-ink-2">—</li> : null}
      {list.map((x) => (
        <li key={x.id} className="flex items-center gap-2">
          <span className="text-ink-2">
            {dayLabel(x.startedAt)}, {time(x.startedAt)}
            {x.size ? ` · ${Math.max(1, Math.round(x.size / 1048576))} MB` : ""}
          </span>
          {x.url ? (
            <a href={x.url} target="_blank" rel="noreferrer">
              {t("meet.download")}
            </a>
          ) : (
            <span className="text-ink-2">{x.status === "recording" ? t("meet.recording") : x.status === "failed" ? "—" : t("meet.processing")}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Recordings of a calendar meeting's video room, shown on the meeting page (nothing when there are none). */
export function EventRecordings({ eventId }: { eventId: string }) {
  const t = useT();
  const meet = useMeetEnabled();
  const [code, setCode] = useState<string | null>(null);
  const [has, setHas] = useState(false);
  useEffect(() => {
    if (!meet) return;
    api<{ rooms: MeetRoomInfo[] }>("work/meet/rooms")
      .then(async (r) => {
        const room = r.rooms.find((x) => x.eventId === eventId);
        if (!room) return;
        const recs = await api<{ recordings: unknown[] }>(`work/meet/rooms/${room.code}/recordings`);
        setHas(recs.recordings.length > 0);
        setCode(room.code);
      })
      .catch(() => undefined);
  }, [eventId, meet]);
  if (!code || !has) return null;
  return (
    <section aria-label={t("meet.recordings")} className="mt-3">
      <h2 className="text-ink-2 m-0 mb-1 text-sm font-semibold">{t("meet.recordings")}</h2>
      <div className="[&_ul]:pl-0">
        <Recordings code={code} />
      </div>
    </section>
  );
}
