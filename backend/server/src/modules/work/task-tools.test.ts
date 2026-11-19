import { describe, expect, it } from "vitest";
import { duplicatePairs, estimateDays, overlap, quantile, titleTokens } from "./task-tools.js";

describe("titleTokens", () => {
  it("folds accents and drops stop words", () => {
    expect([...titleTokens("Sửa lỗi đăng nhập cho trang chủ")]).toEqual(["sua", "loi", "dang", "nhap", "trang", "chu"]);
    expect([...titleTokens("Fix the login page")]).toEqual(["fix", "login", "page"]);
  });
});

describe("duplicatePairs", () => {
  const t = (id: string, title: string) => ({ id, title });
  it("pairs near-identical titles, best first", () => {
    const pairs = duplicatePairs([t("1", "Fix login page error"), t("2", "Fix the login page error"), t("3", "Write Q4 report"), t("4", "Fix login error page")]);
    expect(pairs.map((p) => [p.a.id, p.b.id].sort().join("-"))).toEqual(expect.arrayContaining(["1-2", "1-4", "2-4"]));
    expect(pairs.every((p) => p.a.id !== "3" && p.b.id !== "3")).toBe(true);
  });
  it("ignores one shared word between short titles", () => {
    expect(duplicatePairs([t("1", "Invoice"), t("2", "Invoice reminder email")])).toEqual([]);
  });
  it("matches across accents", () => {
    expect(duplicatePairs([t("1", "Báo cáo doanh thu tháng"), t("2", "Bao cao doanh thu thang")])).toHaveLength(1);
  });
});

describe("estimateDays", () => {
  const from = new Date("2026-11-17T09:00:00Z");
  const f = (code: string, title: string, days: number) => ({
    code,
    title,
    startedAt: new Date("2026-10-01T00:00:00Z"),
    completedAt: new Date(Date.parse("2026-10-01T00:00:00Z") + days * 86_400_000),
  });
  it("uses the similar finished tasks' median", () => {
    const r = estimateDays(
      "Write monthly sales report",
      [f("T-1", "Monthly sales report", 2), f("T-2", "Sales report October", 4), f("T-3", "Write sales report", 6), f("T-4", "Deploy server", 30)],
      from,
    );
    expect(r.basis).toBe("similar");
    expect(r.sample).toBe(3);
    expect(r.medianDays).toBe(4);
    expect(r.suggestedDueAt).toBe("2026-11-21T09:00:00.000Z");
  });
  it("falls back to everything when too few match", () => {
    const r = estimateDays("Design logo", [f("T-1", "Deploy server", 2), f("T-2", "Write docs", 4)], from);
    expect(r.basis).toBe("all");
    expect(r.medianDays).toBe(3);
  });
  it("has no estimate without data", () => {
    expect(estimateDays("x y", [], from).medianDays).toBeNull();
  });
});

describe("helpers", () => {
  it("overlap and quantile", () => {
    expect(overlap(new Set(["a", "b"]), new Set(["b", "c"]))).toBeCloseTo(1 / 3);
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([], 0.5)).toBeNull();
  });
});
