import { merge, zonedInstant, type Interval } from "./people-plan.js";

/**
 * A person's day in order (plan_my_day, tools-assist.ts), without a model: what is late first, then what is due today,
 * then what is at risk or urgent, finishing work already started before opening new work. Blocked work is set apart:
 * the next step there is to unblock it, not to do it. Pure, so the order can be tested.
 */

export interface PlanTask {
  id: string;
  code: string;
  title: string;
  status: string;
  priority?: string | null;
  dueAt: string | null;
  blockedReason?: string | null;
  atRisk?: boolean;
  progress?: number | null;
}

export type Why = "overdue" | "today" | "risk" | "tomorrow" | "urgent" | "high" | "started" | "soon" | "open";

export interface Ranked {
  task: PlanTask;
  score: number;
  why: Why;
  /** Days past due (overdue only). */
  late?: number;
}

const DAY = 86_400_000;
const dayKey = (at: number, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));

/** Open tasks in the order to do them today, and the blocked ones apart. Done and cancelled work is left out. */
export function rankTasks(tasks: PlanTask[], now: number, tz: string): { order: Ranked[]; blocked: PlanTask[] } {
  const today = dayKey(now, tz);
  const tomorrow = dayKey(now + DAY, tz);
  const order: Ranked[] = [];
  const blocked: PlanTask[] = [];
  for (const t of tasks) {
    if (t.status === "done" || t.status === "cancelled") continue;
    if (t.status === "blocked" || t.blockedReason) {
      blocked.push(t);
      continue;
    }
    const due = t.dueAt ? Date.parse(t.dueAt) : NaN;
    const dueDay = Number.isNaN(due) ? null : dayKey(due, tz);
    let score = 0;
    let why: Why = "open";
    let late: number | undefined;
    if (dueDay && dueDay < today) {
      late = Math.max(1, Math.round((now - due) / DAY));
      score = 1000 + Math.min(late, 60);
      why = "overdue";
    } else if (dueDay === today) {
      score = 800;
      why = "today";
    } else if (t.atRisk) {
      score = 600;
      why = "risk";
    } else if (dueDay === tomorrow) {
      score = 500;
      why = "tomorrow";
    } else if (t.priority === "urgent") {
      score = 450;
      why = "urgent";
    } else if (t.priority === "high") {
      score = 300;
      why = "high";
    } else if (t.status === "in_progress" || t.status === "review") {
      score = 200;
      why = "started";
    } else if (!Number.isNaN(due) && due - now < 7 * DAY) {
      score = 150;
      why = "soon";
    }
    // Within a group: urgent before low, started before new, sooner before later.
    score += { urgent: 40, high: 25, medium: 10, low: 0 }[t.priority ?? "medium"] ?? 0;
    if (t.status === "in_progress" || t.status === "review") score += 15;
    if (!Number.isNaN(due) && why !== "overdue") score += Math.max(0, 10 - Math.floor((due - now) / DAY));
    order.push({ task: t, score, why, ...(late !== undefined ? { late } : {}) });
  }
  order.sort((a, b) => b.score - a.score || (a.task.dueAt ?? "~").localeCompare(b.task.dueAt ?? "~") || a.task.code.localeCompare(b.task.code));
  return { order, blocked };
}

/**
 * The free stretches of today's working hours from now on, around meetings: at least `minMinutes` long. `shift`: the
 * working hours ("09:00"–"17:30"); none on a day off.
 */
export function freeToday(now: number, tz: string, shift: { start: string; end: string } | null, meetings: { start: number; end: number }[], minMinutes = 30): Interval[] {
  if (!shift) return [];
  const day = dayKey(now, tz);
  const open = Math.max(zonedInstant(day, shift.start, tz), now);
  const close = zonedInstant(day, shift.end, tz);
  if (close <= open) return [];
  const busy = merge(meetings.filter((m) => m.end > open && m.start < close).map((m) => ({ start: Math.max(m.start, open), end: Math.min(m.end, close) })));
  const free: Interval[] = [];
  let at = open;
  for (const b of busy) {
    if (b.start > at) free.push({ start: at, end: b.start });
    at = Math.max(at, b.end);
  }
  if (close > at) free.push({ start: at, end: close });
  return free.filter((f) => f.end - f.start >= minMinutes * 60_000);
}

/** Tasks put into the free stretches in order: the longest stretch gets the first task, one task per stretch. */
export function slotTasks(order: Ranked[], free: Interval[]): Map<string, Interval> {
  const out = new Map<string, Interval>();
  const byLength = [...free].sort((a, b) => b.end - b.start - (a.end - a.start));
  order.slice(0, byLength.length).forEach((r, i) => out.set(r.task.id, byLength[i]!));
  return out;
}
