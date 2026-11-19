import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Patch, Put, Query, Req } from "@nestjs/common";
import { assertAllowed, decodeNameCursor, encodeNameCursor, parse, requirePrincipal } from "@workspace/service-kit";
import { withTransaction, workspaceTimeZone } from "@workspace/shared";
import type { Request } from "express";
import { z } from "zod";

import { localDay } from "../days.js";

import { EmployeeControllerBase } from "./base.controller.js";
import { allowed, date, emit } from "./common.js";

/** Employee profiles, the directory, my profile and my reporting line. */
@Controller()
export class ProfilesController extends EmployeeControllerBase {
  @Put("employees/:userId")
  async upsert(@Req() req: Request, @Param("userId") userId: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "member.manage");
    const b = parse(
      z.object({
        displayName: z.string().trim().min(1).max(100),
        title: z.string().max(100).default(""),
        departmentId: z.string().nullable().default(null),
        managerId: z.string().nullable().default(null),
        jobLevel: z.string().max(20).nullable().default(null),
        hireDate: date.nullable().default(null),
        location: z.string().max(100).default(""),
      }),
      body,
    );
    if (b.managerId === userId) throw new BadRequestException("an employee cannot manage themselves");
    return withTransaction(this.pool, async (c) => {
      if (b.managerId) {
        // Reject cycles in the reporting line.
        const chain = await c.query<{ found: boolean }>(
          `WITH RECURSIVE up(id) AS (SELECT $1::text UNION SELECT e.manager_id FROM employees e JOIN up ON e.user_id = up.id WHERE e.manager_id IS NOT NULL)
           SELECT EXISTS (SELECT 1 FROM up WHERE id = $2) AS found`,
          [b.managerId, userId],
        );
        if (chain.rows[0]?.found) throw new BadRequestException("reporting line would form a cycle");
      }
      const existing = await c.query<{ code: string }>("SELECT code FROM employees WHERE user_id = $1", [userId]);
      let code = existing.rows[0]?.code;
      if (!code) {
        const n = await c.query<{ value: string }>(
          `INSERT INTO code_counters (entity, value) VALUES ('employee',1) ON CONFLICT (entity) DO UPDATE SET value = code_counters.value + 1 RETURNING value`,
        );
        code = `EMP-${n.rows[0]!.value.padStart(6, "0")}`;
      }
      // The name is the person's own (identity, followed through identity.member.renamed): an admin saving the job
      // fields must not overwrite it with the copy their screen loaded, or the directory and chat would disagree.
      await c.query(
        `INSERT INTO employees (user_id, code, display_name, title, department_id, manager_id, job_level, hire_date, location)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (user_id) DO UPDATE SET title = EXCLUDED.title, department_id = EXCLUDED.department_id,
           manager_id = EXCLUDED.manager_id, job_level = EXCLUDED.job_level, hire_date = EXCLUDED.hire_date, location = EXCLUDED.location, version = employees.version + 1`,
        [userId, code, b.displayName, b.title, b.departmentId, b.managerId, b.jobLevel, b.hireDate, b.location],
      );
      await emit(c, "employee.profile.updated.v1", "employee.profile", userId, { userId, code, departmentId: b.departmentId, managerId: b.managerId });
      return { userId, code };
    });
  }

  /**
   * Directory: public fields only (no phone, no hire date, no salary). Paged by name (`after` = the `nextCursor` of
   * the previous page, `limit` ≤ 200). `all=1` returns every active employee in one answer for callers that need the
   * whole company (follow-up, AI oversight, admin screens): a workspace is one company, so that stays a few thousand
   * rows at most.
   */
  @Get("employees")
  async directory(@Req() req: Request, @Query("q") q?: string, @Query("after") after?: string, @Query("limit") limit?: string, @Query("all") all?: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "employee.profile.read");
    const everyone = all === "1";
    const size = everyone ? null : Math.min(Math.max(Number(limit) || 100, 1), 200);
    const cursor = after ? decodeNameCursor(after) : null;
    return withTransaction(this.pool, async (c) => {
      const rows = (
        await c.query<{ userId: string; code: string; displayName: string; title: string | null; department: string | null; managerId: string | null }>(
          `SELECT e.user_id AS "userId", e.code, e.display_name AS "displayName", e.title, d.name AS department, e.manager_id AS "managerId"
           FROM employees e LEFT JOIN departments d ON d.id = e.department_id
          WHERE e.active AND ($1::text IS NULL OR e.display_name ILIKE '%' || $1 || '%' OR e.title ILIKE '%' || $1 || '%' OR d.name ILIKE '%' || $1 || '%')
            AND ($2::text IS NULL OR (e.display_name, e.user_id) > ($2, $3))
          ORDER BY e.display_name, e.user_id LIMIT $4`,
          [q ?? null, cursor?.name ?? null, cursor?.userId ?? null, size === null ? null : size + 1],
        )
      ).rows;
      const page = size !== null && rows.length > size ? rows.slice(0, size) : rows;
      const last = page.at(-1);
      return { employees: page, nextCursor: size !== null && rows.length > size && last ? encodeNameCursor(last.displayName, last.userId) : null };
    });
  }

  @Get("employees/:userId")
  async profile(@Req() req: Request, @Param("userId") userId: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "employee.profile.read");
    return withTransaction(this.pool, async (c) => {
      const e = await this.employee(c, userId);
      // The name too, so a profile card (chat) needs one request, not the whole department list.
      const dept = e.department_id ? (await c.query<{ name: string }>("SELECT name FROM departments WHERE id = $1", [e.department_id])).rows[0]?.name : null;
      const privateOk = userId === p.id || allowed(p, "member.manage") || e.manager_id === p.id;
      return {
        userId: e.user_id,
        code: e.code,
        displayName: e.display_name,
        title: e.title,
        departmentId: e.department_id,
        department: dept ?? null,
        managerId: e.manager_id,
        location: e.location,
        ...(privateOk ? { phone: e.phone, hireDate: e.hire_date, jobLevel: e.job_level } : {}),
      };
    });
  }

  @Patch("me")
  async editMe(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "employee.profile.edit", { ownerId: p.id });
    const b = parse(
      z.object({
        phone: z
          .string()
          .regex(/^[+0-9 ()-]{0,20}$/)
          .optional(),
        location: z.string().max(100).optional(),
      }),
      body,
    );
    return withTransaction(this.pool, async (c) => {
      const r = await c.query("UPDATE employees SET phone = coalesce($2, phone), location = coalesce($3, location), version = version + 1 WHERE user_id = $1", [
        p.id,
        b.phone ?? null,
        b.location ?? null,
      ]);
      if (!r.rowCount) throw new NotFoundException("no employee profile");
      return { ok: true };
    });
  }

  /**
   * Everyone who reports to the caller, directly or through their managers (the reporting line set in
   * Admin › Members), plus the people of departments the caller heads (Admin › Nhóm & phòng ban). Other modules ask
   * this as the caller to scope "my team" views, so a manager sees their own organisation and nobody else's. Depth
   * is capped to keep a bad chart cheap.
   */
  @Get("me/reports")
  async reports(@Req() req: Request) {
    const p = requirePrincipal(req);
    return withTransaction(this.pool, async (c) => ({
      reports: (
        await c.query(
          `WITH RECURSIVE down(id, depth) AS (
             -- Direct reports, and everyone in a department the caller heads (trưởng phòng).
             SELECT user_id, 1 FROM employees
              WHERE active AND (manager_id = $1 OR department_id IN (SELECT id FROM departments WHERE head_id = $1))
             UNION
             SELECT e.user_id, d.depth + 1 FROM employees e JOIN down d ON e.manager_id = d.id WHERE e.active AND d.depth < 10
           )
           SELECT e.user_id AS "userId", e.display_name AS "displayName", e.title, e.manager_id AS "managerId", min(d.depth)::int AS depth,
                  dp.name AS department
             FROM down d JOIN employees e ON e.user_id = d.id
             LEFT JOIN departments dp ON dp.id = e.department_id
            WHERE e.user_id <> $1
            GROUP BY e.user_id, e.display_name, e.title, e.manager_id, dp.name
            ORDER BY depth, e.display_name`,
          [p.id],
        )
      ).rows,
    }));
  }

  /** The "Me" screen in one call. */
  @Get("me")
  async me(@Req() req: Request) {
    const p = requirePrincipal(req);
    return withTransaction(this.pool, async (c) => {
      const prof =
        (
          await c.query(
            `SELECT user_id AS "userId", code, display_name AS "displayName", title, department_id AS "departmentId", manager_id AS "managerId", phone, location FROM employees WHERE user_id = $1`,
            [p.id],
          )
        ).rows[0] ?? null;
      const today =
        (await c.query(`SELECT check_in AS "checkIn", check_out AS "checkOut" FROM attendance WHERE user_id = $1 AND day = $2`, [p.id, localDay(await workspaceTimeZone(c))]))
          .rows[0] ?? null;
      const balances = (
        await c.query(
          `SELECT leave_type AS "type", entitled_days::float AS entitled, used_days::float AS used,
            coalesce((SELECT sum(days)::float FROM leave_requests r WHERE r.user_id = b.user_id AND r.leave_type = b.leave_type AND r.status = 'pending'), 0) AS pending
          FROM leave_balances b WHERE user_id = $1 AND year = extract(year FROM now())::int ORDER BY leave_type`,
          [p.id],
        )
      ).rows;
      return { profile: prof, attendanceToday: today, leaveBalances: balances };
    });
  }
}
