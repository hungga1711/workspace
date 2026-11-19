import { describe, expect, it } from "vitest";
import { dateFormat, numberFormat } from "./intl";
import { makeFormat } from "./format";
import type { T } from "./i18n/core";

describe("shared Intl formatters", () => {
  it("returns one formatter per locale and option set", () => {
    const a = dateFormat("en-GB", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit" });
    expect(dateFormat("en-GB", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit" })).toBe(a);
    expect(dateFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit" })).not.toBe(a);
    expect(numberFormat("vi-VN", { maximumFractionDigits: 1 })).toBe(numberFormat("vi-VN", { maximumFractionDigits: 1 }));
  });

  it("still refuses an unknown time zone", () => {
    expect(() => dateFormat("en-GB", { timeZone: "Mars/Olympus" })).toThrow();
  });

  it("formats as before: today, yesterday and an older day", () => {
    const t = ((k: string) => k) as unknown as T;
    const f = makeFormat("en", t);
    const tz = "Asia/Ho_Chi_Minh";
    expect(f.dayLabel(new Date(), tz)).toBe("format.today");
    expect(f.dayLabel(new Date(Date.now() - 86400e3), tz)).toBe("format.yesterday");
    expect(f.dayLabel(new Date(Date.now() + 86400e3), tz)).toBe("format.tomorrow");
    expect(f.dayLabel("2020-03-02T05:00:00Z", tz)).toMatch(/^Monday, /);
    expect(f.number(1250.55)).toBe("1,250.6");
  });
});
