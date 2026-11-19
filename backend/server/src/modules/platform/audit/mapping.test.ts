import { describe, expect, it } from "vitest";
import { EVENTS, type KnownEvent } from "@workspace/contracts";
import { MAPPED_TYPES, mapEvent, parseActor, subjectOf, type SubjectState } from "./mapping.js";

const ev = (eventType: string, payload: Record<string, unknown>) => ({ eventType, payload }) as unknown as KnownEvent;

const task = {
  taskId: "t1",
  code: "T-142",
  title: "Gửi báo giá",
  description: "Khách hàng nội bộ: giá 1 tỷ",
  ownerId: "u1",
  assigneeId: null,
  projectId: null,
  status: "todo",
  priority: "normal",
  dueAt: null,
  labels: [],
  version: 1,
  blockedReason: null,
  source: { type: "chat.message" },
};

/** Runs created → updated through the mapping, carrying the saved state like the consumer does. */
function chain(events: KnownEvent[], actor = "user:u1") {
  let prev: SubjectState | null = null;
  const rows = [];
  for (const e of events) {
    const m = mapEvent(e, prev, actor);
    if (!m) continue;
    rows.push(...m.rows);
    if (m.save === "drop") prev = null;
    else if (m.save) prev = { version: m.save.version, state: m.save.state };
  }
  return { rows, prev };
}

describe("audit mapping", () => {
  it("maps only registered event types", () => {
    for (const t of MAPPED_TYPES) expect(Object.hasOwn(EVENTS, t), t).toBe(true);
  });

  it("turns a task update into the changed fields, never the description", () => {
    const { rows, prev } = chain([
      ev("work.task.created.v1", task),
      ev("work.task.updated.v1", { ...task, status: "doing", version: 2 }),
      ev("work.task.updated.v1", { ...task, status: "doing", assigneeId: "u2", description: "giá mới 2 tỷ", version: 3 }),
    ]);
    expect(rows.map((r) => r.action)).toEqual(["work.task.created", "work.task.status_changed", "work.task.updated"]);
    expect(rows[0]!.targetLabel).toBe("T-142 · Gửi báo giá");
    expect(rows[1]!.changes).toEqual({ status: { from: "todo", to: "doing" } });
    expect(rows[2]!.changes).toEqual({ assigneeId: { from: null, to: "u2" }, description: { changed: true } });
    const all = JSON.stringify({ rows, prev });
    expect(all).not.toContain("tỷ");
    expect(all).not.toContain("Khách hàng");
  });

  it("skips a stale update and a no-op save", () => {
    const { rows } = chain([
      ev("work.task.created.v1", { ...task, version: 5 }),
      ev("work.task.updated.v1", { ...task, status: "done", version: 4 }),
      ev("work.task.updated.v1", { ...task, version: 6 }),
    ]);
    expect(rows.map((r) => r.action)).toEqual(["work.task.created"]);
  });

  it("does not audit direct messages or group conversations at all", () => {
    expect(mapEvent(ev("chat.channel.created.v1", { channelId: "c1", kind: "dm", name: null, memberIds: ["a", "b"] }), null, "user:a")!.rows).toEqual([]);
    const prev = { version: null, state: { kind: "group", name: null } };
    expect(mapEvent(ev("chat.channel.member_added.v1", { channelId: "c1", userIds: ["c"] }), prev, "user:a")!.rows).toEqual([]);
  });

  it("never names a private channel, nor stores a topic", () => {
    const m = mapEvent(ev("chat.channel.created.v1", { channelId: "c2", kind: "private", name: "hr-luong", topic: "bảng lương", memberIds: ["a"] }), null, "user:a")!;
    expect(m.rows[0]).toMatchObject({ action: "chat.channel.created", targetLabel: null, meta: { kind: "private" } });
    const renamed = mapEvent(
      ev("chat.channel.updated.v1", { channelId: "c2", kind: "private", name: "hr-2", topic: "x", archived: false, previousName: "hr-luong" }),
      { version: null, state: m.save !== "drop" ? m.save!.state : {} },
      "user:a",
    )!;
    expect(JSON.stringify(renamed)).not.toMatch(/hr-|lương|"x"/);
    expect(renamed.rows.map((r) => r.action)).toEqual(["chat.channel.renamed", "chat.channel.updated"]);
  });

  it("names a public channel and tells joining from being added", () => {
    const state = { version: null, state: { kind: "public", name: "general" } };
    expect(mapEvent(ev("chat.channel.member_added.v1", { channelId: "c", userIds: ["a"] }), state, "user:a")!.rows[0]).toMatchObject({
      action: "chat.channel.joined",
      targetLabel: "#general",
    });
    expect(mapEvent(ev("chat.channel.member_added.v1", { channelId: "c", userIds: ["b"] }), state, "user:a")!.rows[0]!.action).toBe("chat.channel.member_added");
    // A channel created before the trail: unknown kind, so no name.
    expect(mapEvent(ev("chat.channel.member_removed.v1", { channelId: "c", userId: "b" }), null, "user:a")!.rows[0]!.targetLabel).toBeNull();
  });

  it("records page edits as one coalesced entry and keeps their text out", () => {
    const doc = { documentId: "d1", code: "D-1", title: "Kế hoạch", ownerId: "u1", spaceId: null, projectId: null, sharedWith: [], text: "nội dung mật", version: 1 };
    const { rows, prev } = chain([
      ev("work.document.created.v1", doc),
      ev("work.document.updated.v1", { ...doc, text: "nội dung mới", version: 2 }),
      ev("work.document.updated.v1", { ...doc, title: "Kế hoạch 2", text: "nội dung mới", sharedWith: ["u2"], version: 3 }),
    ]);
    expect(rows.map((r) => r.action)).toEqual(["work.document.created", "work.document.edited", "work.document.updated"]);
    expect(rows[1]!.coalesceMinutes).toBe(30);
    expect(rows[2]!.changes).toEqual({ title: { from: "Kế hoạch", to: "Kế hoạch 2" }, sharedWith: { added: ["u2"], removed: [] } });
    expect(JSON.stringify({ rows, prev })).not.toContain("nội dung");
  });

  it("drops the free text of approvals, decisions, leave and attendance notes", () => {
    const rows = [
      mapEvent(ev("work.approval.commented.v1", { approvalId: "a", title: "Mua laptop", authorId: "u", recipientId: "v", body: "giá bao nhiêu?" }), null, "user:u")!,
      mapEvent(
        ev("work.decision.proposed.v1", { decisionId: "d", title: "Chọn NCC", details: "chi tiết mật", projectId: null, deciderId: null, proposedBy: "u", source: null }),
        null,
        "user:u",
      )!,
      mapEvent(
        ev("employee.attendance.corrected.v1", {
          userId: "u",
          day: "2026-11-05",
          before: null,
          after: { checkIn: "2026-11-05T01:00:00Z", checkOut: null },
          correctedBy: "a",
          note: "ốm",
        }),
        null,
        "user:a",
      )!,
    ];
    const s = JSON.stringify(rows);
    expect(s).not.toMatch(/giá bao|chi tiết mật|"ốm"/);
  });

  it("scrubs what modules send as audit entries", () => {
    const m = mapEvent(
      ev("audit.entry.recorded.v1", {
        action: "work.file.downloaded",
        targetType: "file",
        targetId: "f",
        outcome: "success",
        meta: { body: "x", size: 3 },
        changes: { token: { from: "a", to: "b" } },
        coalesceMinutes: 10,
      }),
      null,
      "user:u",
    )!;
    expect(m.rows[0]).toMatchObject({ meta: { size: 3 }, changes: {}, coalesceMinutes: 10 });
  });

  it("knows which subject an event needs", () => {
    expect(subjectOf(ev("work.task.updated.v1", task))).toEqual({ type: "task", id: "t1" });
    expect(subjectOf(ev("chat.message.created.v1", {}))).toBeNull();
  });

  it("reads actors", () => {
    expect(parseActor("user:u1")).toEqual({ type: "user", id: "u1" });
    expect(parseActor("agent:a1")).toEqual({ type: "agent", id: "a1" });
    expect(parseActor("service:apikey:k1")).toEqual({ type: "apikey", id: "k1" });
    expect(parseActor("service:push")).toEqual({ type: "system", id: "push" });
    expect(parseActor("anonymous")).toEqual({ type: "anonymous", id: "" });
    expect(parseActor("signup:a@b.c")).toEqual({ type: "system", id: "" });
  });
});
