import { Body, ConflictException, Controller, Get, Put, Req } from "@nestjs/common";
import { assertAllowed, parse, requirePrincipal } from "@workspace/service-kit";
import { recordAudit, settingsChanges, withTransaction } from "@workspace/shared";
import type { Request } from "express";
import { z } from "zod";

import { employeeSettings, leaveTypes } from "../settings.js";
import { EmployeeControllerBase } from "./base.controller.js";

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Workspace-level people settings: work week, shift and lateness, the yearly leave policy. */
@Controller()
export class SettingsController extends EmployeeControllerBase {
  @Get("settings")
  async get(@Req() req: Request) {
    const p = requirePrincipal(req);
    assertAllowed(p, "employee.profile.read");
    return withTransaction(this.pool, employeeSettings);
  }

  @Put("settings")
  async set(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "member.manage");
    const b = parse(
      z.object({
        workWeek: z.array(z.number().int().min(1).max(7)).min(1).max(7),
        shift: z.object({ start: z.string().regex(HM), end: z.string().regex(HM).nullable(), lateAfterMin: z.number().int().min(0).max(240) }).nullable(),
        leavePolicy: z.object({
          autoGrant: z.boolean(),
          typeCode: z.string().regex(/^[a-z][a-z0-9_]{0,29}$/),
          defaultDays: z.number().min(0).max(365),
          prorate: z.boolean(),
          seniority: z.boolean(),
          carryOverMax: z.number().min(0).max(365),
        }),
      }),
      body,
    );
    return withTransaction(this.pool, async (c) => {
      const type = (await leaveTypes(c, { activeOnly: true })).find((t) => t.code === b.leavePolicy.typeCode);
      if (!type?.requiresBalance) throw new ConflictException({ error: "policy_type_needs_balance" });
      const before = await employeeSettings(c);
      await c.query(
        `INSERT INTO employee_settings (work_week, shift_start, shift_end, late_after_min, leave_auto_grant, leave_type_code, leave_default_days, leave_prorate, leave_seniority, leave_carry_over_max)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (singleton) DO UPDATE SET work_week = EXCLUDED.work_week, shift_start = EXCLUDED.shift_start, shift_end = EXCLUDED.shift_end, late_after_min = EXCLUDED.late_after_min,
           leave_auto_grant = EXCLUDED.leave_auto_grant, leave_type_code = EXCLUDED.leave_type_code, leave_default_days = EXCLUDED.leave_default_days, leave_prorate = EXCLUDED.leave_prorate,
           leave_seniority = EXCLUDED.leave_seniority, leave_carry_over_max = EXCLUDED.leave_carry_over_max, updated_at = now()`,
        [
          [...new Set(b.workWeek)].sort(),
          b.shift?.start ?? null,
          b.shift?.end ?? null,
          b.shift?.lateAfterMin ?? 0,
          b.leavePolicy.autoGrant,
          b.leavePolicy.typeCode,
          b.leavePolicy.defaultDays,
          b.leavePolicy.prorate,
          b.leavePolicy.seniority,
          b.leavePolicy.carryOverMax,
        ],
      );
      const after = await employeeSettings(c);
      await recordAudit(c, { action: "employee.settings.updated", targetType: "settings", targetId: "employee", changes: settingsChanges(before, after) });
      return after;
    });
  }
}
