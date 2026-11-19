import { Controller, Get, Req } from "@nestjs/common";
import { assertAllowed, requirePrincipal } from "@workspace/service-kit";
import { withTransaction } from "@workspace/shared";
import type { Request } from "express";
import { WorkControllerBase } from "./base.controller.js";

/** How many approval requests wait for me: the Yêu cầu tab's count, one indexed count instead of the whole list. */
@Controller()
export class ApprovalsCountController extends WorkControllerBase {
  @Get("approvals/pending-count")
  async pendingCount(@Req() req: Request) {
    const p = requirePrincipal(req);
    assertAllowed(p, "approval.read");
    return withTransaction(this.pool, async (c) => ({
      pending: (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM approvals WHERE approver_id = $1 AND status = 'pending'", [p.id])).rows[0]!.n,
    }));
  }
}
