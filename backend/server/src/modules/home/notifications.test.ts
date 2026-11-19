import { describe, expect, it } from "vitest";
import { groupKeyOf, groupsOf, present, type NotificationRow } from "./notifications.js";
import { msg, texts } from "./texts.js";

const row = (o: Partial<NotificationRow>): NotificationRow => ({
  id: o.id ?? "n1",
  grp: "action",
  kind: "approval.requested",
  title: "Cần duyệt: Laptop",
  body: "",
  url: "/app/work/approvals/a1",
  readAt: null,
  createdAt: "2026-11-08T09:00:00Z",
  titleMsg: null,
  bodyMsg: null,
  actorId: null,
  groupKey: null,
  params: {},
  goneAt: null,
  ...o,
});

describe("notifications in the reader's language", () => {
  it("writes the stored message in the reader's language and keeps old text otherwise", () => {
    const r = row({ titleMsg: msg("approvalNeeded", "Laptop") });
    expect(present(texts("en"), r).title).toBe("Approval needed: Laptop");
    expect(present(texts("vi"), r).title).toBe("Cần duyệt: Laptop");
    expect(present(texts("en"), row({})).title).toBe("Cần duyệt: Laptop");
    // A message key this version no longer has falls back to the text written at the time.
    expect(present(texts("en"), row({ titleMsg: { k: "gone", a: [] } })).title).toBe("Cần duyệt: Laptop");
  });
  it("a deleted task or page keeps its notice but loses the link", () => {
    const n = present(texts("en"), row({ goneAt: "2026-11-08T10:00:00Z" }));
    expect(n).toMatchObject({ gone: true, url: "" });
  });
});

describe("grouping a burst", () => {
  it("keys approvals by kind, comments by task or page, mentions by task or channel", () => {
    expect(groupKeyOf("approval.requested", "a1", "/app/work/approvals/a1")).toBe("approval.requested");
    expect(groupKeyOf("task.commented", "t1", "/app/work/tasks/t1")).toBe("task.commented:t1");
    expect(groupKeyOf("task.mention", "c9", "/app/work/tasks/t1?c=c9")).toBe("task.mention:t1");
    expect(groupKeyOf("mention", "m1", "/app/chat/ch1?m=m1")).toBe("mention:ch1");
    expect(groupKeyOf("meeting.invited", "e1", "/app/work/meetings/e1")).toBe("meeting.invited");
    expect(groupKeyOf("task.due", "t1", "/app/work/tasks/t1")).toBe("task.due");
  });
  it("groups two or more unread rows, newest first, with the distinct people", () => {
    const rows = [
      row({ id: "a", kind: "task.commented", groupKey: "task.commented:t1", actorId: "lily", params: { code: "T-215" } }),
      row({ id: "b", kind: "task.commented", groupKey: "task.commented:t1", actorId: "tom" }),
      row({ id: "c", kind: "task.commented", groupKey: "task.commented:t1", actorId: "lily" }),
      row({ id: "d", kind: "task.commented", groupKey: "task.commented:t2", actorId: "lily" }),
      row({ id: "e", kind: "approval.requested", groupKey: "approval.requested", readAt: "2026-11-08T09:30:00Z" }),
      row({ id: "f", kind: "approval.requested", groupKey: "approval.requested" }),
    ].map((r) => present(texts("en"), r));
    const groups = groupsOf(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: "task.commented:t1", count: 3, ids: ["a", "b", "c"], actorIds: ["lily", "tom"], params: { code: "T-215" } });
  });
});
