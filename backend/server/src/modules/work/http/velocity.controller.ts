import { BadRequestException, Controller, ForbiddenException, Get, Query, Req } from "@nestjs/common";
import { assertAllowed } from "@workspace/service-kit";
import { withTransaction } from "@workspace/shared";
import type { Request } from "express";
import { seesEveryone, type Person } from "../followup.js";
import { resolveRef } from "../ref.js";
import { canReadTask } from "../tasks.js";
import { departmentAccess } from "../people-access.js";
import { attention, doneThisWeek, parseScope, velocity, type Velocity, type VelocityScope } from "../velocity.js";
import type { Principal } from "@workspace/shared";

import { WorkControllerBase } from "./base.controller.js";
import { guard, member } from "./common.js";

/** Flow numbers (velocity.ts): what the boss reads instead of "% done". */
@Controller()
export class VelocityController extends WorkControllerBase {
  /**
   * Flow for a project, a department, a person or the whole workspace: done and added per week, what is in flight,
   * stuck and overdue now, cycle time. Replaces "% done", which falls on a board whenever work is added. Who may ask:
   * a project, anyone who may read projects; a person, themselves and whoever follows them (their manager chain or a
   * company-wide viewer); a department, its people the caller follows; the workspace, company-wide viewers only.
   */
  @Get("velocity")
  async velocity(@Req() req: Request, @Query("scope") scopeQ?: string, @Query("weeks") weeksQ?: string) {
    const p = member(req);
    assertAllowed(p, "task.read");
    const s = parseScope(scopeQ);
    if (!s) throw new BadRequestException("scope must be project:<id>, person:<id>, department:<id> or workspace");
    const weeks = Number(weeksQ) || 8;
    let scope: VelocityScope;
    if (s.kind === "project") {
      assertAllowed(p, "project.read");
      const ref = s.id;
      return guard(() => withTransaction(this.pool, async (c) => this.answer(c, p, { kind: "project", id: await resolveRef(c, "project", ref) }, weeks)));
    } else if (s.kind === "workspace") {
      if (!seesEveryone(p)) throw new ForbiddenException("not allowed: company-wide numbers");
      scope = { kind: "workspace" };
    } else if (s.kind === "person") {
      if (s.id !== p.id && !seesEveryone(p)) {
        const { people } = await this.myPeople(p);
        if (!people.some((x) => x.userId === s.id)) throw new ForbiddenException("not allowed: this person's numbers");
      }
      scope = { kind: "people", ids: [s.id] };
    } else {
      // A department by id or by name, with the department page's rule (people-access.ts): company-wide viewers, its
      // head, managers with reports there, and its own members. Members see the aggregate only, no task lists.
      const [depts, all, me, team] = await Promise.all([
        this.employee.request<{ departments: { id: string; name: string; headId: string | null }[] }>("GET", "/departments", undefined, p).catch(() => null),
        this.employee.request<{ employees: Person[] }>("GET", "/employees?all=1", undefined, p).catch(() => null),
        this.employee.request<{ departmentId?: string | null }>("GET", `/employees/${encodeURIComponent(p.id)}`, undefined, p).catch(() => null),
        this.myPeople(p),
      ]);
      const d = depts?.departments.find((x) => x.id === s.id) ?? depts?.departments.find((x) => x.name === s.id);
      if (!d || !all) throw new ForbiddenException("not allowed: this department's numbers");
      const ids = all.employees.filter((x) => x.department === d.name).map((x) => x.userId);
      const access = departmentAccess({
        callerId: p.id,
        everyone: seesEveryone(p),
        headId: d.headId,
        teamIds: new Set(team.people.map((x) => x.userId)),
        memberIds: ids,
        callerDepartmentId: me?.departmentId ?? null,
        departmentId: d.id,
      });
      if (!access) throw new ForbiddenException("not allowed: this department's numbers");
      scope = { kind: "people", ids };
      if (access === "colleague") return guard(() => withTransaction(this.pool, async (c) => ({ ...(await velocity(c, scope, weeks)), attention: [], finished: [] })));
    }
    return guard(() => withTransaction(this.pool, (c) => this.answer(c, p, scope, weeks)));
  }

  /**
   * The numbers plus, among what the caller may read, up to eight overdue or stuck tasks (the Overview's "needs
   * attention") and up to ten done this week (what a weekly status update starts from).
   */
  private async answer(c: import("pg").PoolClient, p: Principal, scope: VelocityScope, weeks: number): Promise<Velocity & { attention: unknown[]; finished: unknown[] }> {
    const v = await velocity(c, scope, weeks);
    const rows = (await attention(c, scope)).filter((t) => canReadTask(p, t)).slice(0, 8);
    const done = (await doneThisWeek(c, scope)).filter((t) => canReadTask(p, t)).slice(0, 10);
    return {
      ...v,
      finished: done.map((t) => ({ id: t.id, code: t.code, title: t.title, assigneeId: t.assignee_id })),
      attention: rows.map((t) => ({
        id: t.id,
        code: t.code,
        title: t.title,
        status: t.status,
        assigneeId: t.assignee_id,
        dueAt: t.due_at,
        since: t.since,
        reason: t.due_at && t.due_at.getTime() < Date.now() ? "overdue" : "stuck",
      })),
    };
  }
}
