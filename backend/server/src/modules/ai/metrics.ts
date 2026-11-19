import type { PoolClient } from "pg";
import { WORKSPACE_TZ_SQL } from "@workspace/shared";

/**
 * The AI numbers every page shares (Home's chip, Adoption, the weekly report, Usage): one window list and one
 * definition of "uses AI", so two pages showing the same period never disagree about who used it.
 */

/** Windows the AI pages offer, in days. */
export const AI_WINDOWS = [7, 30, 90] as const;
export type AiWindow = (typeof AI_WINDOWS)[number];

/** A requested window, or `fallback` when the request is missing or not one of AI_WINDOWS. */
export function aiWindow(q: unknown, fallback: AiWindow = 30): AiWindow {
  const n = Number(q);
  return (AI_WINDOWS as readonly number[]).includes(n) ? (n as AiWindow) : fallback;
}

/** Model calls the app makes on its own (morning briefs, summaries of AI activity, topic tagging): they cost money
 * but are never someone using AI. */
export const AUTOMATIC_FEATURES = ["brief", "ai_activity_summary", "ai_topics"] as const;

/**
 * Someone uses AI in a window when they sent a prompt to an assistant (outside, through the extension, or the
 * company's) or ran one of the app's AI actions themselves (summaries, drafts, task helpers, workflow steps).
 */
export function usesAi(x: { prompts: number; inAppCalls: number }): boolean {
  return x.prompts > 0 || x.inAppCalls > 0;
}

/**
 * Where a window of `days` starts: midnight `days - 1` days ago in the workspace's zone, so "30 days" is the last 30
 * calendar days including today. Every AI page uses it (Usage's day charts, Overview, the weekly report), so a cost
 * or a head count never differs by the hours between a rolling window and the calendar.
 */
export function aiSinceSql(days: number): string {
  return `((date_trunc('day', now() AT TIME ZONE ${WORKSPACE_TZ_SQL}) - make_interval(days => ${Math.max(0, Math.trunc(days) - 1)})) AT TIME ZONE ${WORKSPACE_TZ_SQL})`;
}

/** The SQL behind usesAi for people `$1` (text[]) in the last `days` days (aiSinceSql), from the conversations and the hourly rollup. */
export function aiUsersSql(days: number): string {
  const since = aiSinceSql(days);
  const automatic = ["assistant", ...AUTOMATIC_FEATURES].map((f) => `'${f}'`).join(", ");
  return `SELECT user_id FROM ai_conversations WHERE last_at > ${since} AND messages > 0 AND user_id = ANY($1::text[])
          UNION
          SELECT user_id FROM ai_hourly_stats WHERE hour >= date_trunc('hour', ${since}) AND feature <> '' AND calls > 0
             AND feature NOT IN (${automatic}) AND user_id = ANY($1::text[])`;
}

/** Who among `ids` used AI in the last `days` days (usesAi). */
export async function aiUsers(c: PoolClient, ids: string[], days: number): Promise<Set<string>> {
  if (!ids.length) return new Set();
  return new Set((await c.query<{ user_id: string }>(aiUsersSql(days), [ids])).rows.map((r) => r.user_id));
}

/**
 * Tokens as a headline: the work a model did (new input, output, cache writes). Cache reads are the same context
 * read again at a tenth of the price; coding agents reread theirs on every turn, so counting them would make one
 * developer's day look like the whole company's month. They stay in the mix, apart.
 */
export function workTokens(x: { input: number; output: number; cacheWrite: number }): number {
  return x.input + x.output + x.cacheWrite;
}
