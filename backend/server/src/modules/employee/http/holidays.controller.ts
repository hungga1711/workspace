import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Post, Put, Query, Req } from "@nestjs/common";
import { assertAllowed, parse, requirePrincipal } from "@workspace/service-kit";
import { withTransaction } from "@workspace/shared";
import type { Request } from "express";
import { z } from "zod";

import { localDay } from "../days.js";
import { employeeSettings } from "../settings.js";
import { EmployeeControllerBase } from "./base.controller.js";
import { emit } from "./common.js";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const holiday = z.object({
  day: z
    .string()
    .regex(DAY)
    .refine((d) => !Number.isNaN(Date.parse(d))),
  name: z.string().trim().min(1).max(100),
});

/** Company holidays (they count as non-working days for leave) and the work week they sit on. */
@Controller()
export class HolidaysController extends EmployeeControllerBase {
  /** Company holidays for a year plus the work week (everyone can see them; they shape leave and attendance). */
  @Get("holidays")
  async holidays(@Req() req: Request, @Query("year") year?: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "employee.profile.read");
    const y = year && /^\d{4}$/.test(year) ? year : localDay(await this.timeZone()).slice(0, 4);
    return withTransaction(this.pool, async (c) => ({
      year: y,
      workWeek: (await employeeSettings(c)).workWeek,
      holidays: (await c.query(`SELECT day::text, name FROM holidays WHERE day BETWEEN $1::date AND $2::date ORDER BY day`, [`${y}-01-01`, `${y}-12-31`])).rows,
    }));
  }

  @Put("holidays/:day")
  async setHoliday(@Req() req: Request, @Param("day") day: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "member.manage");
    if (!DAY.test(day) || Number.isNaN(Date.parse(day))) throw new BadRequestException("day must be YYYY-MM-DD");
    const b = parse(z.object({ name: z.string().trim().min(1).max(100) }), body);
    return withTransaction(this.pool, async (c) => {
      await c.query("INSERT INTO holidays (day, name) VALUES ($1,$2) ON CONFLICT (day) DO UPDATE SET name = EXCLUDED.name", [day, b.name]);
      await emit(c, "employee.holiday.set.v1", "employee.holiday", day, { day, name: b.name, by: p.id });
      return { day, name: b.name };
    });
  }

  /** A country preset or an imported calendar: up to 200 days in one request. */
  @Post("holidays/bulk")
  async setHolidays(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "member.manage");
    const b = parse(z.object({ holidays: z.array(holiday).min(1).max(200) }), body);
    return withTransaction(this.pool, async (c) => {
      let added = 0;
      for (const h of b.holidays) {
        const r = await c.query("INSERT INTO holidays (day, name) VALUES ($1,$2) ON CONFLICT (day) DO NOTHING", [h.day, h.name]);
        if (r.rowCount) {
          added++;
          await emit(c, "employee.holiday.set.v1", "employee.holiday", h.day, { day: h.day, name: h.name, by: p.id });
        }
      }
      return { added, skipped: b.holidays.length - added };
    });
  }

  @Delete("holidays/:day")
  @HttpCode(204)
  async deleteHoliday(@Req() req: Request, @Param("day") day: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "member.manage");
    await withTransaction(this.pool, async (c) => {
      const r = await c.query("DELETE FROM holidays WHERE day = $1::date", [day]);
      if (!r.rowCount) throw new NotFoundException("holiday not found");
      await emit(c, "employee.holiday.removed.v1", "employee.holiday", day, { day, by: p.id });
    });
  }
}
