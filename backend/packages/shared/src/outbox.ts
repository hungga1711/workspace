import type { PoolClient } from "pg";
import { checkEvent, eventEnvelopeSchema, type EventEnvelope, type EventPayloadInput, type EventType } from "@workspace/contracts";
import { cleanOrigin, currentRequestId, maybeRequestContext } from "./context.js";

/**
 * Producers pass the business fields; correlation fields default to the current request. The type
 * must be registered in @workspace/contracts, and the payload is typed by it.
 */
export type OutboxEvent<T extends EventType = EventType> = Omit<EventEnvelope, "requestId" | "eventType" | "payload"> &
  Partial<Pick<EventEnvelope, "requestId">> & { eventType: T; payload: EventPayloadInput<T> };

export class MissingRequestIdError extends Error {
  constructor() {
    super("appendToOutbox: no request id in context; run inside runWithContext/runWithRequestId");
    this.name = "MissingRequestIdError";
  }
}

/**
 * Writes an event in the caller's transaction: it exists exactly when the change commits, and a
 * rollback emits nothing. The module's outbox relay (service-kit startEvents) delivers committed rows
 * to the consumer groups reading `workspace.<aggregateType>`; the row stays EVENT_RETENTION_DAYS as the
 * copy events are replayed from.
 */
export async function appendToOutbox<T extends EventType>(client: PoolClient, event: OutboxEvent<T>): Promise<void> {
  // Every event carries the id of the request that caused it, so consumers log under the same id.
  const requestId = event.requestId ?? currentRequestId();
  if (!requestId) throw new MissingRequestIdError();
  // A bad event fails the request that produced it, never a consumer downstream.
  const payload = checkEvent(event);
  // The caller's address, browser and credential kind travel with the event for the audit trail (ADR 0025).
  const origin = cleanOrigin(event.origin ?? maybeRequestContext()?.origin);
  const e = eventEnvelopeSchema.parse({ ...event, payload, requestId, ...(origin ? { origin } : {}) });
  await client.query(
    `INSERT INTO outbox (id, aggregatetype, aggregateid, type, payload)
     VALUES ($1, $2, $3, $4, $5)`,
    [e.eventId, e.aggregateType, e.aggregateId, e.eventType, JSON.stringify(e)],
  );
}
