import { Body, ConflictException, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { assertAllowed, parse, requirePrincipal } from "@workspace/service-kit";
import { newId, recordAudit, withTransaction } from "@workspace/shared";
import type { Request } from "express";
import { z } from "zod";

import { EmployeeControllerBase } from "./base.controller.js";
import { emit } from "./common.js";

/** Departments. */
@Controller()
export class DepartmentsController extends EmployeeControllerBase {
  @Post("departments")
  async department(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "member.manage");
    const b = parse(z.object({ name: z.string().trim().min(1).max(100), headId: z.string().nullable().default(null) }), body);
    return withTransaction(this.pool, async (c) => {
      const id = newId();
      await c.query("INSERT INTO departments (id, name, head_id) VALUES ($1,$2,$3)", [id, b.name, b.headId]);
      await recordAudit(c, { action: "employee.department.created", targetType: "department", targetId: id, targetLabel: b.name, meta: { headId: b.headId } });
      return { id };
    });
  }

  @Patch("departments/:id")
  @HttpCode(204)
  async updateDepartment(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "member.manage");
    const b = parse(z.object({ name: z.string().trim().min(1).max(100).optional(), headId: z.string().nullable().optional() }), body);
    await withTransaction(this.pool, async (c) => {
      const before = (await c.query<{ name: string; head_id: string | null }>("SELECT name, head_id FROM departments WHERE id = $1", [id])).rows[0];
      const r = await c.query("UPDATE departments SET name = coalesce($2, name), head_id = CASE WHEN $3::boolean THEN $4 ELSE head_id END WHERE id = $1", [
        id,
        b.name ?? null,
        b.headId !== undefined,
        b.headId ?? null,
      ]);
      if (!r.rowCount) throw new NotFoundException("department not found");
      const changes: Record<string, unknown> = {};
      if (b.name !== undefined && b.name !== before?.name) changes.name = { from: before?.name ?? null, to: b.name };
      if (b.headId !== undefined && b.headId !== before?.head_id) changes.headId = { from: before?.head_id ?? null, to: b.headId };
      if (Object.keys(changes).length)
        await recordAudit(c, { action: "employee.department.updated", targetType: "department", targetId: id, targetLabel: b.name ?? before?.name ?? null, changes });
    });
  }

  /**
   * Deleting a department that still has people needs `?move=1`: they are left without a department (and
   * `employee.profile.updated` tells identity, so DEPARTMENT-scope grants stop matching them).
   */
  @Delete("departments/:id")
  @HttpCode(204)
  async deleteDepartment(@Req() req: Request, @Param("id") id: string, @Query("move") move?: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "member.manage");
    await withTransaction(this.pool, async (c) => {
      const people = (await c.query<{ user_id: string; code: string; manager_id: string | null }>("SELECT user_id, code, manager_id FROM employees WHERE department_id = $1", [id]))
        .rows;
      if (people.length && move !== "1") throw new ConflictException({ error: "department_in_use", members: people.length });
      for (const e of people) {
        await c.query("UPDATE employees SET department_id = NULL, version = version + 1 WHERE user_id = $1", [e.user_id]);
        await emit(c, "employee.profile.updated.v1", "employee.profile", e.user_id, { userId: e.user_id, code: e.code, departmentId: null, managerId: e.manager_id });
      }
      const r = await c.query<{ name: string }>("DELETE FROM departments WHERE id = $1 RETURNING name", [id]);
      if (!r.rowCount) throw new NotFoundException("department not found");
      await recordAudit(c, { action: "employee.department.deleted", targetType: "department", targetId: id, targetLabel: r.rows[0]!.name, meta: { members: people.length } });
    });
  }

  @Get("departments")
  async departments(@Req() req: Request) {
    const p = requirePrincipal(req);
    assertAllowed(p, "employee.profile.read");
    return withTransaction(this.pool, async (c) => ({
      departments: (
        await c.query(`SELECT d.id, d.name, d.head_id AS "headId", count(e.user_id)::int AS members
          FROM departments d LEFT JOIN employees e ON e.department_id = d.id AND e.active
          GROUP BY d.id ORDER BY d.name`)
      ).rows,
    }));
  }
}
