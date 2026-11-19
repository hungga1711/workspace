import { afterEach, describe, expect, it, vi } from "vitest";
import { makeFormat, weekdayDate } from "./format";
import { makeT } from "./i18n/dicts";

afterEach(() => vi.useRealTimers());
/** 2026-10-10 at the given hour in Ho Chi Minh City (UTC+7). */
const at = (h: number) => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(Date.UTC(2026, 9, 10, h - 7, 30)));
};

describe("greeting", () => {
  it("follows the clock in Vietnamese (vi-VN prints '11 giờ', which used to read as evening)", () => {
    const f = makeFormat("vi", makeT("vi"));
    at(8);
    expect(f.greeting()).toBe("Chào buổi sáng");
    at(12);
    expect(f.greeting()).toBe("Chào buổi trưa");
    at(15);
    expect(f.greeting()).toBe("Chào buổi chiều");
    at(21);
    expect(f.greeting()).toBe("Chào buổi tối");
  });
  it("is localized", () => {
    at(8);
    expect(makeFormat("en", makeT("en")).greeting()).toBe("Good morning");
    at(21);
    expect(makeFormat("vi", makeT("vi")).greeting()).toBe("Chào buổi tối");
  });
});

describe("makeT", () => {
  it("interpolates and picks the English plural form", () => {
    const t = makeT("en");
    expect(t("home.kpi.dueToday", { count: 1 })).toBe("1 due today");
    expect(t("home.projects.open", { count: 1 })).toBe("1 open task");
    expect(t("home.projects.open", { count: 3 })).toBe("3 open tasks");
  });
  it("uses the single Vietnamese form for every count", () => {
    const t = makeT("vi");
    expect(t("home.projects.open", { count: 1 })).toBe("1 việc đang mở");
    expect(t("home.projects.open", { count: 3 })).toBe("3 việc đang mở");
  });
  it("leaves unknown placeholders visible instead of printing undefined", () => {
    expect(makeT("en")("shell.top.account", {})).toBe("Account: {name}");
  });
});

describe("relative times", () => {
  it("formats ago and due labels per language", () => {
    at(12);
    const now = Date.now();
    expect(makeFormat("en", makeT("en")).ago(new Date(now - 5 * 60_000))).toBe("5 minutes ago");
    expect(makeFormat("vi", makeT("vi")).ago(new Date(now - 5 * 60_000))).toBe("5 phút trước");
    expect(makeFormat("en", makeT("en")).dueLabel(new Date(now - 2 * 86400e3).toISOString())).toEqual({ text: "2 days late", overdue: true });
  });
});

describe("English singular after interpolation", () => {
  it("turns '1 <plural>' into the singular, leaves other counts alone", async () => {
    const { singularize } = await import("./i18n/core");
    expect(singularize("of 1 members")).toBe("of 1 member");
    expect(singularize("1 people sent messages")).toBe("1 person sent messages");
    expect(singularize("1 open tasks · 11 days")).toBe("1 open task · 11 days");
    expect(singularize("2 tasks · 1.5 days")).toBe("2 tasks · 1.5 days");
  });
});

describe("day labels", () => {
  it("are capitalised on their own and lower-case inside a sentence", () => {
    const now = new Date();
    expect(makeFormat("vi", makeT("vi")).dayLabel(now)).toBe("Hôm nay");
    expect(makeFormat("vi", makeT("vi")).dayInline(now)).toBe("hôm nay");
    expect(makeFormat("en", makeT("en")).dayInline(new Date(now.getTime() + 86400e3))).toBe("tomorrow");
  });
});

describe("weekdayDate", () => {
  const d = new Date("2026-12-25T12:00:00Z");
  const f = (tag: string, month: "numeric" | "long") => new Intl.DateTimeFormat(tag, { timeZone: "Europe/London", weekday: "long", day: "numeric", month });
  it("joins the weekday and the date with a comma, whatever the engine's ICU does (server and browser agree)", () => {
    expect(weekdayDate(f("en-GB", "numeric"), d)).toBe("Friday, 25/12");
    expect(weekdayDate(f("en-GB", "long"), d)).toBe("Friday, 25 December");
    expect(weekdayDate(f("vi-VN", "numeric"), d)).toBe("Thứ Sáu, 25/12");
  });
});

describe("shortDate", () => {
  const d = "2026-11-09T10:00:00Z";
  it("names the month outside Vietnamese, so 9 Nov is never read as 11 Sep", () => {
    at(12);
    expect(makeFormat("en", makeT("en")).shortDate(d, "UTC")).toBe("Nov 9");
    expect(makeFormat("es", makeT("es")).shortDate(d, "UTC")).toBe("9 nov");
    expect(makeFormat("zh", makeT("zh")).shortDate(d, "UTC")).toBe("11月9日");
    expect(makeFormat("vi", makeT("vi")).shortDate(d, "UTC")).toBe("09/11");
  });
  it("adds the year for another year", () => {
    at(12);
    expect(makeFormat("en", makeT("en")).shortDate("2025-03-02T10:00:00Z", "UTC")).toBe("Mar 2, 2025");
    expect(makeFormat("vi", makeT("vi")).shortDate("2025-03-02T10:00:00Z", "UTC")).toBe("02/03/2025");
  });
});

describe("stamp", () => {
  const TZ = "Asia/Ho_Chi_Minh";
  it("shows the time today, 'yesterday' and the time, else the date and time", () => {
    at(15); // 2026-10-10 15:30 in Ho Chi Minh City
    const vi = makeFormat("vi", makeT("vi"));
    expect(vi.stamp("2026-10-10T07:05:00Z", TZ)).toBe("14:05");
    expect(vi.stamp("2026-10-09T07:05:00Z", TZ)).toBe(`${makeT("vi")("format.yesterday")} 14:05`);
    expect(vi.stamp("2026-10-01T07:05:00Z", TZ)).toBe("01/10 14:05");
    expect(makeFormat("en", makeT("en")).stamp("2026-10-09T07:05:00Z", TZ)).toBe("Yesterday 14:05");
  });
});
