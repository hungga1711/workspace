import { DEFAULT_TIME_ZONE, startOfDay } from "@workspace/shared";

/*
 * One health rule for projects, key results and goals (no Nest, no database: unit-tested in goal-health.test.ts).
 * A goal is never "on track" while one of its key results is not: a project with late tasks, a number that trails
 * the share of the period gone, or a period that ended short of the target all pull the goal down with them.
 */

export type Health = "done" | "on_track" | "at_risk" | "behind" | "not_started";
export type Direction = "up" | "down";

/** Points a key result (or goal) may trail the share of the period gone before it is "at risk" / "behind". */
const AT_RISK_GAP = 15;
const BEHIND_GAP = 30;
/** More late tasks than this and a project is "behind", not just "at risk". */
const BEHIND_LATE_TASKS = 2;

const RANK: Record<Health, number> = { not_started: 0, done: 0, on_track: 1, at_risk: 2, behind: 3 };
/** The worse of two healths (done / not started never pull another one down). */
const worse = (a: Health, b: Health): Health => (RANK[b] > RANK[a] ? b : a);

export interface NumberKr {
  start: number;
  target: number;
  current: number;
  /** Stored direction; null/undefined reads it from the numbers (a target below the start is lower-is-better). */
  direction?: string | null;
}

/** Higher-is-better ("up") or lower-is-better ("down", e.g. p95 latency, days to hire, open bugs). */
export function krDirection(kr: Pick<NumberKr, "start" | "target" | "direction">): Direction {
  if (kr.direction === "up" || kr.direction === "down") return kr.direction;
  return kr.target < kr.start ? "down" : "up";
}

/** The target is reached (≥ for higher-is-better, ≤ for lower-is-better). */
export function krMet(kr: NumberKr): boolean {
  return krDirection(kr) === "down" ? kr.current <= kr.target : kr.current >= kr.target;
}

/** 0–100 for a number key result, the right way round for either direction. */
export function numberProgress(kr: NumberKr): number {
  const dir = krDirection(kr);
  if (krMet(kr)) return 100;
  const span = kr.target - kr.start;
  // The start agrees with the direction: the share of the way from start to target.
  if ((dir === "up" && span > 0) || (dir === "down" && span < 0)) return clamp(Math.round(((kr.current - kr.start) / span) * 100));
  // No usable start (0 → ≤300 ms): how close the value is to the target, as a ratio.
  if (dir === "down") return kr.current > 0 ? clamp(Math.round((kr.target / kr.current) * 100)) : 0;
  return kr.target > 0 ? clamp(Math.round((kr.current / kr.target) * 100)) : 0;
}

const clamp = (n: number) => Math.max(0, Math.min(100, n));

/** Share (0–100) of [starts, ends) gone by `now`, days counted in the workspace's zone. */
export function expectedShare(starts: string, ends: string, now = Date.now(), timeZone = DEFAULT_TIME_ZONE): number {
  const s = startOfDay(starts, timeZone).getTime();
  const e = startOfDay(ends, timeZone).getTime();
  return e > s ? clamp(Math.round(((now - s) / (e - s)) * 100)) : 100;
}

/** Progress against time gone: behind by more than BEHIND_GAP points, at risk by more than AT_RISK_GAP; ended short = behind. */
export function paceHealth(progress: number, expected: number, ended = false): Health {
  if (progress >= 100) return "done";
  if (ended) return "behind";
  const gap = expected - progress;
  return gap > BEHIND_GAP ? "behind" : gap > AT_RISK_GAP ? "at_risk" : "on_track";
}

export interface ProjectCounts {
  totalTasks: number;
  doneTasks: number;
  openTasks: number;
  overdueTasks: number;
  blockedTasks?: number;
  atRiskTasks?: number;
  dueAt?: Date | string | null;
}
export interface ProjectHealth {
  health: Health;
  /** Finished share of the project's tasks. */
  progress: number;
  late: number;
  blocked: number;
  /** Whole days until the project's due date (negative once past), null without one. */
  daysLeft: number | null;
}

/**
 * A project's health, the same everywhere (Tiến độ › Tổng quan, project lists, the goals it moves): past its due
 * date with work open, or more than two late tasks, is "behind"; any late, blocked or at-risk task is "at risk".
 */
export function projectHealth(p: ProjectCounts, now = Date.now()): ProjectHealth {
  const due = p.dueAt ? new Date(p.dueAt).getTime() : null;
  const daysLeft = due === null ? null : Math.ceil((due - now) / 86400_000);
  const late = p.overdueTasks;
  const blocked = p.blockedTasks ?? 0;
  const progress = p.totalTasks ? Math.round((p.doneTasks / p.totalTasks) * 100) : 0;
  const base = { progress, late, blocked, daysLeft };
  if (!p.totalTasks) return { ...base, health: "not_started" };
  if (!p.openTasks) return { ...base, health: "done" };
  if ((due !== null && due < now) || late > BEHIND_LATE_TASKS) return { ...base, health: "behind" };
  if (late || blocked || (p.atRiskTasks ?? 0)) return { ...base, health: "at_risk" };
  return { ...base, health: "on_track" };
}

/** Why a key result (and so its goal) is not on track: late/blocked tasks of its project, or the pace. */
export type HealthReason = { kind: "project"; late: number; blocked: number; daysLeft: number | null } | { kind: "pace"; gap: number; daysLeft: number } | { kind: "ended" };

export interface KrAssessment {
  progress: number;
  health: Health;
  reason: HealthReason | null;
}

/** One key result against its goal's period: a number by its pace, a project by the worse of its pace and its own health. */
export function assessKr(
  kr: ({ kind: "number" } & NumberKr) | { kind: "project"; project: ProjectCounts | null },
  period: { expected: number; ended: boolean; daysLeft: number },
  now = Date.now(),
): KrAssessment {
  if (kr.kind === "number") {
    const progress = numberProgress(kr);
    const health = paceHealth(progress, period.expected, period.ended);
    return { progress, health, reason: reasonFor(health, progress, period) };
  }
  if (!kr.project) return { progress: 0, health: period.ended ? "behind" : "not_started", reason: period.ended ? { kind: "ended" } : null };
  const ph = projectHealth(kr.project, now);
  const pace = paceHealth(ph.progress, period.expected, period.ended);
  const health = ph.health === "done" ? "done" : ph.health === "not_started" ? pace : worse(pace, ph.health);
  const projectReason = ph.health === "at_risk" || ph.health === "behind";
  return {
    progress: ph.progress,
    health,
    reason:
      health === "done" || health === "on_track" || health === "not_started"
        ? null
        : projectReason && RANK[ph.health] >= RANK[pace]
          ? { kind: "project", late: ph.late, blocked: ph.blocked, daysLeft: ph.daysLeft }
          : reasonFor(health, ph.progress, period),
  };
}

function reasonFor(health: Health, progress: number, period: { expected: number; ended: boolean; daysLeft: number }): HealthReason | null {
  if (health !== "at_risk" && health !== "behind") return null;
  return period.ended ? { kind: "ended" } : { kind: "pace", gap: Math.max(0, period.expected - progress), daysLeft: period.daysLeft };
}

export interface GoalAssessment {
  expected: number;
  health: Health;
  /** The reason of the worst key result (or the goal's own pace). */
  reason: HealthReason | null;
}

/**
 * A goal: "done" when every key result is, "not started" before its period; otherwise the worst of its own pace
 * (average progress against time gone) and each key result's health. One late project is enough to flag it.
 */
export function assessGoal(progress: number, krs: KrAssessment[], starts: string, ends: string, now = Date.now(), timeZone = DEFAULT_TIME_ZONE): GoalAssessment {
  const expected = expectedShare(starts, ends, now, timeZone);
  if (krs.length ? krs.every((k) => k.health === "done") : progress >= 100) return { expected, health: "done", reason: null };
  if (now < startOfDay(starts, timeZone).getTime()) return { expected: 0, health: "not_started", reason: null };
  const end = startOfDay(ends, timeZone).getTime();
  const period = { expected, ended: now >= end, daysLeft: Math.max(0, Math.ceil((end - now) / 86400_000)) };
  let health = paceHealth(progress, expected, period.ended);
  if (health === "done") health = "on_track"; // average at 100 but a key result is not: not done yet
  let reason = reasonFor(health, progress, period);
  for (const k of krs) {
    if (RANK[k.health] > RANK[health]) {
      health = k.health;
      reason = k.reason;
    } else if (k.health === health && !reason) reason = k.reason;
  }
  return { expected, health, reason };
}

/** The period facts assessKr needs, from the goal's dates. */
export function periodFacts(starts: string, ends: string, now = Date.now(), timeZone = DEFAULT_TIME_ZONE) {
  const end = startOfDay(ends, timeZone).getTime();
  return { expected: expectedShare(starts, ends, now, timeZone), ended: now >= end, daysLeft: Math.max(0, Math.ceil((end - now) / 86400_000)) };
}
