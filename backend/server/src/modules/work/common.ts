import type { PoolClient } from "pg";
import { appendToOutbox, authorize, getRequestContext, newId, type Principal, type Resource } from "@workspace/shared";
import { Forbidden } from "./errors.js";
import type { EventPayloadInput, EventType } from "@workspace/contracts";

export async function emit<T extends EventType>(c: PoolClient, eventType: T, aggregateType: string, aggregateId: string, payload: EventPayloadInput<T>) {
  const { actorId } = getRequestContext();
  await appendToOutbox(c, { eventId: newId(), eventType, version: 1, aggregateType, aggregateId, actorId, occurredAt: new Date().toISOString(), payload });
}

export async function activity(c: PoolClient, entityType: string, entityId: string, action: string, changes: Record<string, unknown> = {}) {
  const { actorId } = getRequestContext();
  await c.query("INSERT INTO activity (id, entity_type, entity_id, actor, action, changes) VALUES ($1,$2,$3,$4,$5,$6)", [
    newId(),
    entityType,
    entityId,
    actorId,
    action,
    JSON.stringify(changes),
  ]);
}

/** Allowed if any of the resources is covered (e.g. task as owner OR as assignee). */
export function allowedAny(p: Principal, permission: string, resources: Resource[]): boolean {
  return resources.some((r) => authorize(p, permission, r).allowed);
}

export function requireAny(p: Principal, permission: string, resources: Resource[]): void {
  if (!allowedAny(p, permission, resources)) throw new Forbidden(`not allowed: ${permission}`);
}
