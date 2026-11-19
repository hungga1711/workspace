import { describe, expect, it } from "vitest";
import { MAX_OCCURRENCES, occurrences } from "./calendar.js";

const VN = "Asia/Ho_Chi_Minh";

const d = (s: string) => new Date(s);
const iso = (xs: Date[]) => xs.map((x) => x.toISOString());

describe("occurrences", () => {
  it("weekly keeps the same time each week until the end date (inclusive)", () => {
    expect(iso(occurrences(d("2026-10-12T02:00:00Z"), "weekly", d("2026-11-02T02:00:00Z"), VN))).toEqual([
      "2026-10-12T02:00:00.000Z",
      "2026-10-19T02:00:00.000Z",
      "2026-10-26T02:00:00.000Z",
      "2026-11-02T02:00:00.000Z",
    ]);
  });

  it("weekdays skips Saturday and Sunday in the organizer's zone, even when UTC is on another day", () => {
    // 06:30 in Hanoi on Friday 16 Oct is still Thursday 23:30 UTC.
    const r = occurrences(d("2026-10-15T23:30:00Z"), "weekdays", d("2026-10-20T00:00:00Z"), VN);
    expect(r.map((x) => new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Ho_Chi_Minh", weekday: "short" }).format(x))).toEqual(["Fri", "Mon", "Tue"]);
    expect(occurrences(d("2026-10-15T23:30:00Z"), "weekdays", d("2026-10-20T00:00:00Z"), "UTC").length).toBe(3); // Thu, Fri, Mon in UTC
  });

  it("monthly keeps the day of month and skips months without it", () => {
    expect(iso(occurrences(d("2026-01-31T03:00:00Z"), "monthly", d("2026-06-01T00:00:00Z"), VN))).toEqual([
      "2026-01-31T03:00:00.000Z",
      "2026-03-31T03:00:00.000Z",
      "2026-05-31T03:00:00.000Z",
    ]);
  });

  it("is capped at a year and at MAX_OCCURRENCES", () => {
    expect(occurrences(d("2026-01-01T02:00:00Z"), "daily", d("2030-01-01T00:00:00Z"), VN)).toHaveLength(MAX_OCCURRENCES);
    const weekly = occurrences(d("2026-01-01T02:00:00Z"), "weekly", d("2030-01-01T00:00:00Z"), VN);
    expect(weekly.length).toBe(53);
    expect(weekly.at(-1)!.getTime() - weekly[0]!.getTime()).toBeLessThanOrEqual(366 * 86400_000);
  });
});
