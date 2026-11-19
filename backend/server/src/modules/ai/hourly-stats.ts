import type { PoolClient } from "pg";

/**
 * The hourly rollup behind Công việc › AI (`ai_hourly_stats`): one row per hour, person, tool and
 * feature, added to as prompts and company-AI calls are recorded, so the charts and the cost never scan
 * ai_messages or ai_usage. `prompt` is a message sent to any AI (feature ''), `call` a metered company-AI call.
 */
export type HourlyBump =
  | { prompt: { userId: string; source: string; at: Date; count?: number } }
  | { call: { userId: string; feature: string; provider: string | null; model: string; inputTokens: number; outputTokens: number; at: Date } };

export async function bumpHourlyStats(c: PoolClient, b: HourlyBump): Promise<void> {
  if ("prompt" in b) {
    await c.query(
      `INSERT INTO ai_hourly_stats (hour, user_id, source, prompts)
       VALUES (date_trunc('hour', $3::timestamptz), $1, $2, $4)
       ON CONFLICT (hour, user_id, source, feature, provider, model) DO UPDATE SET prompts = ai_hourly_stats.prompts + $4`,
      [b.prompt.userId, b.prompt.source, b.prompt.at, Math.max(1, Math.round(b.prompt.count ?? 1))],
    );
    return;
  }
  const u = b.call;
  await c.query(
    `INSERT INTO ai_hourly_stats (hour, user_id, source, feature, provider, model, calls, input_tokens, output_tokens)
     VALUES (date_trunc('hour', $7::timestamptz), $1, 'app', $2, $3, $4, 1, $5, $6)
     ON CONFLICT (hour, user_id, source, feature, provider, model) DO UPDATE
       SET calls = ai_hourly_stats.calls + 1, input_tokens = ai_hourly_stats.input_tokens + EXCLUDED.input_tokens,
           output_tokens = ai_hourly_stats.output_tokens + EXCLUDED.output_tokens`,
    [u.userId, u.feature, u.provider ?? "", u.model, u.inputTokens, u.outputTokens, u.at],
  );
}

/**
 * Cost of the rollup's company-AI rows, priced the way ai_usage_costed prices a call: the connection's price list by
 * model (prefix-matching dated names), self-hosted and local models free, anything else unpriced (NULL).
 * Use as `FROM ai_hourly_stats s ${HOURLY_COST_JOIN}` and read `${HOURLY_COST}` / `${HOURLY_UNPRICED}`.
 */
export const HOURLY_COST_JOIN = `LEFT JOIN ai_connections cn ON s.provider = 'c_' || cn.id
  LEFT JOIN LATERAL (SELECT p.model, p.input_per_mtok, p.output_per_mtok FROM ai_model_prices p
                      WHERE p.provider = s.provider
                        AND (s.model = p.model OR starts_with(s.model, p.model || '-') OR starts_with(s.model, p.model || ':'))
                      ORDER BY length(p.model) DESC LIMIT 1) pr ON true`;
export const HOURLY_COST = `CASE WHEN pr.model IS NOT NULL THEN (s.input_tokens::numeric * pr.input_per_mtok + s.output_tokens::numeric * pr.output_per_mtok) / 1000000
  WHEN s.provider = 'local' OR s.model = 'local-extractive' OR cn.mode = 'selfhost' THEN 0 ELSE NULL END`;
export const HOURLY_UNPRICED = `CASE WHEN pr.model IS NULL AND NOT (s.provider = 'local' OR s.model = 'local-extractive' OR cn.mode = 'selfhost') THEN s.input_tokens + s.output_tokens ELSE 0 END`;
