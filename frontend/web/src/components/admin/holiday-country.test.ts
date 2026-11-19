import { describe, expect, it } from "vitest";
import { defaultHolidayCountry } from "./holiday-country";

describe("defaultHolidayCountry", () => {
  it("follows the workspace's time zone first", () => {
    expect(defaultHolidayCountry("Europe/London", "en")).toBe("GB");
    expect(defaultHolidayCountry("Europe/London", "vi")).toBe("GB");
    expect(defaultHolidayCountry("Asia/Ho_Chi_Minh", "en")).toBe("VN");
    expect(defaultHolidayCountry("America/Indiana/Indianapolis", "en")).toBe("US");
    expect(defaultHolidayCountry("Asia/Tokyo", "en")).toBe("JP");
  });
  it("falls back to Vietnam only for a Vietnamese workspace, otherwise suggests nothing", () => {
    expect(defaultHolidayCountry("UTC", "vi")).toBe("VN");
    expect(defaultHolidayCountry("UTC", "en")).toBeNull();
    expect(defaultHolidayCountry("Europe/Berlin", "en")).toBeNull();
    expect(defaultHolidayCountry("America/Sao_Paulo", "en")).toBeNull();
  });
});

describe("defaultHolidayCountry with a saved country", () => {
  it("prefers the workspace's own country setting", () => {
    expect(defaultHolidayCountry("Europe/London", "en", "ES")).toBe("ES");
    expect(defaultHolidayCountry("UTC", "en", "MX")).toBe("MX");
    expect(defaultHolidayCountry("Europe/Madrid", "en", null)).toBe("ES");
    expect(defaultHolidayCountry("Asia/Shanghai", "zh")).toBe("CN");
  });
});
