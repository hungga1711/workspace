import { Controller, Get, Inject, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { withTransaction } from "@workspace/shared";
import { requirePrincipal } from "@workspace/service-kit";
import { DEPS } from "./ai.controller.js";
import { aiAudience } from "./audience.js";
import { priceOf } from "./local-usage-report.js";
import { aiSinceSql, aiWindow } from "./metrics.js";
import type { Deps } from "./runtime.js";

/**
 * The company AI's spend per model over a window, on the AI view's audience (admins everyone, managers their
 * reporting line): what the assistant's ai_spend tool adds to Áp dụng AI's per-person and per-department costs
 * (adoption-people.ts), which carry no model.
 */

export interface ModelUsageRow {
  model: string;
  userId: string;
  calls: number;
  input: number;
  output: number;
}
export interface ModelSpend {
  model: string;
  calls: number;
  tokens: number;
  people: number;
  /** Null when the model has no price (neither the company's nor the built-in table): unknown, never free. */
  costUsd: number | null;
}

export function modelSpend(rows: ModelUsageRow[], company: { model: string; input: number; output: number }[]): ModelSpend[] {
  const by = new Map<string, { calls: number; input: number; output: number; people: Set<string> }>();
  for (const r of rows) {
    const x = by.get(r.model) ?? { calls: 0, input: 0, output: 0, people: new Set<string>() };
    x.calls += r.calls;
    x.input += r.input;
    x.output += r.output;
    x.people.add(r.userId);
    by.set(r.model, x);
  }
  return [...by.entries()]
    .map(([model, x]) => {
      const price = priceOf(model, company);
      return {
        model,
        calls: x.calls,
        tokens: x.input + x.output,
        people: x.people.size,
        costUsd: price ? Math.round(((x.input * price.input + x.output * price.output) / 1_000_000) * 10_000) / 10_000 : null,
      };
    })
    .sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || b.tokens - a.tokens);
}

@Controller()
export class SpendModelsController {
  constructor(@Inject(DEPS) private readonly d: Deps) {}

  @Get("spend/models")
  async models(@Req() req: Request, @Query("days") daysQ?: string) {
    const p = requirePrincipal(req);
    const days = aiWindow(daysQ);
    const { people } = await aiAudience(this.d, p);
    const ids = people.map((x) => x.userId);
    return withTransaction(this.d.pool, async (c) => {
      const rows = (
        await c.query<ModelUsageRow>(
          `SELECT model, user_id AS "userId", count(*)::int AS calls, sum(input_tokens)::bigint::float AS input, sum(output_tokens)::bigint::float AS output
             FROM ai_usage WHERE at > ${aiSinceSql(days)} AND user_id = ANY($1::text[]) AND coalesce(provider, '') <> 'local'
            GROUP BY model, user_id`,
          [ids],
        )
      ).rows;
      const company = (
        await c.query<{ model: string; input: number; output: number }>("SELECT model, input_per_mtok::float AS input, output_per_mtok::float AS output FROM ai_model_prices")
      ).rows;
      return { days, models: modelSpend(rows, company) };
    });
  }
}
