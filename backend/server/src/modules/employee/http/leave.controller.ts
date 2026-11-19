import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
} from "@nestjs/common";
import { assertAllowed, parse, requirePrincipal } from "@workspace/service-kit";
import { newId, recordAudit, withTransaction } from "@workspace/shared";
import type { Request } from "express";
import { z } from "zod";
import { leaveApprover } from "../delegations.js";

import { holidaysBetween, localDay, workingDays } from "../days.js";
import { grantBalances } from "../leave-grant.js";
import { employeeSettings, leaveTypes } from "../settings.js";
import { EmployeeControllerBase } from "./base.controller.js";
import { allowed, date, emit } from "./common.js";

const CODE = /^[a-z][a-z0-9_]{0,29}$/;

/** Last reminder per request (one server process, ADR 0021): a restart only allows one early extra nudge. */
const REMINDED = new Map<string, number>();

/** Leave: types, balances, requests, decisions. */
@Controller()
export class LeaveController extends EmployeeControllerBase {
  /** The workspace's leave types (admins see inactive ones too, to reactivate them). */
  @Get("leave/types")
  async types(@Req() req: Request) {
    const p = requirePrincipal(req);
    assertAllowed(p, "employee.profile.read");
    const all = allowed(p, "member.manage");
    return withTransaction(this.pool, async (c) => ({ types: await leaveTypes(c, { activeOnly: !all }) }));
  }

  /**
   * Create or change a leave type. Codes are permanent (requests and balances reference them); names and rules change.
   * `?create=1` (the "add type" form) refuses a code that already exists, so a new type can never silently rewrite an
   * existing one (e.g. turn "sick" into a type that needs a balance).
   */
  @Put("leave/types/:code")
  async setType(@Req() req: Request, @Param("code") code: string, @Body() body: unknown, @Query("create") create?: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "member.manage");
    if (!CODE.test(code)) throw new BadRequestException({ error: "bad_code" });
    const b = parse(
      z.object({
        nameVi: z.string().trim().min(1).max(60),
        nameEn: z.string().trim().min(1).max(60),
        paid: z.boolean().default(true),
        requiresBalance: z.boolean().default(true),
        color: z.string().max(20).default(""),
        active: z.boolean().default(true),
        sort: z.number().int().min(0).max(1000).default(100),
      }),
      body,
    );
    return withTransaction(this.pool, async (c) => {
      await leaveTypes(c); // seeds the built-ins first, so a custom type never replaces them
      if (create === "1" && (await c.query("SELECT 1 FROM leave_types WHERE code = $1", [code])).rowCount)
        throw new ConflictException({ error: "code_taken", message: `a leave type with code "${code}" already exists` });
      await c.query(
        `INSERT INTO leave_types (code, name_vi, name_en, paid, requires_balance, color, active, sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (code) DO UPDATE SET name_vi = EXCLUDED.name_vi, name_en = EXCLUDED.name_en, paid = EXCLUDED.paid,
           requires_balance = EXCLUDED.requires_balance, color = EXCLUDED.color, active = EXCLUDED.active, sort = EXCLUDED.sort`,
        [code, b.nameVi, b.nameEn, b.paid, b.requiresBalance, b.color, b.active, b.sort],
      );
      await recordAudit(c, {
        action: "employee.leave_type.saved",
        targetType: "leave_type",
        targetId: code,
        targetLabel: b.nameVi,
        meta: { paid: b.paid, requiresBalance: b.requiresBalance, active: b.active },
      });
      return { code, ...b };
    });
  }

  /** Deactivates a type (rows stay: old requests still name it). The policy's default type cannot be turned off. */
  @Delete("leave/types/:code")
  @HttpCode(204)
  async removeType(@Req() req: Request, @Param("code") code: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "member.manage");
    await withTransaction(this.pool, async (c) => {
      const s = await employeeSettings(c);
      if (code === s.leavePolicy.typeCode) throw new ConflictException({ error: "default_type" });
      const r = await c.query("UPDATE leave_types SET active = false WHERE code = $1", [code]);
      if (!r.rowCount) throw new NotFoundException("leave type not found");
      await recordAudit(c, { action: "employee.leave_type.deactivated", targetType: "leave_type", targetId: code });
    });
  }

  @Put("leave/balances/:userId")
  @HttpCode(204)
  async setBalance(@Req() req: Request, @Param("userId") userId: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "member.manage");
    const b = parse(z.object({ type: z.string().regex(CODE), year: z.number().int().min(2000).max(2100), entitledDays: z.number().min(0).max(365) }), body);
    await withTransaction(this.pool, async (c) => {
      const before = (
        await c.query<{ d: number }>("SELECT entitled_days::float AS d FROM leave_balances WHERE user_id = $1 AND leave_type = $2 AND year = $3", [userId, b.type, b.year])
      ).rows[0];
      await c.query(
        `INSERT INTO leave_balances (user_id, leave_type, year, entitled_days) VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id, leave_type, year) DO UPDATE SET entitled_days = EXCLUDED.entitled_days`,
        [userId, b.type, b.year, b.entitledDays],
      );
      await recordAudit(c, {
        action: "employee.leave.balance_set",
        targetType: "member",
        targetId: userId,
        meta: { type: b.type, year: b.year },
        changes: { entitledDays: { from: before?.d ?? null, to: b.entitledDays } },
      });
    }).catch((e: { code?: string }) => {
      // The web translates the code ("below what is already used").
      if (e.code === "23514") throw new BadRequestException({ error: "below_used" });
      throw e;
    });
  }

  /** HR overview of leave for a year and type: entitled, used, pending and remaining per active employee. */
  @Get("leave/balances")
  async balances(@Req() req: Request, @Query("year") yearQ?: string, @Query("type") type?: string, @Query("userId") userIdQ?: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "member.manage");
    const year = /^\d{4}$/.test(yearQ ?? "") ? Number(yearQ) : Number(localDay(await this.timeZone()).slice(0, 4));
    const t = type && CODE.test(type) ? type : "annual";
    return withTransaction(this.pool, async (c) => ({
      year,
      type: t,
      policy: (await employeeSettings(c)).leavePolicy,
      employees: (
        await c.query(
          `SELECT e.user_id AS "userId", e.code, e.display_name AS "displayName", e.hire_date::text AS "hireDate",
                b.entitled_days::float AS entitled, coalesce(b.used_days, 0)::float AS used,
                coalesce((SELECT sum(days) FROM leave_requests l WHERE l.user_id = e.user_id AND l.leave_type = $2 AND l.status = 'pending' AND extract(year FROM l.start_date) = $1), 0)::float AS pending
           FROM employees e LEFT JOIN leave_balances b ON b.user_id = e.user_id AND b.leave_type = $2 AND b.year = $1
          WHERE e.active AND ($3::text IS NULL OR e.user_id = $3) ORDER BY e.display_name LIMIT 2000`,
          [year, t, userIdQ && userIdQ.length <= 64 ? userIdQ : null],
        )
      ).rows,
    }));
  }

  /**
   * Grants a year's leave to everyone at once (start of year, or whenever the admin presses the button). Options:
   * +1 day per full 5 years of service (Vietnam's Labour Code art. 114, optional elsewhere), carrying over last
   * year's unused days up to a cap, and proration for people hired during the year. "Only missing" leaves people
   * who already have a balance untouched. The same routine runs automatically on 1 January when the policy says so.
   */
  @Post("leave/balances/bulk")
  async bulkBalances(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "member.manage");
    const b = parse(
      z.object({
        type: z.string().regex(CODE),
        year: z.number().int().min(2000).max(2100),
        entitledDays: z.number().min(0).max(365),
        seniority: z.boolean().default(false),
        carryOverMax: z.number().min(0).max(365).default(0),
        onlyMissing: z.boolean().default(true),
        prorate: z.boolean().default(false),
      }),
      body,
    );
    return withTransaction(this.pool, (c) => grantBalances(c, b, p.id));
  }

  @Post("leave")
  async requestLeave(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "leave.request", { ownerId: p.id });
    const b = parse(
      z.object({ type: z.string().regex(CODE), startDate: date, endDate: date, reason: z.string().max(1000).default(""), halfDay: z.boolean().default(false) }),
      body,
    );
    if (b.endDate < b.startDate) throw new BadRequestException({ error: "end_before_start", message: "end date before start date" });
    return withTransaction(this.pool, async (c) => {
      const type = (await leaveTypes(c, { activeOnly: true })).find((t) => t.code === b.type);
      if (!type) throw new BadRequestException({ error: "unknown_type", message: "unknown leave type" });
      const settings = await employeeSettings(c);
      // Weekends (the workspace's own work week) and company holidays are not counted.
      const holidays = await holidaysBetween(c, b.startDate, b.endDate);
      const days = b.halfDay
        ? b.startDate === b.endDate && workingDays(b.startDate, b.endDate, holidays, settings.workWeek) === 1
          ? 0.5
          : -1
        : workingDays(b.startDate, b.endDate, holidays, settings.workWeek);
      if (days <= 0) throw new BadRequestException({ error: "no_working_days", message: "request covers no working days" });
      const me = await this.employee(c, p.id);
      // No manager yet (a small company before its org chart): the request goes to the top of the company,
      // the first person nobody manages (usually whoever created the workspace), instead of being impossible.
      const managerId =
        me.manager_id ??
        (await c.query<{ user_id: string }>("SELECT user_id FROM employees WHERE active AND manager_id IS NULL AND user_id <> $1 ORDER BY code LIMIT 1", [p.id])).rows[0]?.user_id;
      if (!managerId) throw new BadRequestException({ error: "no_approver", message: "no manager set to approve leave" });
      // A request may cross New Year; it is charged to the year it starts in (one balance row, no split: a
      // Christmas-to-January holiday is one decision for the manager and one line for the person).
      const year = Number(b.startDate.slice(0, 4));
      if (type.requiresBalance) {
        const bal = await c.query<{ entitled_days: string; used_days: string }>(
          "SELECT entitled_days, used_days FROM leave_balances WHERE user_id = $1 AND leave_type = $2 AND year = $3 FOR UPDATE",
          [p.id, b.type, year],
        );
        const pending = await c.query<{ n: string }>(
          "SELECT coalesce(sum(days), 0) AS n FROM leave_requests WHERE user_id = $1 AND leave_type = $2 AND status = 'pending' AND extract(year FROM start_date) = $3",
          [p.id, b.type, year],
        );
        const available = bal.rows[0] ? Number(bal.rows[0].entitled_days) - Number(bal.rows[0].used_days) - Number(pending.rows[0]!.n) : 0;
        if (days > available) throw new ConflictException({ error: "insufficient_balance", available, requested: days });
      }
      const overlap = await c.query(
        "SELECT 1 FROM leave_requests WHERE user_id = $1 AND status IN ('pending','approved') AND daterange(start_date, end_date, '[]') && daterange($2::date, $3::date, '[]')",
        [p.id, b.startDate, b.endDate],
      );
      if (overlap.rowCount) throw new ConflictException({ error: "overlapping_request" });
      const id = newId();
      const route = await leaveApprover(c, managerId, p.id);
      await c.query("INSERT INTO leave_requests (id, user_id, leave_type, start_date, end_date, days, reason, approver_id, on_behalf_of) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [
        id,
        p.id,
        b.type,
        b.startDate,
        b.endDate,
        days,
        b.reason,
        route.approverId,
        route.onBehalfOf,
      ]);
      await emit(c, "employee.leave.requested.v1", "employee.leave", id, {
        requestId: id,
        userId: p.id,
        displayName: me.display_name,
        approverId: route.approverId,
        type: b.type,
        days,
        startDate: b.startDate,
        endDate: b.endDate,
        ...(route.onBehalfOf ? { onBehalfOf: route.onBehalfOf } : {}),
      });
      return { id, days, status: "pending" };
    });
  }

  @Post("leave/:id/decision")
  @HttpCode(204)
  async decideLeave(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(z.object({ decision: z.enum(["approved", "rejected"]), note: z.string().trim().max(500).optional() }), body);
    await withTransaction(this.pool, async (c) => {
      const r = await c.query<{ user_id: string; approver_id: string; status: string; leave_type: string; days: string; start_date: string; on_behalf_of: string | null }>(
        "SELECT user_id, approver_id, status, leave_type, days, start_date::text, on_behalf_of FROM leave_requests WHERE id = $1 FOR UPDATE",
        [id],
      );
      const lr = r.rows[0];
      if (!lr) throw new NotFoundException("leave request not found");
      // The routing is the authority: the manager it went to (or the delegate acting for them) decides without any
      // extra grant; `leave.approve` is for HR deciding anyone's request.
      const isApprover = lr.approver_id === p.id;
      if (!isApprover && !allowed(p, "leave.approve")) throw new ForbiddenException("not the approver");
      if (lr.user_id === p.id) throw new ForbiddenException("cannot decide your own leave");
      if (lr.status !== "pending") throw new ConflictException({ error: "already_decided", status: lr.status });
      // A refusal says why: the person plans around it (another date, another type) and HR reads it later.
      if (b.decision === "rejected" && !b.note) throw new BadRequestException({ error: "reason_required", message: "a rejection needs a reason" });
      await c.query("UPDATE leave_requests SET status = $2, decided_at = now(), decided_by = $3, decision_note = $4 WHERE id = $1", [id, b.decision, p.id, b.note || null]);
      const type = (await leaveTypes(c)).find((t) => t.code === lr.leave_type);
      // A type no longer listed: everything but unpaid draws a balance.
      const draws = type ? type.requiresBalance : lr.leave_type !== "unpaid";
      if (b.decision === "approved" && draws) {
        const u = await c.query("UPDATE leave_balances SET used_days = used_days + $3 WHERE user_id = $1 AND leave_type = $2 AND year = $4 AND used_days + $3 <= entitled_days", [
          lr.user_id,
          lr.leave_type,
          lr.days,
          Number(lr.start_date.slice(0, 4)),
        ]);
        if (!u.rowCount) throw new ConflictException({ error: "insufficient_balance" });
      }
      await emit(c, "employee.leave.decided.v1", "employee.leave", id, { requestId: id, userId: lr.user_id, approverId: lr.approver_id, decision: b.decision, decidedBy: p.id });
    });
  }

  /**
   * Admin › Leave requests: nudges the approver of a request that is still pending (a notification, nothing else).
   * Once per request every 12 hours, so a busy HR desk cannot flood a manager.
   */
  @Post("leave/:id/remind")
  @HttpCode(204)
  async remindApprover(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    if (!allowed(p, "leave.approve")) throw new ForbiddenException({ error: "forbidden", message: "missing permission leave.approve for the whole company" });
    await withTransaction(this.pool, async (c) => {
      const lr = (
        await c.query<{ user_id: string; approver_id: string | null; status: string; days: string; name: string | null }>(
          `SELECT r.user_id, r.approver_id, r.status, r.days, e.display_name AS name FROM leave_requests r LEFT JOIN employees e ON e.user_id = r.user_id WHERE r.id = $1`,
          [id],
        )
      ).rows[0];
      if (!lr) throw new NotFoundException("leave request not found");
      if (lr.status !== "pending" || !lr.approver_id) throw new ConflictException({ error: "not_pending", status: lr.status });
      const key = `leave-remind:${id}`;
      const last = REMINDED.get(key);
      if (last && Date.now() - last < 12 * 3600_000) throw new ConflictException({ error: "reminded_recently" });
      REMINDED.set(key, Date.now());
      await emit(c, "employee.leave.reminded.v1", "employee.leave", id, {
        requestId: id,
        approverId: lr.approver_id,
        displayName: lr.name ?? "",
        days: Number(lr.days),
        remindedBy: p.id,
      });
    });
  }

  @Post("leave/:id/cancel")
  @HttpCode(204)
  async cancelLeave(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    await withTransaction(this.pool, async (c) => {
      const r = await c.query("UPDATE leave_requests SET status = 'cancelled' WHERE id = $1 AND user_id = $2 AND status = 'pending' RETURNING approver_id", [id, p.id]);
      if (!r.rowCount) throw new NotFoundException("no pending request");
      await emit(c, "employee.leave.decided.v1", "employee.leave", id, { requestId: id, userId: p.id, approverId: r.rows[0].approver_id, decision: "cancelled", decidedBy: p.id });
    });
  }

  /**
   * Admin › Nghỉ phép › Đơn nghỉ: everyone's requests, for HR (leave.approve for the whole company; a manager's
   * team-scoped grant sees only what is routed to them, through GET leave?role=approver). Pending first, then newest.
   * `from`/`to` keep requests that overlap the period.
   */
  @Get("leave/requests")
  async allRequests(@Req() req: Request, @Query() query: Record<string, string>) {
    const p = requirePrincipal(req);
    if (!allowed(p, "leave.approve")) throw new ForbiddenException({ error: "forbidden", message: "missing permission leave.approve for the whole company" });
    const q = parse(
      z.object({
        status: z.enum(["pending", "approved", "rejected", "cancelled", "all"]).default("all"),
        userId: z.string().min(1).max(64).optional(),
        departmentId: z.string().min(1).max(64).optional(),
        from: date.optional(),
        to: date.optional(),
        limit: z.coerce.number().int().min(1).max(500).default(200),
      }),
      query,
    );
    return withTransaction(this.pool, async (c) => ({
      requests: (
        await c.query(
          `SELECT r.id, r.user_id AS "userId", e.display_name AS "displayName", e.department_id AS "departmentId", d.name AS department,
                  r.leave_type AS "type", r.start_date::text AS "startDate", r.end_date::text AS "endDate", r.days::float, r.status, r.reason,
                  r.created_at AS "createdAt", r.on_behalf_of AS "onBehalfOf", r.approver_id AS "approverId", r.decided_at AS "decidedAt",
                  r.decided_by AS "decidedBy", r.decision_note AS "decisionNote"
             FROM leave_requests r
             LEFT JOIN employees e ON e.user_id = r.user_id
             LEFT JOIN departments d ON d.id = e.department_id
            WHERE ($1 = 'all' OR r.status = $1) AND ($2::text IS NULL OR r.user_id = $2) AND ($3::text IS NULL OR e.department_id = $3)
              AND ($4::date IS NULL OR r.end_date >= $4) AND ($5::date IS NULL OR r.start_date <= $5)
            ORDER BY (r.status = 'pending') DESC, r.created_at DESC
            LIMIT $6`,
          [q.status, q.userId ?? null, q.departmentId ?? null, q.from ?? null, q.to ?? null, q.limit],
        )
      ).rows,
    }));
  }

  @Get("leave")
  async myLeave(@Req() req: Request, @Query("role") role?: string) {
    const p = requirePrincipal(req);
    return withTransaction(this.pool, async (c) => ({
      requests: (
        await c.query(
          `SELECT id, user_id AS "userId", leave_type AS "type", start_date::text AS "startDate", end_date::text AS "endDate", days::float, status, reason, created_at AS "createdAt", on_behalf_of AS "onBehalfOf",
                  approver_id AS "approverId", decided_at AS "decidedAt"
          FROM leave_requests WHERE ${role === "approver" ? "approver_id" : "user_id"} = $1 ORDER BY created_at DESC LIMIT 100`,
          [p.id],
        )
      ).rows,
    }));
  }
}
