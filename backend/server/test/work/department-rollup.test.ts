import { describe, expect, it } from "vitest";
import { departmentRollup, weeklyReport } from "../../src/modules/work/followup.js";

const person = (userId: string, department: string | null, n: Partial<Parameters<typeof departmentRollup>[0][number]> = {}) => ({
  userId,
  department,
  open: 0,
  inProgress: 0,
  overdue: 0,
  atRisk: 0,
  stale: 0,
  blocked: 0,
  done7: 0,
  done28: 0,
  onTimeRate: null,
  avgProgress: null,
  ...n,
});

describe("departmentRollup", () => {
  it("adds people up per department, weights on-time by finished work and puts late departments first (no department last)", () => {
    const r = departmentRollup([
      person("a", "Kỹ thuật", { open: 4, overdue: 3, done28: 8, onTimeRate: 50, avgProgress: 40, doneWeeks: [1, 2, 2, 3] }),
      person("b", "Kỹ thuật", { open: 2, done28: 2, onTimeRate: 100, avgProgress: 80, doneWeeks: [0, 0, 1, 1] }),
      person("c", "Kinh doanh", { open: 1, done7: 2, done28: 4, onTimeRate: 100 }),
      person("d", null, { open: 1 }),
    ]);
    expect(r.map((d) => d.name)).toEqual(["Kỹ thuật", "Kinh doanh", null]);
    const eng = r[0]!;
    expect(eng).toMatchObject({ people: 2, open: 6, overdue: 3, health: "risk", avgProgress: 60, userIds: ["a", "b"], doneWeeks: [1, 2, 3, 4] });
    // (50×8 + 100×2) / 10 = 60, not the plain average 75
    expect(eng.onTimeRate).toBe(60);
    expect(r[1]).toMatchObject({ health: "ok", onTimeRate: 100, done7: 2 });
    expect(r[2]).toMatchObject({ onTimeRate: null, avgProgress: null });
  });
});

describe("weeklyReport", () => {
  it("has a department table and an AI section when there is data, and neither when there is none", () => {
    const team = {
      people: [],
      totals: { open: 0, overdue: 0, atRisk: 0, stale: 0, blocked: 0, done7: 0 },
      departments: departmentRollup([person("a", "Kỹ thuật", { inProgress: 2, overdue: 1, done28: 4, onTimeRate: 75, avgProgress: 40 })]),
    } as unknown as Parameters<typeof weeklyReport>[0];
    const mine = { summary: { open: 0, overdue: 0, stale: 0, blocked: 0, atRisk: 0, done14: 0 }, tasks: [] } as unknown as Parameters<typeof weeklyReport>[1];
    const ai = {
      totals: { people: 3, active: 2, prompts: 10, outside: 4, flagged: 1 },
      people: [{ userId: "a", displayName: "Lan <b>", prompts: 10, flagged: 1, sources: { chatgpt: 4, company: 6 }, topics: { code: 7, writing: 3 } }],
    };
    const r = weeklyReport(team, mine, new Map([["a", "Lan"]]), "vi", new Date("2026-10-13T03:00:00Z"), ai, [
      { title: "Doanh thu quý", department: null, progress: 30, expected: 14, health: "on_track" },
    ]);
    expect(r.html).toContain("<h2>Mục tiêu quý</h2>");
    expect(r.html).toContain("<td><p>Doanh thu quý</p></td><td><p>Toàn công ty</p></td><td><p>30%</p></td><td><p>14%</p></td><td><p>Đúng tiến độ</p></td>");
    expect(r.html).toContain("<h2>Theo phòng ban</h2>");
    expect(r.html).toContain("<td><p>Kỹ thuật</p></td><td><p>2</p></td><td><p>1</p></td>");
    expect(r.html).toContain("<td><p>40%</p></td><td><p>75%</p></td>");
    expect(r.html).toContain("2/3 người dùng AI, 10 câu hỏi, 40% trên ChatGPT, Claude, Gemini, 1 cảnh báo dữ liệu nhạy cảm.");
    expect(r.html).toContain("Trợ lý AI công ty, ChatGPT");
    expect(r.html).toContain("Lập trình, Soạn thảo");
    const bare = weeklyReport({ ...team, departments: [] } as typeof team, mine, new Map(), "en", new Date(), null);
    expect(bare.html).not.toContain("By department");
    expect(bare.html).not.toContain("AI this week");
  });
});
