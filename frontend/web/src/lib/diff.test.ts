import { describe, expect, it } from "vitest";
import { diffLines } from "./diff";

describe("diffLines", () => {
  it("keeps common lines and marks removed and added ones in order", () => {
    expect(diffLines("# Quy chế\nĐiều 1\nĐiều 2", "# Quy chế\nĐiều 1 (sửa)\nĐiều 2\nĐiều 3")).toEqual([
      { type: "same", text: "# Quy chế" },
      { type: "del", text: "Điều 1" },
      { type: "add", text: "Điều 1 (sửa)" },
      { type: "same", text: "Điều 2" },
      { type: "add", text: "Điều 3" },
    ]);
  });
  it("handles empty sides and the size cap", () => {
    expect(diffLines("", "a")).toEqual([
      { type: "del", text: "" },
      { type: "add", text: "a" },
    ]);
    expect(diffLines("x\ny\nz", "x\ny\nz", 1).filter((l) => l.type !== "same")).toHaveLength(4);
  });
});
