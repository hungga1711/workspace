import type { z } from "zod";
import type { EventEnvelope } from "../event-envelope.js";
import { aiEvents } from "./ai.js";
import { auditEvents } from "./audit.js";
import { chatEvents } from "./chat.js";
import type { EventDefinition } from "./define.js";
import { employeeEvents } from "./employee.js";
import { identityEvents } from "./identity.js";
import { opsEvents } from "./ops.js";
import { platformEvents } from "./platform.js";
import { workEvents } from "./work.js";

/**
 * Every event type a module may publish, with its topic and payload schema. The single source of truth for
 * producers (appendToOutbox refuses an unregistered type or a payload that does not match), consumers
 * (consumeEvents validates before handing an event over) and docs/events/catalog.md (`pnpm events:catalog`).
 */
export const EVENTS = {
  ...identityEvents,
  ...platformEvents,
  ...chatEvents,
  ...workEvents,
  ...employeeEvents,
  ...aiEvents,
  ...opsEvents,
  ...auditEvents,
} satisfies Record<string, EventDefinition>;

type Registry = typeof EVENTS;
export type EventType = keyof Registry;
/** What a producer passes (timestamps may be Dates). */
export type EventPayloadInput<T extends EventType> = z.input<Registry[T]["payload"]>;
/** What a consumer reads (wire form: timestamps are ISO strings). */
export type EventPayload<T extends EventType> = z.output<Registry[T]["payload"]>;
/** An envelope narrowed to one event type; a union of these narrows on `switch (e.eventType)`. */
export type EventOf<T extends EventType> = Omit<EventEnvelope, "eventType" | "payload"> & { eventType: T; payload: EventPayload<T> };
export type KnownEvent = { [T in EventType]: EventOf<T> }[EventType];

export const isEventType = (t: string): t is EventType => Object.prototype.hasOwnProperty.call(EVENTS, t);

/** The topic an event type travels on. */
export const topicOf = (t: EventType): string => `workspace.${EVENTS[t].aggregateType}`;

export class UnknownEventTypeError extends Error {
  constructor(readonly eventType: string) {
    super(`event type ${eventType} is not registered in @workspace/contracts (backend/packages/contracts/src/events)`);
    this.name = "UnknownEventTypeError";
  }
}

export class InvalidEventError extends Error {
  constructor(
    readonly eventType: string,
    readonly issues: string,
  ) {
    super(`${eventType}: ${issues}`);
    this.name = "InvalidEventError";
  }
}

/**
 * Validates an event's routing and payload, and returns the payload in wire form (JSON, timestamps as
 * ISO strings): exactly what consumers receive.
 */
export function checkEvent(e: { eventType: string; aggregateType: string; payload: unknown }): Record<string, unknown> {
  if (!isEventType(e.eventType)) throw new UnknownEventTypeError(e.eventType);
  const def: EventDefinition = EVENTS[e.eventType];
  if (e.aggregateType !== def.aggregateType) throw new InvalidEventError(e.eventType, `aggregateType must be ${def.aggregateType}, got ${e.aggregateType}`);
  // Parsed as produced (a Postgres date is still a Date here), then returned in wire form.
  const r = def.payload.safeParse(e.payload);
  if (!r.success) throw new InvalidEventError(e.eventType, r.error.issues.map((i) => `${i.path.join(".") || "payload"}: ${i.message}`).join("; "));
  // Unknown top-level fields are kept: adding a field before its schema does is not an error.
  return JSON.parse(JSON.stringify({ ...(e.payload as Record<string, unknown>), ...(r.data as Record<string, unknown>) })) as Record<string, unknown>;
}

/** Narrows an envelope to a registered type (consumeEvents has already validated its payload). */
export function asKnown(e: EventEnvelope): KnownEvent | null {
  return isEventType(e.eventType) ? (e as unknown as KnownEvent) : null;
}

/** Typed payload of an event the caller already switched on. */
export function payloadOf<T extends EventType>(e: EventEnvelope, type: T): EventPayload<T> {
  if (e.eventType !== type) throw new InvalidEventError(e.eventType, `expected ${type}`);
  return e.payload as EventPayload<T>;
}
