import { Controller, ForbiddenException, Get, Inject, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { withTransaction, workspaceTimeZone, WORKSPACE_TZ_SQL } from "@workspace/shared";
import { requirePrincipal } from "@workspace/service-kit";
import { DEPS } from "./ai.controller.js";
import { aiAudience, type Person } from "./audience.js";
import { helpfulScore } from "./capability.js";
import { HOURLY_COST, HOURLY_COST_JOIN, HOURLY_UNPRICED } from "./hourly-stats.js";
import { DEMO_DEVICES, today } from "./local-usage.js";
import { dayRange, priceOf } from "./local-usage-report.js";
import { aiWindow, AUTOMATIC_FEATURES, usesAi, workTokens } from "./metrics.js";
import type { Deps } from "./runtime.js";

/**
 * AI › Áp dụng AI › Tổng quan, the owner's three questions in one read: what AI costs and where the tokens go, and how
 * each person uses it. One profile per person in the caller's AI audience (admins everyone, managers their reporting
 * line, anyone else only themselves): how much they use AI and with which tools, for what kind of work, whether they
 * say it helps, their tokens and cost, a day-by-day strip and the change against the window before. From those counts
 * a rule names the person's pattern, so the page can say "uses AI every day, mostly for code, and says it helps"
 * with no model. It reads counts and the person's own one-tap ratings, never conversation text.
 */

/** Uses a week from which someone is a regular, and a heavy, user (the same 3 a week Usage compares on). */
const REGULAR_PER_WEEK = 3;
const POWER_PER_WEEK = 10;
/** Ratings a personal helpful rate needs before it is shown or judged. */
const MIN_RATED = 3;
/** A change against the window before counts as up or down beyond this share. */
const TREND = 0.25;

export type Pattern = "power" | "regular" | "light" | "new" | "lapsed" | "none";

/** One (person, day) of use: prompts to any assistant and the app's own AI actions the person ran. */
export interface UseDay {
  userId: string;
  day: string;
  prompts: number;
  calls: number;
}
export interface ConvRow {
  userId: string;
  source: string;
  topic: string;
  conversations: number;
  prompts: number;
  rated: number;
  yes: number;
  partly: number;
  flagged: number;
  tasks: number;
}
export interface CompanyRow {
  userId: string;
  feature: string;
  calls: number;
  tokens: number;
  costUsd: number;
  unpriced: number;
}
export interface LocalRow {
  userId: string;
  tool: string;
  tokens: number;
  listValueUsd: number;
}

const top = (r: Map<string, number>, n: number) =>
  [...r.entries()]
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([key, count]) => ({ key, count }));
const bump = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

/** The pattern a person's counts add up to. `uses`/`prevUses` are prompts plus the app's AI actions they ran. */
export function patternOf(uses: number, prevUses: number, days: number): Pattern {
  if (!uses) return prevUses ? "lapsed" : "none";
  const perWeek = uses / (days / 7);
  if (perWeek >= POWER_PER_WEEK) return "power";
  if (perWeek >= REGULAR_PER_WEEK) return "regular";
  return prevUses ? "light" : "new";
}

/**
 * The profiles and the roll-ups from the window's rows. `range` is the window's days (YYYY-MM-DD, oldest first);
 * `prev` is each person's uses in the window before. Automatic model calls (briefs, topic tagging) cost money, so they
 * are in `company` for tokens and cost, but they are never someone using AI: `useDays` leaves them out.
 */
export function buildProfiles(people: Person[], range: string[], useDays: UseDay[], prev: Map<string, number>, conv: ConvRow[], company: CompanyRow[], local: LocalRow[]) {
  const days = range.length;
  // The strip: a cell per day up to 30 days, per week beyond (13 cells for 90 days).
  const cell = days > 30 ? 7 : 1;
  const cells = Math.ceil(days / cell);
  const at = new Map(range.map((d, i) => [d, Math.min(cells - 1, Math.floor(i / cell))]));
  const automatic = new Set<string>(AUTOMATIC_FEATURES);

  const profiles = people.map((x) => {
    const spark = Array<number>(cells).fill(0);
    let prompts = 0;
    let calls = 0;
    const active = new Set<string>();
    for (const u of useDays) {
      if (u.userId !== x.userId || !at.has(u.day)) continue;
      const n = u.prompts + u.calls;
      if (!n) continue;
      spark[at.get(u.day)!]! += n;
      prompts += u.prompts;
      calls += u.calls;
      active.add(u.day);
    }
    const sources = new Map<string, number>();
    const topics = new Map<string, number>();
    const c = { conversations: 0, rated: 0, yes: 0, partly: 0, flagged: 0, tasks: 0 };
    for (const r of conv) {
      if (r.userId !== x.userId) continue;
      bump(sources, r.source, r.prompts);
      bump(topics, r.topic, r.prompts);
      c.conversations += r.conversations;
      c.rated += r.rated;
      c.yes += r.yes;
      c.partly += r.partly;
      c.flagged += r.flagged;
      c.tasks += r.tasks;
    }
    const features = new Map<string, number>();
    let companyTokens = 0;
    let costUsd = 0;
    let unpriced = 0;
    for (const r of company) {
      if (r.userId !== x.userId) continue;
      companyTokens += r.tokens;
      costUsd += r.costUsd;
      unpriced += r.unpriced;
      if (r.feature !== "assistant" && !automatic.has(r.feature)) bump(features, r.feature, r.calls);
    }
    const tools = new Map<string, number>();
    let localTokens = 0;
    let listValueUsd = 0;
    for (const r of local) {
      if (r.userId !== x.userId) continue;
      bump(tools, r.tool, r.tokens);
      localTokens += r.tokens;
      listValueUsd += r.listValueUsd;
    }
    const uses = prompts + calls;
    const prevUses = prev.get(x.userId) ?? 0;
    const helpful = c.rated >= MIN_RATED ? round(helpfulScore(c) ?? 0, 2) : null;
    const change = prevUses ? (uses - prevUses) / prevUses : null;
    return {
      userId: x.userId,
      displayName: x.displayName,
      title: x.title ?? null,
      department: x.department ?? null,
      // A coding agent on the person's computer is AI use too, even with no prompt recorded in the app.
      pattern: !uses && localTokens ? ("regular" as Pattern) : patternOf(uses, prevUses, days),
      trend: change === null ? null : change > TREND ? ("up" as const) : change < -TREND ? ("down" as const) : ("flat" as const),
      uses,
      prevUses,
      prompts,
      inAppCalls: calls,
      conversations: c.conversations,
      activeDays: active.size,
      spark,
      sources: top(sources, 3),
      topics: top(new Map([...topics].filter(([k]) => k !== "other")), 3),
      features: top(features, 2),
      tools: top(tools, 2),
      tokens: companyTokens + localTokens,
      companyTokens,
      localTokens,
      costUsd: round(costUsd),
      listValueUsd: round(listValueUsd),
      unpricedTokens: unpriced,
      rated: c.rated,
      helpful,
      aiTasks: c.tasks,
      flagged: c.flagged,
      /** Worth a word with the person: sensitive data went out, or they keep saying AI does not help. */
      attention: c.flagged > 0 ? ("sensitive" as const) : helpful !== null && helpful < 0.5 ? ("unhelpful" as const) : null,
    };
  });

  const order: Record<Pattern, number> = { power: 0, regular: 1, light: 2, new: 3, lapsed: 4, none: 5 };
  profiles.sort((a, b) => order[a.pattern] - order[b.pattern] || b.uses - a.uses || b.tokens - a.tokens || a.displayName.localeCompare(b.displayName));

  const using = (x: (typeof profiles)[number]) => usesAi({ prompts: x.prompts, inAppCalls: x.inAppCalls }) || x.localTokens > 0;
  const departments = new Map<
    string,
    { name: string | null; people: number; using: number; uses: number; tokens: number; costUsd: number; rated: number; yes: number; partly: number }
  >();
  const rate = new Map<string, { rated: number; yes: number; partly: number }>();
  for (const r of conv) {
    const k = rate.get(r.userId) ?? { rated: 0, yes: 0, partly: 0 };
    k.rated += r.rated;
    k.yes += r.yes;
    k.partly += r.partly;
    rate.set(r.userId, k);
  }
  for (const x of profiles) {
    const d = departments.get(x.department ?? "") ?? { name: x.department, people: 0, using: 0, uses: 0, tokens: 0, costUsd: 0, rated: 0, yes: 0, partly: 0 };
    d.people++;
    if (using(x)) d.using++;
    d.uses += x.uses;
    d.tokens += x.tokens;
    d.costUsd += x.costUsd;
    const k = rate.get(x.userId);
    if (k) {
      d.rated += k.rated;
      d.yes += k.yes;
      d.partly += k.partly;
    }
    departments.set(x.department ?? "", d);
  }
  const features = new Map<string, { feature: string; calls: number; tokens: number; costUsd: number; people: Set<string> }>();
  const ids = new Set(people.map((x) => x.userId));
  for (const r of company) {
    if (!ids.has(r.userId)) continue;
    const f = features.get(r.feature) ?? { feature: r.feature, calls: 0, tokens: 0, costUsd: 0, people: new Set<string>() };
    f.calls += r.calls;
    f.tokens += r.tokens;
    f.costUsd += r.costUsd;
    f.people.add(r.userId);
    features.set(r.feature, f);
  }
  const all = [...rate.entries()]
    .filter(([u]) => ids.has(u))
    .reduce((a, [, k]) => ({ rated: a.rated + k.rated, yes: a.yes + k.yes, partly: a.partly + k.partly }), { rated: 0, yes: 0, partly: 0 });
  const sum = (f: (x: (typeof profiles)[number]) => number) => profiles.reduce((n, x) => n + f(x), 0);
  const outside = conv.filter((r) => ids.has(r.userId) && r.source !== "company").reduce((n, r) => n + r.prompts, 0);
  const counts = Object.fromEntries(
    (["power", "regular", "light", "new", "lapsed", "none"] as Pattern[]).map((k) => [k, profiles.filter((x) => x.pattern === k).length]),
  ) as Record<Pattern, number>;
  return {
    totals: {
      people: profiles.length,
      using: profiles.filter(using).length,
      patterns: counts,
      uses: sum((x) => x.uses),
      prevUses: sum((x) => x.prevUses),
      prompts: sum((x) => x.prompts),
      /** Prompts sent to assistants outside the company's (ChatGPT, Claude, Gemini… through the extension): not billed here. */
      outsidePrompts: outside,
      inAppCalls: sum((x) => x.inAppCalls),
      companyTokens: sum((x) => x.companyTokens),
      localTokens: sum((x) => x.localTokens),
      costUsd: round(sum((x) => x.costUsd)),
      listValueUsd: round(sum((x) => x.listValueUsd)),
      unpricedTokens: sum((x) => x.unpricedTokens),
      rated: all.rated,
      helpful: all.rated >= MIN_RATED ? round(helpfulScore(all) ?? 0, 2) : null,
      aiTasks: sum((x) => x.aiTasks),
      flagged: sum((x) => x.flagged),
      attention: profiles.filter((x) => x.attention).length,
    },
    departments: [...departments.values()]
      .map(({ rated, yes, partly, ...d }) => ({ ...d, costUsd: round(d.costUsd), helpful: rated >= MIN_RATED ? round(helpfulScore({ rated, yes, partly }) ?? 0, 2) : null }))
      .sort((a, b) => Number(a.name === null) - Number(b.name === null) || b.tokens - a.tokens || b.people - a.people),
    features: [...features.values()]
      .map((f) => ({ feature: f.feature, calls: f.calls, tokens: f.tokens, costUsd: round(f.costUsd), people: f.people.size }))
      .sort((a, b) => b.tokens - a.tokens),
    people: profiles,
  };
}

@Controller()
export class AdoptionPeopleController {
  constructor(@Inject(DEPS) private readonly d: Deps) {}

  @Get("adoption/people")
  async people(@Req() req: Request, @Query("days") daysQ?: string) {
    const p = requirePrincipal(req);
    if (p.type !== "user") throw new ForbiddenException("people only");
    const days = aiWindow(daysQ);
    // Admins and managers see their audience; anyone else their own profile, never a refusal.
    let scope: "team" | "me" = "team";
    let people: Person[];
    try {
      people = (await aiAudience(this.d, p)).people;
    } catch (e) {
      if (!(e instanceof ForbiddenException)) throw e;
      scope = "me";
      const dir = await this.d.services.employee.request<{ employees: Person[] }>("GET", "/employees?all=1", undefined, p).catch(() => ({ employees: [] as Person[] }));
      people = [dir.employees.find((x) => x.userId === p.id) ?? { userId: p.id, displayName: "" }];
    }
    const ids = people.map((x) => x.userId);
    const automatic = ["assistant", ...AUTOMATIC_FEATURES].map((f) => `'${f}'`).join(", ");
    return withTransaction(this.d.pool, async (c) => {
      const tz = await workspaceTimeZone(c);
      const end = today(tz);
      const all = dayRange(days * 2, end);
      const range = all.slice(days);
      const from = all[0]!;
      const mid = range[0]!;
      // The window as whole days in the workspace's zone, and the window before it for the change.
      const window = `s.hour >= ($2::date::timestamp AT TIME ZONE ${WORKSPACE_TZ_SQL}) AND s.hour < (($3::date + 1)::timestamp AT TIME ZONE ${WORKSPACE_TZ_SQL})`;
      const use = (
        await c.query<{ user_id: string; day: string; prompts: number; calls: number }>(
          `SELECT s.user_id, to_char((s.hour AT TIME ZONE ${WORKSPACE_TZ_SQL})::date, 'YYYY-MM-DD') AS day,
                  coalesce(sum(s.prompts) FILTER (WHERE s.feature = ''), 0)::int AS prompts,
                  coalesce(sum(s.calls) FILTER (WHERE s.feature <> '' AND s.feature NOT IN (${automatic})), 0)::int AS calls
             FROM ai_hourly_stats s WHERE s.user_id = ANY($1::text[]) AND ${window} GROUP BY 1, 2`,
          [ids, from, end],
        )
      ).rows;
      const prev = new Map<string, number>();
      for (const r of use) if (r.day < mid) prev.set(r.user_id, (prev.get(r.user_id) ?? 0) + r.prompts + r.calls);
      const conv = (
        await c.query<ConvRow>(
          `SELECT user_id AS "userId", source, topic, count(*)::int AS conversations, coalesce(sum(messages), 0)::int AS prompts, count(helpful)::int AS rated,
                  count(*) FILTER (WHERE helpful = 'yes')::int AS yes, count(*) FILTER (WHERE helpful = 'partly')::int AS partly,
                  count(*) FILTER (WHERE cardinality(sensitive) > 0)::int AS flagged, count(DISTINCT task_id)::int AS tasks
             FROM ai_conversations
            WHERE user_id = ANY($1::text[]) AND source <> 'import' AND last_at >= ($2::date::timestamp AT TIME ZONE ${WORKSPACE_TZ_SQL})
            GROUP BY user_id, source, topic`,
          [ids, mid],
        )
      ).rows;
      const company = (
        await c.query<CompanyRow>(
          `SELECT s.user_id AS "userId", s.feature, sum(s.calls)::int AS calls, sum(s.input_tokens + s.output_tokens)::bigint::float AS tokens,
                  coalesce(sum(${HOURLY_COST}), 0)::float AS "costUsd", coalesce(sum(${HOURLY_UNPRICED}), 0)::bigint::float AS unpriced
             FROM ai_hourly_stats s ${HOURLY_COST_JOIN}
            WHERE s.feature <> '' AND s.user_id = ANY($1::text[]) AND ${window} GROUP BY s.user_id, s.feature`,
          [ids, mid, end],
        )
      ).rows;
      const prices = (
        await c.query<{ model: string; input: string; output: string }>("SELECT model, input_per_mtok AS input, output_per_mtok AS output FROM ai_model_prices")
      ).rows.map((x) => ({ model: x.model, input: Number(x.input), output: Number(x.output) }));
      const local = (
        await c.query<{ user_id: string; tool: string; model: string; i: string; o: string; cr: string; cw: string }>(
          `SELECT user_id, tool, model, sum(input_tokens) AS i, sum(output_tokens) AS o, sum(cache_read_tokens) AS cr, sum(cache_write_tokens) AS cw
             FROM ai_local_usage u WHERE user_id = ANY($1::text[]) AND day >= $2::date AND day <= $3::date AND ${DEMO_DEVICES}
            GROUP BY user_id, tool, model`,
          [ids, mid, end],
        )
      ).rows.map((r): LocalRow => {
        const t = { input: Number(r.i), output: Number(r.o), cacheRead: Number(r.cr), cacheWrite: Number(r.cw) };
        const price = priceOf(r.model, prices);
        return {
          userId: r.user_id,
          tool: r.tool,
          tokens: workTokens(t),
          listValueUsd: price ? (t.input * price.input + t.output * price.output + t.cacheRead * price.cacheRead + t.cacheWrite * price.cacheWrite) / 1e6 : 0,
        };
      });
      // What the company AI cost in the window before, for "up or down on last period".
      const prevCost = (
        await c.query<{ cost: number }>(
          `SELECT coalesce(sum(${HOURLY_COST}), 0)::float AS cost FROM ai_hourly_stats s ${HOURLY_COST_JOIN}
            WHERE s.feature <> '' AND s.user_id = ANY($1::text[]) AND s.hour >= ($2::date::timestamp AT TIME ZONE ${WORKSPACE_TZ_SQL})
              AND s.hour < ($3::date::timestamp AT TIME ZONE ${WORKSPACE_TZ_SQL})`,
          [ids, from, mid],
        )
      ).rows[0]!.cost;
      const r = buildProfiles(
        people,
        range,
        use.filter((x) => x.day >= mid).map((x) => ({ userId: x.user_id, day: x.day, prompts: x.prompts, calls: x.calls })),
        prev,
        conv,
        company,
        local,
      );
      return { days, scope, from: mid, to: end, ...r, totals: { ...r.totals, prevCostUsd: Math.round(prevCost * 1e4) / 1e4 } };
    });
  }
}
