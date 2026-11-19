import { describe, expect, it } from "vitest";
import { promptTaskCodes } from "./task-codes.js";

describe("promptTaskCodes", () => {
  it("finds task codes in the order typed, once each", () => {
    expect(promptTaskCodes("Summarise T-157 and compare with OPS-12, then T-157 again")).toEqual(["T-157", "OPS-12"]);
  });
  it("skips model names, standards and lower-case words", () => {
    expect(promptTaskCodes("GPT-4 vs COVID-19 under ISO-9001; also t-12 and foo-bar")).toEqual([]);
  });
  it("needs a clean boundary on both sides", () => {
    expect(promptTaskCodes("XT-157a ABT-1-2 (T-9) T-10.")).toEqual(["T-9", "T-10"]);
  });
  it("finds synced keys with digits in the prefix and ClickUp ids", () => {
    expect(promptTaskCodes("AB2-7 is blocked by #86b1x2y3z; branch CU-86b9q8w7e")).toEqual(["AB2-7", "#86B1X2Y3Z", "#86B9Q8W7E"]);
  });
  it("leaves plain numbers and words after # alone", () => {
    expect(promptTaskCodes("item #1234 and #heading and #1234567")).toEqual([]);
  });
  it("caps how many it returns", () => {
    expect(promptTaskCodes("T-1 T-2 T-3 T-4", 2)).toEqual(["T-1", "T-2"]);
  });
});
