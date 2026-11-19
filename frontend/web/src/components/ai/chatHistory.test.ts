import { describe, expect, it } from "vitest";
import { dayBreaks } from "./chatHistory";

const TZ = "Asia/Ho_Chi_Minh";

describe("dayBreaks", () => {
  it("adds none when the thread stays within one day", () => {
    expect(
      dayBreaks(
        [
          { id: "a", at: "2026-11-10T02:00:00Z" },
          { id: "b", at: "2026-11-10T09:00:00Z" },
        ],
        TZ,
      ).size,
    ).toBe(0);
  });
  it("marks the first message and each new day, in the workspace's zone", () => {
    // 16:30 UTC on the 10th is already the 11th in Ho Chi Minh City.
    const rows = [
      { id: "a", at: "2026-11-10T02:00:00Z" },
      { id: "b", at: "2026-11-10T03:00:00Z" },
      { id: "c", at: "2026-11-10T17:30:00Z" },
      { id: "d", at: "2026-11-11T01:00:00Z" },
    ];
    expect([...dayBreaks(rows, TZ)].sort()).toEqual(["a", "c"]);
  });
  it("skips messages without a time", () => {
    expect([...dayBreaks([{ id: "a", at: "2026-11-09T02:00:00Z" }, { id: "b" }, { id: "c", at: "2026-11-10T02:00:00Z" }], TZ)].sort()).toEqual(["a", "c"]);
  });
});
