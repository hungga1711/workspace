import { describe, expect, it } from "vitest";
import { leaveDaySet, summarize, workingDayList } from "./attendance-summary.js";

describe("workingDayList", () => {
  it("keeps the work week and drops holidays", () => {
    // Mon 16 – Sun 22 Nov 2026, Thursday a holiday.
    expect(workingDayList("2026-11-16", "2026-11-22", new Set(["2026-11-19"]), [1, 2, 3, 4, 5])).toEqual(["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-20"]);
    expect(workingDayList("2026-11-16", "2026-11-22", new Set(), [1, 2, 3, 4, 5, 6])).toHaveLength(6);
  });
});

describe("summarize", () => {
  const days = ["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20"];
  const leave = leaveDaySet([{ start: "2026-11-18", end: "2026-11-18" }], days);
  it("counts present, late, leave and absent days up to the last countable day", () => {
    const s = summarize(
      days,
      [
        { day: "2026-11-16", lateMinutes: 12, hours: 8, missedCheckout: false },
        { day: "2026-11-16", lateMinutes: 0, hours: 1.25, missedCheckout: false },
        { day: "2026-11-19", lateMinutes: 0, hours: 0, missedCheckout: true },
      ],
      leave,
      "2026-11-19",
    );
    expect(s).toEqual({
      workingDays: 5,
      presentDays: 2,
      lateDays: 1,
      lateMinutes: 12,
      hours: 9.3,
      missedCheckouts: 1,
      leaveDays: 1,
      absentDays: 1,
      absentOn: ["2026-11-17"],
    });
  });
});
