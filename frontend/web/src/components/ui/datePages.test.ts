import { describe, expect, it } from "vitest";
import { dayParam, yearPage, yearPageStart } from "./datePages";

describe("yearPage", () => {
  it("shows the decade with a year either side", () => {
    expect(yearPageStart(2026)).toBe(2019);
    expect(yearPage(2024)).toEqual([2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026, 2027, 2028, 2029, 2030]);
    expect(yearPage(2030)[0]).toBe(2029);
  });
});

describe("dayParam", () => {
  it("keeps real days", () => {
    expect(dayParam("2024-02-29")).toBe("2024-02-29");
    expect(dayParam("2026-11-11")).toBe("2026-11-11");
  });
  it("drops anything else", () => {
    for (const v of ["2023-02-29", "2024-13-01", "2024-1-1", "20240101", "", null, undefined, "0001-01-01", "2024-01-01T00:00"]) expect(dayParam(v)).toBeNull();
  });
});
