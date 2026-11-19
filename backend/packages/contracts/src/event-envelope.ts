import { z } from "zod";

// Event names follow domain.entity.event.vN, e.g. "work.task.created.v1".
export const EVENT_TYPE_PATTERN = /^[a-z]+(\.[a-z_]+)+\.v\d+$/;

const ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, "must be a ULID");

export const REQUEST_ID_PATTERN = /^[\w-]{8,64}$/;

export const eventEnvelopeSchema = z
  .object({
    eventId: ulid,
    eventType: z.string().regex(EVENT_TYPE_PATTERN, "must match domain.entity.event.vN"),
    version: z.number().int().positive(),
    aggregateType: z.string().min(1),
    aggregateId: z.string().min(1).max(128),
    actorId: z.string().min(1),
    occurredAt: z.string().datetime(),
    /**
     * The request that caused the event, carried to every consumer so one id follows a user action across modules.
     * appendToOutbox always sets it; events dispatched straight to the bus (tests, tools) may omit it.
     */
    requestId: z.string().regex(REQUEST_ID_PATTERN).optional(),
    payload: z.record(z.unknown()),
    /**
     * Where the action came from, for the audit trail (ADR 0025): the caller's address and browser, and the credential
     * kind ("session", "personal_key", "workspace_key", "oauth"). Set by appendToOutbox from the request context.
     */
    origin: z.object({ ip: z.string().max(64).optional(), userAgent: z.string().max(300).optional(), via: z.string().max(32).optional() }).optional(),
  })
  // The numeric version and the name's `.vN` suffix say the same thing; a mismatch is a producer bug.
  .refine((e) => e.eventType.endsWith(`.v${e.version}`), { message: "version must match the .vN suffix of eventType", path: ["version"] });

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
