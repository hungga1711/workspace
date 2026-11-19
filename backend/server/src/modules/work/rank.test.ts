import { describe, expect, it } from "vitest";
import { between } from "./rank.js";

describe("between", () => {
  it("orders between neighbours, at ends and when keys are adjacent", () => {
    const cases: [string | null, string | null][] = [
      [null, null],
      [null, "i"],
      ["i", null],
      ["a", "b"],
      ["a", "a1"],
      ["az", "b"],
      ["i", "i0i"],
      ["1", "2"],
    ];
    for (const [a, b] of cases) {
      const m = between(a, b);
      if (a !== null) expect(m > a).toBe(true);
      if (b !== null) expect(m < b).toBe(true);
    }
  });

  it("survives 500 repeated inserts at the front and between the same pair", () => {
    let first = between(null, null);
    for (let i = 0; i < 500; i++) {
      const n = between(null, first);
      expect(n < first).toBe(true);
      first = n;
    }
    let lo = "a";
    const hi = "b";
    for (let i = 0; i < 500; i++) {
      const m = between(lo, hi);
      expect(m > lo && m < hi).toBe(true);
      lo = m;
    }
  });

  it("rejects inverted bounds", () => {
    expect(() => between("b", "a")).toThrow();
  });
});
