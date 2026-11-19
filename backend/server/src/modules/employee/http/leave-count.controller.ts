import { Controller, Get, Req } from "@nestjs/common";
import { requirePrincipal } from "@workspace/service-kit";
import { withTransaction } from "@workspace/shared";
import type { Request } from "express";
import { EmployeeControllerBase } from "./base.controller.js";

/** How many leave requests wait for my decision: the Yêu cầu tab's count, one indexed count instead of the list. */
@Controller()
export class LeaveCountController extends EmployeeControllerBase {
  @Get("leave/pending-count")
  async pendingCount(@Req() req: Request) {
    const p = requirePrincipal(req);
    return withTransaction(this.pool, async (c) => ({
      pending: (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM leave_requests WHERE approver_id = $1 AND status = 'pending'", [p.id])).rows[0]!.n,
    }));
  }
}
