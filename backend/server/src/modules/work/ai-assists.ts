import type { PoolClient } from "pg";
import type { EventEnvelope } from "@workspace/contracts";

/**
 * Projection of `ai.usage.recorded.v1` (the ai module) for tasks: which tasks AI helped with (company AI, or an outside
 * conversation the person linked to the task, `source: "extension"`), when it
 * first did, and how much (ADR 0011). Idempotency is startConsumer's (processed_events); a replay never counts twice.
 * Other subjects (documents, meetings…) are not tracked here yet.
 */
export async function applyAiUsageEvent(e: EventEnvelope, c: PoolClient): Promise<void> {
  if (e.eventType !== "ai.usage.recorded.v1") return;
  const p = e.payload as { userId: string; subjectType: string; subjectId: string; tokens: number; at?: string };
  if (p.subjectType !== "task") return;
  await c.query(
    `INSERT INTO task_ai_assists (task_id, first_at, last_at, calls, tokens, people)
     SELECT $1, $2, $2, 1, $3, ARRAY[$4::text] WHERE EXISTS (SELECT 1 FROM tasks WHERE id = $1)
     ON CONFLICT (task_id) DO UPDATE SET
       first_at = least(task_ai_assists.first_at, EXCLUDED.first_at),
       last_at = greatest(task_ai_assists.last_at, EXCLUDED.last_at),
       calls = task_ai_assists.calls + 1,
       tokens = task_ai_assists.tokens + EXCLUDED.tokens,
       people = CASE WHEN $4 = ANY(task_ai_assists.people) THEN task_ai_assists.people ELSE task_ai_assists.people || $4 END`,
    [p.subjectId, p.at ?? e.occurredAt, p.tokens, p.userId],
  );
}
