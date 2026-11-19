import { describe, expect, it } from "vitest";
import { dueAt, msg, renderMsg, texts } from "./texts.js";

describe("generated text per locale", () => {
  it("falls back to English for unknown locales; Chinese and Spanish have their own texts", () => {
    expect(texts(undefined).dayTitle).toBe(texts("en").dayTitle);
    expect(texts("fr").mentioned).toBe("You were mentioned");
    expect(texts("zh").mentioned).toBe("你被提及");
    expect(texts("es").taskAssigned("Plan")).toBe("Asignada a ti: Plan");
  });
  it("writes a stored due time in the reader's language and zone; older rows keep their text", () => {
    const when = dueAt("2026-11-12T17:00:00Z", "Europe/London");
    expect(texts("en").dueSoon(when, "Launch")).toMatch(/^Due soon \(Nov 12, 0?5:00\sPM\): Launch$/);
    expect(texts("zh").dueSoon(when, "Launch")).toContain("11月12日");
    expect(texts("es").overdue(when, "Launch")).toMatch(/^Vencida desde 12 nov/);
    expect(texts("en").dueSoon("29/10, 17:00", "Old")).toBe("Due soon (29/10, 17:00): Old");
  });
  it("renders a stored message in whichever language reads it", () => {
    const m = msg("approvalNeeded", "Laptop for Lan");
    expect(renderMsg(texts("en"), m)).toBe("Approval needed: Laptop for Lan");
    expect(renderMsg(texts("vi"), m)).toBe("Cần duyệt: Laptop for Lan");
    expect(renderMsg(texts("vi"), msg("mentioned"))).toBe("Bạn được nhắc tên");
    expect(renderMsg(texts("en"), JSON.parse(JSON.stringify(msg("leaveRequested", "Lan", 2))))).toBe("Lan requested 2 days off");
  });
  it("writes English with singular and plural counts", () => {
    const en = texts("en");
    expect(en.dayCounts(1, 2, 0)).toBe("1 task · 2 meetings · 0 approvals");
    expect(en.leaveRequested("Lan", 1)).toBe("Lan requested 1 day off");
    expect(en.meeting(false, "weekly", "Sync")).toBe("Weekly meeting invitation: Sync");
    expect(en.digest.subject(1, 0)).toBe("Today: 1 item to handle");
  });
  it("keeps the Vietnamese wording", () => {
    const vi = texts("vi");
    expect(vi.meeting(false, null, "Họp")).toBe("Lời mời họp: Họp");
    expect(vi.leaveItem("Lan", 2)).toBe("Nghỉ phép: Lan (2 ngày)");
    expect(vi.leaveRange("2026-10-15", "2026-10-16")).toBe("15/10 → 16/10");
  });
  it("has a push title for every kind in both languages", () => {
    expect(Object.keys(texts("en").push).sort()).toEqual(Object.keys(texts("vi").push).sort());
  });
});

describe("sensitive-data alert", () => {
  it("names every kind and source in the reader's language, the company keyword included", () => {
    expect(texts("vi").aiFlagged(["keyword", "contacts"], "perplexity")).toBe("Dữ liệu nhạy cảm (từ khoá công ty đặt, danh sách liên hệ) vừa được gửi vào Perplexity");
    expect(texts("en").aiFlagged(["keyword"], "company")).toBe("Sensitive data (company keyword) was just sent to the company assistant");
  });
});
