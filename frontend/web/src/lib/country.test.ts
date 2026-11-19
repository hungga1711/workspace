import { describe, expect, it } from "vitest";
import { COUNTRIES, COUNTRY_RULES, countryFromZone, hasFullYear, holidaysFor } from "./country";

describe("holidaysFor", () => {
  it("lists movable feasts and substitute days for the years it ships", () => {
    expect(holidaysFor("GB", 2026).map((h) => h.day)).toContain("2026-04-03"); // Good Friday
    expect(holidaysFor("GB", 2026).map((h) => h.day)).toContain("2026-12-28"); // Boxing Day substitute
    expect(holidaysFor("US", 2026).find((h) => h.day === "2026-11-26")?.name).toBe("Thanksgiving Day");
    expect(holidaysFor("VN", 2026).filter((h) => h.name === "Tết Nguyên đán")).toHaveLength(5);
  });
  it("falls back to fixed-date days for other years", () => {
    expect(hasFullYear("ES", 2030)).toBe(false);
    expect(holidaysFor("ES", 2030).map((h) => h.day)).toEqual(COUNTRY_RULES.ES.fixed.map(([md]) => `2030-${md}`));
  });
  it("never lists a weekend-only date twice and keeps every date valid", () => {
    for (const c of COUNTRIES)
      for (const y of [2026, 2027]) {
        const days = holidaysFor(c, y).map((h) => h.day);
        expect(new Set(days).size, `${c} ${y}`).toBe(days.length);
        for (const d of days) expect(Number.isNaN(Date.parse(`${d}T00:00:00Z`)), `${c} ${d}`).toBe(false);
      }
  });
});

describe("countryFromZone", () => {
  it("reads the country from the time zone, then a Vietnamese workspace in Asia", () => {
    expect(countryFromZone("Europe/Madrid", "es")).toBe("ES");
    expect(countryFromZone("America/Mexico_City", "es")).toBe("MX");
    expect(countryFromZone("Asia/Shanghai", "zh")).toBe("CN");
    expect(countryFromZone("Europe/Berlin", "vi")).toBeNull();
    expect(countryFromZone("UTC", "vi")).toBe("VN");
  });
});

describe("COUNTRY_RULES", () => {
  it("starts annual leave from each country's minimum", () => {
    expect(COUNTRY_RULES.VN.leaveDays).toBe(12);
    expect(COUNTRY_RULES.ES.leaveDays).toBe(22);
    expect(COUNTRY_RULES.CN.leaveDays).toBe(5);
    expect(COUNTRY_RULES.US.leaveStatutory).toBe(false);
  });
});
