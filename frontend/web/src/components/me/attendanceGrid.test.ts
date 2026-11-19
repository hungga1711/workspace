import { describe, expect, it } from "vitest";
import { addDays, calendarWeeks, leaveDays, level, monthStarts, weekday } from "./attendanceGrid";

describe("attendance calendar", () => {
  it("lays out Monday-first weeks ending with today's week", () => {
    const cols = calendarWeeks("2026-10-28", 53); // a Wednesday
    expect(cols).toHaveLength(53);
    expect(cols.every((w) => w.length === 7 && weekday(w[0]!) === 0)).toBe(true);
    expect(cols.at(-1)).toContain("2026-10-28");
    expect(cols[0]![0]).toBe(addDays("2026-10-26", -52 * 7));
  });

  it("labels the columns where a month starts", () => {
    // 1 November is in the last column but still ahead: no label for it yet.
    const starts = monthStarts(calendarWeeks("2026-10-28", 9), "2026-10-28");
    expect(starts.map((s) => s.month)).toEqual(["2026-09", "2026-10"]);
  });

  it("crosses a year end and keeps day boundaries", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(weekday("2027-01-03")).toBe(6);
  });

  it("shades by hours and expands leave ranges", () => {
    expect([0, 2, 5, 8, 10].map(level)).toEqual([0, 1, 2, 3, 4]);
    expect([...leaveDays([{ startDate: "2026-10-30", endDate: "2026-11-02" }])]).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
  });
});
