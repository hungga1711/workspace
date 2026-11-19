"use client";

import { useT, useFormat } from "@/lib/i18n/client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Avatar, AvatarStack, useDirectory } from "@/lib/people";
import { btn, btnPrimary, cx } from "@/lib/ui";
import { PageHeader } from "@/components/ui/PageHeader";
import { Tabs } from "@/components/ui/Tabs";
import { Segmented } from "@/components/ui/Segmented";
import { workSubTabs } from "./workTabAlias";
import { CheckCircleIcon, ChecklistIcon, FileIcon, PlusIcon, UsersIcon, VideoIcon } from "@/components/app/icons";
import { DOT, GLOW, IconTile } from "@/components/ui/Bento";
import { NewEventModal } from "./CalendarView";
import { MeetNowButton, RecentRooms } from "@/components/meet/MeetNow";
import { REPEAT } from "./recurrence";
import type { Project } from "./types";
import { taskHref } from "@/lib/links";
import { meetingHref } from "@/lib/links";

export interface MeetingRow {
  id: string;
  code?: string | null;
  title: string;
  startsAt: string;
  endsAt: string;
  organizerId: string;
  location: string;
  projectId: string | null;
  response: string;
  hasAgenda: boolean;
  hasNotes: boolean;
  attendeeCount: number;
  actionItems: number;
  openActionItems: number;
  seriesId?: string | null;
  recurrence?: string | null;
  attendeeIds?: string[];
}

/** Upcoming: a recurring series shows once (its next occurrence) with how many more follow. */
function collapse(meetings: MeetingRow[]): (MeetingRow & { more: number })[] {
  const seen = new Map<string, MeetingRow & { more: number }>();
  const out: (MeetingRow & { more: number })[] = [];
  for (const m of meetings) {
    const first = m.seriesId ? seen.get(m.seriesId) : undefined;
    if (first) {
      first.more += 1;
      continue;
    }
    const row = { ...m, more: 0 };
    if (m.seriesId) seen.set(m.seriesId, row);
    out.push(row);
  }
  return out;
}

export interface MeetingFollowups {
  actionItems: {
    id: string;
    code: string;
    title: string;
    status: string;
    assigneeId: string | null;
    dueAt: string | null;
    meetingId: string;
    meetingCode?: string | null;
    meetingTitle: string;
  }[];
  missingNotes: { id: string; code?: string | null; title: string; startsAt: string }[];
}

/** "35 phút" / "2 giờ" / "3 ngày" until a start time. */
function until(iso: string, tx: ReturnType<typeof useT>) {
  const min = Math.max(1, Math.round((Date.parse(iso) - Date.now()) / 60_000));
  return min < 60
    ? tx("work.meetingsview.inMin", { n: min })
    : min < 24 * 60
      ? tx("work.meetingsview.inHours", { n: Math.round(min / 60) })
      : tx("work.meetingsview.inDays", { n: Math.round(min / 1440) });
}

/**
 * Meetings: the next meeting up front (when, who, is there an agenda), the rest grouped by
 * day, and in the right rail what meetings left behind: open action items and minutes still to write.
 */
export function MeetingsView({ meetings, when, projects, followups }: { meetings: MeetingRow[]; when: "upcoming" | "past"; projects: Project[]; followups?: MeetingFollowups }) {
  const { dayLabel, time, dueLabel } = useFormat();
  const tx = useT();
  const router = useRouter();
  const dir = useDirectory();
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const rows = when === "upcoming" && !expanded ? collapse(meetings) : meetings.map((m) => ({ ...m, more: 0 }));
  const hidden = meetings.length - rows.length;
  const next = when === "upcoming" ? rows[0] : undefined;
  const rest = next ? rows.slice(1) : rows;
  const groups: { day: string; items: typeof rows }[] = [];
  for (const m of rest) {
    const day = dayLabel(m.startsAt);
    const g = groups.at(-1);
    if (g && g.day === day) g.items.push(m);
    else groups.push({ day, items: [m] });
  }
  const live = next && Date.parse(next.startsAt) <= Date.now();
  const status = (m: MeetingRow) => (
    <span className="flex shrink-0 flex-wrap items-center gap-3 text-xs">
      {when === "upcoming" ? (
        <span className={m.hasAgenda ? "text-ok" : "text-ink-2"}>{m.hasAgenda ? tx("work.meetingsview.co_chuong_trinh") : tx("work.meetingsview.chua_co_chuong_trinh")}</span>
      ) : (
        <span className={cx("flex items-center gap-1", m.hasNotes ? "text-ok" : "text-warn")}>
          <FileIcon className="size-3.5" />
          {m.hasNotes ? tx("work.meetingsview.co_bien_ban") : tx("work.meetingsview.chua_co_bien_ban")}
        </span>
      )}
      {m.actionItems ? (
        <span className="text-ink-2 flex items-center gap-1">
          <CheckCircleIcon className="size-3.5" />
          {tx("work.meetingsview.viec_con_mo", { p0: m.openActionItems, p1: m.actionItems })}
        </span>
      ) : null}
      {m.response === "pending" && m.organizerId !== dir.me ? (
        <span className="bg-signal-wash text-signal-text rounded-sm px-1.5 py-0.5 text-xs font-medium">{tx("work.meetingsview.chua_phan_hoi")}</span>
      ) : null}
    </span>
  );
  const meta = (m: MeetingRow & { more: number }) => (
    <span className="text-ink-2 flex flex-wrap items-center gap-x-3 text-xs">
      {m.attendeeIds?.length ? <AvatarStack ids={m.attendeeIds} max={4} /> : null}
      <span className="flex items-center gap-1">
        <UsersIcon className="size-3.5" />
        {tx("work.meetingsview.nguoi", { p0: m.attendeeCount })}
      </span>
      {m.recurrence ? (
        <span>
          {REPEAT(tx)[m.recurrence] ?? tx("work.meetingsview.dinh_ky")}
          {m.more ? tx("work.meetingsview.them_buoi_sap_toi", { p0: m.more }) : ""}
        </span>
      ) : null}
      {m.location ? <span>{m.location}</span> : null}
      <span>{tx("work.meetingsview.to_chuc_boi", { p0: dir.name(m.organizerId) })}</span>
    </span>
  );
  // The side column only when it has something to show (empty cards hide, DESIGN.md copy rules).
  const side = !!followups && (followups.actionItems.length > 0 || followups.missingNotes.length > 0);
  return (
    <>
      <PageHeader
        title={tx("work.page.lich")}
        actions={
          <>
            <MeetNowButton />
            <button type="button" className={btnPrimary} onClick={() => setCreating(true)}>
              <PlusIcon className="size-4" />
              {tx("work.meetingsview.tao_cuoc_hop")}
            </button>
          </>
        }
        tabs={<Tabs tabs={workSubTabs("calendar", tx)} active="meetings" label={tx("work.page.lich")} />}
        toolbar={
          <Segmented
            size="sm"
            label={tx("work.meetingsview.thoi_gian")}
            value={when}
            options={[
              { value: "upcoming", label: tx("work.meetingsview.sap_toi"), href: "/app/work/calendar?view=meetings" },
              { value: "past", label: tx("work.meetingsview.da_dien_ra"), href: "/app/work/calendar?view=meetings&when=past" },
            ]}
          />
        }
      />
      <div className={cx("grid grid-cols-[minmax(0,1fr)] items-start gap-6", side && "xl:grid-cols-[minmax(0,1fr)_340px]")}>
        <div className="grid min-w-0 gap-5">
          {next ? (
            // Home's hero: a step higher than the cards, lit softly from its corner in the meeting tone.
            <section aria-label={tx("work.meetingsview.next")} className="bg-surface shadow-hero relative isolate grid gap-3 overflow-hidden rounded-2xl p-6 max-sm:p-5">
              <span aria-hidden="true" className={cx("glow pointer-events-none absolute -right-24 -top-28 -z-10 size-80", GLOW.tangerine)} />
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
                <span className="text-ink-2 inline-flex items-center gap-2 text-xs font-medium uppercase tracking-[0.08em]">
                  <span aria-hidden="true" className={cx("size-1.5 rounded-full", DOT.tangerine, live && "motion-safe:animate-pulse")} />
                  {live ? tx("work.meetingsview.live") : tx("work.meetingsview.startsIn", { when: until(next.startsAt, tx) })}
                </span>
                <span className="text-ink-2">
                  {dayLabel(next.startsAt)} ·{" "}
                  <span className="tabular-nums">
                    {time(next.startsAt)}–{time(next.endsAt)}
                  </span>
                </span>
              </div>
              <Link
                href={meetingHref(next)}
                className="text-ink font-display text-balance text-[26px]/[1.15] font-semibold tracking-[-0.035em] no-underline hover:underline max-sm:text-[22px]/[1.2]"
              >
                {next.title}
              </Link>
              {meta(next)}
              <div className="flex flex-wrap items-center gap-2">
                <Link href={meetingHref(next)} className={cx(btn, "no-underline")}>
                  {tx("work.meetingsview.open")}
                </Link>
                {!next.hasAgenda ? (
                  <Link href={meetingHref(next)} className={cx(btn, "no-underline")}>
                    {tx("work.meetingsview.writeAgenda")}
                  </Link>
                ) : null}
                {next.hasAgenda || next.actionItems ? <span className="ml-auto">{status(next)}</span> : null}
              </div>
            </section>
          ) : null}
          {when === "upcoming" ? <RecentRooms /> : null}
          {meetings.length === 0 ? (
            // Slim and calm (Home's quiet cell): one card, the tile, the line and the one action, never a tall dashed box.
            <section aria-labelledby="mt-empty-h" className="bg-surface shadow-card flex min-w-0 flex-wrap items-center gap-x-3.5 gap-y-3 rounded-xl px-5 py-4 max-sm:px-4">
              <IconTile tone="tangerine">
                <VideoIcon />
              </IconTile>
              <span className="min-w-0 flex-1 leading-[1.35]">
                <h2 id="mt-empty-h" className="m-0 text-sm font-semibold tracking-[-0.01em]">
                  {when === "upcoming" ? tx("work.meetingsview.khong_co_cuoc_hop") : tx("work.meetingsview.chua_co_cuoc_hop")}
                </h2>
                <span className="text-ink-2 block text-[13px]">{tx("work.meetingsview.empty_hint")}</span>
              </span>
              {when === "upcoming" ? (
                // Phones have "New meeting" in the header right above; here it only squeezed the line.
                <button type="button" className={cx(btn, "max-sm:hidden")} onClick={() => setCreating(true)}>
                  {tx("work.meetingsview.tao_cuoc_hop")}
                </button>
              ) : null}
            </section>
          ) : (
            groups.map((g) => (
              <section key={g.day} aria-label={g.day} className="grid gap-2">
                <h2 className="text-ink-2 m-0 text-xs font-medium uppercase tracking-[0.08em]">{g.day}</h2>
                <ul className="divide-divider bg-surface shadow-card m-0 list-none divide-y overflow-hidden rounded-xl p-0">
                  {g.items.map((m) => (
                    <li key={m.id} className="hover:bg-hover/60 grid gap-1.5 px-4 py-3 transition-colors sm:flex sm:items-center sm:gap-x-4">
                      <span className="text-ink-2 shrink-0 text-xs tabular-nums sm:w-24">
                        {time(m.startsAt)}–{time(m.endsAt)}
                      </span>
                      <span className="grid min-w-0 flex-1 gap-0.5">
                        <Link href={meetingHref(m)} className="text-ink block truncate font-medium no-underline hover:underline">
                          {m.title}
                        </Link>
                        {meta(m)}
                      </span>
                      {status(m)}
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
          {when === "upcoming" && (hidden > 0 || expanded) ? (
            <button type="button" className="text-brand-text justify-self-start text-sm underline" onClick={() => setExpanded((v) => !v)}>
              {expanded ? tx("work.meetingsview.gop_cac_cuoc_hop") : tx("work.meetingsview.hien_tung_buoi_cua", { p0: hidden })}
            </button>
          ) : null}
        </div>
        {side && followups ? (
          <aside className="grid content-start gap-4 xl:sticky xl:top-4">
            {followups.actionItems.length ? (
              <section aria-labelledby="mt-items-h" className="bg-surface shadow-card grid gap-1 rounded-xl p-4">
                <h2 id="mt-items-h" className="m-0 mb-2 flex min-h-8 items-center gap-3 text-sm font-semibold tracking-[-0.01em]">
                  <IconTile tone="green">
                    <ChecklistIcon />
                  </IconTile>
                  {tx("work.meetingsview.openItems")} <span className="text-ink-2 font-normal">{followups.actionItems.length}</span>
                </h2>
                {followups.actionItems.length ? (
                  <ul className="m-0 grid list-none gap-0.5 p-0">
                    {followups.actionItems.map((t) => {
                      const due = t.dueAt ? dueLabel(t.dueAt) : null;
                      return (
                        <li key={t.id} className="hover:bg-hover -mx-2 grid gap-0.5 rounded-lg px-2 py-1.5 transition-colors">
                          <span className="flex items-center gap-2">
                            {t.assigneeId ? <Avatar id={t.assigneeId} size="xs" /> : null}
                            <Link href={taskHref(t)} className="text-ink min-w-0 flex-1 truncate text-sm no-underline hover:underline" title={t.title}>
                              {t.title}
                            </Link>
                            {due ? <span className={cx("shrink-0 text-xs tabular-nums", due.overdue ? "text-block" : "text-ink-2")}>{due.text}</span> : null}
                          </span>
                          <Link href={meetingHref({ id: t.meetingId, code: t.meetingCode })} className="text-ink-2 truncate pl-7 text-xs no-underline hover:underline">
                            {t.meetingTitle}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </section>
            ) : null}
            {followups.missingNotes.length ? (
              <section aria-labelledby="mt-notes-h" className="bg-surface shadow-card grid gap-1 rounded-xl p-4">
                <h2 id="mt-notes-h" className="m-0 mb-2 flex min-h-8 items-center gap-3 text-sm font-semibold tracking-[-0.01em]">
                  <IconTile tone="tangerine">
                    <FileIcon />
                  </IconTile>
                  {tx("work.meetingsview.missingNotes")}
                </h2>
                <ul className="m-0 grid list-none gap-0.5 p-0">
                  {followups.missingNotes.map((m) => (
                    <li key={m.id}>
                      <Link
                        href={meetingHref(m)}
                        className="hover:bg-hover text-ink -mx-2 flex min-h-10 items-center gap-2 rounded-lg px-2 py-1.5 text-sm no-underline transition-colors"
                      >
                        <FileIcon className="text-warn size-3.5 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">{m.title}</span>
                        <span className="text-ink-2 shrink-0 text-xs">{dayLabel(m.startsAt)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </aside>
        ) : null}
      </div>
      {creating ? (
        <NewEventModal
          projects={projects}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            router.refresh();
          }}
        />
      ) : null}
    </>
  );
}
