import { BadRequestException, Controller, ForbiddenException, Get, Query, Req } from "@nestjs/common";
import { assertAllowed } from "@workspace/service-kit";
import { authorize, withTransaction, type Principal } from "@workspace/shared";
import type { Request } from "express";
import { seesEveryone, type Person } from "../followup.js";
import { resolveRef } from "../ref.js";
import { blockedTasks, blockerChains, outputWindows, overdueTrend } from "../reports.js";
import { canReadTask } from "../tasks.js";
import { parseScope, type VelocityScope } from "../velocity.js";

import { WorkControllerBase } from "./base.controller.js";
import { guard, member } from "./common.js";

/** Reads for the assistant's report tools (reports.ts): blockers, output against the window before, overdue per week. */
@Controller()
export class ReportsController extends WorkControllerBase {
  /** Blocked tasks the caller may read, longest blocked first, each with what it waits on and what waits on it. */
  @Get("reports/blockers")
  async blockers(@Req() req: Request) {
    const p = member(req);
    assertAllowed(p, "task.read");
    return withTransaction(this.pool, async (c) => {
      const { tasks, edges } = await blockedTasks(c);
      const readable = new Map(tasks.filter((t) => canReadTask(p, t)).map((t) => [t.id, t]));
      const seen = edges.filter((e) => readable.has(e.from) && readable.has(e.to));
      const waiting = new Set(seen.map((e) => e.to));
      const blocked = [...readable.values()].filter((t) => t.blocked_reason || waiting.has(t.id)).sort((a, b) => a.since.getTime() - b.since.getTime());
      const chains = new Map(
        blockerChains(
          blocked.map((t) => t.id),
          seen,
        ).map((x) => [x.id, x]),
      );
      const head = (id: string) => {
        const t = readable.get(id)!;
        return { id: t.id, code: t.code, title: t.title, status: t.status, assigneeId: t.assignee_id };
      };
      return {
        tasks: blocked.slice(0, 60).map((t) => ({
          ...head(t.id),
          dueAt: t.due_at,
          reason: t.blocked_reason,
          since: t.since,
          waitingOn: chains.get(t.id)!.waitingOn.map(head),
          holdsUp: chains.get(t.id)!.holdsUp,
        })),
        total: blocked.length,
      };
    });
  }

  /**
   * Tasks done per person in the window and the window before (7, 14, 30 or 90 days), on the AI view's audience:
   * AI admins everyone, others their reporting line, so it lines up with the ai module's per-person AI use.
   */
  @Get("reports/output")
  async output(@Req() req: Request, @Query("days") daysQ?: string) {
    const p = member(req);
    assertAllowed(p, "task.read");
    const days = [7, 14, 30, 90].includes(Number(daysQ)) ? Number(daysQ) : 30;
    const people = authorize(p, "ai.policy.manage").allowed
      ? (await this.employee.request<{ employees: Person[] }>("GET", "/employees?all=1", undefined, p).catch(() => ({ employees: [] as Person[] }))).employees
      : (await this.employee.request<{ reports: Person[] }>("GET", "/me/reports", undefined, p).catch(() => ({ reports: [] as Person[] }))).reports;
    const rows = await withTransaction(this.pool, (c) =>
      outputWindows(
        c,
        people.map((x) => x.userId),
        days,
      ),
    );
    const by = new Map(rows.map((r) => [r.userId, r]));
    return {
      days,
      people: people.map((x) => {
        const o = by.get(x.userId);
        return {
          userId: x.userId,
          displayName: x.displayName,
          department: x.department ?? null,
          done: o?.done ?? 0,
          donePrev: o?.donePrev ?? 0,
          dated: o?.dated ?? 0,
          onTime: o?.onTime ?? 0,
        };
      }),
    };
  }

  /**
   * Overdue at the end of each week, for the same scopes as /velocity: a project (anyone who may read projects),
   * a person (themselves, their manager chain, company-wide viewers), a department (company-wide viewers; anyone
   * else only over the members they follow), the workspace (company-wide viewers).
   */
  @Get("reports/overdue-trend")
  async overdue(@Req() req: Request, @Query("scope") scopeQ?: string, @Query("weeks") weeksQ?: string) {
    const p = member(req);
    assertAllowed(p, "task.read");
    const s = parseScope(scopeQ);
    if (!s) throw new BadRequestException("scope must be project:<id>, person:<id>, department:<id> or workspace");
    const weeks = Number(weeksQ) || 8;
    if (s.kind === "project") {
      assertAllowed(p, "project.read");
      return guard(() => withTransaction(this.pool, async (c) => ({ weeks: await overdueTrend(c, { kind: "project", id: await resolveRef(c, "project", s.id) }, weeks) })));
    }
    const scope = await this.peopleScope(p, s as { kind: "person" | "department"; id: string } | { kind: "workspace" });
    return guard(() => withTransaction(this.pool, async (c) => ({ weeks: await overdueTrend(c, scope, weeks) })));
  }

  private async peopleScope(p: Principal, s: { kind: "person" | "department"; id: string } | { kind: "workspace" }): Promise<VelocityScope> {
    const everyone = seesEveryone(p);
    if (s.kind === "workspace") {
      if (!everyone) throw new ForbiddenException("not allowed: company-wide numbers");
      return { kind: "workspace" };
    }
    const mine = everyone ? null : new Set([p.id, ...(await this.myPeople(p)).people.map((x) => x.userId)]);
    if (s.kind === "person") {
      if (mine && !mine.has(s.id)) throw new ForbiddenException("not allowed: this person's numbers");
      return { kind: "people", ids: [s.id] };
    }
    const [depts, all] = await Promise.all([
      this.employee.request<{ departments: { id: string; name: string }[] }>("GET", "/departments", undefined, p).catch(() => null),
      this.employee.request<{ employees: Person[] }>("GET", "/employees?all=1", undefined, p).catch(() => null),
    ]);
    const d = depts?.departments.find((x) => x.id === s.id) ?? depts?.departments.find((x) => x.name.toLowerCase() === s.id.toLowerCase());
    if (!d || !all) throw new ForbiddenException("not allowed: this department's numbers");
    const ids = all.employees.filter((x) => x.department === d.name && (!mine || mine.has(x.userId))).map((x) => x.userId);
    if (!ids.length) throw new ForbiddenException("not allowed: this department's numbers");
    return { kind: "people", ids };
  }
}
