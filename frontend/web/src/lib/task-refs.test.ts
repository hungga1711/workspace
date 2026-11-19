import { describe, expect, it } from "vitest";
import { codeSource, taskCodePattern } from "./task-refs";

const re = (format?: string) => new RegExp(taskCodePattern(format)!, "gi");
const found = (text: string, format?: string) => text.match(re(format)) ?? [];

describe("task codes in text", () => {
  it("finds the default codes, not look-alikes", () => {
    expect(found("Xem T-041 và t-7, còn T-0412 nữa")).toEqual(["T-041", "T-0412"]);
    expect(found("ST-041 hay T-041x hay /T-041- không phải")).toEqual([]);
  });

  it("follows the workspace's format and still knows the default", () => {
    expect(found("TASK-2026-000123 rồi T-002", "TASK-{yyyy}-{seq6}")).toEqual(["TASK-2026-000123", "T-002"]);
  });

  it("refuses a format with nothing fixed to anchor on", () => {
    expect(codeSource("{id10}")).toBeNull();
    expect(codeSource("{seq3}")).toBeNull();
  });
});
