import { HttpException, HttpStatus } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { appendToOutbox, getRequestContext, newId, withTransaction } from "@workspace/shared";
import { ServiceCallError } from "@workspace/service-kit";
import { ProviderError } from "./gateway.js";
import { bumpHourlyStats } from "./hourly-stats.js";

/**
 * What company AI may cost, and what it did cost (Admin › Kết nối AI › Hạn mức; Công việc › AI).
 *
 * Admins set monthly limits in tokens and/or USD for the whole workspace, a department or one person. Before
 * every model call meteredGenerate asks `assertBudget`; a call that would start past a limit is refused with
 * BudgetExceeded (HTTP 429 `ai_budget_exceeded`). After the call `recordUsage` logs it and warns once per
 * month at 80% and 100% of each budget (Home notifications through `ai.quota.threshold_reached.v1`).
 * Without any budget nothing is limited, and the check costs one indexed lookup.
 *
 * Cost comes from the prices admins enter per connection and model (ai_model_prices, read through the
 * ai_usage_costed view): unpriced hosted usage has no cost rather than a guessed one.
 */

export type BudgetScope = "workspace" | "department" | "person";
export const SCOPES: readonly BudgetScope[] = ["workspace", "department", "person"];
const THRESHOLDS = [80, 100] as const;

export interface Budget {
  scope: BudgetScope;
  scopeId: string;
  monthlyTokens: number | null;
  monthlyUsd: number | null;
}
export interface Spend {
  tokens: number;
  usd: number;
}
export interface Price {
  inputPerMTok: number;
  outputPerMTok: number;
}

export class BudgetExceeded extends Error {
  override name = "BudgetExceeded";
  constructor(
    readonly scope: BudgetScope,
    readonly scopeId: string,
    readonly unit: "tokens" | "usd",
    readonly used: number,
    readonly limit: number,
  ) {
    super(`monthly AI budget used up (${scope})`);
  }
}

/** The month budgets count in ('YYYY-MM', UTC like the database's date_trunc('month', now())). */
const period = (d = new Date()) => d.toISOString().slice(0, 7);

/** USD for one call at a price per 1M tokens. */
export const costUsd = (inputTokens: number, outputTokens: number, p: Price) => (inputTokens * p.inputPerMTok + outputTokens * p.outputPerMTok) / 1_000_000;

/** How full a budget is, in percent: the fuller of its token and USD limits. */
export function percentUsed(b: Budget, s: Spend): number {
  const parts = [b.monthlyTokens ? (s.tokens / b.monthlyTokens) * 100 : 0, b.monthlyUsd ? (s.usd / b.monthlyUsd) * 100 : 0];
  return Math.max(...parts);
}

/** The first budget a new call would break (person first: the most specific answer), else null. */
export function firstExceeded(budgets: Budget[], spendOf: (b: Budget) => Spend): BudgetExceeded | null {
  const order: Record<BudgetScope, number> = { person: 0, department: 1, workspace: 2 };
  for (const b of [...budgets].sort((x, y) => order[x.scope] - order[y.scope])) {
    const s = spendOf(b);
    if (b.monthlyTokens !== null && s.tokens >= b.monthlyTokens) return new BudgetExceeded(b.scope, b.scopeId, "tokens", s.tokens, b.monthlyTokens);
    if (b.monthlyUsd !== null && s.usd >= b.monthlyUsd) return new BudgetExceeded(b.scope, b.scopeId, "usd", round(s.usd), b.monthlyUsd);
  }
  return null;
}

/** Thresholds a budget has reached (each one is announced once per month; the alert table dedups). */
export const reached = (b: Budget, s: Spend) => THRESHOLDS.filter((t) => percentUsed(b, s) >= t);

const round = (n: number) => Math.round(n * 10_000) / 10_000;

interface BudgetRow {
  scope: BudgetScope;
  scope_id: string;
  monthly_tokens: string | null;
  monthly_usd: string | null;
}
const toBudget = (r: BudgetRow): Budget => ({
  scope: r.scope,
  scopeId: r.scope_id,
  monthlyTokens: r.monthly_tokens === null ? null : Number(r.monthly_tokens),
  monthlyUsd: r.monthly_usd === null ? null : Number(r.monthly_usd),
});

/** The budgets that apply to one person: theirs, their department's and the workspace's. */
async function budgetsFor(c: PoolClient, userId: string, departmentId: string | null): Promise<Budget[]> {
  const r = await c.query<BudgetRow>(
    `SELECT scope, scope_id, monthly_tokens, monthly_usd FROM ai_budgets
      WHERE scope = 'workspace' OR (scope = 'person' AND scope_id = $1) OR (scope = 'department' AND scope_id = $2)`,
    [userId, departmentId ?? ""],
  );
  return r.rows.map(toBudget);
}

/**
 * This month's spend per budget: three rows of `ai_spend_month` (workspace, this person, their department), kept
 * by `recordUsage`, instead of summing the month's usage on every call.
 */
async function spendFor(c: PoolClient, _budgets: Budget[], userId: string, departmentId: string | null): Promise<(b: Budget) => Spend> {
  const r = (
    await c.query<{ scope: string; tokens: string; usd: string }>(
      `SELECT scope, tokens::text, cost_usd::text AS usd FROM ai_spend_month
        WHERE month = date_trunc('month', now())::date
          AND ((scope = 'workspace') OR (scope = 'person' AND scope_id = $1) OR (scope = 'department' AND scope_id = $2))`,
      [userId, departmentId ?? ""],
    )
  ).rows;
  const by = new Map(r.map((x) => [x.scope, { tokens: Number(x.tokens), usd: Number(x.usd) }]));
  const none = { tokens: 0, usd: 0 };
  return (b) => by.get(b.scope) ?? none;
}

/** Adds one call to the month's running totals (workspace, person, department) that `spendFor` reads. */
async function addSpend(c: PoolClient, usageId: string, userId: string, departmentId: string | null, tokens: number) {
  const cost = (await c.query<{ cost: string | null }>("SELECT cost_usd::text AS cost FROM ai_usage_costed WHERE id = $1", [usageId])).rows[0]?.cost;
  const scopes: [string, string][] = [["workspace", ""], ["person", userId], ...(departmentId ? [["department", departmentId] as [string, string]] : [])];
  await c.query(
    `INSERT INTO ai_spend_month (month, scope, scope_id, tokens, cost_usd)
     SELECT date_trunc('month', now())::date, s.scope, s.scope_id, $3, $4 FROM unnest($1::text[], $2::text[]) AS s(scope, scope_id)
     ON CONFLICT (month, scope, scope_id) DO UPDATE SET tokens = ai_spend_month.tokens + EXCLUDED.tokens, cost_usd = ai_spend_month.cost_usd + EXCLUDED.cost_usd`,
    [scopes.map((s) => s[0]), scopes.map((s) => s[1]), tokens, Number(cost ?? 0)],
  );
}

/** Refuses a call that would start past any budget of this person, their department or the workspace. */
export async function assertBudget(pool: Pool, who: { userId: string; departmentId: string | null }): Promise<void> {
  await withTransaction(pool, async (c) => {
    const budgets = await budgetsFor(c, who.userId, who.departmentId);
    if (!budgets.length) return;
    const over = firstExceeded(budgets, await spendFor(c, budgets, who.userId, who.departmentId));
    if (over) throw over;
  });
}

export interface UsageRecord {
  userId: string;
  agentId: string | null;
  feature: string;
  model: string;
  provider: string | null;
  departmentId: string | null;
  subject: { type: string; id: string } | null;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Logs one call, then announces any budget threshold it crossed (once per budget, month and threshold). A call
 * on a known piece of work (a task, a document…) also emits `ai.usage.recorded.v1`, so the work module can tell
 * which tasks were done with AI's help (ADR 0011).
 */
export async function recordUsage(pool: Pool, u: UsageRecord, admins: () => Promise<string[]>): Promise<void> {
  const { actorId } = getRequestContext();
  const id = newId();
  const crossed = await withTransaction(pool, async (c) => {
    const { at } = (
      await c.query<{ at: Date }>(
        `INSERT INTO ai_usage (id, user_id, agent_id, feature, model, provider, department_id, subject_type, subject_id, input_tokens, output_tokens)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING at`,
        [id, u.userId, u.agentId, u.feature, u.model, u.provider, u.departmentId, u.subject?.type ?? null, u.subject?.id ?? null, u.inputTokens, u.outputTokens],
      )
    ).rows[0]!;
    if (u.subject)
      await appendToOutbox(c, {
        eventId: newId(),
        eventType: "ai.usage.recorded.v1",
        version: 1,
        aggregateType: "ai.usage",
        aggregateId: id,
        actorId,
        occurredAt: new Date().toISOString(),
        payload: {
          usageId: id,
          userId: u.userId,
          feature: u.feature,
          subjectType: u.subject.type,
          subjectId: u.subject.id,
          tokens: u.inputTokens + u.outputTokens,
          // The database's time, like the task's completed_at it is compared with (no app-server clock skew).
          at: at.toISOString(),
          source: "app",
        },
      });
    await addSpend(c, id, u.userId, u.departmentId, u.inputTokens + u.outputTokens);
    await bumpHourlyStats(c, {
      call: { userId: u.userId, feature: u.feature, provider: u.provider, model: u.model, inputTokens: u.inputTokens, outputTokens: u.outputTokens, at },
    });
    const budgets = await budgetsFor(c, u.userId, u.departmentId);
    if (!budgets.length) return [];
    const spend = await spendFor(c, budgets, u.userId, u.departmentId);
    const out: { budget: Budget; threshold: number; pct: number }[] = [];
    for (const b of budgets)
      for (const t of reached(b, spend(b))) {
        const fresh = await c.query("INSERT INTO ai_budget_alerts (scope, scope_id, period, threshold) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [
          b.scope,
          b.scopeId,
          period(),
          t,
        ]);
        if (fresh.rowCount) out.push({ budget: b, threshold: t, pct: Math.round(percentUsed(b, spend(b))) });
      }
    // 100% supersedes 80% when one call crosses both.
    return out.filter((x) => x.threshold === 100 || !out.some((y) => y.budget === x.budget && y.threshold === 100));
  });
  if (!crossed.length) return;
  const to = await admins().catch(() => [] as string[]);
  await withTransaction(pool, async (c) => {
    for (const x of crossed) {
      // Admins hear about every budget; the person about their own (they are the one who can slow down).
      const audiences: { recipients: string[]; url: string }[] = [{ recipients: to, url: "/admin/workspace/ai" }];
      if (x.budget.scope === "person") audiences.push({ recipients: [x.budget.scopeId].filter((r) => !to.includes(r)), url: "/app/ai/ask" });
      for (const a of audiences.filter((a) => a.recipients.length))
        await appendToOutbox(c, {
          eventId: newId(),
          eventType: "ai.quota.threshold_reached.v1",
          version: 1,
          aggregateType: "ai.quota",
          aggregateId: `${x.budget.scope}:${x.budget.scopeId || "workspace"}`,
          actorId,
          occurredAt: new Date().toISOString(),
          payload: { threshold: x.threshold, period: period(), scope: x.budget.scope, scopeId: x.budget.scopeId, recipients: a.recipients, url: a.url },
        });
    }
  });
}

// ---------------------------------------------------------------- admin reads and writes

export interface BudgetView extends Budget {
  spend: Spend;
  percent: number;
}

/**
 * Every budget with this month's spend (Admin › Kết nối AI › Hạn mức), from the running totals in `ai_spend_month`
 * (one row per scope, kept by `recordUsage`) rather than the month's usage rows: `GET spend/me` shows this on every
 * assistant page.
 */
export async function listBudgets(c: PoolClient): Promise<BudgetView[]> {
  const rows = (
    await c.query<BudgetRow & { tokens: string; usd: string }>(
      `SELECT b.scope, b.scope_id, b.monthly_tokens, b.monthly_usd, coalesce(m.tokens, 0)::text AS tokens, coalesce(m.cost_usd, 0)::text AS usd
         FROM ai_budgets b
         LEFT JOIN ai_spend_month m ON m.scope = b.scope AND m.scope_id = b.scope_id
                                    AND m.month = date_trunc('month', now())::date
        ORDER BY array_position(ARRAY['workspace','department','person'], b.scope), b.scope_id`,
    )
  ).rows;
  return rows.map((r) => {
    const b = toBudget(r);
    const spend = { tokens: Number(r.tokens), usd: round(Number(r.usd)) };
    return { ...b, spend, percent: Math.round(percentUsed(b, spend)) };
  });
}

export async function setBudget(c: PoolClient, b: Budget, by: string): Promise<void> {
  await c.query(
    `INSERT INTO ai_budgets (scope, scope_id, monthly_tokens, monthly_usd, updated_by) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (scope, scope_id) DO UPDATE SET monthly_tokens = EXCLUDED.monthly_tokens, monthly_usd = EXCLUDED.monthly_usd,
       updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [b.scope, b.scopeId, b.monthlyTokens, b.monthlyUsd, by],
  );
  // A raised limit may warn again this month.
  await c.query("DELETE FROM ai_budget_alerts WHERE scope = $1 AND scope_id = $2 AND period = $3", [b.scope, b.scopeId, period()]);
}

/** The HTTP answer for a refused call: 429 with what ran out, so the web can say whose limit it was and until when. */
export function budgetHttpError(e: BudgetExceeded): HttpException {
  const next = new Date();
  next.setUTCMonth(next.getUTCMonth() + 1, 1);
  next.setUTCHours(0, 0, 0, 0);
  return new HttpException(
    { error: "ai_budget_exceeded", message: e.message, scope: e.scope, unit: e.unit, used: e.used, limit: e.limit, resetsAt: next.toISOString() },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

/**
 * Runs an AI action on a user's request: a refused budget becomes its 429, and a task or board the user may not read
 * (the owning module answers 404 or 403) a plain 404.
 */
/**
 * The model did not answer (its computer is not connected, the provider is down or timed out): a 503 the screen shows
 * as "could not answer, try again", not a server fault in the log.
 */
export const aiDown = (e: unknown): unknown =>
  e instanceof ProviderError && e.status !== 400 ? new HttpException({ error: "ai_unavailable", message: e.message.slice(0, 300) }, 503) : e;

export function guardAi<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((e) => {
    if (e instanceof BudgetExceeded) throw budgetHttpError(e);
    if (e instanceof ServiceCallError && (e.status === 404 || e.status === 403)) throw new HttpException({ error: "not_found" }, 404);
    throw aiDown(e);
  });
}
