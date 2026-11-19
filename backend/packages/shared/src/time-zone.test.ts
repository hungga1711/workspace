import { describe, expect, it } from "vitest";
import { dayKey, ddmm, startOfDay, wallClock, zoneOffset } from "./time-zone.js";

describe("workspace time zone helpers", () => {
  it("reads the day and dd/mm in the zone, not the server's", () => {
    const evening = new Date("2026-10-15T18:30:00Z"); // 01:30 on the 16th in Vietnam
    expect(dayKey(evening, "Asia/Ho_Chi_Minh")).toBe("2026-10-16");
    expect(dayKey(evening, "Europe/London")).toBe("2026-10-15");
    expect(ddmm(evening, "Asia/Ho_Chi_Minh")).toBe("16/10");
    expect(wallClock(evening, "Asia/Ho_Chi_Minh").getUTCHours()).toBe(1);
  });

  it("follows daylight saving", () => {
    expect(zoneOffset(new Date("2026-07-01T12:00:00Z"), "Europe/Berlin")).toBe(2 * 3_600_000);
    expect(zoneOffset(new Date("2026-12-01T12:00:00Z"), "Europe/Berlin")).toBe(3_600_000);
  });

  it("finds the instant a day starts, on both sides of a daylight-saving change", () => {
    expect(startOfDay("2026-10-16", "Asia/Ho_Chi_Minh").toISOString()).toBe("2026-10-15T17:00:00.000Z");
    expect(startOfDay("2026-03-29", "Europe/Berlin").toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect(startOfDay("2026-03-30", "Europe/Berlin").toISOString()).toBe("2026-03-29T22:00:00.000Z");
  });
});
