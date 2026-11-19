import { describe, expect, it } from "vitest";
import { EVENT_TYPE_PATTERN } from "../event-envelope.js";
import { describePayload } from "./describe.js";
import { asKnown, checkEvent, EVENTS, InvalidEventError, isEventType, payloadOf, topicOf, UnknownEventTypeError } from "./registry.js";

const task = {
  taskId: "t1",
  code: "T-1",
  title: "Gửi báo giá",
  description: "",
  ownerId: "u1",
  assigneeId: null,
  projectId: null,
  status: "todo",
  priority: "normal",
  dueAt: new Date("2026-10-20T10:00:00.000Z"),
  labels: [],
  version: 1,
  blockedReason: null,
  source: null,
};

describe("event registry", () => {
  it.each(Object.keys(EVENTS))("%s follows domain.entity.event.vN", (type) => {
    expect(type).toMatch(EVENT_TYPE_PATTERN);
  });

  it.each(Object.entries(EVENTS).map(([t, d]) => [t, d.aggregateType]))("%s: the name starts with its domain (%s)", (type, aggregate) => {
    // Webhook topics are derived from the first two segments of the type for most events; the
    // domain segment must at least agree with the aggregate's.
    expect(type.split(".")[0]).toBe(aggregate.split(".")[0]);
  });

  it("routes by aggregate type", () => {
    expect(topicOf("work.task.created.v1")).toBe("workspace.work.task");
    expect(topicOf("work.meeting.scheduled.v1")).toBe("workspace.work.calendar");
  });

  it("accepts a producer payload and returns its wire form", () => {
    const out = checkEvent({ eventType: "work.task.created.v1", aggregateType: "work.task", payload: task });
    expect(out.dueAt).toBe("2026-10-20T10:00:00.000Z");
  });

  it("keeps additive fields compatible (unknown keys pass)", () => {
    expect(() => checkEvent({ eventType: "work.task.created.v1", aggregateType: "work.task", payload: { ...task, newField: 1 } })).not.toThrow();
  });

  it("rejects an unregistered type", () => {
    expect(() => checkEvent({ eventType: "work.task.exploded.v1", aggregateType: "work.task", payload: {} })).toThrow(UnknownEventTypeError);
  });

  it("rejects the wrong topic", () => {
    expect(() => checkEvent({ eventType: "work.task.created.v1", aggregateType: "work.project", payload: task })).toThrow(/aggregateType must be work.task/);
  });

  it("names the field that does not match", () => {
    const bad = () => checkEvent({ eventType: "work.task.created.v1", aggregateType: "work.task", payload: { ...task, labels: "x" } });
    expect(bad).toThrow(InvalidEventError);
    expect(bad).toThrow(/labels/);
  });

  it("reads a Postgres date (local midnight) as its day", () => {
    const out = checkEvent({ eventType: "work.delegation.set.v1", aggregateType: "work.delegation", payload: { userId: "u", delegateId: "d", until: new Date(2026, 10, 1) } });
    expect(out.until).toBe("2026-11-01");
  });

  it("checks consumer-side payloads in wire form too", () => {
    expect(() => checkEvent({ eventType: "work.task.created.v1", aggregateType: "work.task", payload: { ...task, dueAt: "2026-10-20T10:00:00.000Z" } })).not.toThrow();
  });

  it("narrows known envelopes", () => {
    const e = {
      eventId: "01JABCDEFGHJKMNPQRSTVWXYZ0",
      eventType: "work.delegation.cleared.v1",
      version: 1,
      aggregateType: "work.delegation",
      aggregateId: "u",
      actorId: "user:u",
      occurredAt: "2026-10-08T13:00:00.000Z",
      payload: { userId: "u" },
    };
    expect(asKnown(e)?.eventType).toBe("work.delegation.cleared.v1");
    expect(payloadOf(e, "work.delegation.cleared.v1").userId).toBe("u");
    expect(asKnown({ ...e, eventType: "work.delegation.cleared.v9" })).toBeNull();
    expect(isEventType("nope.v1")).toBe(false);
  });

  it("describes payloads for the catalog", () => {
    expect(describePayload(EVENTS["work.document.commented.v1"].payload)).toContain("notify: string[]");
    expect(describePayload(EVENTS["chat.status.set.v1"].payload)).toContain("dndUntil: ISO string \\| null");
    expect(describePayload(EVENTS["work.approval.requested.v1"].payload)).toContain("onBehalfOf?: string");
  });
});
