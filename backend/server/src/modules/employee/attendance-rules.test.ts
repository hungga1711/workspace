import { describe, expect, it } from "vitest";
import { isMissedCheckout, maxShiftHours } from "./attendance-rules.js";

const at = (iso: string) => new Date(iso);

describe("isMissedCheckout", () => {
  it("keeps a normal day open", () => {
    expect(isMissedCheckout(at("2026-11-07T01:30:00Z"), at("2026-11-07T10:30:00Z"), 16)).toBe(false);
  });
  it("keeps a night shift that crosses midnight (Asia/Ho_Chi_Minh 22:00 → 06:00)", () => {
    expect(isMissedCheckout(at("2026-11-07T15:00:00Z"), at("2026-11-07T23:00:00Z"), 16)).toBe(false);
  });
  it("treats yesterday's morning check-in as forgotten the next morning", () => {
    expect(isMissedCheckout(at("2026-11-06T01:30:00Z"), at("2026-11-07T01:25:00Z"), 16)).toBe(true);
  });
  it("uses the boundary strictly", () => {
    expect(isMissedCheckout(at("2026-11-07T00:00:00Z"), at("2026-11-07T16:00:00Z"), 16)).toBe(false);
    expect(isMissedCheckout(at("2026-11-07T00:00:00Z"), at("2026-11-07T16:00:01Z"), 16)).toBe(true);
  });
});

describe("maxShiftHours", () => {
  it("defaults to 16 and ignores values outside 4–24", () => {
    expect(maxShiftHours({})).toBe(16);
    expect(maxShiftHours({ ATTENDANCE_MAX_SHIFT_HOURS: "12" })).toBe(12);
    expect(maxShiftHours({ ATTENDANCE_MAX_SHIFT_HOURS: "48" })).toBe(16);
    expect(maxShiftHours({ ATTENDANCE_MAX_SHIFT_HOURS: "x" })).toBe(16);
  });
});
