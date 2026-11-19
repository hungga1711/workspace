import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, setWorkspaceTimeZone } from "@/lib/timezone";
import { addDays, at, fromZonedInput, isAllDay, monthGridStart, parts, weekStart, zonedInput } from "./calTime";

describe("calendar time (workspace zone, Vietnam by default)", () => {
  it("an event from midnight lasting a day or more is all-day; a long timed one is not", () => {
    const day = (k: string, n: number) => ({ startsAt: at(k).toISOString(), endsAt: at(addDays(k, n)).toISOString() });
    expect(isAllDay(day("2026-10-16", 1))).toBe(true);
    expect(isAllDay(day("2026-10-16", 3))).toBe(true);
    expect(isAllDay({ startsAt: at("2026-10-16", 8 * 60).toISOString(), endsAt: at("2026-10-17", 9 * 60).toISOString() })).toBe(false);
    expect(isAllDay({ startsAt: at("2026-10-16").toISOString(), endsAt: at("2026-10-16", 60).toISOString() })).toBe(false);
  });
  it("weeks start on Monday and month grids on the Monday before the 1st", () => {
    expect(weekStart("2026-10-11")).toBe("2026-10-05"); // Sunday → previous Monday
    expect(weekStart("2026-10-12")).toBe("2026-10-12");
    expect(monthGridStart("2026-10-20")).toBe("2026-09-28");
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
  it("a slot is the same instant in any browser time zone", () => {
    expect(at("2026-10-12", 9 * 60).toISOString()).toBe("2026-10-12T02:00:00.000Z");
    expect(parts("2026-10-12T02:00:00.000Z")).toEqual({ key: "2026-10-12", minutes: 540 });
    expect(parts("2026-10-11T17:30:00.000Z")).toEqual({ key: "2026-10-12", minutes: 30 });
  });
  it("date fields show and read times in the workspace zone, whatever the browser's", () => {
    expect(zonedInput("2026-10-28T10:00:00.000Z")).toBe("2026-10-28T17:00");
    expect(fromZonedInput("2026-10-28T17:00").toISOString()).toBe("2026-10-28T10:00:00.000Z");
    expect(fromZonedInput("2026-10-28").toISOString()).toBe("2026-10-27T17:00:00.000Z");
  });
  it("follows a workspace zone with daylight saving", () => {
    setWorkspaceTimeZone("Europe/Berlin");
    // 29 March 2026: clocks go from 02:00 to 03:00 (UTC+1 → UTC+2).
    expect(at("2026-03-28", 9 * 60).toISOString()).toBe("2026-03-28T08:00:00.000Z");
    expect(at("2026-03-30", 9 * 60).toISOString()).toBe("2026-03-30T07:00:00.000Z");
    expect(parts("2026-03-29T22:30:00.000Z")).toEqual({ key: "2026-03-30", minutes: 30 });
    expect(addDays("2026-03-28", 2)).toBe("2026-03-30");
  });
  afterAll(() => setWorkspaceTimeZone(DEFAULT_TIME_ZONE));
});
