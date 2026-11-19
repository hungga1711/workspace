import { dateFormat } from "@/lib/intl";
// A plain module (no "use client", no React): Home's rules, unit-tested in model.test.ts.

/** Approvals at or above this amount are never decided from a Home row: "Xem để duyệt" opens the request first. */
const APPROVAL_REVIEW_VND = 50_000_000;
/** Amounts from here up are opened before they are decided; per currency (other currencies: no threshold). */
export const APPROVAL_REVIEW: Record<string, number> = {
  VND: APPROVAL_REVIEW_VND,
  USD: 2_000,
  EUR: 2_000,
  GBP: 2_000,
  SGD: 3_000,
  AUD: 3_000,
  JPY: 300_000,
  KRW: 3_000_000,
  THB: 70_000,
  CNY: 15_000,
};
/** AI use is shown for a group only from this many people up, so a tile never points at one person. */
export const AI_MIN_GROUP = 5;
/** Rows a tile shows before "+N". */
export const APPROVAL_ROWS = 4;
export const TASK_ROWS = 5;
export const MENTION_ROWS = 3;
/** A meeting stays on Home this long after it ends. */
const MEETING_GRACE = 15 * 60_000;
/** "Vào họp" shows from this long before a meeting starts. */
export const JOIN_BEFORE = 15 * 60_000;

const DAY = 86400_000;

// ---------------------------------------------------------------- role

export type HomeRole = "manager" | "staff";

/**
 * Who gets which Home, decided on the server: people who follow a team (Tiến độ › Đội ngũ has a scope for them:
 * their reports, or everyone for an admin) get the manager Home; everyone else the staff Home, which never asks
 * for team or company numbers.
 */
export function homeRole(followupScope: string | null | undefined): HomeRole {
  return followupScope === "reports" || followupScope === "everyone" ? "manager" : "staff";
}

// ---------------------------------------------------------------- approvals

export interface PendingApproval {
  id: string;
  /** Readable code (YC-007) of a request; leave has none. */
  code?: string | null;
  /** purchase | payment | trip | other | leave … */
  kind: string;
  title: string;
  requesterId: string;
  createdAt: string;
  amount: number | null;
  /** ISO 4217; null without an amount. */
  currency: string | null;
  /** Leave: its first day (YYYY-MM-DD); a request for the next two days is the most urgent. */
  startsOn?: string | null;
  source: "work" | "leave";
}

export interface ApprovalQueue<T extends PendingApproval> {
  count: number;
  /** Total amount per currency, largest first. */
  totals: { currency: string; amount: number }[];
  /** When the longest-waiting request was sent. */
  oldestAt: string | null;
  rows: (T & { review: boolean })[];
  more: number;
}

/** Leave that starts within two days, then the longest wait first; ties keep the larger amount first. */
function orderApprovals<T extends PendingApproval>(items: readonly T[], now = Date.now()): T[] {
  const soon = (x: PendingApproval) => (x.startsOn && Date.parse(`${x.startsOn}T00:00:00Z`) - now < 2 * DAY ? 0 : 1);
  return [...items].sort((a, b) => soon(a) - soon(b) || Date.parse(a.createdAt) - Date.parse(b.createdAt) || (b.amount ?? 0) - (a.amount ?? 0));
}

export function approvalQueue<T extends PendingApproval>(
  items: readonly T[],
  opts: { now?: number; threshold?: number | Record<string, number>; max?: number } = {},
): ApprovalQueue<T> {
  const { now = Date.now(), threshold = APPROVAL_REVIEW, max = APPROVAL_ROWS } = opts;
  const ordered = orderApprovals(items, now);
  const byCurrency = new Map<string, number>();
  for (const x of items) if (x.amount) byCurrency.set(x.currency ?? "VND", (byCurrency.get(x.currency ?? "VND") ?? 0) + x.amount);
  const oldest = items.reduce<string | null>((m, x) => (!m || Date.parse(x.createdAt) < Date.parse(m) ? x.createdAt : m), null);
  return {
    count: items.length,
    totals: [...byCurrency].map(([currency, amount]) => ({ currency, amount })).sort((a, b) => b.amount - a.amount),
    oldestAt: oldest,
    rows: ordered.slice(0, max).map((x) => ({ ...x, review: needsReview(x, threshold) })),
    more: Math.max(0, ordered.length - max),
  };
}

/** Big money is opened before it is decided (the Peek shows the details, files and history). */
export const needsReview = (x: Pick<PendingApproval, "amount" | "currency">, threshold: number | Record<string, number> = APPROVAL_REVIEW) => {
  const limit = typeof threshold === "number" ? threshold : threshold[x.currency ?? "VND"];
  return limit !== undefined && (x.amount ?? 0) >= limit;
};

/** How long something has waited, in the largest whole unit. */
export function waited(fromIso: string, now = Date.now()): { unit: "minutes" | "hours" | "days"; count: number } {
  const ms = Math.max(0, now - Date.parse(fromIso));
  if (ms >= DAY) return { unit: "days", count: Math.floor(ms / DAY) };
  if (ms >= 3600_000) return { unit: "hours", count: Math.floor(ms / 3600_000) };
  return { unit: "minutes", count: Math.max(1, Math.floor(ms / 60_000)) };
}

// ---------------------------------------------------------------- this week

export interface TeamTotals {
  overdue: number;
  blocked: number;
  done7: number;
}
/** One line of the manager's "Tuần này" card, each a link to the matching Tiến độ view. */
export interface WeekItem {
  id: "done" | "late" | "blocked" | "ai";
  value: number;
  /** For "Dùng AI": out of how many people. */
  of?: number;
  href: string;
}

export interface AiWeek {
  totals: { people: number; active: number; prompts?: number; inApp?: number };
  weekly?: { people: number }[];
}

/** The AI line, or null: hidden without any AI data and for groups under AI_MIN_GROUP people (counts only). */
export function aiWeek(ai: AiWeek | null | undefined): WeekItem | null {
  if (!ai || ai.totals.people < AI_MIN_GROUP) return null;
  const any = ai.totals.active > 0 || (ai.totals.prompts ?? 0) > 0 || (ai.totals.inApp ?? 0) > 0 || (ai.weekly ?? []).some((w) => w.people > 0);
  return any ? { id: "ai", value: ai.totals.active, of: ai.totals.people, href: "/app/ai/adoption/usage" } : null;
}

/** `progress`: where the figures lead (Tiến độ; the task list on an installation without the AI destination). */
export function weekItems(totals: TeamTotals, ai: AiWeek | null | undefined, progress = "/app/ai/progress"): WeekItem[] {
  const out: WeekItem[] = [
    { id: "done", value: totals.done7, href: progress },
    { id: "late", value: totals.overdue, href: progress },
    { id: "blocked", value: totals.blocked, href: progress },
  ];
  const a = aiWeek(ai);
  return a ? [...out, a] : out;
}

// ---------------------------------------------------------------- my tasks

export interface MyTask {
  id: string;
  title: string;
  dueAt: string | null;
  status: string;
}
export const isOverdue = (t: Pick<MyTask, "dueAt">, now = Date.now()) => !!t.dueAt && Date.parse(t.dueAt) < now;

/** Calendar-day difference in a time zone (0 = today, -2 = two days ago). */
export function dayOffset(iso: string, tz: string, now = Date.now()): number {
  const key = (ms: number) => dateFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
  return Math.round((Date.parse(`${key(Date.parse(iso))}T00:00:00Z`) - Date.parse(`${key(now)}T00:00:00Z`)) / DAY);
}

// ---------------------------------------------------------------- the cards

export interface DayMeeting {
  key: string;
  kind: "meeting" | "deadline";
  at: string;
  endsAt?: string | null;
}
export interface DayMention {
  key: string;
  at: string | null;
}

export interface HomePlan<A extends PendingApproval, T extends MyTask, M extends DayMeeting, N extends DayMention> {
  approvals: ApprovalQueue<A>;
  /** Open work by due date: overdue (longest late first), due later today, after today (nearest first, undated last). */
  late: T[];
  today: T[];
  upcoming: T[];
  /** Newest first. */
  mentions: N[];
  /** Today's meetings and deadlines not yet over, in time order. */
  meetings: M[];
  /** The meeting in progress or next: the one that gets "Vào họp". */
  joinKey: string | null;
}

const due = (t: MyTask) => (t.dueAt ? Date.parse(t.dueAt) : Infinity);

/** What Home's cards show: each list whole and in order; the cards cap their own rows. */
export function planHome<A extends PendingApproval, T extends MyTask, M extends DayMeeting, N extends DayMention>(
  input: { approvals: readonly A[]; tasks: readonly T[]; meetings: readonly M[]; mentions: readonly N[] },
  opts: { tz: string; now?: number; threshold?: number | Record<string, number> },
): HomePlan<A, T, M, N> {
  const { tz, now = Date.now(), threshold } = opts;
  const open = input.tasks.filter((t) => t.status !== "done" && t.status !== "cancelled").sort((a, b) => due(a) - due(b));
  const late = open.filter((t) => isOverdue(t, now));
  const today = open.filter((t) => !isOverdue(t, now) && t.dueAt && dayOffset(t.dueAt, tz, now) === 0);
  const upcoming = open.filter((t) => !isOverdue(t, now) && !today.includes(t));
  const meetings = input.meetings.filter((m) => Date.parse(m.endsAt ?? m.at) > now - MEETING_GRACE).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const join = meetings.find((m) => m.kind === "meeting" && Date.parse(m.endsAt ?? m.at) > now);
  return {
    approvals: approvalQueue(input.approvals, { now, threshold }),
    late,
    today,
    upcoming,
    mentions: [...input.mentions].sort((a, b) => Date.parse(b.at ?? "0") - Date.parse(a.at ?? "0")),
    meetings,
    joinKey: join?.key ?? null,
  };
}

// ---------------------------------------------------------------- the team tile

export interface DeptNumbers {
  name: string | null;
  overdue: number;
  open: number;
}

/** Departments with late work, worst first, at most `max`; each bar is relative to the worst. */
export function deptBars(departments: readonly DeptNumbers[], max = 4) {
  const late = departments.filter((d) => d.overdue > 0).sort((a, b) => b.overdue - a.overdue || b.open - a.open);
  const top = late[0]?.overdue ?? 0;
  return late.slice(0, max).map((d) => ({ name: d.name, overdue: d.overdue, share: top ? Math.max(6, Math.round((d.overdue / top) * 100)) : 0 }));
}

// ---------------------------------------------------------------- the boss's "Today"

/** At most this many things to act on today: a list longer than three stops being a priority. */
export const TODAY_MAX = 3;
/** Tasks finished with AI and without are compared only from this many in each group; below it, counts only. */
export const AI_MIN_SAMPLE = 20;

export interface StuckPerson {
  userId: string;
  displayName: string;
  overdue: number;
  blocked: number;
  stale: number;
  /** The first blocker someone wrote down, if any. */
  reason: string | null;
}
export type TodayItem =
  | { kind: "stuck"; person: StuckPerson }
  | { kind: "waiting"; pipeline: number; approvals: number; href: string }
  | { kind: "sensitive"; blocked: number; redacted: number; warned: number }
  | { kind: "failed"; what: "team" | "waiting" };

/** How stuck someone is: late work weighs most, then blocked, then work that has not moved. */
const stuckScore = (p: Pick<StuckPerson, "overdue" | "blocked" | "stale">) => p.overdue * 3 + p.blocked * 2 + p.stale;

/**
 * The boss's three things for today, most useful first: the most stuck person, what waits for my decision (agent drafts
 * and requests), a sensitive-data alert, then the next stuck people. A source that failed takes a slot as "couldn't
 * load" so the strip never reads as an all-clear it cannot vouch for; with nothing to show, the list is empty.
 */
export function todayItems(input: {
  people: readonly StuckPerson[] | null;
  waiting: { pipeline: number; approvals: number; href: string } | null;
  safety: { blocked: number; redacted: number; warned: number } | null;
}): TodayItem[] {
  const stuck = (input.people ?? []).filter((p) => p.overdue + p.blocked > 0).sort((a, b) => stuckScore(b) - stuckScore(a) || a.displayName.localeCompare(b.displayName));
  const out: TodayItem[] = [];
  if (input.people === null) out.push({ kind: "failed", what: "team" });
  else if (stuck[0]) out.push({ kind: "stuck", person: stuck[0] });
  if (input.waiting === null) out.push({ kind: "failed", what: "waiting" });
  else if (input.waiting.pipeline + input.waiting.approvals > 0) out.push({ kind: "waiting", ...input.waiting });
  const s = input.safety;
  if (s && s.blocked + s.redacted + s.warned > 0) out.push({ kind: "sensitive", ...s });
  for (const p of stuck.slice(1)) {
    if (out.length >= TODAY_MAX) break;
    out.push({ kind: "stuck", person: p });
  }
  return out.slice(0, TODAY_MAX);
}

export interface AiDone {
  done: number;
  dated: number;
  onTime: number;
}
/** Tasks finished with AI against without: the on-time rates only when both groups reach AI_MIN_SAMPLE. */
export function aiComparison(withAi: { assisted: AiDone; other: AiDone } | null) {
  if (!withAi) return null;
  const { assisted, other } = withAi;
  const rate = (g: AiDone) => (g.dated ? Math.round((g.onTime / g.dated) * 100) : null);
  const enough = assisted.dated >= AI_MIN_SAMPLE && other.dated >= AI_MIN_SAMPLE;
  return { withAi: assisted.done, without: other.done, rates: enough ? { withAi: rate(assisted), without: rate(other) } : null };
}
