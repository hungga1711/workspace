import { BadRequestException, Controller, Get, Inject, Param, Query, Req } from "@nestjs/common";
import { assertAllowed, requirePrincipal } from "@workspace/service-kit";
import { authorize, withTransaction } from "@workspace/shared";
import type { Request } from "express";
import type { Pool } from "pg";
import { holidaysBetween, localDay, workingDays } from "./days.js";
import { employeeSettings } from "./settings.js";
import { POOL } from "./http/common.js";
import { workspaceTz } from "./time-zone.js";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Me views beyond one's own record: team attendance for managers and who is off.
 * Employees see their own information; managers
 * see their direct reports; HR (WORKSPACE scope) sees everyone.
 */
@Controller()
export class PeopleController {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  /**
   * Team today: one day's attendance for the caller's people. Managers get their whole reporting line (direct and
   * indirect reports, and the people of departments they head, as Follow-up does); HR and admins with attendance.read
   * at WORKSPACE get everyone, optionally one department. Each row says checked in (late or not), on leave, a missed
   * check-out (yesterday's open day closed for them) or not in yet; `workingDay` is false on weekends and holidays.
   */
  @Get("attendance/team")
  async teamAttendance(@Req() req: Request, @Query("day") day?: string, @Query("department") department?: string) {
    const p = requirePrincipal(req);
    const tz = await workspaceTz(this.pool);
    const d = day && DATE.test(day) ? day : localDay(tz);
    const everyone = authorize(p, "attendance.read").allowed;
    // Managers read their people's attendance through a team-scoped grant (Manager role); without one, nothing.
    if (!everyone && !p.grants.some((g) => g.permission === "attendance.read" && g.scope !== "SELF"))
      return { day: d, workingDay: true, shift: null, members: [], departments: [], scope: "none" };
    return withTransaction(this.pool, async (c) => {
      const { workWeek, shift } = await employeeSettings(c);
      const holidays = await holidaysBetween(c, d, d);
      const workingDay = workingDays(d, d, holidays, workWeek) === 1;
      const departments = everyone ? (await c.query<{ id: string; name: string }>("SELECT id, name FROM departments ORDER BY name")).rows : [];
      const rows = (
        await c.query(
          `WITH RECURSIVE down(id, depth) AS (
             SELECT user_id, 1 FROM employees
              WHERE active AND (manager_id = $1 OR department_id IN (SELECT id FROM departments WHERE head_id = $1))
             UNION
             SELECT e.user_id, d.depth + 1 FROM employees e JOIN down d ON e.manager_id = d.id WHERE e.active AND d.depth < 10
           )
           SELECT e.user_id AS "userId", e.display_name AS "displayName", e.title, dp.id AS "departmentId", dp.name AS department,
                  a.check_in AS "checkIn", a.check_out AS "checkOut", a.late_minutes AS "lateMinutes",
                  coalesce(a.missed_checkout, false) AS "missedCheckout",
                  EXISTS (SELECT 1 FROM attendance m WHERE m.user_id = e.user_id AND m.missed_checkout AND m.day = $2::date - 1) AS "missedYesterday",
                  EXISTS (SELECT 1 FROM leave_requests l WHERE l.user_id = e.user_id AND l.status = 'approved' AND $2::date BETWEEN l.start_date AND l.end_date) AS "onLeave"
             FROM employees e
             LEFT JOIN departments dp ON dp.id = e.department_id
             LEFT JOIN LATERAL (SELECT * FROM attendance x WHERE x.user_id = e.user_id AND x.day = $2::date ORDER BY x.check_in LIMIT 1) a ON true
            WHERE e.active AND e.user_id <> $1
              AND ($3 OR e.user_id IN (SELECT id FROM down))
              AND ($4::text IS NULL OR e.department_id = $4)
            ORDER BY e.display_name LIMIT 2000`,
          [p.id, d, everyone, everyone && department ? department : null],
        )
      ).rows;
      return { day: d, workingDay, shift, members: rows, departments, scope: everyone ? "company" : rows.length ? "team" : "none" };
    });
  }

  /**
   * Monthly attendance report for HR / payroll: per active employee, days with a
   * check-in, hours worked (closed days only), days missing a check-out, and approved leave working days
   * in the month. Company-wide attendance.read only.
   */
  @Get("attendance/report")
  async attendanceReport(@Req() req: Request, @Query("month") month?: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "attendance.read");
    const tz = await workspaceTz(this.pool);
    const m = month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : localDay(tz).slice(0, 7);
    const first = `${m}-01`;
    const last = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);
    return withTransaction(this.pool, async (c) => {
      const rows = (
        await c.query<{ userId: string; code: string; displayName: string; department: string | null; days: number; hours: string; open: number; lateDays: number }>(
          `SELECT e.user_id AS "userId", e.code, e.display_name AS "displayName", d.name AS department,
                count(DISTINCT a.day)::int AS days, coalesce(sum(extract(epoch FROM a.check_out - a.check_in)) / 3600, 0)::numeric(10,2)::text AS hours,
                count(a.id) FILTER (WHERE a.missed_checkout OR (a.check_out IS NULL AND a.day < (now() AT TIME ZONE $3)::date))::int AS open,
                count(DISTINCT a.day) FILTER (WHERE a.late_minutes > 0)::int AS "lateDays"
           FROM employees e
           LEFT JOIN departments d ON d.id = e.department_id
           LEFT JOIN attendance a ON a.user_id = e.user_id AND a.day BETWEEN $1::date AND $2::date
          WHERE e.active GROUP BY e.user_id, e.code, e.display_name, d.name ORDER BY e.display_name LIMIT 2000`,
          [first, last, tz],
        )
      ).rows;
      const leaves = (
        await c.query<{ user_id: string; start: string; end: string }>(
          `SELECT user_id, greatest(start_date, $1::date)::text AS start, least(end_date, $2::date)::text AS "end" FROM leave_requests
          WHERE status = 'approved' AND daterange(start_date, end_date, '[]') && daterange($1::date, $2::date, '[]')`,
          [first, last],
        )
      ).rows;
      const holidays = await holidaysBetween(c, first, last);
      const { workWeek, shift } = await employeeSettings(c);
      const leaveDays = new Map<string, number>();
      for (const l of leaves) leaveDays.set(l.user_id, (leaveDays.get(l.user_id) ?? 0) + workingDays(l.start, l.end, holidays, workWeek));
      return {
        month: m,
        workWeek,
        shift,
        workingDays: workingDays(first, last, holidays, workWeek),
        holidays: [...holidays].sort(),
        employees: rows.map((r) => ({ ...r, hours: Number(r.hours), leaveDays: leaveDays.get(r.userId) ?? 0 })),
      };
    });
  }

  /**
   * Leave overlapping a date range for the caller and their direct reports only (names and dates, no reasons). Colleagues
   * never see each other's leave; HR and admins have the leave screens for the company.
   */
  @Get("leave/out")
  async whoIsOut(@Req() req: Request, @Query("from") from?: string, @Query("to") to?: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "employee.profile.read");
    if (!from || !to || !DATE.test(from) || !DATE.test(to) || to < from) throw new BadRequestException("from/to required (YYYY-MM-DD)");
    return withTransaction(this.pool, async (c) => {
      const rows = (
        await c.query(
          `SELECT l.user_id AS "userId", e.display_name AS "displayName", l.leave_type AS "type", l.start_date::text AS "startDate", l.end_date::text AS "endDate", l.status
           FROM leave_requests l JOIN employees e ON e.user_id = l.user_id
          WHERE l.status IN ('approved', 'pending') AND daterange(l.start_date, l.end_date, '[]') && daterange($2::date, $3::date, '[]')
            AND (e.manager_id = $1 OR l.user_id = $1)
          ORDER BY l.start_date LIMIT 200`,
          [p.id, from, to],
        )
      ).rows;
      return { out: rows };
    });
  }

  /** Reference lists for forms (leave types, job levels…), from the platform projection. */
  @Get("master-data/:kind")
  async masterData(@Req() req: Request, @Param("kind") kind: string) {
    requirePrincipal(req);
    const v = (await this.pool.query<{ version: number }>("SELECT version FROM master_data_versions WHERE kind = $1", [kind])).rows[0];
    const items = (await this.pool.query(`SELECT code, label, active FROM master_data WHERE kind = $1 AND active ORDER BY code`, [kind])).rows;
    return { kind, version: v?.version ?? 0, items };
  }
}
