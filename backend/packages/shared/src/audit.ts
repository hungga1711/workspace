import type { PoolClient } from "pg";
import type { EventPayloadInput } from "@workspace/contracts";
import { maybeRequestContext, type RequestOrigin } from "./context.js";
import { newId } from "./ids.js";
import { appendToOutbox } from "./outbox.js";

export type AuditEntryInput = EventPayloadInput<"audit.entry.recorded.v1"> & {
  /** Overrides the request's actor: a sign-in (no principal yet) names the person, a failed one "anonymous". */
  actorId?: string;
  /** Overrides the request's origin (public routes get the address and browser in the body). */
  origin?: RequestOrigin;
};

/**
 * Records an action for the audit trail (ADR 0025) in the caller's transaction: it exists exactly when the change
 * commits. Use it only where no domain event already says what happened; the platform module turns domain events
 * into trail rows itself. One outbox insert, so it never slows the request noticeably.
 */
export async function recordAudit(c: PoolClient, entry: AuditEntryInput): Promise<void> {
  const { actorId, origin, ...payload } = entry;
  await appendToOutbox(c, {
    eventId: newId(),
    eventType: "audit.entry.recorded.v1",
    version: 1,
    aggregateType: "audit.entry",
    aggregateId: `${payload.targetType}:${payload.targetId}`.slice(0, 128),
    actorId: actorId ?? maybeRequestContext()?.actorId ?? "system",
    occurredAt: new Date().toISOString(),
    payload,
    ...(origin ? { origin } : {}),
  });
}

function leaves(v: unknown, prefix: string, out: Record<string, unknown>, depth: number): Record<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) && depth < 3) {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) leaves(x, prefix ? `${prefix}.${k}` : k, out, depth + 1);
  } else out[prefix] = v instanceof Date ? v.toISOString() : (v ?? null);
  return out;
}

/**
 * What a settings save changed, as { "shift.start": { from, to } } (dotted paths, at most three levels and 40
 * paths), for an audit entry's `changes`. Only for settings: never pass content through it.
 */
export function settingsChanges(before: unknown, after: unknown): Record<string, { from: unknown; to: unknown }> {
  const a = leaves(before, "", {}, 0);
  const b = leaves(after, "", {}, 0);
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (JSON.stringify(a[k] ?? null) === JSON.stringify(b[k] ?? null)) continue;
    out[k] = { from: a[k] ?? null, to: b[k] ?? null };
    if (Object.keys(out).length >= 40) break;
  }
  return out;
}
