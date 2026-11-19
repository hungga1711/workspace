import { describe, expect, it } from "vitest";
import type { ToolContext } from "./tools.js";
import { findChannel, lines, readable } from "./tools-chat.js";

const channels = [
  { id: "c1", kind: "public", name: "sales", displayName: "Sales", dmUserId: null, unread: 0, mentions: 0, lastReadSeq: 0 },
  { id: "c2", kind: "private", name: "sales-north", displayName: "Sales North", dmUserId: null, unread: 0, mentions: 0, lastReadSeq: 0 },
  { id: "c3", kind: "dm", name: null, displayName: null, dmUserId: "u-lan", unread: 0, mentions: 0, lastReadSeq: 0 },
];
const employees = [
  { userId: "me", displayName: "Minh" },
  { userId: "u-lan", displayName: "Nguyễn Thị Lan" },
  { userId: "u-huy", displayName: "Trần Huy" },
];
const client = (routes: Record<string, unknown>) => ({ request: async (_m: string, path: string) => routes[path.split("?")[0]!] }) as never;
const ctx = {
  principal: { type: "user", id: "me", teamIds: [], departmentId: null, grants: [] },
  agentId: null,
  lang: "en",
  timeZone: "Asia/Ho_Chi_Minh",
  services: { chat: client({ "/channels": { channels } }), employee: client({ "/employees": { employees } }), work: client({}) },
} as unknown as ToolContext;

describe("findChannel", () => {
  it("finds a channel by id, exact name with or without #, or the one loose match", async () => {
    expect((await findChannel(ctx, "c2")).id).toBe("c2");
    expect((await findChannel(ctx, "#sales")).id).toBe("c1");
    expect((await findChannel(ctx, "north")).id).toBe("c2");
  });
  it("finds the direct conversation with a colleague, and never makes one", async () => {
    expect((await findChannel(ctx, "lan")).id).toBe("c3");
    await expect(findChannel(ctx, "Huy")).rejects.toThrow(/no direct conversation/);
    await expect(findChannel(ctx, "nobody here")).rejects.toThrow(/not a channel/);
  });
});

describe("lines", () => {
  it("writes who said what, with thread replies indented", () => {
    const base = { channelId: "c1", seq: 1, authorType: "user", importAuthor: null, replyCount: 0, createdAt: "2026-11-17T02:05:00Z" };
    const out = lines(
      [
        { ...base, id: "m1", threadRootId: null, authorId: "u-lan", body: "Can you  send\nthe quote?", replyCount: 1 },
        { ...base, id: "m2", threadRootId: "m1", authorId: "me", body: "Sent" },
        { ...base, id: "m3", threadRootId: null, authorId: "me", body: "   " },
      ],
      new Map(employees.map((e) => [e.userId, e.displayName])),
      ctx,
    );
    expect(out.split("\n")).toEqual([
      expect.stringMatching(/^\[message m1\] .* Nguyễn Thị Lan: Can you send the quote\? \(1 replies\)$/),
      expect.stringMatching(/^ {2}↳ \[message m2\] .* Minh: Sent$/),
    ]);
  });
});

describe("readable", () => {
  it("shows mentions as names, never as user ids", () => {
    const names = new Map([["01M7KMY6064ZR1QATV3QHAS2W4", "Lan Nguyễn"]]);
    expect(readable("<@01M7KMY6064ZR1QATV3QHAS2W4> can you send it?", names)).toBe("@Lan Nguyễn can you send it?");
    expect(readable("<@gone> and <@01M7KMY6064ZR1QATV3QHAS2W4>", names)).toBe("@someone and @Lan Nguyễn");
  });
});
