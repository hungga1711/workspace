import type { PoolClient } from "pg";
import { appendToOutbox, authorize, newId, settingsChanges, type Principal } from "@workspace/shared";
import type { EventPayloadInput, EventType } from "@workspace/contracts";
import { trail } from "./audit/trail.js";

export const POOL = Symbol("POOL");
export const IDENTITY = Symbol("IDENTITY");

export function isPlatform(p: Principal, permission: string): boolean {
  return authorize(p, permission).allowed && p.grants.some((g) => g.permission === permission && g.scope === "PLATFORM");
}

/**
 * A platform admin action: the legacy per-module log (kept for its endpoint) and the audit trail (ADR 0025), whose
 * action is `platform.<action>`. `extra` adds a readable target and field changes to the trail entry.
 */
export async function audit(
  c: PoolClient,
  actor: string,
  action: string,
  resource: string,
  resourceId: string,
  metadata: unknown = {},
  extra: { label?: string | null; changes?: Record<string, unknown> } = {},
) {
  await trail(c, {
    actor,
    action: `platform.${action}`,
    targetType: resource,
    targetId: resourceId,
    targetLabel: extra.label ?? null,
    meta: metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>) : {},
    ...(extra.changes ? { changes: extra.changes } : {}),
  });
  await c.query("INSERT INTO audit_log (id, actor, action, resource, resource_id, source, metadata) VALUES ($1,$2,$3,$4,$5,'platform',$6)", [
    newId(),
    actor,
    action,
    resource,
    resourceId,
    JSON.stringify(metadata),
  ]);
}

/** Workspace events: one aggregate, the installation's workspace. */
export async function emit<T extends EventType>(c: PoolClient, actor: string, eventType: T, payload: EventPayloadInput<T>) {
  await appendToOutbox(c, {
    eventId: newId(),
    eventType,
    version: 1,
    aggregateType: "platform.workspace",
    aggregateId: "workspace",
    actorId: actor,
    occurredAt: new Date().toISOString(),
    payload,
  });
}

/** What a settings save changed (shared `settingsChanges`), for the audit trail. */
export const configChanges = (before: unknown, after: unknown): Record<string, unknown> => settingsChanges(before, after);
