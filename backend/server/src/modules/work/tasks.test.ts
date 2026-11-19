import { describe, expect, it } from "vitest";
import { nextDue } from "./tasks.js";

const VN = "Asia/Ho_Chi_Minh";

const d = (s: string) => new Date(s);
const now = d("2026-10-09T03:00:00Z");

describe("nextDue", () => {
  it("steps weekly / biweekly / daily from the previous due date", () => {
    expect(nextDue(d("2026-10-10T10:00:00Z"), "weekly", VN, now).toISOString()).toBe("2026-10-17T10:00:00.000Z");
    expect(nextDue(d("2026-10-10T10:00:00Z"), "biweekly", VN, now).toISOString()).toBe("2026-10-24T10:00:00.000Z");
    expect(nextDue(d("2026-10-10T10:00:00Z"), "daily", VN, now).toISOString()).toBe("2026-10-11T10:00:00.000Z");
  });
  it("skips forward past now when finished late (no overdue backlog)", () => {
    expect(nextDue(d("2026-09-01T10:00:00Z"), "weekly", VN, now).toISOString()).toBe("2026-10-13T10:00:00.000Z");
  });
  it("weekdays skips the weekend in Vietnam time", () => {
    expect(nextDue(d("2026-10-09T10:00:00Z"), "weekdays", VN, now).toISOString()).toBe("2026-10-12T10:00:00.000Z"); // Fri → Mon
  });
  it("monthly keeps the day, or the last day of a shorter month", () => {
    expect(nextDue(d("2026-10-31T10:00:00Z"), "monthly", VN, now).toISOString()).toBe("2026-11-30T10:00:00.000Z");
    expect(nextDue(d("2026-11-15T02:00:00Z"), "monthly", VN, now).toISOString()).toBe("2026-12-15T02:00:00.000Z");
  });
});
