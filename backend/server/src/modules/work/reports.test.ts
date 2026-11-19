import { describe, expect, it } from "vitest";
import { blockerChains } from "./reports.js";

describe("blockerChains", () => {
  it("follows open predecessors upstream and counts what waits downstream, stopping at cycles", () => {
    const edges = [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "c", to: "d" },
      { from: "c", to: "e" },
      { from: "x", to: "y" },
      { from: "y", to: "x" },
    ];
    const [c, x] = blockerChains(["c", "x"], edges);
    expect(c).toEqual({ id: "c", waitingOn: ["b", "a"], holdsUp: 2 });
    expect(x).toEqual({ id: "x", waitingOn: ["y"], holdsUp: 1 });
  });
});
