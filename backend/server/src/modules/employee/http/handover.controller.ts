import { BadRequestException, Body, Controller, Get, Param, Post, Req } from "@nestjs/common";
import { assertAllowed, parse, requirePrincipal } from "@workspace/service-kit";
import { recordAudit, withTransaction } from "@workspace/shared";
import type { Request } from "express";
import { z } from "zod";

import { EmployeeControllerBase } from "./base.controller.js";
import { emit } from "./common.js";

/** Offboarding handover: what a leaving person holds and moving it to someone else. */
@Controller()
export class HandoverController extends EmployeeControllerBase {
  /** Offboarding: what a leaving manager still holds here (pending leave approvals, direct reports). */
  @Get("handover/:userId")
  async handoverSummary(@Req() req: Request, @Param("userId") userId: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "member.manage");
    return withTransaction(
      this.pool,
      async (c) =>
        (
          await c.query<{ leaveApprovals: number; reports: number }>(
            `SELECT (SELECT count(*)::int FROM leave_requests WHERE approver_id = $1 AND status = 'pending') AS "leaveApprovals",
              (SELECT count(*)::int FROM employees WHERE manager_id = $1 AND active) AS reports`,
            [userId],
          )
        ).rows[0],
    );
  }

  /**
   * Hands pending leave approvals and direct reports to another person. Reports keep a valid chain:
   * if the new manager is one of them, they report to the leaver's own manager instead.
   */
  @Post("handover/:userId")
  async handover(@Req() req: Request, @Param("userId") userId: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "member.manage");
    const b = parse(z.object({ toUserId: z.string().min(1).max(100) }), body);
    if (b.toUserId === userId) throw new BadRequestException("choose a different person to hand over to");
    return withTransaction(this.pool, async (c) => {
      const leaver = (await c.query<{ manager_id: string | null }>("SELECT manager_id FROM employees WHERE user_id = $1", [userId])).rows[0];
      // Nobody approves their own leave: the new person's own pending request goes to the leaver's manager.
      const leaves = (
        await c.query<{ id: string; user_id: string; approver_id: string; leave_type: string; days: string; start_date: string; end_date: string; display_name: string }>(
          `UPDATE leave_requests l SET approver_id = CASE WHEN l.user_id = $2 THEN coalesce($3, l.approver_id) ELSE $2 END FROM employees e
          WHERE l.approver_id = $1 AND l.status = 'pending' AND e.user_id = l.user_id
          RETURNING l.id, l.user_id, l.approver_id, l.leave_type, l.days::text, l.start_date::text, l.end_date::text, e.display_name`,
          [userId, b.toUserId, leaver?.manager_id ?? null],
        )
      ).rows.filter((l) => l.approver_id !== userId);
      for (const l of leaves) {
        await emit(c, "employee.leave.requested.v1", "employee.leave", l.id, {
          requestId: l.id,
          userId: l.user_id,
          displayName: l.display_name,
          approverId: l.approver_id,
          type: l.leave_type,
          days: Number(l.days),
          startDate: l.start_date,
          endDate: l.end_date,
        });
      }
      const reports = (
        await c.query<{ user_id: string; code: string; department_id: string | null }>(
          `UPDATE employees SET manager_id = CASE WHEN user_id = $2 THEN $3 ELSE $2 END, version = version + 1
          WHERE manager_id = $1 AND active RETURNING user_id, code, department_id`,
          [userId, b.toUserId, leaver?.manager_id ?? null],
        )
      ).rows;
      for (const r of reports) {
        await emit(c, "employee.profile.updated.v1", "employee.profile", r.user_id, {
          userId: r.user_id,
          code: r.code,
          departmentId: r.department_id,
          managerId: r.user_id === b.toUserId ? (leaver?.manager_id ?? null) : b.toUserId,
        });
      }
      await recordAudit(c, {
        action: "employee.handover.done",
        targetType: "member",
        targetId: userId,
        meta: { toUserId: b.toUserId, leaveApprovals: leaves.length, reports: reports.length },
      });
      return { leaveApprovals: leaves.length, reports: reports.length };
    });
  }
}
