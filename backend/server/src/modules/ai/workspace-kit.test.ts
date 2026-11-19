import { describe, expect, it } from "vitest";
import { matchNames } from "./workspace-kit.js";

const people = ["An Phạm", "Lan Nguyễn", "Thanh An", "Minh Lê", "Minh Trần", "Hoàng Anh"].map((displayName) => ({ displayName }));
const names = (who: string) => matchNames(people, who).map((p) => p.displayName);

describe("matchNames", () => {
  it("prefers whole names, then whole words, then word starts, then any part", () => {
    expect(names("Minh Lê")).toEqual(["Minh Lê"]);
    expect(names("minh le")).toEqual(["Minh Lê"]);
    // "An" is a whole word of two names, not every name that contains "an" (Lan, Hoàng Anh).
    expect(names("An")).toEqual(["An Phạm", "Thanh An"]);
    expect(names("an pham")).toEqual(["An Phạm"]);
    expect(names("Minh")).toEqual(["Minh Lê", "Minh Trần"]);
    expect(names("Hoa")).toEqual(["Hoàng Anh"]);
    expect(names("guyen")).toEqual(["Lan Nguyễn"]);
    expect(names("Bình")).toEqual([]);
    expect(names("  ")).toEqual([]);
  });
});
