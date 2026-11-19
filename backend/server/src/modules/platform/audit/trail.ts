import type { Pool, PoolClient } from "pg";
import { asKnown, type EventEnvelope } from "@workspace/contracts";
import { consumeEvents, type EventBus, type EventConsumer } from "@workspace/service-kit";
import { maybeRequestContext, newId, withTransaction, type RequestOrigin } from "@workspace/shared";
import { MAPPED_TYPES, mapEvent, parseActor, subjectOf, type AuditDraft, type SubjectState } from "./mapping.js";
import { scrubRecord } from "./privacy.js";

/** One row of `audit_trail` as it is written. */
export interface TrailRow extends AuditDraft {
  id: string;
  at: string | Date;
  actor: string;
  origin?: RequestOrigin | undefined;
  requestId?: string | null | undefined;
}

/** Appends one row (append-only: the module's role may not update or delete). A redelivered event is a no-op. */
export async function insertTrail(c: PoolClient, r: TrailRow): Promise<boolean> {
  const actor = parseActor(r.actor);
  if (r.coalesceMinutes) {
    const recent = await c.query(
      `SELECT 1 FROM audit_trail WHERE target_type = $1 AND target_id = $2 AND action = $3 AND actor_id = $4 AND at > $5::timestamptz - make_interval(mins => $6) LIMIT 1`,
      [r.targetType, r.targetId, r.action, actor.id, r.at, r.coalesceMinutes],
    );
    if (recent.rowCount) return false;
  }
  const ins = await c.query(
    `INSERT INTO audit_trail (id, at, actor_type, actor_id, via, ip, user_agent, module, action, target_type, target_id, target_label, outcome, request_id, changes, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT (id) DO NOTHING`,
    [
      r.id,
      r.at,
      actor.type,
      actor.id,
      r.origin?.via ?? null,
      r.origin?.ip ?? null,
      r.origin?.userAgent ?? null,
      r.action.split(".")[0],
      r.action,
      r.targetType,
      r.targetId.slice(0, 200),
      r.targetLabel?.slice(0, 300) ?? null,
      r.outcome ?? "success",
      r.requestId ?? null,
      JSON.stringify(r.changes ?? {}),
      JSON.stringify(r.meta ?? {}),
    ],
  );
  return (ins.rowCount ?? 0) > 0;
}

/**
 * A direct entry from the platform module itself (settings, webhooks, logo, reads of the trail), in the caller's
 * transaction. Other modules use `recordAudit` (shared), which travels as an event.
 */
export async function trail(c: PoolClient, entry: AuditDraft & { actor?: string }): Promise<void> {
  const ctx = maybeRequestContext();
  await insertTrail(c, {
    ...entry,
    meta: scrubRecord(entry.meta),
    ...(entry.changes ? { changes: scrubRecord(entry.changes) } : {}),
    id: newId(),
    at: new Date(),
    actor: entry.actor ?? ctx?.actorId ?? "system",
    origin: ctx?.origin,
    requestId: ctx?.requestId ?? null,
  });
}

async function loadSubject(c: PoolClient, type: string, id: string): Promise<SubjectState | null> {
  const r = await c.query<{ version: number | null; state: Record<string, unknown> }>("SELECT version, state FROM audit_subjects WHERE type = $1 AND id = $2", [type, id]);
  return r.rows[0] ?? null;
}

/** Turns one event into trail rows. Exported for tests (the consumer calls it in its own transaction). */
export async function auditEvent(c: PoolClient, event: EventEnvelope): Promise<number> {
  const e = asKnown(event);
  if (!e || !MAPPED_TYPES.has(e.eventType)) return 0;
  const subject = subjectOf(e);
  const prev = subject ? await loadSubject(c, subject.type, subject.id) : null;
  const mapped = mapEvent(e, prev, event.actorId);
  if (!mapped) return 0;
  let n = 0;
  for (const [i, row] of mapped.rows.entries()) {
    const ok = await insertTrail(c, {
      ...row,
      // The event id makes a redelivery a no-op; a second row from the same event gets a suffix.
      id: i === 0 ? event.eventId : `${event.eventId}-${i}`,
      at: event.occurredAt,
      actor: event.actorId,
      origin: event.origin,
      requestId: event.requestId ?? null,
    });
    if (ok) n++;
  }
  const save = mapped.save;
  if (subject && save === "drop") await c.query("DELETE FROM audit_subjects WHERE type = $1 AND id = $2", [subject.type, subject.id]);
  else if (subject && save && typeof save === "object")
    await c.query(
      `INSERT INTO audit_subjects (type, id, version, state, updated_at) VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (type, id) DO UPDATE SET version = EXCLUDED.version, state = EXCLUDED.state, updated_at = now()`,
      [subject.type, subject.id, save.version, JSON.stringify(save.state)],
    );
  return n;
}

/**
 * The `platform-audit` consumer. Not `startConsumer`: an event with no mapping (most of them) returns before any
 * database work, and the trail's primary key (the event id) already makes a redelivery a no-op, so no
 * processed_events row is written per event.
 */
export function startAuditConsumer(bus: EventBus, pool: Pool, topics: readonly string[]): Promise<EventConsumer> {
  return consumeEvents({
    bus,
    groupId: "platform-audit",
    topics: [...topics],
    deadLetters: pool,
    handle: async (event) => {
      if (!MAPPED_TYPES.has(event.eventType)) return;
      await withTransaction(pool, (c) => auditEvent(c, event));
    },
  });
}
