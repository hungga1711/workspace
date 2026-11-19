import { describe, expect, it } from "vitest";
import type { ChannelSummary } from "@/components/shell/types";
import { withIncoming, withRead } from "./liveChannels";

const ch = (id: string, over: Partial<ChannelSummary> = {}): ChannelSummary => ({
  id,
  kind: "public",
  name: id,
  unread: 0,
  mentions: 0,
  lastSeq: 0,
  lastReadSeq: 0,
  dmUserId: null,
  lastMessageAt: "2026-10-28T09:00:00.000Z",
  ...over,
});

describe("withIncoming", () => {
  it("counts the message and a mention of me on its conversation only", () => {
    const out = withIncoming([ch("a"), ch("b")], { channelId: "a", authorId: "u2", threadRootId: null, mentions: ["me"], createdAt: "2026-10-28T10:00:00.000Z" }, "me");
    expect(out[0]).toMatchObject({ unread: 1, mentions: 1, lastMessageAt: "2026-10-28T10:00:00.000Z" });
    expect(out[1]).toEqual(ch("b"));
  });

  it("leaves the conversation's place alone for a thread reply", () => {
    const out = withIncoming([ch("a", { unread: 2 })], { channelId: "a", authorId: "u2", threadRootId: "r1", createdAt: "2026-10-28T10:00:00.000Z" }, "me");
    expect(out[0]).toMatchObject({ unread: 3, mentions: 0, lastMessageAt: "2026-10-28T09:00:00.000Z" });
  });
});

describe("withRead", () => {
  it("takes the server's unread count and drops mentions once nothing is unread", () => {
    expect(withRead([ch("a", { unread: 4, mentions: 2 })], { channelId: "a", unread: 0 })[0]).toMatchObject({ unread: 0, mentions: 0 });
    expect(withRead([ch("a", { unread: 4, mentions: 2 })], { channelId: "a", unread: 1 })[0]).toMatchObject({ unread: 1, mentions: 2 });
  });
});
