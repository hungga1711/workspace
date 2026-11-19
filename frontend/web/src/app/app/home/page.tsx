import { workspaceInfo } from "@/lib/features";
import { featureOfHref, type Feature } from "@/lib/feature-links";
import { getTimeZone } from "@/lib/setup";
import { meetingHref } from "@/lib/links";
import { aiMonitoring, aiStatus } from "@/lib/ai";
import type { Metadata } from "next";
import { gw } from "@/lib/gateway";
import { readSession } from "@/lib/session";
import { localDate } from "@/lib/format";
import { getFormat, getT } from "@/lib/i18n/server";
import { projectHealthOf } from "@/lib/health";
import { HomeBoard, type AgendaItem, type HomeTask, type MentionItem } from "@/components/home/Board";
import { TeamTile, WeekTile } from "@/components/home/Side";
import { ManagerLine } from "@/components/home/ManagerLine";
import { PushPrompt, StartChecklist } from "@/components/home/HomeLazy";
import { AttendanceToday } from "@/components/home/AttendanceToday";
import { AiThisWeek, TodayBrief } from "@/components/home/TodayBrief";
import dynamic from "next/dynamic";

// Only the AI Insights only home shows the pace block: its code loads there, not on every Home.
const Velocity = dynamic(() => import("@/components/work/Velocity").then((m) => m.Velocity));
import { homeRole, todayItems, type AiDone, type AiWeek, type DeptNumbers, type StuckPerson, type TeamTotals } from "@/components/home/model";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("shell.nav.home") };
}

interface HomeProject {
  id: string;
  name: string;
  dueAt: string | null;
  openTasks: number;
  overdueTasks: number;
  doneTasks: number;
  totalTasks: number;
  blockedTasks?: number;
  atRiskTasks?: number;
  health?: "done" | "on_track" | "at_risk" | "behind" | "not_started";
  daysLeft?: number | null;
}
interface NeedsItem {
  kind: string;
  refId: string;
  title: string;
  subtitle: string;
  url: string;
}
interface TodayItem {
  kind: string;
  refId: string;
  title: string;
  subtitle: string;
  url: string;
  at: string;
}
interface Home {
  needsYou: NeedsItem[];
  today: TodayItem[];
  timezone: string;
  generatedAt: string;
}
interface Workspace {
  workspace: { name: string; created_at: string };
  config: { timezone: string; home: { sections: { announcements: boolean } } };
  features?: { attendance?: boolean; insightsOnly?: boolean } & Partial<Record<Feature, boolean>>;
}
interface Team {
  scope: string;
  totals: TeamTotals;
  departments?: DeptNumbers[];
  people?: { userId: string; displayName: string; overdue: number; blocked: number; stale: number; tasks: { blockedReason: string | null }[] }[];
}
interface Summary {
  open: (HomeTask & { assigneeId: string | null })[];
  recentlyDone: { id: string; code?: string | null; title: string }[];
  projects: { id: string; name: string }[];
  stats: { overdue: number; doneToday?: number; doneThisWeek: number; doneLastWeek: number; onTimeRate: number | null; onTimeOf?: number };
}
interface Me {
  profile: { managerId: string | null } | null;
  leaveBalances: { type: string; entitled: number; used: number; pending: number }[];
  attendanceToday?: { checkIn: string; checkOut: string | null } | null;
}
interface CalEvent {
  id: string;
  code?: string | null;
  title: string;
  kind: string;
  startsAt: string;
  endsAt: string;
  location: string | null;
  response: string | null;
}
interface MentionMsg {
  id: string;
  channelId: string;
  authorId: string;
  body: string;
  createdAt: string;
  channel: { kind: string; name: string | null } | null;
}
interface Channel {
  id: string;
  kind: string;
  name: string | null;
  dmUserId: string | null;
  lastMessageAt?: string | null;
}

/** A failed read becomes null, so only its own part says so and the rest of Home still renders. */
const safe = <T,>(p: Promise<T>): Promise<T | null> => p.catch(() => null);
const skip = Promise.resolve(null);

/*
 * Home: a short greeting, the question for the company's AI, then four tiles: next meeting, my tasks, mentions, and the team (people who follow
 * one) or my week (everyone else, who never ask for team numbers). Reads start together; the role-only ones are
 * chained on the team answer. A failed read only blanks its own tile.
 */
export default async function HomePage() {
  const teamP = safe(gw<Team>("/api/work/followup/team?brief=1"));
  const roleP = teamP.then((x) => homeRole(x?.scope));
  // Without it Home still renders (the workspace's own zone, announcements shown): one failed read never blanks the page.
  const wsP = workspaceInfo<Workspace>().catch(async (): Promise<Workspace> => ({
    workspace: { name: "", created_at: new Date(0).toISOString() },
    config: { timezone: await getTimeZone(), home: { sections: { announcements: true } } },
  }));
  // A feature the deployment left out (DISABLED_FEATURES): Home neither asks for it nor lists what is left of it
  // (a leave request or a meeting recorded before it was switched off).
  const hasP = wsP.then((w) => (feature: Feature | null) => !feature || w.features?.[feature] !== false);
  const homeP = Promise.all([safe(gw<Home>("/api/home/home")), hasP]).then(([h, has]) => {
    const kept = (i: { kind: string; url: string }) =>
      has(featureOfHref(i.url)) && (has("time") || !(i.kind === "approval" && i.url.startsWith("/app/me"))) && (has("calendar") || i.kind !== "meeting");
    return h && { ...h, needsYou: h.needsYou.filter(kept), today: h.today.filter(kept) };
  });
  const summaryP = safe(gw<Summary>("/api/work/me/summary"));
  const now = Date.now();
  const eventsP = hasP.then((has) =>
    has("calendar")
      ? safe(
          gw<{ events: CalEvent[] }>(
            `/api/work/calendar/events?from=${encodeURIComponent(new Date(now - 86400_000).toISOString())}&to=${encodeURIComponent(new Date(now + 86400_000).toISOString())}`,
          ),
        )
      : null,
  );
  const mentionsP = homeP.then(async (h) => {
    const items = h?.needsYou ?? [];
    const [m, ch] = await Promise.all([
      items.some((i) => i.kind === "mention") ? safe(gw<{ messages: MentionMsg[] }>("/api/chat/mentions")) : skip,
      items.some((i) => i.kind === "dm") ? safe(gw<{ channels: Channel[] }>("/api/chat/channels")) : skip,
    ]);
    return { messages: m?.messages ?? [], channels: ch?.channels ?? [] };
  });
  // Manager-only reads (team numbers), chained on the role; staff never ask for them.
  // The AI line exists only while the company records AI use (Admin › AI).
  const aiP = roleP.then(async (r) => (r === "manager" && (await aiMonitoring()) ? safe(gw<AiWeek>("/api/ai/oversight?days=7")) : null));
  const projectsP = roleP.then((r) => (r === "manager" ? safe(gw<{ projects: HomeProject[] }>("/api/work/projects")) : null));
  // The boss's Today and AI this week: agent runs waiting on me, the week's sensitive-data sends, and tasks
  // finished with AI against without. Manager-only; the AI ones only while the company records AI use.
  const monitoringP = roleP.then(async (r) => r === "manager" && (await aiMonitoring()));
  const asksP = Promise.all([roleP, hasP]).then(([r, has]) =>
    r === "manager" && has("ai") ? safe(gw<{ asks: unknown[]; approvals?: unknown[] }>("/api/work/agent-questions/open")) : null,
  );
  const safetyP = monitoringP.then((m) => (m ? safe(gw<{ total: { warn: number; redact: number; block: number } }>("/api/ai/oversight/safety?days=7")) : null));
  const outcomesP = monitoringP.then((m) => (m ? safe(gw<{ withAi: { assisted: AiDone; other: AiDone } }>("/api/work/followup/outcomes?days=7")) : null));
  // Staff: leave left and, on the first day, who the manager is; everyone, when the company clocks in: today's attendance.
  const meP = Promise.all([roleP, wsP]).then(([r, w]) => (r === "staff" || w.features?.attendance ? safe(gw<Me>("/api/employee/me")) : null));

  const [team, role, home, ws, session, summary, events, mentionData, ai, projects, me, asks, safety, outcomes, monitoring, aiNow] = await Promise.all([
    teamP,
    roleP,
    homeP,
    wsP,
    readSession(),
    summaryP,
    eventsP,
    mentionsP.catch(() => ({ messages: [] as MentionMsg[], channels: [] as Channel[] })),
    aiP,
    projectsP,
    meP,
    asksP,
    safetyP,
    outcomesP,
    monitoringP,
    aiStatus(),
  ]);

  const f = await getFormat();
  const { t } = f;
  // The display zone every other screen uses (the workspace's): "My time zone" only times emails and quiet hours,
  // so Home must not show a meeting at another hour than Me and the calendar do.
  const tz = ws.config.timezone;
  const today = localDate(new Date(now), tz);

  // ---- tasks ----
  const tasks: HomeTask[] = (summary?.open ?? []).map(({ id, code, title, dueAt, status, projectId, version }) => ({ id, code, title, dueAt, status, projectId, version }));

  // ---- calendar ----
  const meetings: AgendaItem[] = events
    ? events.events
        .filter((e) => e.response !== "declined" && localDate(e.startsAt, tz) === today)
        .map((e) => {
          const minutes = Math.round((Date.parse(e.endsAt) - Date.parse(e.startsAt)) / 60_000);
          return {
            key: `e:${e.id}`,
            kind: e.kind === "meeting" ? ("meeting" as const) : ("deadline" as const),
            at: e.startsAt,
            endsAt: e.endsAt,
            title: e.title,
            meta: [e.location, minutes > 0 ? t("home.cal.minutes", { count: minutes }) : null].filter(Boolean).join(" · ") || null,
            href: meetingHref(e),
            eventId: e.kind === "meeting" ? e.id : undefined,
          };
        })
    : (home?.today ?? [])
        .filter((i) => i.kind === "meeting")
        .map((i) => ({ key: `m:${i.refId}`, kind: "meeting" as const, at: i.at, title: i.title, meta: i.subtitle || null, href: i.url, eventId: i.refId }));

  // ---- mentions and direct messages still waiting (Home's needs-you rows), with who wrote and where from chat ----
  const waitingChat = (home?.needsYou ?? []).filter((i) => i.kind === "mention" || i.kind === "dm");
  const byMsg = new Map(mentionData.messages.map((m) => [m.id, m] as const));
  const byChannel = new Map(mentionData.channels.map((c) => [c.id, c] as const));
  const mentions: MentionItem[] = waitingChat.map((i) => {
    if (i.kind === "mention") {
      const m = byMsg.get(i.refId);
      return {
        key: `m:${i.refId}`,
        authorId: m?.authorId ?? null,
        channel: m ? (m.channel?.kind === "dm" ? null : (m.channel?.name ?? null)) : i.subtitle.replace(/^#/, "") || null,
        text: m?.body ?? i.title,
        at: m?.createdAt ?? null,
        href: i.url,
      };
    }
    const c = byChannel.get(i.refId);
    return { key: `d:${i.refId}`, authorId: c?.dmUserId ?? null, channel: null, text: i.title, at: c?.lastMessageAt ?? null, href: i.url };
  });

  const firstName = session?.givenName ?? "";

  let attendance: React.ReactNode = null;
  if (ws.features?.attendance && me) {
    const a = me.attendanceToday ?? null;
    const hours = (from: string, to: number) => f.t("home.attendance.hours", { h: ((to - Date.parse(from)) / 3600_000).toFixed(1) });
    attendance = (
      <AttendanceToday
        state={!a ? "none" : a.checkOut ? "done" : "in"}
        title={!a ? f.t("home.attendance.none") : a.checkOut ? f.t("home.attendance.done") : f.t("home.attendance.in")}
        detail={
          !a
            ? null
            : a.checkOut
              ? `${f.time(a.checkIn, tz)}–${f.time(a.checkOut, tz)} · ${hours(a.checkIn, Date.parse(a.checkOut))}`
              : `${f.t("home.attendance.since", { time: f.time(a.checkIn, tz) })} · ${hours(a.checkIn, now)}`
        }
        link={f.t("home.attendance.history")}
      />
    );
  }

  let side: React.ReactNode;
  let firstRun: React.ReactNode = null;
  let brief: React.ReactNode = null;
  if (role === "manager") {
    const people: StuckPerson[] | null = team
      ? (team.people ?? []).map((x) => ({
          userId: x.userId,
          displayName: x.displayName,
          overdue: x.overdue,
          blocked: x.blocked,
          stale: x.stale,
          reason: x.tasks.find((k) => k.blockedReason)?.blockedReason ?? null,
        }))
      : null;
    // No agents on an installation without AI: nothing waits there, which is not the same as a failed read.
    const pipeline = ws.features?.ai === false ? 0 : asks ? asks.asks.length + (asks.approvals?.length ?? 0) : null;
    const requests = home ? home.needsYou.filter((i) => i.kind === "approval").length : null;
    const items = todayItems({
      people,
      waiting: pipeline === null || requests === null ? null : { pipeline, approvals: requests, href: pipeline ? "/app/chat" : "/app/work/ops" },
      safety: safety ? { blocked: safety.total.block, redacted: safety.total.redact, warned: safety.total.warn } : null,
    });
    // Awaited, not left as an element: the tile draws nothing for a small group, and its column must not stay blank.
    const aiTile = monitoring ? await AiThisWeek({ ai, withAi: outcomes?.withAi ?? null }) : null;
    const todayTile = await TodayBrief({ items });
    brief =
      todayTile || aiTile ? (
        <div className={todayTile && aiTile ? "grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]" : "grid grid-cols-1"}>
          {todayTile}
          {aiTile}
        </div>
      ) : null;
    const behind = (projects?.projects ?? []).filter((p) => projectHealthOf(p, now) === "behind").length;
    side = <TeamTile team={team} ai={ai} behind={behind} />;
    // A brand-new workspace: the admin's first steps.
    if (now - Date.parse(ws.workspace.created_at) < 7 * 86400_000 && (projects?.projects.length ?? 0) === 0) firstRun = <StartChecklist />;
  } else {
    const annual = me?.leaveBalances.find((b) => b.type === "annual");
    side = (
      <WeekTile
        stats={summary?.stats ?? null}
        leaveLeft={annual && ws.features?.time !== false ? Math.max(0, annual.entitled - annual.used - annual.pending) : null}
        recent={summary?.recentlyDone ?? []}
      />
    );
    // First day: nothing assigned and nothing done yet.
    if (summary && !summary.open.length && !summary.recentlyDone.length)
      firstRun = (
        <>
          <StartChecklist />
          {me?.profile?.managerId ? <ManagerLine managerId={me.profile.managerId} /> : null}
        </>
      );
  }

  // AI Insights only (Admin › Settings): the week's AI use and the synced tasks' pace lead; chat, meetings and
  // requests are not part of this mode.
  // Company-wide numbers only for whoever may read them (the owner with direct reports still may): asked, not guessed.
  const companyPace = ws.features?.insightsOnly && role === "manager" ? (await safe(gw<unknown>("/api/work/velocity?scope=workspace&weeks=1"))) !== null : false;
  if (ws.features?.insightsOnly && role === "manager")
    return (
      <div className="flex w-full flex-col gap-6 max-md:gap-4">
        <header className="min-w-0">
          <h1 data-page-title="" className="font-display m-0 text-balance text-[28px]/[1.15] font-semibold tracking-[-0.035em] max-sm:text-2xl/[1.2]">
            {f.greeting(tz)}
            {firstName ? `, ${firstName}` : ""}
          </h1>
        </header>
        {brief}
        {companyPace ? <Velocity scope="workspace" showAttention title={t("home.insights.pace")} /> : null}
      </div>
    );

  return (
    <div className="flex w-full flex-col gap-6 max-md:gap-4">
      <HomeBoard
        tasks={tasks}
        meetings={meetings}
        mentions={mentions}
        tz={tz}
        failed={{ tasks: summary === null, meetings: events === null && home === null, mentions: home === null }}
        side={side}
        between={
          brief || firstRun ? (
            <>
              {brief}
              {firstRun}
            </>
          ) : null
        }
        // The greeting sits in the hero. No announcement pill; announcements still
        // reach people through notifications.
        hello={`${f.greeting(tz)}${firstName ? `, ${firstName}` : ""}`}
        top={attendance}
        aiOn={aiNow.assistant}
        week={summary ? { done: summary.stats.doneThisWeek, last: summary.stats.doneLastWeek } : null}
      />
      <PushPrompt />
    </div>
  );
}
