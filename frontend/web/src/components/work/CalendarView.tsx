"use client";

import { dateFormat } from "@/lib/intl";
import { fromWallTime, wallTime, workspaceTimeZone } from "@/lib/timezone";
import { FormField } from "./FormField";
import { CalendarSync } from "./CalendarSync";
import type { T } from "@/lib/i18n/core";
import { useT, useFormat } from "@/lib/i18n/client";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { useDirectory } from "@/lib/people";
import { btn, btnGhost, btnPrimary, btnSm, cx, input, btnDanger, hitPad, meta, smallText } from "@/lib/ui";
import { PageHeader } from "@/components/ui/PageHeader";
import { Tabs } from "@/components/ui/Tabs";
import { Segmented } from "@/components/ui/Segmented";
import { Picker } from "@/components/ui/Picker";
import { DateField } from "@/components/ui/DateField";
import { dayParam } from "@/components/ui/datePages";
import { workSubTabs } from "./workTabAlias";
import { Modal } from "@/components/ui/Modal";
import { Field } from "@/components/ui/bits";
import { SlimEmpty } from "./progressUi";
import { PeoplePicker } from "@/components/chat/NewConversation";
import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon, LinkIcon, PlusIcon } from "@/components/app/icons";
import { toneOf } from "./calTone";
import { Rsvp } from "./Rsvp";
import { INTL_TAG } from "@/lib/i18n/config";
import { useLocale } from "@/lib/i18n/client";
import { MonthGrid } from "./MonthGrid";
import { addDays, at, calendarZone, isAllDay, monthGridStart, parts, today, weekStart } from "./calTime";
import { REPEAT } from "./recurrence";
import { useNewParam } from "@/lib/deeplink";
import { WeekGrid } from "./WeekGrid";
import type { CalEvent, Project } from "./types";
import { meetingHref } from "@/lib/links";

type CalMode = "week" | "month" | "agenda";

const KIND = (tx: T): Record<string, string> => ({ meeting: tx("work.calendarview.cuoc_hop"), deadline: tx("work.calendarview.han_chot"), event: tx("work.calendarview.su_kien") });

/** Calendar like Google Calendar: week (default), month or agenda; drag your events to reschedule. */
export function CalendarView({ events, projects }: { events: CalEvent[]; projects: Project[]; from?: string }) {
  const { dayLabel, time } = useFormat();
  const tx = useT();
  const tag = INTL_TAG[useLocale()];
  const dir = useDirectory();
  const router = useRouter();
  const [list, setList] = useState(events);
  const [creating, setCreating] = useNewParam("event");
  const [slot, setSlot] = useState<Date | null>(null);
  const [cancelling, setCancelling] = useState<CalEvent | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [view, setViewRaw] = useState<CalMode>("week");
  // The day the view is anchored on lives in the URL (?date=), so a link or the back button lands on the same week.
  const anchor = dayParam(useSearchParams().get("date")) ?? today();
  const setAnchor = (key: string, jump = false) => {
    const q = new URLSearchParams(window.location.search);
    if (key === today()) q.delete("date");
    else q.set("date", key);
    const url = `${window.location.pathname}${q.size ? `?${q}` : ""}`;
    // A jump from the picker is a step back can undo; arrows paging week by week would bury it, so they replace.
    if (jump) window.history.pushState(null, "", url);
    else window.history.replaceState(null, "", url);
  };
  const [syncing, setSyncing] = useState(false);
  // Any entry opens in the large centred view (the meeting peek), like a task; closing it comes back here.
  const open = (e: CalEvent) => router.push(meetingHref(e), { scroll: false });
  const path = usePathname();
  // Back from the peek (an answer, a cancellation, an edit there): reload what the grid shows.
  useEffect(() => {
    if (path === "/app/work/calendar") setTick((n) => n + 1);
  }, [path]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    try {
      const v = localStorage.getItem("wos_cal_view");
      if (v === "month" || v === "agenda" || v === "week") setViewRaw(v);
      // A phone fits three days of the week grid: the list (from today) reads better until one is chosen.
      else if (window.matchMedia("(max-width: 639px)").matches) setViewRaw("agenda");
    } catch {
      /* ignore */
    }
  }, []);
  const setView = (v: CalMode) => {
    setViewRaw(v);
    try {
      localStorage.setItem("wos_cal_view", v);
    } catch {
      /* ignore */
    }
  };
  const range = view === "week" ? { start: weekStart(anchor), days: 7 } : view === "month" ? { start: monthGridStart(anchor), days: 42 } : { start: anchor, days: 14 };
  useEffect(() => {
    let alive = true;
    api<{ events: CalEvent[] }>(`work/calendar/events?from=${at(range.start).toISOString()}&to=${at(addDays(range.start, range.days)).toISOString()}`)
      .then((r) => alive && setList(r.events))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [range.start, range.days, tick]);
  const step = (n: number) => {
    if (view === "month") {
      const d = at(anchor, 12 * 60);
      setAnchor(parts(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1, 5))).key);
    } else setAnchor(addDays(anchor, n * (view === "week" ? 7 : 14)));
  };
  const title =
    view === "month"
      ? dateFormat(tag, { timeZone: calendarZone(), month: "long", year: "numeric" }).format(at(anchor, 12 * 60))
      : `${dateFormat(tag, { timeZone: calendarZone(), day: "numeric", month: "short" }).format(at(range.start, 12 * 60))} – ${dateFormat(tag, {
          timeZone: calendarZone(),
          day: "numeric",
          month: "short",
          year: "numeric",
        }).format(at(addDays(range.start, range.days - 1), 12 * 60))}`;
  const days = Array.from({ length: 14 }, (_, i) => addDays(anchor, i));
  // The next thing on my calendar, above the grids: a grid scrolled or paged elsewhere never hides it.
  const upNext = list.filter((e) => Date.parse(e.endsAt) > Date.now() && e.response !== "declined" && !isAllDay(e)).sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0];

  /** Drag to reschedule: the calendar moves at once and goes back if the server says no. */
  const reschedule = async (e: CalEvent, startsAt: Date, endsAt: Date) => {
    const before = list;
    setList((l) => l.map((x) => (x.id === e.id ? { ...x, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() } : x)));
    setMsg(null);
    try {
      await api(`work/calendar/events/${e.id}`, { method: "PATCH", body: { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() } });
      setMsg(tx("work.calendarview.moved", { title: e.title, when: `${dayLabel(startsAt)} ${time(startsAt)}` }));
    } catch {
      setList(before);
      setMsg(tx("work.calendarview.moveFailed"));
    }
  };

  const respond = async (e: CalEvent, response: "accepted" | "declined") => {
    setMsg(null);
    try {
      await api(`work/calendar/events/${e.id}/respond`, { method: "POST", body: { response } });
      setList((l) => l.map((x) => (x.id === e.id ? { ...x, response } : x)));
    } catch {
      setMsg(tx("work.calendarview.respondFailed"));
    }
  };
  const cancel = async (e: CalEvent, scope: "one" | "following") => {
    setCancelling(null);
    await api(`work/calendar/events/${e.id}${scope === "following" ? "?scope=following" : ""}`, { method: "DELETE" });
    setList((l) => l.filter((x) => (scope === "following" && e.seriesId ? !(x.seriesId === e.seriesId && x.startsAt >= e.startsAt) : x.id !== e.id)));
  };

  return (
    <>
      <PageHeader
        title={tx("work.page.lich")}
        actions={
          <>
            {/* Sync is a visible action, not hidden alone in a "⋯" menu. */}
            <button type="button" className={btn} onClick={() => setSyncing(true)}>
              <LinkIcon />
              <span className="max-sm:sr-only">{tx("work.calsync.button")}</span>
            </button>
            <button type="button" className={btnPrimary} onClick={() => setCreating(true)}>
              <PlusIcon className="size-4" />
              {tx("work.calendarview.tao_lich")}
            </button>
          </>
        }
        tabs={<Tabs tabs={workSubTabs("calendar", tx)} active="calendar" label={tx("work.page.lich")} />}
      />
      <CalendarSync open={syncing} onClose={() => setSyncing(false)} />
      {/* Where we are in time, and how to see it: one quiet row above the grid. */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button type="button" className={cx(btn, btnSm)} onClick={() => setAnchor(today())}>
          {tx("work.calendarview.today")}
        </button>
        <span className="flex">
          <button type="button" className={cx(btnGhost, btnSm, "w-8 px-0")} onClick={() => step(-1)} aria-label={tx("work.calendarview.prev")} title={tx("work.calendarview.prev")}>
            <ChevronLeftIcon className="size-4" />
          </button>
          <button type="button" className={cx(btnGhost, btnSm, "w-8 px-0")} onClick={() => step(1)} aria-label={tx("work.calendarview.next")} title={tx("work.calendarview.next")}>
            <ChevronRightIcon className="size-4" />
          </button>
        </span>
        {/* The period is also the way to any other date: its picker pages by month, year and decade. */}
        <h2 className="m-0 flex min-w-0 flex-1 max-sm:order-first max-sm:basis-full">
          <DateField
            variant="title"
            label={tx("work.calendarview.jumpTo")}
            value={anchor}
            onChange={(k) => k && setAnchor(k, true)}
            display={title}
            clearable={false}
            className="max-w-full max-sm:-ml-1.5"
            triggerClassName="font-display h-9 text-[22px]/7 font-semibold capitalize tracking-[-0.03em] max-sm:text-xl"
          />
        </h2>
        <Segmented
          label={tx("work.calendarview.kieu_xem_lich")}
          value={view}
          onChange={setView}
          options={[
            { value: "week", label: tx("work.calendarview.tuan") },
            { value: "month", label: tx("work.calendarview.thang") },
            { value: "agenda", label: tx("work.calendarview.danh_sach") },
          ]}
        />
      </div>
      {upNext && view !== "agenda" ? (
        // The next event as one pill (Home's announcement line), its tone's dot first.
        <p className={cx(meta, "bg-surface shadow-card m-0 mb-3 flex w-fit min-w-0 max-w-full items-center gap-1.5 rounded-full py-1.5 pl-3 pr-4")}>
          <span aria-hidden="true" className={cx("size-2 shrink-0 rounded-full", toneOf(upNext).dot)} />
          <span className="shrink-0">{tx("work.calendarview.upNext")}</span>
          <span aria-hidden="true">·</span>
          <span className="text-ink shrink-0 tabular-nums">
            {dayLabel(new Date(upNext.startsAt))} {time(upNext.startsAt)}
          </span>
          <span aria-hidden="true">·</span>
          {upNext.kind === "meeting" ? (
            <Link href={meetingHref(upNext)} className={cx("text-ink min-w-0 truncate font-medium", hitPad)}>
              {upNext.title}
            </Link>
          ) : (
            <span className="text-ink min-w-0 truncate font-medium">{upNext.title}</span>
          )}
        </p>
      ) : null}
      {msg ? (
        <p role="status" className="text-ink-2 m-0 mb-2 text-sm">
          {msg}
        </p>
      ) : null}
      {view === "week" ? (
        <WeekGrid events={list} start={range.start} me={dir.me} onMove={(e, a, b) => void reschedule(e, a, b)} onSlot={setSlot} onOpen={open} />
      ) : view === "month" ? (
        <MonthGrid
          events={list}
          start={range.start}
          month={anchor.slice(0, 7)}
          me={dir.me}
          onMove={(e, a, b) => void reschedule(e, a, b)}
          onSlot={setSlot}
          onOpen={open}
          onOpenDay={(k) => {
            setAnchor(k, true);
            setView("week");
          }}
        />
      ) : list.length === 0 ? (
        <SlimEmpty
          icon={<CalendarIcon />}
          tone="tangerine"
          title={tx("work.calendarview.khong_co_lich_nao")}
          action={
            <button type="button" className={btn} onClick={() => setCreating(true)}>
              {tx("work.calendarview.tao_cuoc_hop")}
            </button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-5">
          {days.map((d) => {
            const rows = list.filter((e) => parts(e.startsAt).key === d);
            if (!rows.length) return null;
            return (
              <section key={d} aria-label={dayLabel(at(d, 12 * 60))}>
                <h2 className="text-ink-2 mb-2 text-xs font-medium uppercase tracking-[0.08em]">{dayLabel(at(d, 12 * 60))}</h2>
                <ul className="divide-divider-soft bg-surface shadow-card m-0 list-none divide-y overflow-hidden rounded-xl p-0">
                  {rows.map((e) => (
                    <li key={e.id} className="hover:bg-hover/60 grid gap-x-3 gap-y-1.5 px-4 py-3 transition-colors sm:grid-cols-[7rem_minmax(0,1fr)_auto] sm:items-center">
                      <span className={cx("text-ink-2 flex items-center gap-2 tabular-nums", smallText)}>
                        <span aria-hidden="true" className={cx("size-2 shrink-0 rounded-full", e.response === "declined" ? "bg-edge" : toneOf(e).dot)} />
                        {isAllDay(e) ? tx("work.weekgrid.allDay") : `${time(e.startsAt)}–${time(e.endsAt)}`}
                      </span>
                      <span className="min-w-0">
                        <button
                          type="button"
                          aria-haspopup="dialog"
                          onClick={() => open(e)}
                          className={cx("text-ink line-clamp-2 block text-left font-medium hover:underline max-md:py-1", e.response === "declined" && "text-ink-2 line-through")}
                        >
                          {e.title}
                        </button>
                        <span className={cx("text-ink-2", smallText)}>
                          {tx("work.calendarview.to_chuc_boi", {
                            p0: KIND(tx)[e.kind] ?? e.kind,
                            // Mid-sentence, so only the first letter drops to lower case ("weekdays (Mon–Fri)", not "(mon–fri)").
                            p1: e.recurrence ? ` · ${lowerFirst(REPEAT(tx)[e.recurrence] ?? tx("work.calendarview.dinh_ky"))}` : "",
                            p2: e.location ? ` · ${e.location}` : "",
                            p3: dir.name(e.organizerId),
                          })}
                        </span>
                      </span>
                      {e.organizerId === dir.me ? (
                        Date.parse(e.endsAt) < Date.now() ? null : (
                          <button type="button" className={cx(btn, btnSm)} onClick={() => setCancelling(e)}>
                            {tx("work.calendarview.huy_lich")}
                          </button>
                        )
                      ) : (
                        <Rsvp response={e.response} past={Date.parse(e.endsAt) < Date.now()} onRespond={(r) => void respond(e, r)} />
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
      {cancelling ? (
        <Modal
          title={tx("work.calendarview.huy", { p0: cancelling.title })}
          onClose={() => setCancelling(null)}
          footer={
            cancelling.seriesId ? (
              <>
                <button type="button" className={btn} onClick={() => setCancelling(null)}>
                  {tx("work.calendarview.giu_lai")}
                </button>
                <button type="button" className={btn} onClick={() => void cancel(cancelling, "one")}>
                  {tx("work.calendarview.chi_buoi_nay")}
                </button>
                <button type="button" className={btnDanger} onClick={() => void cancel(cancelling, "following")}>
                  {tx("work.calendarview.buoi_nay_va_cac")}
                </button>
              </>
            ) : (
              <>
                <button type="button" className={btn} onClick={() => setCancelling(null)}>
                  {tx("work.calendarview.giu_lai")}
                </button>
                <button type="button" className={btnDanger} onClick={() => void cancel(cancelling, "one")}>
                  {tx("work.calendarview.huy_lich")}
                </button>
              </>
            )
          }
        >
          <p className="m-0 text-sm">{cancelling.seriesId ? tx("work.calendarview.day_la_lich_lap") : tx("work.calendarview.lich_bien_mat_khoi")}</p>
        </Modal>
      ) : null}
      {creating || slot ? (
        <NewEventModal
          projects={projects}
          initial={slot}
          onClose={() => {
            setCreating(false);
            setSlot(null);
          }}
          onCreated={() => {
            setCreating(false);
            setSlot(null);
            setTick((n) => n + 1);
            router.refresh();
          }}
        />
      ) : null}
    </>
  );
}

/** "HH:mm" → minutes since midnight. */
const minutesOf = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
const hhmm = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const addMinutes = (hm: string, n: number) => hhmm(Math.min(minutesOf(hm) + n, 23 * 60 + 45));

/** Times every 15 minutes (after `after` when given), plus the current value if it is off the grid. */
function timeSlots(current: string, after?: string) {
  const min = after ? minutesOf(after) + 15 : 0;
  const slots: string[] = [];
  for (let m = min; m < 24 * 60; m += 15) slots.push(hhmm(m));
  if (current && !slots.includes(current)) {
    slots.push(current);
    slots.sort();
  }
  return slots.map((v) => ({ value: v, label: v }));
}

export function NewEventModal({
  projects,
  onClose,
  onCreated,
  initial = null,
}: {
  projects: Project[];
  onClose: () => void;
  onCreated: () => void;
  /** Clicked on the calendar: start there, for an hour. */
  initial?: Date | null;
}) {
  const tx = useT();
  const dir = useDirectory();
  // Dates and times here are the workspace's (Admin › Settings), the zone the calendar shows them in, not this
  // browser's: someone travelling would otherwise book a meeting hours off.
  const zone = workspaceTimeZone();
  const local = (d: Date) => wallTime(d, zone);
  const start0 = initial ? new Date(initial) : nextSlot(new Date(), zone);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState("meeting");
  const [day, setDay] = useState(local(start0).slice(0, 10));
  const [from, setFrom] = useState(local(start0).slice(11, 16));
  const [to, setTo] = useState(local(new Date(start0.getTime() + 3600e3)).slice(11, 16));
  const start = `${day}T${from}`;
  const end = `${day}T${to}`;
  const [location, setLocation] = useState("");
  const [projectId, setProjectId] = useState("");
  const [people, setPeople] = useState<string[]>([]);
  const [repeat, setRepeat] = useState("");
  const [until, setUntil] = useState(local(new Date(start0.getTime() + 90 * 86400e3)).slice(0, 10));
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!title.trim()) {
      setError(tx("work.calendarview.dat_ten_cho_lich"));
      return;
    }
    if (end <= start) {
      setError(tx("work.calendarview.gio_ket_thuc_phai"));
      return;
    }
    if (repeat && until < start.slice(0, 10)) {
      setError(tx("work.calendarview.ngay_ket_thuc_lap"));
      return;
    }
    try {
      const recurrence = repeat ? { rule: repeat, until: fromWallTime(`${until}T23:59`, zone).toISOString(), timeZone: zone } : null;
      await api("work/calendar/events", {
        method: "POST",
        body: {
          title,
          kind,
          startsAt: fromWallTime(start, zone).toISOString(),
          endsAt: fromWallTime(end, zone).toISOString(),
          location,
          projectId: projectId || null,
          attendeeIds: [...new Set([dir.me, ...people])],
          recurrence,
        },
      });
      onCreated();
    } catch {
      setError(tx("work.calendarview.chua_tao_duoc_lich"));
    }
  };
  return (
    <Modal
      title={tx("work.calendarview.tao_lich")}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className={btn} onClick={onClose}>
            {tx("work.calendarview.huy_2")}
          </button>
          <button type="button" className={btnPrimary} onClick={() => void submit()}>
            {tx("work.calendarview.tao_va_gui_loi")}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4">
        <Field label={tx("work.calendarview.tieu_de")} error={error}>
          <input className={input} value={title} onChange={(e) => setTitle(e.target.value)} autoFocus placeholder={tx("work.calendarview.hop_giao_ban")} />
        </Field>
        <div className="grid grid-cols-2 items-start gap-3 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)]">
          <div className="col-span-2 sm:col-span-1">
            <FormField label={tx("work.calendarview.ngay")}>
              <DateField label={tx("work.calendarview.ngay")} value={day} clearable={false} onChange={(v) => v && setDay(v)} />
            </FormField>
          </div>
          <FormField label={tx("work.calendarview.tu")}>
            <Picker
              variant="field"
              label={tx("work.calendarview.tu")}
              value={from}
              options={timeSlots(from)}
              onChange={(v) => {
                // Keep the meeting's length when the start moves past the end.
                if (to <= v) setTo(addMinutes(v, Math.max(15, minutesOf(to) - minutesOf(from))));
                setFrom(v);
              }}
            />
          </FormField>
          <FormField label={tx("work.calendarview.den")}>
            <Picker variant="field" label={tx("work.calendarview.den")} value={to} options={timeSlots(to, from)} onChange={setTo} />
          </FormField>
          <p className="text-ink-2 col-span-2 m-0 -mt-1 text-xs sm:col-span-3">{tx("work.calendarview.zoneHint", { zone: zone.replace(/_/g, " ") })}</p>
        </div>
        {kind !== "deadline" ? (
          <div className="grid grid-cols-2 items-start gap-3">
            <FormField label={tx("work.calendarview.lap_lai")}>
              <Picker
                variant="field"
                label={tx("work.calendarview.lap_lai")}
                value={repeat}
                onChange={setRepeat}
                options={[{ value: "", label: tx("work.calendarview.khong_lap_lai") }, ...Object.entries(REPEAT(tx)).map(([k, v]) => ({ value: k, label: v }))]}
              />
            </FormField>
            {repeat ? (
              <FormField label={tx("work.calendarview.den_ngay")} hint={tx("work.calendarview.toi_da_1_nam")}>
                <DateField label={tx("work.calendarview.den_ngay")} value={until} onChange={setUntil} />
              </FormField>
            ) : null}
          </div>
        ) : null}
        <div className="grid gap-4 md:grid-cols-2">
          <div className="grid content-start gap-4">
            <FormField label={tx("work.calendarview.loai")}>
              <Picker
                variant="field"
                label={tx("work.calendarview.loai")}
                value={kind}
                onChange={setKind}
                options={Object.entries(KIND(tx)).map(([k, v]) => ({ value: k, label: v }))}
              />
            </FormField>
            <Field label={tx("work.calendarview.dia_diem_hoac_link")}>
              <input className={input} value={location} onChange={(e) => setLocation(e.target.value)} placeholder={tx("work.calendarview.phong_hop_3_google")} />
            </Field>
            <FormField label={tx("work.calendarview.du_an")}>
              <Picker
                variant="field"
                label={tx("work.calendarview.du_an")}
                value={projectId}
                onChange={setProjectId}
                options={[{ value: "", label: tx("work.calendarview.khong") }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
              />
            </FormField>
          </div>
          <Field label={tx("work.calendarview.moi_tham_gia")}>
            <PeoplePicker selected={people} onChange={setPeople} exclude={[dir.me]} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLocaleLowerCase() + s.slice(1);
}

/** The next half hour inside working hours (09:00–18:00, Monday to Friday) in `zone`: where a new event starts. */
function nextSlot(now: Date, zone: string): Date {
  const wall = wallTime(new Date(Math.ceil(now.getTime() / 1800e3) * 1800e3), zone);
  let day = wall.slice(0, 10);
  let time = wall.slice(11, 16);
  const weekday = (d: string) => new Date(`${d}T12:00:00Z`).getUTCDay();
  const nextDay = (d: string) => new Date(Date.parse(`${d}T12:00:00Z`) + 86400e3).toISOString().slice(0, 10);
  if (time < "09:00") time = "09:00";
  else if (time > "17:30") {
    day = nextDay(day);
    time = "09:00";
  }
  while (weekday(day) === 0 || weekday(day) === 6) {
    day = nextDay(day);
    time = "09:00";
  }
  return fromWallTime(`${day}T${time}`, zone);
}
