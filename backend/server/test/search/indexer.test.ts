import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "@workspace/contracts";
import { toAction } from "../../src/modules/search/indexer.js";

const ev = (eventType: string, payload: Record<string, unknown>): EventEnvelope => ({
  eventId: "e1",
  eventType,
  version: 1,
  aggregateType: eventType.split(".").slice(0, 2).join("."),
  aggregateId: "a",
  actorId: "user:u",
  occurredAt: "2026-10-09T00:00:00.000Z",
  payload,
});

describe("toAction", () => {
  it("indexes channels on create and re-indexes them on rename, never DMs", () => {
    const created = toAction(ev("chat.channel.created.v1", { channelId: "c1", kind: "public", name: "du-an", topic: "Q4" }));
    expect(created).toMatchObject({ op: "index", doc: { entity_type: "channel", entity_id: "c1", title: "#du-an", body: "Q4", url: "/app/chat/c1" } });
    const renamed = toAction(ev("chat.channel.updated.v1", { channelId: "c1", kind: "private", name: "ra-mat", topic: "" }));
    expect(renamed).toMatchObject({ op: "index", doc: { entity_id: "c1", title: "#ra-mat" } });
    expect(toAction(ev("chat.channel.created.v1", { channelId: "d1", kind: "dm", name: null }))).toBeNull();
  });

  it("re-indexes a person under the new name after a rename", () => {
    const renamed = toAction(ev("identity.member.renamed.v1", { userId: "u1", email: "lan@x.vn", displayName: "Nguyễn Thị Lan Anh" }));
    expect(renamed).toMatchObject({ op: "index", doc: { entity_type: "person", entity_id: "u1", title: "Nguyễn Thị Lan Anh" } });
  });

  it("deletes removed messages and tasks; ignores unknown events", () => {
    expect(toAction(ev("chat.message.deleted.v1", { messageId: "m1" }))).toEqual({ op: "delete", type: "message", id: "m1" });
    expect(toAction(ev("work.task.deleted.v1", { taskId: "t1" }))).toEqual({ op: "delete", type: "task", id: "t1" });
    expect(toAction(ev("work.meeting.scheduled.v1", { eventId: "x" }))).toBeNull();
  });

  it("restricts task documents to their owner and assignee", () => {
    const a = toAction(ev("work.task.created.v1", { taskId: "t1", code: "T-001", title: "Báo giá", ownerId: "u1", assigneeId: "u2", projectId: null, description: "" }));
    expect(a).toMatchObject({ op: "index", doc: { entity_type: "task", container_id: "user:u1", acl_users: ["u1", "u2"], title: "T-001 Báo giá" } });
  });
});
