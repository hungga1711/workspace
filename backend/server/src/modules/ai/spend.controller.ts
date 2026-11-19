import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, Post, Put, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { withTransaction, recordAudit, type Principal } from "@workspace/shared";
import { assertAllowed, requirePrincipal } from "@workspace/service-kit";
import { DEPS } from "./ai.controller.js";
import { departmentOf, type Deps } from "./runtime.js";
import { listBudgets, percentUsed, SCOPES, setBudget } from "./budgets.js";
import { DEFAULTS } from "./gateway.js";
import { CONNECTION_COLS, VENDOR_LABEL, type ConnectionRow } from "./connections.js";
import { connKey } from "./workspace-gateway.js";
import { priceOf } from "./local-usage-report.js";

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const r = schema.safeParse(body);
  if (!r.success) throw new BadRequestException({ error: "invalid", issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
  return r.data;
}

const PriceInput = z.object({
  provider: z.string().min(1).max(64),
  model: z.string().trim().min(1).max(200),
  inputPerMTok: z.number().min(0).max(10_000),
  outputPerMTok: z.number().min(0).max(10_000),
});
const BudgetInput = z
  .object({
    scope: z.enum(SCOPES as [string, ...string[]]),
    scopeId: z.string().max(64).default(""),
    monthlyTokens: z.number().int().positive().max(1e13).nullable().default(null),
    monthlyUsd: z.number().positive().max(1e9).nullable().default(null),
  })
  .refine((b) => b.monthlyTokens !== null || b.monthlyUsd !== null, { message: "set a token or a USD limit", path: ["monthlyTokens"] })
  .refine((b) => (b.scope === "workspace") === (b.scopeId === ""), { message: "workspace budgets have no scopeId; others need one", path: ["scopeId"] });

const ENV_LABELS: Record<string, string> = { openai: "GPT", anthropic: "Claude", gemini: "Gemini" };

/**
 * Admin › Kết nối AI › Chi phí & hạn mức: prices per connection and model (USD per 1M tokens), and monthly
 * budgets for the workspace, a department or a person (budgets.ts). `spend/me` tells anyone how close they are
 * to their own limits.
 */
@Controller()
export class SpendController {
  constructor(@Inject(DEPS) private readonly d: Deps) {}

  private admin(req: Request): Principal {
    const p = requirePrincipal(req);
    assertAllowed(p, "ai.agent.manage");
    return p;
  }

  @Get("spend")
  async overview(@Req() req: Request) {
    this.admin(req);
    const gw = this.d.provider as { providers?: () => string[] };
    const envVendors = (gw.providers?.() ?? []).filter((x) => !x.startsWith("c_"));
    return withTransaction(this.d.pool, async (c) => {
      const conns = (await c.query<ConnectionRow>(`SELECT ${CONNECTION_COLS} FROM ai_connections ORDER BY is_default DESC, created_at`)).rows;
      // Models worth pricing: each connection's configured ones, the env vendors' defaults, and any model that
      // actually answered in the last 90 days (a vendor may answer with a dated name).
      const used = (
        await c.query<{ provider: string; model: string; tokens: string }>(
          `SELECT provider, model, sum(input_tokens + output_tokens)::bigint AS tokens FROM ai_usage
            WHERE at > now() - interval '90 days' AND provider IS NOT NULL AND provider <> 'local' GROUP BY 1, 2`,
        )
      ).rows;
      const models = new Map<string, { provider: string; label: string; model: string; selfhost: boolean; tokens90d: number }>();
      const add = (provider: string, label: string, model: string, selfhost: boolean) => {
        if (model && !models.has(`${provider}:${model}`)) models.set(`${provider}:${model}`, { provider, label, model, selfhost, tokens90d: 0 });
      };
      for (const r of conns) for (const m of [r.model_smart, r.model_fast]) add(connKey(r.id), r.name || VENDOR_LABEL[r.vendor], m, r.mode === "selfhost");
      for (const v of envVendors) for (const m of [DEFAULTS[v]?.smart, DEFAULTS[v]?.fast]) add(v, ENV_LABELS[v] ?? v, m ?? "", false);
      for (const u of used) {
        const conn = conns.find((r) => connKey(r.id) === u.provider);
        if (!models.has(`${u.provider}:${u.model}`))
          add(u.provider, conn ? conn.name || VENDOR_LABEL[conn.vendor] : (ENV_LABELS[u.provider] ?? u.provider), u.model, conn?.mode === "selfhost");
        models.get(`${u.provider}:${u.model}`)!.tokens90d = Number(u.tokens);
      }
      const prices = (
        await c.query<{ provider: string; model: string; inputPerMTok: number; outputPerMTok: number }>(
          `SELECT provider, model, input_per_mtok::float AS "inputPerMTok", output_per_mtok::float AS "outputPerMTok" FROM ai_model_prices ORDER BY provider, model`,
        )
      ).rows;
      return { models: [...models.values()], prices, budgets: await listBudgets(c) };
    });
  }

  /**
   * What these models cost per million tokens, for a page that has token counts of its own (AI › Workflows ›
   * Performance, work/workflows/insights.ts): the company's price when an admin entered one, else the public list
   * price, else null. Null means "not known", never free.
   */
  @Post("spend/quote")
  @HttpCode(200)
  async quote(@Req() req: Request, @Body() body: unknown) {
    assertAllowed(requirePrincipal(req), "task.read");
    const b = parse(z.object({ models: z.array(z.string().trim().min(1).max(200)).max(200) }), body);
    const company = await withTransaction(
      this.d.pool,
      async (c) =>
        (await c.query<{ model: string; input: number; output: number }>("SELECT model, input_per_mtok::float AS input, output_per_mtok::float AS output FROM ai_model_prices"))
          .rows,
    );
    return {
      prices: Object.fromEntries(
        [...new Set(b.models)].map((m) => {
          const own = company.some((x) => x.model.toLowerCase() === m.toLowerCase());
          const price = priceOf(m, company);
          return [m, price ? { inputPerMTok: price.input, outputPerMTok: price.output, source: own ? "company" : "list" } : null];
        }),
      ),
    };
  }

  @Put("spend/prices")
  async setPrice(@Req() req: Request, @Body() body: unknown) {
    const p = this.admin(req);
    const b = parse(PriceInput, body);
    await withTransaction(this.d.pool, async (c) => {
      await c.query(
        `INSERT INTO ai_model_prices (provider, model, input_per_mtok, output_per_mtok, updated_by) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (provider, model) DO UPDATE SET input_per_mtok = EXCLUDED.input_per_mtok, output_per_mtok = EXCLUDED.output_per_mtok,
           updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [b.provider, b.model, b.inputPerMTok, b.outputPerMTok, p.id],
      );
      await recordAudit(c, {
        action: "ai.spend.prices_set",
        targetType: "ai_model",
        targetId: `${b.provider}/${b.model}`.slice(0, 200),
        targetLabel: b.model,
        meta: { inputPerMTok: b.inputPerMTok, outputPerMTok: b.outputPerMTok },
      });
    });
    return { ok: true };
  }

  @Delete("spend/prices")
  @HttpCode(200)
  async deletePrice(@Req() req: Request, @Query("provider") provider = "", @Query("model") model = "") {
    this.admin(req);
    await withTransaction(this.d.pool, async (c) => {
      const r = await c.query("DELETE FROM ai_model_prices WHERE provider = $1 AND model = $2", [provider, model]);
      if (r.rowCount) await recordAudit(c, { action: "ai.spend.prices_cleared", targetType: "ai_model", targetId: `${provider}/${model}`.slice(0, 200), targetLabel: model });
    });
    return { ok: true };
  }

  @Put("spend/budgets")
  async putBudget(@Req() req: Request, @Body() body: unknown) {
    const p = this.admin(req);
    const b = parse(BudgetInput, body);
    await withTransaction(this.d.pool, async (c) => {
      await setBudget(c, { scope: b.scope as (typeof SCOPES)[number], scopeId: b.scopeId, monthlyTokens: b.monthlyTokens, monthlyUsd: b.monthlyUsd }, p.id);
      await recordAudit(c, {
        action: "ai.spend.budget_set",
        targetType: "ai_budget",
        targetId: `${b.scope}:${b.scopeId || "workspace"}`.slice(0, 200),
        meta: { scope: b.scope, scopeId: b.scopeId, monthlyTokens: b.monthlyTokens, monthlyUsd: b.monthlyUsd },
      });
    });
    return { ok: true };
  }

  @Delete("spend/budgets")
  @HttpCode(200)
  async deleteBudget(@Req() req: Request, @Query("scope") scope = "", @Query("scopeId") scopeId = "") {
    this.admin(req);
    await withTransaction(this.d.pool, async (c) => {
      const r = await c.query("DELETE FROM ai_budgets WHERE scope = $1 AND scope_id = $2", [scope, scopeId]);
      if (r.rowCount)
        await recordAudit(c, {
          action: "ai.spend.budget_removed",
          targetType: "ai_budget",
          targetId: `${scope}:${scopeId || "workspace"}`.slice(0, 200),
          meta: { scope, scopeId },
        });
    });
    return { ok: true };
  }

  /** The caller's own limits this month (Trợ lý AI shows a notice from 80%). Never other people's numbers. */
  @Get("spend/me")
  async mine(@Req() req: Request) {
    const p = requirePrincipal(req);
    assertAllowed(p, "ai.use");
    const departmentId = await departmentOf(this.d, p);
    return withTransaction(this.d.pool, async (c) => {
      const mine = (await listBudgets(c)).filter(
        (b) => b.scope === "workspace" || (b.scope === "person" && b.scopeId === p.id) || (b.scope === "department" && b.scopeId === departmentId),
      );
      const top = mine.sort((a, b) => percentUsed(b, b.spend) - percentUsed(a, a.spend))[0];
      return { budget: top ? { scope: top.scope, percent: top.percent } : null };
    });
  }
}
