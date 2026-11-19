"use client";

import { dateFormat } from "@/lib/intl";
import { useFeature } from "@/lib/features-context";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { api } from "@/lib/client";
import { useFormat, useLocale } from "@/lib/i18n/client";
import { taskHref } from "@/lib/links";
import { formatMentions } from "@/lib/names";
import { Avatar, AvatarFace, useDirectory } from "@/lib/people";
import { BrandMark } from "@/components/ui/BrandMark";
import { useToast } from "@/components/ui/Toast";
import { LoadFailed } from "@/components/ui/LoadFailed";
import { btn, btnPrimary, cx } from "@/lib/ui";
import { ArrowUpIcon, AtIcon, CalendarIcon, CheckCircleIcon, CheckIcon } from "@/components/app/icons";
import { Figure, Quiet, Tile, tileRow } from "@/components/ui/Bento";
import { JOIN_BEFORE, MENTION_ROWS, TASK_ROWS, dayOffset, planHome, type MyTask } from "./model";

// Only when a meeting is about to start: its own chunk.
const MeetNowButton = dynamic(() => import("@/components/meet/MeetNow").then((m) => m.MeetNowButton));

export interface HomeTask extends MyTask {
  code?: string | null;
  projectId: string | null;
  version: number;
}
export interface AgendaItem {
  key: string;
  kind: "meeting" | "deadline";
  at: string;
  endsAt?: string | null;
  title: string;
  meta?: string | null;
  href: string;
  eventId?: string;
}
export interface MentionItem {
  key: string;
  authorId: string | null;
  /** A channel's name, or null for a direct message. */
  channel: string | null;
  text: string;
  at: string | null;
  href: string;
}

const VI_DAYS = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];
const rowTitle = "text-ink block truncate text-sm no-underline hover:underline";

function Done({ title, onClick }: { title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={title}
      onClick={onClick}
      className="border-ink-2/40 hover:border-ok hover:bg-ok-wash hover:text-ok grid size-[18px] shrink-0 place-items-center rounded-full border-[1.5px] p-0 text-transparent transition-colors max-md:size-6"
    >
      <CheckIcon className="size-3" />
    </button>
  );
}

/**
 * Home's board: the greeting, the question for the company's AI, then the bento: next meeting, my tasks, mentions and
 * the page's own tile (`side`: the team for managers, my week for everyone else). Tasks are marked done in place,
 * optimistically: the task leaves at once and comes back with a message if the server refuses. A failed read shows a
 * retry in its own tile only.
 */
export function HomeBoard({
  tasks,
  meetings,
  mentions,
  tz,
  failed,
  side,
  between,
  hello,
  top,
  aiOn,
  week,
}: {
  tasks: HomeTask[];
  meetings: AgendaItem[];
  mentions: MentionItem[];
  tz: string;
  failed: { tasks: boolean; meetings: boolean; mentions: boolean };
  side: React.ReactNode;
  /** Between the ask bar and the bento: the manager's Today, the first-run steps. */
  between?: React.ReactNode;
  /** The greeting, written on the server in the workspace's time zone. No date eyebrow. */
  hello: string;
  /** Beside the greeting: today's attendance, where the company clocks in. */
  top?: React.ReactNode;
  /** A company AI answers questions: the ask bar leads the page. */
  aiOn: boolean;
  /** Tasks I finished this week and last; null when the read failed. */
  week: { done: number; last: number } | null;
}) {
  const f = useFormat();
  const { t, time } = f;
  const locale = useLocale();
  const dir = useDirectory();
  const toast = useToast();
  const [open, setOpen] = useState(tasks);
  const [error, setError] = useState<string | null>(null);
  // Re-planned every minute, so a meeting's "in 5 min" and its join button follow the clock.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const day = useMemo(() => planHome({ approvals: [], tasks: open, meetings, mentions }, { tz, now }), [open, meetings, mentions, tz, now]);

  // ---- tasks ----
  const complete = (task: HomeTask) => {
    setError(null);
    setOpen((l) => l.filter((x) => x.id !== task.id));
    api(`work/tasks/${task.id}`, { method: "PATCH", body: { expectedVersion: task.version, status: "done" } })
      .then(() => toast({ message: t("home.mine.done", { title: task.title }) }))
      .catch(() => {
        setOpen((l) => (l.some((x) => x.id === task.id) ? l : [...l, task]));
        setError(t("home.mine.error", { title: task.title }));
      });
  };
  const lateDays = (task: MyTask) => Math.max(1, -(task.dueAt ? dayOffset(task.dueAt, tz, now) : 0));
  const dueLabel = (task: HomeTask): { text: string; late: boolean } => {
    if (!task.dueAt) return { text: t("home.mine.noDue"), late: false };
    if (Date.parse(task.dueAt) < now) return { text: t("home.mine.late", { count: lateDays(task) }), late: true };
    const d = dayOffset(task.dueAt, tz, now);
    if (d === 0) return { text: time(task.dueAt, tz), late: false };
    if (d === 1) return { text: t("home.mine.dueTomorrow"), late: false };
    const wd = dateFormat("en-US", { timeZone: tz, weekday: "short" }).format(new Date(task.dueAt));
    const name = locale === "vi" ? VI_DAYS[["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd)] : wd;
    return { text: `${name} ${f.shortDate(task.dueAt, tz)}`, late: false };
  };
  const when = (iso: string) => (now - Date.parse(iso) < 86400_000 && f.dayLabel(iso) === t("format.today") ? time(iso) : f.dayLabel(iso));

  const myTasks = [...day.late, ...day.today, ...day.upcoming];
  const agenda = day.meetings;
  const next = agenda.find((m) => m.key === day.joinKey) ?? agenda[0] ?? null;
  const rest = agenda.filter((m) => m !== next);
  const nextStarts = next ? Date.parse(next.at) : 0;
  const nextLive = !!next && nextStarts <= now;
  const nextJoinable = !!next && next.key === day.joinKey && nextStarts - now <= JOIN_BEFORE;

  // The pointer's light (`spot`) for whichever card it is over: one listener for the whole board.
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "mouse") return;
    const el = (e.target as HTMLElement).closest<HTMLElement>(".spot");
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${e.clientX - r.left}px`);
    el.style.setProperty("--my", `${e.clientY - r.top}px`);
  };

  // A tile with something to show is a full tile; one with nothing (or a failed read) is a cell of the quiet strip
  // under the bento, so an empty day never leaves tall blank cards.
  const hasCalendar = useFeature("calendar");
  const meetingsFull = hasCalendar && !failed.meetings && !!next;
  const tasksFull = !failed.tasks && myTasks.length > 0;
  const mentionsFull = !failed.mentions && day.mentions.length > 0;
  const full = 1 + Number(meetingsFull) + Number(tasksFull) + Number(mentionsFull);
  const quietCount = (hasCalendar ? 4 : 3) - full;

  const meetingsTile =
    meetingsFull && next ? (
      <Tile
        id="home-today"
        icon={<CalendarIcon />}
        tone="tangerine"
        title={t("home.tiles.meetings")}
        link={{ href: "/app/work/calendar", label: t("home.tiles.calendar") }}
        className={full === 4 ? "@4xl:col-start-1 @4xl:row-start-1" : undefined}
      >
        <Figure n={<time dateTime={next.at}>{time(next.at, tz)}</time>}>
          <span className={cx("rounded-full px-2 py-0.5 text-xs font-medium", nextLive ? "bg-block-wash text-block" : "bg-ground ring-hairline text-ink-2 ring-1 ring-inset")}>
            {nextLive ? t("home.focus.live") : t("home.focus.in", { count: Math.max(0, Math.ceil((nextStarts - now) / 60_000)) })}
          </span>
        </Figure>
        <Link href={next.href} className={cx(rowTitle, "mt-2.5 font-medium")}>
          {next.kind === "deadline" ? t("home.cal.deadline", { title: next.title }) : next.title}
        </Link>
        {next.meta ? <span className="text-ink-2 block truncate text-xs">{next.meta}</span> : null}
        {nextJoinable && next.eventId ? (
          <span className="mt-3">
            <MeetNowButton eventId={next.eventId} label={t("home.cal.join")} className={cx(btnPrimary, "w-full")} />
          </span>
        ) : null}
        {rest.length ? (
          <ul className="border-divider m-0 mt-3 list-none border-t p-0 pt-1">
            {rest.slice(0, 3).map((m) => (
              <li key={m.key} className={cx(tileRow, "min-h-9 py-1")}>
                <time dateTime={m.at} className="text-ink-2 w-11 shrink-0 text-xs font-medium tabular-nums">
                  {time(m.at, tz)}
                </time>
                <Link href={m.href} className={cx(rowTitle, "min-w-0 flex-1 text-[13px]")}>
                  {m.kind === "deadline" ? t("home.cal.deadline", { title: m.title }) : m.title}
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </Tile>
    ) : (
      <Quiet
        id="home-today"
        icon={<CalendarIcon />}
        tone="tangerine"
        title={t("home.tiles.meetings")}
        link={{ href: "/app/work/calendar", label: t("home.tiles.calendar") }}
        clear={!failed.meetings}
      >
        {failed.meetings ? <LoadFailed className="text-[13px]" /> : t("home.tiles.meetingsEmpty")}
      </Quiet>
    );

  const tasksTile = tasksFull ? (
    <Tile
      id="home-tasks"
      icon={<CheckCircleIcon />}
      tone="sky"
      title={t("home.tiles.tasks")}
      link={{ href: "/app/work/tasks?view=list", label: t("home.tiles.allTasks") }}
      className={full === 4 ? "@4xl:col-start-2 @4xl:row-span-2 @4xl:row-start-1" : undefined}
    >
      <Figure n={myTasks.length} label={t("home.tiles.open", { count: myTasks.length })}>
        {day.late.length ? <span className="bg-block-wash text-block rounded-full px-2 py-0.5 text-xs font-medium">{t("home.tiles.late", { count: day.late.length })}</span> : null}
      </Figure>
      <ul className="m-0 mt-3 list-none p-0">
        {myTasks.slice(0, TASK_ROWS).map((task) => {
          const due = dueLabel(task);
          return (
            <li key={task.id} className={tileRow}>
              <Done title={t("home.mine.complete", { title: task.title })} onClick={() => complete(task)} />
              <Link href={taskHref(task)} className={cx(rowTitle, "min-w-0 flex-1")}>
                {task.title}
              </Link>
              <span className={cx("shrink-0 text-xs tabular-nums", due.late ? "text-block font-medium" : "text-ink-2")}>{due.text}</span>
            </li>
          );
        })}
      </ul>
      {/* Ends on an action like the week tile beside it, so short lists still balance the row. */}
      <div className="mt-auto pt-5">
        <Link href="/app/work/tasks?view=list" className={cx(btn, "w-full")}>
          {myTasks.length > TASK_ROWS ? t("home.tiles.more", { count: myTasks.length - TASK_ROWS }) : t("home.tiles.allTasks")}
        </Link>
      </div>
    </Tile>
  ) : (
    <Quiet
      id="home-tasks"
      icon={<CheckCircleIcon />}
      tone="sky"
      title={t("home.tiles.tasks")}
      link={{ href: "/app/work/tasks?view=list", label: t("home.tiles.allTasks") }}
      clear={!failed.tasks}
    >
      {failed.tasks ? <LoadFailed className="text-[13px]" /> : t("home.tiles.tasksEmpty")}
    </Quiet>
  );

  const mentionsTile = mentionsFull ? (
    <Tile
      id="home-mentions"
      icon={<AtIcon />}
      tone="violet"
      title={t("home.tiles.mentions")}
      link={{ href: "/app/chat/mentions", label: t("home.tiles.allMentions") }}
      className={full === 4 ? "@4xl:col-start-1 @4xl:row-start-2" : undefined}
    >
      <Figure n={day.mentions.length} label={t("home.tiles.waiting", { count: day.mentions.length })} />
      <ul className="m-0 mt-3 list-none p-0">
        {day.mentions.slice(0, MENTION_ROWS).map((m) => (
          <li key={m.key}>
            <Link href={m.href} className="text-ink hover:bg-hover -mx-2 flex min-h-11 min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 no-underline transition-colors">
              {m.authorId ? <Avatar id={m.authorId} size="sm" /> : <AvatarFace name="@" seed={m.key} size="sm" />}
              <span className="min-w-0 flex-1 leading-[1.35]">
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                    {m.authorId ? dir.name(m.authorId) : t("home.mentions.someone")}
                    <span className="text-ink-2 font-normal"> · {m.channel ? `#${m.channel}` : t("home.mentions.dm")}</span>
                  </span>
                  {m.at ? <span className="text-ink-2 shrink-0 text-xs tabular-nums">{when(m.at)}</span> : null}
                </span>
                <span className="text-ink-soft block truncate text-[13px]">{formatMentions(m.text, dir.names)}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Tile>
  ) : (
    <Quiet
      id="home-mentions"
      icon={<AtIcon />}
      tone="violet"
      title={t("home.tiles.mentions")}
      link={{ href: "/app/chat/mentions", label: t("home.tiles.allMentions") }}
      clear={!failed.mentions}
    >
      {failed.mentions ? <LoadFailed className="text-[13px]" /> : t("home.tiles.mentionsEmpty")}
    </Quiet>
  );

  const fullTiles = [meetingsFull ? meetingsTile : null, tasksFull ? tasksTile : null, mentionsFull ? mentionsTile : null].filter(Boolean);
  // No calendar on this installation (left out at deploy time): no "Meetings today" cell, not an empty one.
  const quietTiles = [meetingsFull || !hasCalendar ? null : meetingsTile, tasksFull ? null : tasksTile, mentionsFull ? null : mentionsTile].filter(Boolean);

  return (
    <div className="@container flex min-w-0 flex-col gap-4" onPointerMove={onPointerMove}>
      {error ? (
        <p role="alert" className="bg-block-wash text-block m-0 rounded-lg px-3 py-2 text-sm">
          {error}
        </p>
      ) : null}
      {/*
        The top of Home (2026-11-11): the greeting with how the week is going, then the question for the AI as the
        first thing on the page. Plain white cards on the canvas: no glow, no dot grid, no gradient.
      */}
      <header className="flex min-w-0 flex-wrap items-end justify-between gap-x-8 gap-y-3">
        <div className="min-w-0">
          <h1 data-page-title="" className="font-display m-0 text-balance text-[28px]/[1.15] font-semibold tracking-[-0.035em] max-sm:text-2xl/[1.2]">
            {hello}
          </h1>
          {week ? (
            <p className="text-ink-2 m-0 mt-1 text-sm">
              {week.done ? t("home.hello.weekDone", { count: week.done }) : t("home.hello.weekNone")}
              {week.done > week.last && week.last > 0 ? <span className="text-ok font-medium"> {t("home.hello.weekUp", { count: week.done - week.last })}</span> : null}
            </p>
          ) : null}
        </div>
        {top}
      </header>

      {aiOn ? <AskBar /> : null}

      {between}

      {fullTiles.length ? (
        <div className={cx("stagger grid gap-4", full === 4 ? "@xl:grid-cols-2 @4xl:grid-cols-3" : full === 3 ? "@xl:grid-cols-2 @4xl:grid-cols-3" : "@xl:grid-cols-2")}>
          {fullTiles}
          {/* The page's own tile: the team (managers) or my week. */}
          <div
            className={cx(
              "grid min-w-0",
              full === 3 && "@xl:col-span-2 @4xl:col-span-1",
              full === 4 && "@4xl:col-start-3 @4xl:row-span-2 @4xl:row-start-1 @xl:col-span-2 @4xl:col-span-1",
            )}
          >
            {side}
          </div>
        </div>
      ) : (
        side
      )}

      {quietCount ? (
        <div
          className={cx(
            "bg-hairline shadow-card stagger grid gap-px overflow-hidden rounded-xl",
            quietCount === 3 ? "@2xl:grid-cols-3" : quietCount === 2 ? "@xl:grid-cols-2" : "",
          )}
        >
          {quietTiles}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A question for the company's AI, from Home: it opens Hỏi đáp and is sent at once. Drawn as a chat composer (a
 * titled box with a two-line field, a caret-coloured prompt and a labelled send button) so it reads as "type here"
 * at a glance. Three starters cover what people ask first in the morning. Drawn only while a company
 * AI answers (every feature works without one).
 */
function AskBar() {
  const { t } = useFormat();
  const router = useRouter();
  const [q, setQ] = useState("");
  const ask = (text: string) => router.push(`/app/ai/ask?send=1&q=${encodeURIComponent(text)}`);
  const submit = () => {
    if (q.trim()) ask(q.trim());
  };
  const starters = [
    [t("home.ask.plan"), t("home.ask.planPrompt")],
    [t("home.ask.late"), t("home.ask.latePrompt")],
    [t("home.ask.week"), t("aiw.chat.welcome.brief.prompt")],
  ] as const;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="bg-surface shadow-card ring-hairline focus-within:ring-accent/50 grid min-w-0 gap-3 rounded-2xl p-4 ring-1 transition-shadow focus-within:ring-2 max-sm:p-3"
    >
      <label htmlFor="home-ask" className="text-ink flex items-center gap-2.5 text-[15px] font-semibold tracking-[-0.01em]">
        <BrandMark className="size-6" />
        {t("home.ask.title")}
      </label>
      <textarea
        id="home-ask"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        rows={2}
        maxLength={4000}
        placeholder={t("home.ask.placeholder")}
        className="bg-ground ring-hairline text-ink placeholder:text-ink-2 focus:bg-surface min-h-[4.5rem] w-full min-w-0 resize-none rounded-xl px-3.5 py-3 text-[15px]/6 outline-none ring-1 ring-inset transition-colors"
      />
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {starters.map(([label, prompt]) => (
          <button
            key={label}
            type="button"
            onClick={() => ask(prompt)}
            className="bg-surface ring-hairline text-ink-soft hover:text-ink hover:bg-hover inline-flex h-8 items-center rounded-full px-3 text-[13px] ring-1 ring-inset transition-colors"
          >
            {label}
          </button>
        ))}
        <span className="ml-auto flex items-center gap-3">
          <span className="text-ink-2 text-xs max-sm:hidden">{t("home.ask.hint")}</span>
          <button type="submit" disabled={!q.trim()} className={cx(btnPrimary, "px-4 disabled:opacity-40")}>
            {t("home.ask.send")}
            <ArrowUpIcon className="size-4" />
          </button>
        </span>
      </div>
    </form>
  );
}
