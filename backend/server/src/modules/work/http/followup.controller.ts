import { Body, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, Post, Query, Req } from "@nestjs/common";
import { assertAllowed, parse } from "@workspace/service-kit";
import { authorize, withTransaction, type Principal } from "@workspace/shared";
import type { Request } from "express";
import { z } from "zod";
import { createDoc } from "../documents.js";
import type { WeeklyAi } from "../followup.js";
import { delegated, nudge, nudgeAll, teamStatus, weeklyReport, type Person } from "../followup.js";
import { currentPeriod, load as loadGoals } from "../goals.js";
import { aiByProject, outcomes } from "../outcomes.js";
import { workspaceTimeZone } from "../settings.js";
import { seesEveryone } from "../followup.js";
import { departmentAccess, fullRow, personAccess, workNumbersOnly } from "../people-access.js";

import { WorkControllerBase } from "./base.controller.js";
import { guard, member } from "./common.js";

interface Profile {
  userId: string;
  displayName: string;
  title: string | null;
  department: string | null;
  departmentId: string | null;
  managerId: string | null;
}

/** The web sends the person's UI language on every call; generated comments follow it. */
const uiLocale = (req: Request): "vi" | "en" => (req.headers["x-locale"] === "vi" ? "vi" : "en");

/** Follow-up: delegated work, team status, outcomes, weekly report and nudges. */
@Controller()
export class FollowUpController extends WorkControllerBase {
  // ---- follow-up: what I delegated, what my team is doing (followup.ts) ----
  @Get("followup/delegated")
  async delegated(@Req() req: Request) {
    const p = member(req);
    assertAllowed(p, "task.read");
    return withTransaction(this.pool, (c) => delegated(c, p));
  }

  /**
   * What people got done in the window and the 8-week trend, for Công việc › AI (AI use next to output).
   * AI admins see everyone, as in the AI view; managers their reporting line.
   */
  @Get("followup/outcomes")
  async outcomes(@Req() req: Request, @Query("days") daysQ?: string) {
    const p = member(req);
    assertAllowed(p, "task.read");
    const days = [7, 30, 90].includes(Number(daysQ)) ? Number(daysQ) : 30;
    const people = await this.aiPeople(p);
    return withTransaction(this.pool, (c) =>
      outcomes(
        c,
        people.map((x) => x.userId),
        days,
      ),
    );
  }

  /** The same audience as the ai module's AI view: AI admins (ai.policy.manage) see everyone, others their reports. */
  private async aiPeople(p: Principal): Promise<Person[]> {
    return authorize(p, "ai.policy.manage").allowed
      ? (await this.employee.request<{ employees: Person[] }>("GET", "/employees?all=1", undefined, p).catch(() => ({ employees: [] as Person[] }))).employees
      : (await this.employee.request<{ reports: Person[] }>("GET", "/me/reports", undefined, p).catch(() => ({ reports: [] as Person[] }))).reports;
  }

  /**
   * Áp dụng AI: how the company AI went per project and per task, over the caller's team (their reports, or everyone
   * for those who follow the whole company) and their own work.
   */
  @Get("followup/ai-projects")
  async aiProjects(@Req() req: Request, @Query("days") daysQ?: string) {
    const p = member(req);
    assertAllowed(p, "task.read");
    const days = [7, 30, 90].includes(Number(daysQ)) ? Number(daysQ) : 30;
    const { scope, people } = await this.myPeople(p);
    const ids = [...new Set([p.id, ...people.map((x) => x.userId)])];
    const audience = (await this.aiPeople(p)).map((x) => x.userId);
    return withTransaction(this.pool, async (c) => {
      const r = await aiByProject(c, ids, days);
      // The headline comparison (faster, on time) is the one Usage shows for the same window and people
      // (outcomes.ts), so the two pages never disagree by a point; the per-project rows stay as they are.
      if (audience.length) {
        const w = (await outcomes(c, audience, days)).withAi;
        r.total.assisted = w.assisted;
        r.total.other = w.other;
      }
      return { days, scope, ...r };
    });
  }

  @Get("followup/team")
  async team(@Req() req: Request, @Query("brief") brief?: string) {
    const p = member(req);
    assertAllowed(p, "task.read");
    const { scope, people } = await this.myPeople(p);
    return withTransaction(this.pool, async (c) => {
      const r = await teamStatus(c, p, people);
      if (brief !== "1") return { scope, ...r };
      // Home's team card: the numbers and only the few tasks worth asking about, not every task of every person.
      return {
        scope,
        totals: r.totals,
        departments: r.departments,
        people: r.people.map(({ tasks, doneRecently: _d, now: _n, ...x }) => ({
          ...x,
          now: [],
          doneRecently: [],
          tasks: tasks.filter((t) => t.status !== "done" && (t.overdue || t.atRisk || t.stale || t.blockedReason)).slice(0, 3),
        })),
      };
    });
  }

  /**
   * One person's page in Work (/app/work/people/:id): who may open it is people-access.ts (yourself, your reporting
   * line, everyone for company followers, same-department colleagues as numbers only); anyone else gets a 403.
   */
  @Get("people/:userId")
  async person(@Req() req: Request, @Param("userId") userId: string) {
    const p = member(req);
    assertAllowed(p, "task.read");
    if (!/^[0-9A-Za-z_-]{6,64}$/.test(userId)) throw new NotFoundException("person not found");
    const profile = (id: string) => this.employee.request<Profile>("GET", `/employees/${encodeURIComponent(id)}`, undefined, p).catch(() => null);
    const [target, me, team] = await Promise.all([profile(userId), userId === p.id ? null : profile(p.id), this.myPeople(p)]);
    if (!target) throw new NotFoundException("person not found");
    const access = personAccess({
      callerId: p.id,
      targetId: userId,
      everyone: seesEveryone(p),
      teamIds: new Set(team.people.map((x) => x.userId)),
      callerDepartmentId: (userId === p.id ? target : me)?.departmentId ?? null,
      targetDepartmentId: target.departmentId,
    });
    if (!access) throw new ForbiddenException({ error: "no_access", message: "this person is not in your team or department" });
    const who: Person = { userId, displayName: target.displayName, title: target.title, managerId: target.managerId, department: target.department, depth: 1 };
    const r = await withTransaction(this.pool, (c) => teamStatus(c, { ...p, id: "" }, [who]));
    const row = r.people[0] ?? null;
    return {
      access,
      profile: { userId, displayName: target.displayName, title: target.title, department: target.department, departmentId: target.departmentId },
      person: row && access === "colleague" ? workNumbersOnly(row) : row,
    };
  }

  /**
   * A department's page in Work: its people, their numbers and the department's rollup (done per week). Rows of people
   * outside the caller's line are numbers only (people-access.ts).
   */
  @Get("departments/:id/status")
  async department(@Req() req: Request, @Param("id") id: string) {
    const p = member(req);
    assertAllowed(p, "task.read");
    const [depts, all, me, team] = await Promise.all([
      this.employee.request<{ departments: { id: string; name: string; headId: string | null }[] }>("GET", "/departments", undefined, p).catch(() => null),
      this.employee.request<{ employees: Person[] }>("GET", "/employees?all=1", undefined, p).catch(() => null),
      this.employee.request<Profile>("GET", `/employees/${encodeURIComponent(p.id)}`, undefined, p).catch(() => null),
      this.myPeople(p),
    ]);
    if (!depts || !all) throw new Error("employee directory unavailable");
    const d = depts.departments.find((x) => x.id === id);
    if (!d) throw new NotFoundException("department not found");
    const members = all.employees.filter((e) => e.department === d.name);
    const teamIds = new Set(team.people.map((x) => x.userId));
    const access = departmentAccess({
      callerId: p.id,
      everyone: seesEveryone(p),
      headId: d.headId,
      teamIds,
      memberIds: members.map((x) => x.userId),
      callerDepartmentId: me?.departmentId ?? null,
      departmentId: d.id,
    });
    if (!access) throw new ForbiddenException({ error: "no_access", message: "this department is not yours to follow" });
    const r = await withTransaction(this.pool, (c) => teamStatus(c, { ...p, id: "" }, members));
    return {
      access,
      department: { id: d.id, name: d.name, headId: d.headId, members: members.length },
      totals: r.totals,
      rollup: r.departments[0] ?? null,
      people: r.people.map((x) =>
        fullRow(access, { callerId: p.id, headId: d.headId, teamIds, userId: x.userId }) ? { ...x, full: true } : { ...workNumbersOnly(x), full: false },
      ),
    };
  }

  /**
   * What my manager sees about me in Follow-up, exactly as they see it (transparency: people should
   * never wonder what is visible). Private to-dos are excluded here as they are there.
   */
  @Get("followup/me")
  async followupMe(@Req() req: Request) {
    const p = member(req);
    assertAllowed(p, "task.read");
    return withTransaction(this.pool, async (c) => {
      const r = await teamStatus(c, { ...p, id: "" }, [{ userId: p.id, displayName: "", title: null, managerId: null, depth: 1 }]);
      return { me: r.people[0] ?? null };
    });
  }

  /** "Tạo báo cáo tuần": Follow-up's numbers written into a new private page the caller can edit and share. */
  @Post("followup/report")
  @HttpCode(201)
  async report(@Req() req: Request, @Body() body: unknown) {
    const p = member(req);
    assertAllowed(p, "task.read");
    const b = parse(z.object({ locale: z.enum(["vi", "en"]).default("vi") }), body ?? {});
    const { people } = await this.myPeople(p);
    const everyone = await this.employee.request<{ employees: Person[] }>("GET", "/employees?all=1", undefined, p).catch(() => ({ employees: [] as Person[] }));
    const names = new Map([...everyone.employees, ...people].map((x) => [x.userId, x.displayName]));
    // The week's AI use, as the caller may see it (their reporting line); left out when they may not.
    const ai = await this.ai.request<WeeklyAi>("GET", "/oversight?days=7", undefined, p).catch(() => null);
    return guard(() =>
      withTransaction(this.pool, async (c) => {
        const timeZone = await workspaceTimeZone(c);
        const goals = (await loadGoals(c, "period = $1", [currentPeriod(new Date(), timeZone)])).map((g) => ({
          title: g.title,
          department: g.department,
          progress: g.progress,
          expected: g.expected,
          health: g.health,
        }));
        const r = weeklyReport(await teamStatus(c, p, people), await delegated(c, p), names, b.locale, new Date(), ai, goals, timeZone);
        return createDoc(c, p, { title: r.title, content: r.html, format: "html", projectId: null, emoji: "📊", labels: [b.locale === "en" ? "weekly-report" : "bao-cao-tuan"] });
      }),
    );
  }

  /** Ask everyone with open work and no progress update for a few days, in one go (at most once a day per task). */
  @Post("followup/nudge-all")
  async nudgeAll(@Req() req: Request) {
    const p = member(req);
    assertAllowed(p, "task.read");
    const { people } = await this.myPeople(p);
    const mine = new Set(people.map((x) => x.userId));
    return guard(() =>
      withTransaction(this.pool, async (c) => {
        const team = await teamStatus(c, p, people);
        const given = await delegated(c, p);
        return nudgeAll(c, p, [...team.people.flatMap((x) => x.tasks), ...given.tasks], (u) => mine.has(u), uiLocale(req));
      }),
    );
  }

  @Post("tasks/:id/nudge")
  @HttpCode(201)
  async nudge(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = member(req);
    const b = parse(z.object({ message: z.string().max(1000).default("") }), body ?? {});
    const { people } = await this.myPeople(p);
    const mine = new Set(people.map((x) => x.userId));
    return guard(() => withTransaction(this.pool, (c) => nudge(c, p, id, b.message, (u) => mine.has(u), uiLocale(req))));
  }
}
