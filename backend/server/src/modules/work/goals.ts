import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, Patch, Post, Put, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { authorize, DEFAULT_TIME_ZONE, newId, wallClock, withTransaction, type Principal } from "@workspace/shared";
import { workspaceTimeZone } from "./settings.js";
import { assertAllowed, parse, requirePrincipal } from "@workspace/service-kit";
import { BadRequestException } from "@nestjs/common";
import { assessGoal, assessKr, krDirection, krMet, periodFacts } from "./goal-health.js";

export const GOALS_POOL = Symbol("GOALS_POOL");

/**
 * Mục tiêu (OKR). A goal belongs to the company or a department for a period (a quarter by default; any two dates for a sprint) and
 * has 1–8 key results. A key result is either a number moved by its owner (revenue 0 → 2 tỷ, NPS 30 → 45)
 * or a project whose finished share of tasks is the progress. A goal's progress is the average of its
 * key results. Its health is the worst of its own pace and each key result's (goal-health.ts): a number that trails
 * the share of the period gone, or a project with late tasks, makes the goal "at risk" or "behind". A number key
 * result is higher-is-better or lower-is-better (`direction`; p95 latency 900 → 300 ms).
 */

/** A quarter, a half or a year ("Q4/2026", "H1/2027", "N/2026"), or any dates ("D/2026-11-03/2026-11-16", both inclusive: a sprint, a campaign). */
const PERIOD = /^(Q[1-4]|H[12]|N)\/\d{4}$|^D\/\d{4}-\d{2}-\d{2}\/\d{4}-\d{2}-\d{2}$/;
const isDated = (period: string) => period.startsWith("D/");
/** [starts, ends): the first day and the day after the last one, as the goals table stores them. */
export function periodRange(period: string): { starts: string; ends: string } {
  const [p, y, z] = period.split("/") as [string, string, string?];
  if (p === "D") {
    const from = Date.parse(`${y}T00:00:00Z`);
    const to = Date.parse(`${z}T00:00:00Z`);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) throw new BadRequestException("period: the end date must be on or after the start date");
    return { starts: y, ends: new Date(to + 86_400_000).toISOString().slice(0, 10) };
  }
  const year = Number(y);
  const span = p === "N" ? [0, 12] : p.startsWith("H") ? [(Number(p[1]) - 1) * 6, 6] : [(Number(p[1]) - 1) * 3, 3];
  const start = new Date(Date.UTC(year, span[0]!, 1));
  const end = new Date(Date.UTC(year, span[0]! + span[1]!, 1));
  return { starts: start.toISOString().slice(0, 10), ends: end.toISOString().slice(0, 10) };
}
/** This quarter in the workspace's zone, e.g. "Q4/2026". */
export function currentPeriod(now = new Date(), timeZone = DEFAULT_TIME_ZONE): string {
  const w = wallClock(now, timeZone);
  return `Q${Math.floor(w.getUTCMonth() / 3) + 1}/${w.getUTCFullYear()}`;
}

const krInput = z.object({
  id: z.string().max(40).optional(),
  title: z.string().trim().min(1).max(200),
  kind: z.enum(["number", "project"]),
  start: z.number().finite().default(0),
  target: z.number().finite().default(100),
  current: z.number().finite().optional(),
  unit: z.string().trim().max(20).default(""),
  /** Lower-is-better ("down") or higher-is-better ("up"); omitted, it is read from start and target. */
  direction: z.enum(["up", "down"]).nullable().optional(),
  projectId: z.string().max(40).nullable().default(null),
});
const goalInput = z.object({
  title: z.string().trim().min(1).max(200),
  ownerId: z.string().min(1).max(64),
  department: z.string().trim().max(100).nullable().default(null),
  period: z.string().regex(PERIOD),
  keyResults: z.array(krInput).min(1).max(8),
});

interface GoalRow {
  id: string;
  title: string;
  owner_id: string;
  department: string | null;
  period: string;
  starts_on: string;
  ends_on: string;
  created_by: string;
  updated_at: Date;
}
interface KrRow {
  id: string;
  goal_id: string;
  title: string;
  kind: "number" | "project";
  start_value: string;
  target: string;
  current: string;
  unit: string;
  project_id: string | null;
  direction: string | null;
  updated_at: Date;
  done: number | null;
  total: number | null;
  open: number | null;
  overdue: number | null;
  blocked: number | null;
  at_risk: number | null;
  project_due: Date | null;
  project_name: string | null;
}

export async function load(c: PoolClient, where: string, args: unknown[]) {
  const goals = (
    await c.query<GoalRow>(
      `SELECT id, title, owner_id, department, period, starts_on::text, ends_on::text, created_by, updated_at FROM goals WHERE NOT archived AND ${where} ORDER BY department NULLS FIRST, created_at`,
      args,
    )
  ).rows;
  if (!goals.length) return [];
  const timeZone = await workspaceTimeZone(c);
  const krs = (
    await c.query<KrRow>(
      `SELECT k.id, k.goal_id, k.title, k.kind, k.start_value, k.target, k.current, k.unit, k.project_id, k.direction, k.updated_at,
              p.name AS project_name, p.due_at AS project_due, c.done, c.total, c.open, c.overdue, c.blocked
         FROM key_results k LEFT JOIN projects p ON p.id = k.project_id
         LEFT JOIN LATERAL (
           SELECT count(*) FILTER (WHERE t.status = 'done')::int AS done,
                  count(*) FILTER (WHERE t.status <> 'cancelled')::int AS total,
                  count(*) FILTER (WHERE t.status NOT IN ('done','cancelled'))::int AS open,
                  count(*) FILTER (WHERE t.status NOT IN ('done','cancelled') AND t.due_at < now())::int AS overdue,
                  count(*) FILTER (WHERE t.status NOT IN ('done','cancelled') AND t.blocked_reason IS NOT NULL)::int AS blocked,
                  count(*) FILTER (WHERE t.status NOT IN ('done','cancelled') AND t.due_at >= now()
                    AND (t.eta_at > t.due_at OR (t.due_at < now() + interval '2 days' AND t.status <> 'review' AND t.progress < 50)))::int AS at_risk
             FROM tasks t WHERE k.project_id IS NOT NULL AND t.project_id = k.project_id) c ON true
        WHERE k.goal_id = ANY($1::text[]) ORDER BY k.position`,
      [goals.map((g) => g.id)],
    )
  ).rows;
  const now = Date.now();
  return goals.map((g) => {
    const period = periodFacts(g.starts_on, g.ends_on, now, timeZone);
    const mine = krs
      .filter((k) => k.goal_id === g.id)
      .map((k) => {
        const n = { start: Number(k.start_value), target: Number(k.target), current: Number(k.current), direction: k.direction };
        const project =
          k.kind === "project" && k.project_id
            ? {
                totalTasks: k.total ?? 0,
                doneTasks: k.done ?? 0,
                openTasks: k.open ?? 0,
                overdueTasks: k.overdue ?? 0,
                blockedTasks: k.blocked ?? 0,
                atRiskTasks: k.at_risk ?? 0,
                dueAt: k.project_due,
              }
            : null;
        const a = k.kind === "number" ? assessKr({ kind: "number", ...n }, period, now) : assessKr({ kind: "project", project }, period, now);
        return {
          id: k.id,
          title: k.title,
          kind: k.kind,
          start: n.start,
          target: n.target,
          current: n.current,
          direction: k.kind === "number" ? krDirection(n) : ("up" as const),
          met: k.kind === "number" ? krMet(n) : a.progress >= 100,
          unit: k.unit,
          projectId: k.project_id,
          projectName: k.project_name,
          done: k.done ?? 0,
          total: k.total ?? 0,
          progress: a.progress,
          health: a.health,
          reason: a.reason,
          updatedAt: k.updated_at,
        };
      });
    const progress = mine.length ? Math.round(mine.reduce((s, k) => s + k.progress, 0) / mine.length) : 0;
    return {
      id: g.id,
      title: g.title,
      ownerId: g.owner_id,
      department: g.department,
      period: g.period,
      startsOn: g.starts_on,
      endsOn: g.ends_on,
      updatedAt: g.updated_at,
      createdBy: g.created_by,
      progress,
      ...assessGoal(progress, mine, g.starts_on, g.ends_on, now, timeZone),
      keyResults: mine,
    };
  });
}

@Controller()
export class GoalsController {
  constructor(@Inject(GOALS_POOL) private readonly pool: Pool) {}

  private canEdit(p: Principal, g: { owner_id: string; created_by: string }) {
    return g.owner_id === p.id || g.created_by === p.id || authorize(p, "project.edit").allowed;
  }

  /** Goals of a period (default: this quarter) with progress and health; the periods that have goals. */
  @Get("goals")
  async list(@Req() req: Request, @Query("period") period?: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "project.read");
    return withTransaction(this.pool, async (c) => {
      const want = period && PERIOD.test(period) ? period : currentPeriod(new Date(), await workspaceTimeZone(c));
      const { starts, ends } = periodRange(want);
      // A dated goal (a sprint, a campaign) has no period of its own in the picker: it shows under every quarter,
      // half or year it overlaps, so the boss looking at Q4 sees November's sprint goal beside the quarter's.
      const where = isDated(want) ? "period = $1" : "(period = $1 OR (period LIKE 'D/%' AND starts_on < $3 AND ends_on > $2))";
      return {
        period: want,
        periods: (
          await c.query<{ period: string }>(
            "SELECT DISTINCT period, max(ends_on) e FROM goals WHERE NOT archived AND period NOT LIKE 'D/%' GROUP BY period ORDER BY e DESC LIMIT 12",
          )
        ).rows.map((r) => r.period),
        canCreate: authorize(p, "project.create").allowed,
        goals: (await load(c, where, isDated(want) ? [want] : [want, starts, ends])).map((g) => ({
          ...g,
          canEdit: this.canEdit(p, { owner_id: g.ownerId, created_by: g.createdBy }),
        })),
      };
    });
  }

  @Post("goals")
  async create(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "project.create");
    const b = parse(goalInput, body);
    const { starts, ends } = periodRange(b.period);
    return withTransaction(this.pool, async (c) => {
      const id = newId();
      await c.query(`INSERT INTO goals (id, title, owner_id, department, period, starts_on, ends_on, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [
        id,
        b.title,
        b.ownerId,
        b.department,
        b.period,
        starts,
        ends,
        p.id,
      ]);
      await this.saveKrs(c, id, b.keyResults);
      return (await load(c, "id = $1", [id]))[0];
    });
  }

  @Put("goals/:id")
  async update(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(goalInput, body);
    const { starts, ends } = periodRange(b.period);
    return withTransaction(this.pool, async (c) => {
      const g = (await c.query<GoalRow>("SELECT owner_id, created_by FROM goals WHERE id = $1 AND NOT archived", [id])).rows[0];
      if (!g) throw new NotFoundException("goal not found");
      if (!this.canEdit(p, g)) throw new ForbiddenException("only the owner or an admin edits this goal");
      await c.query("UPDATE goals SET title=$2, owner_id=$3, department=$4, period=$5, starts_on=$6, ends_on=$7, updated_at=now() WHERE id=$1", [
        id,
        b.title,
        b.ownerId,
        b.department,
        b.period,
        starts,
        ends,
      ]);
      await this.saveKrs(c, id, b.keyResults);
      return (await load(c, "id = $1", [id]))[0];
    });
  }

  /** Check-in on a number key result: the new value (the goal owner, the KR's goal editors). */
  @Patch("key-results/:id")
  async checkin(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(z.object({ current: z.number().finite() }), body);
    return withTransaction(this.pool, async (c) => {
      const g = (await c.query<GoalRow & { kind: string }>("SELECT g.owner_id, g.created_by, k.kind FROM key_results k JOIN goals g ON g.id = k.goal_id WHERE k.id = $1", [id]))
        .rows[0];
      if (!g) throw new NotFoundException("key result not found");
      if (!this.canEdit(p, g)) throw new ForbiddenException("only the owner or an admin updates this goal");
      if (g.kind !== "number") throw new BadRequestException("a project key result moves with its tasks");
      await c.query("UPDATE key_results SET current = $2, updated_at = now() WHERE id = $1", [id, b.current]);
      return { ok: true };
    });
  }

  @Delete("goals/:id")
  @HttpCode(204)
  async archive(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    await withTransaction(this.pool, async (c) => {
      const g = (await c.query<GoalRow>("SELECT owner_id, created_by FROM goals WHERE id = $1", [id])).rows[0];
      if (!g) throw new NotFoundException("goal not found");
      if (!this.canEdit(p, g)) throw new ForbiddenException("only the owner or an admin archives this goal");
      await c.query("UPDATE goals SET archived = true, updated_at = now() WHERE id = $1", [id]);
    });
  }

  /** Replaces a goal's key results, keeping the values of the ones that stay (matched by id). */
  private async saveKrs(c: PoolClient, goalId: string, krs: z.output<typeof krInput>[]) {
    const keep = krs.map((k) => k.id).filter(Boolean) as string[];
    await c.query("DELETE FROM key_results WHERE goal_id = $1 AND NOT (id = ANY($2::text[]))", [goalId, keep]);
    for (const [i, k] of krs.entries()) {
      if (k.kind === "project" && !k.projectId) throw new BadRequestException("keyResults: a project key result needs a project");
      if (k.kind === "number" && k.target === k.start) throw new BadRequestException("keyResults: target must differ from the start");
      if (k.projectId && !(await c.query("SELECT 1 FROM projects WHERE id = $1", [k.projectId])).rowCount) throw new BadRequestException("keyResults: unknown project");
      const exists = k.id ? (await c.query("SELECT 1 FROM key_results WHERE id = $1 AND goal_id = $2", [k.id, goalId])).rowCount : 0;
      if (exists)
        await c.query(
          "UPDATE key_results SET title=$2, kind=$3, start_value=$4, target=$5, current=coalesce($6, current), unit=$7, project_id=$8, position=$9, direction=$10, updated_at=now() WHERE id=$1",
          [k.id, k.title, k.kind, k.start, k.target, k.current ?? null, k.unit, k.kind === "project" ? k.projectId : null, i, k.kind === "number" ? (k.direction ?? null) : null],
        );
      else
        await c.query(
          `INSERT INTO key_results (id, goal_id, title, kind, start_value, target, current, unit, project_id, position, direction)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            newId(),
            goalId,
            k.title,
            k.kind,
            k.start,
            k.target,
            k.current ?? k.start,
            k.unit,
            k.kind === "project" ? k.projectId : null,
            i,
            k.kind === "number" ? (k.direction ?? null) : null,
          ],
        );
    }
  }
}
