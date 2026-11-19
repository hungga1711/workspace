import { describe, expect, it } from "vitest";
import { costOf, shortTokens } from "./insights";

describe("costOf", () => {
  const models = [
    { provider: "c_1", model: "main-1", input: 1_000_000, output: 100_000 },
    { provider: null, model: "mystery", input: 5000, output: 500 },
  ];
  it("prices what has a price and counts what has none, never as free", () => {
    expect(costOf(models, { "main-1": { inputPerMTok: 2, outputPerMTok: 10, source: "list" }, mystery: null })).toEqual({ usd: 3, unpriced: 5500 });
  });
  it("is unknown when no model has a price, or the prices could not be read", () => {
    expect(costOf(models, { "main-1": null, mystery: null })).toEqual({ usd: null, unpriced: 1_105_500 });
    expect(costOf(models, null)).toEqual({ usd: null, unpriced: 1_105_500 });
    expect(costOf([], {})).toEqual({ usd: null, unpriced: 0 });
  });
});

describe("shortTokens", () => {
  it("reads in k and M", () => {
    expect([0, 950, 1240, 12_400, 999_400, 3_400_000, 34_000_000].map(shortTokens)).toEqual(["0", "950", "1.2k", "12k", "999k", "3.4M", "34M"]);
  });
});
