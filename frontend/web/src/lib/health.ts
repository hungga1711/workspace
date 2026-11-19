import type { T } from "@/lib/i18n/core";

/*
 * Health as the work module computes it (goal-health.ts): one rule for projects, key results and goals,
 * and the reason behind it in words ("2 việc trễ, còn 10 ngày").
 */

export type Health = "done" | "on_track" | "at_risk" | "behind" | "not_started";
export type HealthReason = { kind: "project"; late: number; blocked: number; daysLeft: number | null } | { kind: "pace"; gap: number; daysLeft: number } | { kind: "ended" };

/** Dot colour per health (status colours from the tokens). */
export const HEALTH_DOT: Record<Health, string> = { done: "bg-ok", on_track: "bg-ok", at_risk: "bg-warn", behind: "bg-block", not_started: "bg-ink-2/40" };

const days = (t: T, n: number | null) =>
  n === null ? null : n > 0 ? t("goals.reason.daysLeft", { count: n }) : n === 0 ? t("goals.reason.dueToday") : t("goals.reason.overdueBy", { count: -n });

/** "2 việc trễ, còn 10 ngày" / "chậm 20 điểm so với thời gian, còn 45 ngày" / "hết kỳ, chưa đạt". */
export function reasonText(t: T, r: HealthReason | null | undefined): string | null {
  if (!r) return null;
  if (r.kind === "ended") return t("goals.reason.ended");
  if (r.kind === "pace") return [t("goals.reason.pace", { gap: r.gap }), days(t, r.daysLeft)].filter(Boolean).join(", ");
  const parts = [r.late ? t("goals.reason.late", { count: r.late }) : null, r.blocked ? t("goals.reason.blocked", { count: r.blocked }) : null, days(t, r.daysLeft)];
  return parts.filter(Boolean).join(", ") || null;
}

/** The work module's project rule (goal-health.ts), for project rows the API lists without `health`. */
export function projectHealthOf(
  p: { totalTasks?: number; doneTasks?: number; openTasks: number; overdueTasks: number; blockedTasks?: number; atRiskTasks?: number; dueAt: string | null; health?: Health },
  now = Date.now(),
): Health {
  if (p.health) return p.health;
  if (!p.totalTasks) return "not_started";
  if (!p.openTasks) return "done";
  if ((p.dueAt && Date.parse(p.dueAt) < now) || p.overdueTasks > 2) return "behind";
  if (p.overdueTasks || p.blockedTasks || p.atRiskTasks) return "at_risk";
  return "on_track";
}

/** Whole days until a due date (negative once past), null without one. */
export const daysUntil = (iso: string | null | undefined, now = Date.now()) => (iso ? Math.ceil((Date.parse(iso) - now) / 86400_000) : null);
