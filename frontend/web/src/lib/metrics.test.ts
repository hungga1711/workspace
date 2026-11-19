import { describe, expect, it } from "vitest";
import { chartable, compareOutcomes, enoughToCompare, firstShown, MIN_COMPARE_SAMPLE, periodsWithData, share } from "./metrics";

describe("sample gating", () => {
  it("compares only when both groups reach the minimum", () => {
    expect(MIN_COMPARE_SAMPLE).toBe(20);
    expect(enoughToCompare(7, 6)).toBe(false);
    expect(enoughToCompare(20, 19)).toBe(false);
    expect(enoughToCompare(20, 25)).toBe(true);
  });
  it("has no share without a denominator", () => {
    expect(share(0, 0)).toBeNull();
    expect(share(0, 4)).toBe(0);
    expect(share(3, 4)).toBe(75);
  });
});

describe("period trimming", () => {
  it("drops empty leading periods and keeps at least four", () => {
    expect(firstShown([[0, 0, 0, 0, 0, 0, 2, 5]])).toBe(4);
    expect(firstShown([[0, 0, 1, 0, 0, 0, 2, 5]])).toBe(2);
    // A second series counts too.
    expect(
      firstShown([
        [0, 0, 0, 0, 0, 0, 0, 5],
        [0, 3, 0, 0, 0, 0, 0, 0],
      ]),
    ).toBe(1);
    expect(firstShown([[0, 0, 0]])).toBe(0);
    expect(firstShown([[0, 0, 0, 0, 0, 0, 0, 0]])).toBe(4);
  });
  it("asks for three periods with data before drawing a chart", () => {
    expect(
      periodsWithData([
        [0, 0, 2, 5],
        [0, 1, 0, 0],
      ]),
    ).toBe(3);
    expect(chartable([[0, 0, 0, 0, 0, 0, 2, 5]])).toBe(false);
    expect(chartable([[0, 1, 0, 0, 0, 0, 2, 5]])).toBe(true);
  });
});

describe("compareOutcomes", () => {
  const g = (done: number, dated: number, onTime: number, cycleDays: number | null) => ({ done, dated, onTime, cycleDays });
  it("compares both figures with the counts behind them", () => {
    expect(compareOutcomes(g(40, 30, 27, 2.1), g(120, 100, 57, 4.9))).toEqual({
      days: { ai: 2.1, other: 4.9, nAi: 40, nOther: 120 },
      onTime: { ai: 90, other: 57, nAi: 30, nOther: 100 },
    });
  });
  it("hides a figure when either side is under the minimum", () => {
    const r = compareOutcomes(g(19, 19, 10, 2), g(200, 150, 90, 5));
    expect(r.days).toBeNull();
    expect(r.onTime).toBeNull();
  });
  it("gates on-time by dated tasks, not finished ones", () => {
    const r = compareOutcomes(g(30, 12, 10, 2), g(30, 25, 20, 3));
    expect(r.days).not.toBeNull();
    expect(r.onTime).toBeNull();
  });
  it("takes a custom minimum", () => {
    expect(compareOutcomes(g(5, 5, 4, 1), g(5, 5, 2, 2), 5).onTime).toEqual({ ai: 80, other: 40, nAi: 5, nOther: 5 });
  });
});
