import { describe, expect, it } from "vitest";
import { eventEnvelopeSchema } from "./event-envelope.js";

const valid = {
  eventId: "01JABCDEFGHJKMNPQRSTVWXYZ0",
  eventType: "work.task.created.v1",
  version: 1,
  aggregateType: "task",
  aggregateId: "01JABCDEFGHJKMNPQRSTVWXYZ2",
  actorId: "user:01JABCDEFGHJKMNPQRSTVWXYZ3",
  occurredAt: "2026-10-08T13:00:00.000Z",
  payload: { title: "Review proposal" },
};

describe("eventEnvelopeSchema", () => {
  it("accepts a well-formed envelope", () => {
    expect(eventEnvelopeSchema.parse(valid)).toEqual(valid);
  });

  it("carries the causing request id", () => {
    const e = { ...valid, requestId: "01JABCDEFGHJKMNPQRSTVWXYZ4" };
    expect(eventEnvelopeSchema.parse(e)).toEqual(e);
  });

  it("still reads events published before requestId existed", () => {
    expect(eventEnvelopeSchema.safeParse(valid).success).toBe(true);
  });

  it.each(["short", "has space in it!", "x".repeat(65)])("rejects request id %s", (requestId) => {
    expect(eventEnvelopeSchema.safeParse({ ...valid, requestId }).success).toBe(false);
  });

  it("drops the trace parent that older stored events still carry", () => {
    expect(eventEnvelopeSchema.parse({ ...valid, traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" })).toEqual(valid);
  });

  it("rejects an envelope without an actor", () => {
    const { actorId: _omit, ...rest } = valid;
    expect(eventEnvelopeSchema.safeParse(rest).success).toBe(false);
  });

  it.each(["task.created", "Work.task.created.v1", "work.task.created.1"])("rejects event type %s", (eventType) => {
    expect(eventEnvelopeSchema.safeParse({ ...valid, eventType }).success).toBe(false);
  });

  it("rejects a version that disagrees with the name", () => {
    expect(eventEnvelopeSchema.safeParse({ ...valid, version: 2 }).success).toBe(false);
  });
});
