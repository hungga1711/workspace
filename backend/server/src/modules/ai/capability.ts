import { Controller, Get, Inject, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { withTransaction } from "@workspace/shared";
import { requirePrincipal } from "@workspace/service-kit";
import { DEPS } from "./ai.controller.js";
import { aiAudience, type Person } from "./audience.js";
import type { Deps } from "./runtime.js";

/**
 * The capability map: per department, who uses AI often and whose conversations they themselves rate as helpful,
 * so a manager can ask them to show colleagues how. It reads counts and the person's own one-tap ratings, never
 * conversation text; managers see their reporting line, admins everyone (as in Công việc › AI).
 */

export interface UseStats {
  userId: string;
  conversations: number;
  prompts: number;
  rated: number;
  yes: number;
  partly: number;
}

/** From these, someone can be suggested as a mentor: enough use in the window and enough ratings to trust. */
const MENTOR = { minPrompts: 10, minRated: 3, minScore: 0.7, perDepartment: 2 } as const;

/** Helpful share of the conversations the person rated: "yes" counts 1, "partly" a half. */
export const helpfulScore = (s: Pick<UseStats, "rated" | "yes" | "partly">) => (s.rated ? (s.yes + s.partly / 2) / s.rated : null);

export function capabilityMap(people: Person[], stats: UseStats[]) {
  const byUser = new Map(stats.map((s) => [s.userId, s]));
  const row = (p: Person, s: UseStats) => ({
    userId: p.userId,
    displayName: p.displayName,
    title: p.title ?? null,
    conversations: s.conversations,
    prompts: s.prompts,
    rated: s.rated,
    score: helpfulScore(s),
    mentor: false,
  });
  const departments = new Map<string, { name: string | null; people: number; active: number; rows: ReturnType<typeof row>[] }>();
  for (const p of people) {
    const key = p.department ?? "";
    const d = departments.get(key) ?? { name: p.department ?? null, people: 0, active: 0, rows: [] };
    d.people++;
    const s = byUser.get(p.userId);
    if (s && s.prompts > 0) {
      d.active++;
      d.rows.push(row(p, s));
    }
    departments.set(key, d);
  }
  return [...departments.values()]
    .map((d) => {
      // Rank by rated helpfulness weighted by how much the person uses AI: a careful heavy user first.
      const ranked = d.rows.sort((a, b) => weight(b) - weight(a) || b.prompts - a.prompts || a.displayName.localeCompare(b.displayName));
      let mentors = 0;
      for (const r of ranked)
        if (mentors < MENTOR.perDepartment && r.prompts >= MENTOR.minPrompts && r.rated >= MENTOR.minRated && (r.score ?? 0) >= MENTOR.minScore) {
          r.mentor = true;
          mentors++;
        }
      return { name: d.name, people: d.people, active: d.active, top: ranked.slice(0, 5) };
    })
    .sort((a, b) => Number(a.name === null) - Number(b.name === null) || b.active - a.active);
}
const weight = (r: { score: number | null; prompts: number }) => (r.score ?? 0.4) * Math.log2(1 + r.prompts);

@Controller()
export class CapabilityController {
  constructor(@Inject(DEPS) private readonly d: Deps) {}

  @Get("insights/capability")
  async capability(@Req() req: Request, @Query("days") daysQ?: string) {
    const p = requirePrincipal(req);
    const days = [30, 90].includes(Number(daysQ)) ? Number(daysQ) : 30;
    const { people } = await aiAudience(this.d, p);
    const stats = await withTransaction(
      this.d.pool,
      async (c) =>
        (
          await c.query<UseStats>(
            `SELECT user_id AS "userId", count(*)::int AS conversations, coalesce(sum(messages), 0)::int AS prompts,
                  count(helpful)::int AS rated, count(*) FILTER (WHERE helpful = 'yes')::int AS yes,
                  count(*) FILTER (WHERE helpful = 'partly')::int AS partly
             FROM ai_conversations WHERE last_at > now() - make_interval(days => $2) AND user_id = ANY($1::text[]) AND source <> 'import'
            GROUP BY user_id`,
            [people.map((x) => x.userId), days],
          )
        ).rows,
    );
    return { days, mentor: MENTOR, departments: capabilityMap(people, stats) };
  }
}
