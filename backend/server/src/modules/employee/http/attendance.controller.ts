import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Param, Post, Put, Query, Req } from "@nestjs/common";
import { assertAllowed, parse, requirePrincipal } from "@workspace/service-kit";
import { newId, withTransaction } from "@workspace/shared";
import type { Request } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";

import { isMissedCheckout } from "../attendance-rules.js";
import { localDay, localMinutes } from "../days.js";
import { employeeSettings } from "../settings.js";
import { EmployeeControllerBase } from "./base.controller.js";
import { allowed, emit } from "./common.js";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ROW = `id, day::text, check_in AS "checkIn", check_out AS "checkOut", late_minutes AS "lateMinutes", source, corrected_by AS "correctedBy", correction_note AS "correctionNote", missed_checkout AS "missedCheckout"`;

/**
 * Attendance: one row per check-in (a day may hold two after a break, a night shift checks out the next local
 * day), lateness against the workspace shift, HR corrections and self-service correction requests.
 */
@Controller()
export class AttendanceController extends EmployeeControllerBase {
  @Post("attendance/check-in")
  async checkIn(@Req() req: Request) {
    const p = requirePrincipal(req);
    assertAllowed(p, "attendance.record", { ownerId: p.id });
    const tz = await this.timeZone();
    const now = new Date();
    const day = localDay(tz, now);
    return withTransaction(this.pool, async (c) => {
      const open = (
        await c.query<{ id: string; day: string; check_in: Date }>("SELECT id, day::text, check_in FROM attendance WHERE user_id = $1 AND check_out IS NULL FOR UPDATE", [p.id])
      ).rows[0];
      // Still on the clock: a second check-in is a mistake. Open longer than a shift: yesterday's forgotten check-out,
      // closed here so it never blocks the new day; the answer names that day so the person can request a correction.
      if (open && !isMissedCheckout(open.check_in, now)) throw new ConflictException({ error: "already_checked_in", day: open.day });
      const missed = open ? await this.closeMissed(c, open.id) : null;
      // Late = minutes past the shift start plus the grace the admin allows; 0 when the company tracks no shift.
      const shift = (await employeeSettings(c)).shift;
      const late = shift ? Math.max(0, localMinutes(tz, now) - (Number(shift.start.slice(0, 2)) * 60 + Number(shift.start.slice(3, 5)) + shift.lateAfterMin)) : 0;
      const r = await c.query(`INSERT INTO attendance (id, user_id, day, check_in, late_minutes) VALUES ($1,$2,$3,$4,$5) RETURNING ${ROW}`, [newId(), p.id, day, now, late]);
      return missed ? { ...r.rows[0], closedMissed: { day: missed } } : r.rows[0];
    });
  }

  /**
   * Closes the open check-in, whichever day it started on (a night shift checks out the next local day). One open
   * longer than a shift is closed as a missed check-out with no hours: the person requests a correction for that day.
   */
  @Post("attendance/check-out")
  async checkOut(@Req() req: Request) {
    const p = requirePrincipal(req);
    assertAllowed(p, "attendance.record", { ownerId: p.id });
    return withTransaction(this.pool, async (c) => {
      const open = (
        await c.query<{ id: string; day: string; check_in: Date }>("SELECT id, day::text, check_in FROM attendance WHERE user_id = $1 AND check_out IS NULL FOR UPDATE", [p.id])
      ).rows[0];
      if (!open) throw new ConflictException({ error: "not_checked_in_or_already_out", day: localDay(await this.timeZone()) });
      if (isMissedCheckout(open.check_in, new Date())) {
        await this.closeMissed(c, open.id);
        return (await c.query(`SELECT ${ROW} FROM attendance WHERE id = $1`, [open.id])).rows[0];
      }
      const r = await c.query(`UPDATE attendance SET check_out = now() WHERE id = $1 RETURNING ${ROW}`, [open.id]);
      return r.rows[0];
    });
  }

  /**
   * HR correction of one day (forgotten check-out, wrong time). The row keeps who corrected it, when
   * and why (source becomes "admin"), and an event records the before/after for the audit trail.
   */
  @Put("attendance/:userId/:day")
  async correctAttendance(@Req() req: Request, @Param("userId") userId: string, @Param("day") day: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "member.manage");
    if (!DAY.test(day)) throw new BadRequestException("day must be YYYY-MM-DD");
    const b = parse(
      z.object({ checkIn: z.string().datetime({ offset: true }), checkOut: z.string().datetime({ offset: true }).nullable(), note: z.string().trim().min(1).max(300) }),
      body,
    );
    await this.validateTimes(day, b.checkIn, b.checkOut);
    return withTransaction(this.pool, async (c) => {
      await this.employee(c, userId);
      return this.applyCorrection(c, userId, day, b, p.id);
    });
  }

  /** Employees propose their own fix (missed badge, wrong time); the line manager (or HR) approves it. */
  @Post("attendance/corrections")
  @HttpCode(201)
  async requestCorrection(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "attendance.record", { ownerId: p.id });
    const b = parse(
      z.object({
        day: z.string().regex(DAY),
        checkIn: z.string().datetime({ offset: true }),
        checkOut: z.string().datetime({ offset: true }).nullable(),
        reason: z.string().trim().min(1).max(300),
      }),
      body,
    );
    await this.validateTimes(b.day, b.checkIn, b.checkOut);
    return withTransaction(this.pool, async (c) => {
      const me = await this.employee(c, p.id);
      const dup = await c.query("SELECT 1 FROM attendance_corrections WHERE user_id = $1 AND day = $2 AND status = 'pending'", [p.id, b.day]);
      if (dup.rowCount) throw new ConflictException({ error: "pending_correction" });
      const id = newId();
      await c.query("INSERT INTO attendance_corrections (id, user_id, day, check_in, check_out, reason, approver_id) VALUES ($1,$2,$3,$4,$5,$6,$7)", [
        id,
        p.id,
        b.day,
        b.checkIn,
        b.checkOut,
        b.reason,
        me.manager_id,
      ]);
      return { id, status: "pending" };
    });
  }

  /** Mine, or (role=approver) the ones routed to me; HR with member.manage sees every pending one. */
  @Get("attendance/corrections")
  async corrections(@Req() req: Request, @Query("role") role?: string) {
    const p = requirePrincipal(req);
    const approver = role === "approver";
    const hr = approver && allowed(p, "member.manage");
    return withTransaction(this.pool, async (c) => ({
      corrections: (
        await c.query(
          `SELECT x.id, x.user_id AS "userId", e.display_name AS "displayName", x.day::text, x.check_in AS "checkIn", x.check_out AS "checkOut", x.reason, x.status,
                  x.approver_id AS "approverId", x.decided_at AS "decidedAt", x.created_at AS "createdAt"
             FROM attendance_corrections x JOIN employees e ON e.user_id = x.user_id
            WHERE ${hr ? "(x.approver_id = $1 OR x.status = 'pending')" : approver ? "x.approver_id = $1" : "x.user_id = $1"}
            ORDER BY x.created_at DESC LIMIT 100`,
          [p.id],
        )
      ).rows,
    }));
  }

  @Post("attendance/corrections/:id/decision")
  @HttpCode(204)
  async decideCorrection(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(z.object({ decision: z.enum(["approved", "rejected"]) }), body);
    await withTransaction(this.pool, async (c) => {
      const x = (
        await c.query<{ user_id: string; day: string; check_in: Date; check_out: Date | null; reason: string; status: string; approver_id: string | null }>(
          "SELECT user_id, day::text, check_in, check_out, reason, status, approver_id FROM attendance_corrections WHERE id = $1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!x) throw new BadRequestException("correction not found");
      if (x.approver_id !== p.id && !allowed(p, "member.manage")) throw new ForbiddenException("not the approver");
      if (x.user_id === p.id) throw new ForbiddenException("cannot decide your own correction");
      if (x.status !== "pending") throw new ConflictException({ error: "already_decided", status: x.status });
      await c.query("UPDATE attendance_corrections SET status = $2, decided_by = $3, decided_at = now() WHERE id = $1", [id, b.decision, p.id]);
      if (b.decision === "approved") {
        await this.applyCorrection(c, x.user_id, x.day, { checkIn: x.check_in.toISOString(), checkOut: x.check_out?.toISOString() ?? null, note: x.reason }, p.id);
      }
    });
  }

  @Get("attendance")
  async attendance(@Req() req: Request, @Query("userId") userId?: string, @Query("from") from?: string, @Query("to") to?: string) {
    const p = requirePrincipal(req);
    const target = userId ?? p.id;
    if (!from || !to || !DAY.test(from) || !DAY.test(to)) throw new BadRequestException("from/to required (YYYY-MM-DD)");
    return withTransaction(this.pool, async (c) => {
      if (target !== p.id) {
        const e = await this.employee(c, target);
        // Managers see direct reports; HR/admins with WORKSPACE scope see everyone.
        if (e.manager_id !== p.id && !allowed(p, "attendance.read")) throw new ForbiddenException("not allowed");
        if (e.manager_id === p.id && !p.grants.some((g) => g.permission === "attendance.read")) throw new ForbiddenException("not allowed");
      }
      return {
        days: (await c.query(`SELECT ${ROW} FROM attendance WHERE user_id = $1 AND day BETWEEN $2 AND $3 ORDER BY day, check_in`, [target, from, to])).rows,
      };
    });
  }

  /** A forgotten check-out: no hours (check_out = check_in) and the flag, until a correction sets the real times. */
  private async closeMissed(c: PoolClient, id: string): Promise<string> {
    const r = await c.query<{ day: string }>("UPDATE attendance SET check_out = check_in, missed_checkout = true WHERE id = $1 RETURNING day::text", [id]);
    return r.rows[0]!.day;
  }

  private async validateTimes(day: string, checkIn: string, checkOut: string | null) {
    if (checkOut && Date.parse(checkOut) < Date.parse(checkIn)) throw new BadRequestException("check-out is before check-in");
    if (checkOut && Date.parse(checkOut) - Date.parse(checkIn) > 24 * 3600_000) throw new BadRequestException("a day cannot exceed 24 hours");
    if (localDay(await this.timeZone(), new Date(checkIn)) !== day) throw new BadRequestException("check-in must be on that day");
  }

  /** Rewrites the day's first entry (or adds one): source "admin", who/when/why kept, before/after in an event. */
  private async applyCorrection(c: PoolClient, userId: string, day: string, b: { checkIn: string; checkOut: string | null; note: string }, by: string) {
    const before =
      (
        await c.query<{ id: string; check_in: Date; check_out: Date | null }>(
          "SELECT id, check_in, check_out FROM attendance WHERE user_id = $1 AND day = $2 ORDER BY check_in LIMIT 1",
          [userId, day],
        )
      ).rows[0] ?? null;
    const r = before
      ? await c.query(
          `UPDATE attendance SET check_in = $2, check_out = $3, source = 'admin', corrected_by = $4, corrected_at = now(), correction_note = $5, missed_checkout = false WHERE id = $1 RETURNING ${ROW}`,
          [before.id, b.checkIn, b.checkOut, by, b.note],
        )
      : await c.query(
          `INSERT INTO attendance (id, user_id, day, check_in, check_out, source, corrected_by, corrected_at, correction_note) VALUES ($1,$2,$3,$4,$5,'admin',$6,now(),$7) RETURNING ${ROW}`,
          [newId(), userId, day, b.checkIn, b.checkOut, by, b.note],
        );
    await emit(c, "employee.attendance.corrected.v1", "employee.attendance", `${userId}:${day}`, {
      userId,
      day,
      before: before ? { check_in: before.check_in, check_out: before.check_out } : null,
      after: { checkIn: b.checkIn, checkOut: b.checkOut },
      correctedBy: by,
      note: b.note,
    });
    return { ...r.rows[0], note: b.note };
  }
}
