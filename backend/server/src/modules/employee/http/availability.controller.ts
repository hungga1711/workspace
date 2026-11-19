import { BadRequestException, Controller, Get, Query, Req } from "@nestjs/common";
import { assertAllowed, requirePrincipal } from "@workspace/service-kit";
import { authorize, withTransaction } from "@workspace/shared";
import type { Request } from "express";
import { leaveDaySet, summarize, workingDayList } from "../attendance-summary.js";
import { holidaysBetween, localDay } from "../days.js";
import { employeeSettings } from "../settings.js";

import { EmployeeControllerBase } from "./base.controller.js";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const span = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 86400_000;

/**
 * Two reads for the assistant's people tools: when a group can meet, and attendance over a period.
 */
@Controller()
export class AvailabilityController extends EmployeeControllerBase {
  /**
   * The working calendar for finding a meeting time: work week, shift hours, holidays, and the days on which any of
   * the given people is on approved leave, as one list for the group. Who is away and why stays private (colleagues
   * never see each other's leave); a scheduler only needs to know the day is out.
   */
  @Get("availability")
  async availability(@Req() req: Request, @Query("users") users?: string, @Query("from") from?: string, @Query("to") to?: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "employee.profile.read");
    if (!from || !to || !DATE.test(from) || !DATE.test(to) || to < from || span(from, to) > 62) throw new BadRequestException("from/to required (YYYY-MM-DD), at most 62 days");
    const ids = [
      ...new Set(
        (users ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s && s.length <= 64),
      ),
    ].slice(0, 30);
    return withTransaction(this.pool, async (c) => {
      const { workWeek, shift } = await employeeSettings(c);
      const holidays = [...(await holidaysBetween(c, from, to))].sort();
      const leave = ids.length
        ? (
            await c.query<{ start: string; end: string }>(
              `SELECT greatest(start_date, $2::date)::text AS start, least(end_date, $3::date)::text AS "end" FROM leave_requests
                WHERE user_id = ANY($1) AND status = 'approved' AND daterange(start_date, end_date, '[]') && daterange($2::date, $3::date, '[]')`,
              [ids, from, to],
            )
          ).rows
        : [];
      const all = workingDayList(from, to, new Set(), [1, 2, 3, 4, 5, 6, 7]);
      return { workWeek, shift, holidays, awayDays: [...leaveDaySet(leave, all)].sort() };
    });
  }

  /**
   * Attendance over a period (up to 92 days) per person: days in, late days and minutes, hours, missed check-outs,
   * leave days and absences (working days with neither a check-in nor approved leave, up to yesterday). Scope as Team
   * today: attendance.read for the company (optionally one department or person), a manager's reporting line through
   * a team grant, otherwise the caller alone.
   */
  @Get("attendance/summary")
  async summary(@Req() req: Request, @Query("from") from?: string, @Query("to") to?: string, @Query("department") department?: string, @Query("userId") userId?: string) {
    const p = requirePrincipal(req);
    if (!from || !to || !DATE.test(from) || !DATE.test(to) || to < from || span(from, to) > 92) throw new BadRequestException("from/to required (YYYY-MM-DD), at most 92 days");
    const everyone = authorize(p, "attendance.read").allowed;
    const team = !everyone && p.grants.some((g) => g.permission === "attendance.read" && g.scope !== "SELF");
    const scope = everyone ? "company" : team ? "team" : "self";
    const tz = await this.timeZone();
    return withTransaction(this.pool, async (c) => {
      const people = (
        await c.query<{ userId: string; displayName: string; department: string | null }>(
          `WITH RECURSIVE down(id, depth) AS (
             SELECT user_id, 1 FROM employees
              WHERE active AND (manager_id = $1 OR department_id IN (SELECT id FROM departments WHERE head_id = $1))
             UNION
             SELECT e.user_id, d.depth + 1 FROM employees e JOIN down d ON e.manager_id = d.id WHERE e.active AND d.depth < 10
           )
           SELECT e.user_id AS "userId", e.display_name AS "displayName", dp.name AS department
             FROM employees e LEFT JOIN departments dp ON dp.id = e.department_id
            WHERE e.active
              AND ($2 = 'company' OR e.user_id = $1 OR ($2 = 'team' AND e.user_id IN (SELECT id FROM down)))
              AND ($3::text IS NULL OR e.department_id = $3 OR lower(dp.name) = lower($3))
              AND ($4::text IS NULL OR e.user_id = $4)
            ORDER BY e.display_name LIMIT 500`,
          [p.id, scope, department?.trim() || null, userId?.trim() || null],
        )
      ).rows;
      const ids = people.map((x) => x.userId);
      const { workWeek } = await employeeSettings(c);
      const days = workingDayList(from, to, await holidaysBetween(c, from, to), workWeek);
      const rows = ids.length
        ? (
            await c.query<{ user_id: string; day: string; late_minutes: number; hours: string; missed_checkout: boolean }>(
              `SELECT user_id, day::text, late_minutes, coalesce(extract(epoch FROM check_out - check_in) / 3600, 0)::text AS hours, missed_checkout
                 FROM attendance WHERE user_id = ANY($1) AND day BETWEEN $2::date AND $3::date`,
              [ids, from, to],
            )
          ).rows
        : [];
      const leave = ids.length
        ? (
            await c.query<{ user_id: string; start: string; end: string }>(
              `SELECT user_id, start_date::text AS start, end_date::text AS "end" FROM leave_requests
                WHERE user_id = ANY($1) AND status = 'approved' AND daterange(start_date, end_date, '[]') && daterange($2::date, $3::date, '[]')`,
              [ids, from, to],
            )
          ).rows
        : [];
      const today = localDay(tz);
      const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86400_000).toISOString().slice(0, 10);
      return {
        from,
        to,
        scope,
        workingDays: days.length,
        people: people.map((x) => ({
          ...x,
          ...summarize(
            days,
            rows.filter((r) => r.user_id === x.userId).map((r) => ({ day: r.day, lateMinutes: r.late_minutes, hours: Number(r.hours), missedCheckout: r.missed_checkout })),
            leaveDaySet(
              leave.filter((l) => l.user_id === x.userId),
              days,
            ),
            yesterday,
          ),
        })),
      };
    });
  }
}
