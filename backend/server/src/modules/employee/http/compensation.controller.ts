import { Body, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, Put, Req } from "@nestjs/common";
import { assertAllowed, parse, requirePrincipal } from "@workspace/service-kit";
import { withTransaction } from "@workspace/shared";
import type { Request } from "express";
import { z } from "zod";

import { EmployeeControllerBase } from "./base.controller.js";
import { allowed, date, emit } from "./common.js";

/** Compensation (sensitive: own permission, never in events). */
@Controller()
export class CompensationController extends EmployeeControllerBase {
  @Put("employees/:userId/compensation")
  @HttpCode(204)
  async setComp(@Req() req: Request, @Param("userId") userId: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "member.manage");
    assertAllowed(p, "employee.salary.read");
    const b = parse(z.object({ baseSalary: z.number().nonnegative().max(1e12), currency: z.string().length(3), effectiveFrom: date }), body);
    await withTransaction(this.pool, async (c) => {
      await this.employee(c, userId);
      await c.query(
        "INSERT INTO compensation (user_id, base_salary, currency, effective_from) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id, effective_from) DO UPDATE SET base_salary = EXCLUDED.base_salary, currency = EXCLUDED.currency",
        [userId, b.baseSalary, b.currency, b.effectiveFrom],
      );
      await emit(c, "employee.compensation.changed.v1", "employee.profile", userId, { userId }); // no amounts in events
    });
  }

  /** Salary: own record (SELF), department (DEPARTMENT), or everyone (WORKSPACE). */
  @Get("employees/:userId/compensation")
  async comp(@Req() req: Request, @Param("userId") userId: string) {
    const p = requirePrincipal(req);
    return withTransaction(this.pool, async (c) => {
      const e = await this.employee(c, userId).catch(() => null);
      if (!e || !allowed(p, "employee.salary.read", { ownerId: userId, departmentId: e.department_id })) {
        // Same answer for "no such employee" and "not allowed".
        throw new ForbiddenException("not allowed to view compensation");
      }
      const r = await c.query(
        `SELECT base_salary::float AS "baseSalary", currency, effective_from::text AS "effectiveFrom" FROM compensation WHERE user_id = $1 AND effective_from <= now()::date ORDER BY effective_from DESC LIMIT 1`,
        [userId],
      );
      if (!r.rows[0]) throw new NotFoundException("no compensation record");
      return r.rows[0];
    });
  }
}
