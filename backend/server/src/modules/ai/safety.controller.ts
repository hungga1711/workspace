import { Body, ConflictException, Controller, Delete, Get, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { newId, withTransaction, recordAudit } from "@workspace/shared";
import { assertAllowed, parse, requirePrincipal } from "@workspace/service-kit";
import { DEPS } from "./ai.controller.js";
import { audienceOf } from "./activity.js";
import type { Deps } from "./runtime.js";

/**
 * The safety net around outside AI: the company's own keywords (client names, project codes) that the
 * extension treats like ID numbers, and how often sends were warned about, redacted or blocked, per person
 * and department. Counts only; the text that was redacted or blocked never reaches workspace.
 */
@Controller()
export class SafetyController {
  constructor(@Inject(DEPS) private readonly d: Deps) {}

  @Get("policy/keywords")
  async keywords(@Req() req: Request) {
    const p = requirePrincipal(req);
    assertAllowed(p, "ai.policy.manage");
    return withTransaction(this.d.pool, async (c) => ({
      keywords: (await c.query(`SELECT id, term, label, created_at AS "createdAt" FROM ai_keywords ORDER BY lower(term)`)).rows,
    }));
  }

  @Post("policy/keywords")
  async addKeyword(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "ai.policy.manage");
    const b = parse(z.object({ term: z.string().trim().min(2).max(120), label: z.string().trim().max(120).default("") }), body);
    return withTransaction(this.d.pool, async (c) => {
      const id = newId();
      const r = await c.query(`INSERT INTO ai_keywords (id, term, label, created_by) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [id, b.term, b.label, p.id]);
      if (!r.rowCount) throw new ConflictException({ error: "keyword_exists" });
      await recordAudit(c, { action: "ai.safety.keyword_added", targetType: "ai_keyword", targetId: id, targetLabel: b.term });
      return { keyword: { id, term: b.term, label: b.label } };
    });
  }

  @Delete("policy/keywords/:id")
  @HttpCode(204)
  async removeKeyword(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "ai.policy.manage");
    await withTransaction(this.d.pool, async (c) => {
      const r = await c.query<{ term: string }>("DELETE FROM ai_keywords WHERE id = $1 RETURNING term", [id]);
      if (r.rows[0]) await recordAudit(c, { action: "ai.safety.keyword_removed", targetType: "ai_keyword", targetId: id, targetLabel: r.rows[0].term });
    });
  }

  /** Warned / redacted / blocked sends in the window, per person (with department), for the caller's audience. */
  @Get("oversight/safety")
  async safety(@Req() req: Request, @Query("days") daysQ?: string) {
    const p = requirePrincipal(req);
    const days = [7, 30, 90].includes(Number(daysQ)) ? Number(daysQ) : 30;
    const { people } = await audienceOf(this.d, p);
    const byId = new Map(people.map((x) => [x.userId, x]));
    return withTransaction(this.d.pool, async (c) => {
      const rows = (
        await c.query<{ user_id: string; warn: number; redact: number; block: number }>(
          `SELECT user_id,
                  coalesce(sum(count) FILTER (WHERE action = 'warn'), 0)::int AS warn,
                  coalesce(sum(count) FILTER (WHERE action = 'redact'), 0)::int AS redact,
                  coalesce(sum(count) FILTER (WHERE action = 'block'), 0)::int AS block
             FROM ai_safety_events WHERE at > now() - make_interval(days => $2) AND user_id = ANY($1::text[]) GROUP BY user_id`,
          [[...byId.keys()], days],
        )
      ).rows;
      const persons = rows
        .map((r) => ({
          userId: r.user_id,
          name: byId.get(r.user_id)?.displayName ?? "",
          department: byId.get(r.user_id)?.department ?? null,
          warn: r.warn,
          redact: r.redact,
          block: r.block,
        }))
        .sort((a, b) => b.redact + b.block + b.warn - (a.redact + a.block + a.warn));
      const depts = new Map<string, { department: string | null; warn: number; redact: number; block: number }>();
      for (const x of persons) {
        const k = x.department ?? "";
        const d = depts.get(k) ?? { department: x.department, warn: 0, redact: 0, block: 0 };
        d.warn += x.warn;
        d.redact += x.redact;
        d.block += x.block;
        depts.set(k, d);
      }
      const total = persons.reduce((s, x) => ({ warn: s.warn + x.warn, redact: s.redact + x.redact, block: s.block + x.block }), { warn: 0, redact: 0, block: 0 });
      return { days, total, people: persons, departments: [...depts.values()] };
    });
  }
}
