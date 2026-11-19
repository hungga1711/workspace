import { describe, expect, it } from "vitest";
import { AREA_TOOLS, areasOf, selectTools } from "./tool-select.js";
import { EXTRA_READ, EXTRA_WRITE } from "./tools-extra.js";

const all = ["search_workspace", "read_item", "create_task", "list_my_tasks", "needs_my_attention", ...Object.values(AREA_TOOLS).flat()];

describe("selectTools", () => {
  it("keeps every tool outside the areas, and adds only the areas a question points to", () => {
    const shown = selectTools(all, "Ai đang quá tải trong phòng Sales?");
    expect(shown.has("search_workspace")).toBe(true);
    expect(shown.has("needs_my_attention")).toBe(true);
    expect(shown.has("workload_balance")).toBe(true);
    expect(shown.has("create_whiteboard_diagram")).toBe(false);
    expect(shown.has("import_tasks")).toBe(false);
  });

  it("brings the place's own tools: a channel the chat tools, a task the task tools", () => {
    expect(selectTools(all, "thanks", "channel").has("summarize_channel")).toBe(true);
    expect(selectTools(all, "thanks", "task").has("split_task")).toBe(true);
    expect(selectTools(all, "thanks").has("summarize_channel")).toBe(false);
  });

  it("shows everything when there is no question (a resumed answer)", () => {
    expect(selectTools(all, undefined).size).toBe(all.length);
    expect(selectTools(all, "  ").size).toBe(all.length);
  });

  it("reads Vietnamese without accents, English, and AI words without taking 'ai' (who) for AI", () => {
    expect(areasOf("Tôi đã bỏ lỡ gì ở kênh này?").has("chat")).toBe(true);
    expect(areasOf("Find a meeting slot for Lan and Minh").has("people")).toBe(true);
    expect(areasOf("Ai dùng ChatGPT nhiều nhất?").has("ai")).toBe(true);
    expect(areasOf("ai đang rảnh?").has("ai")).toBe(false);
    expect(areasOf("Import this Jira CSV").has("data")).toBe(true);
    expect(areasOf("Vẽ sơ đồ quy trình duyệt chi").has("whiteboard")).toBe(true);
    expect(areasOf("Nói về kế hoạch").has("whiteboard")).toBe(false);
  });

  it("lists every area tool that exists, and only those", () => {
    const real = new Set([...EXTRA_READ.map((t) => t.name), ...EXTRA_WRITE.map((w) => w.tool.name)]);
    const listed = Object.values(AREA_TOOLS).flat();
    expect(listed.filter((n) => !real.has(n))).toEqual([]);
    // needs_my_attention is core on purpose: "what should I do" is asked in any words.
    expect([...real].filter((n) => !listed.includes(n))).toEqual(["needs_my_attention"]);
  });

  it("finds the area in the everyday words people use, with or without accents", () => {
    const cases: [string, string][] = [
      ["find a time to meet with Minh tomorrow", "people"],
      ["schedule a call with An", "people"],
      ["gặp Minh lúc nào được?", "people"],
      ["who hasn't replied to me", "chat"],
      ["toi bo lo gi o kenh nay?", "chat"],
      ["ai dang qua tai?", "reports"],
      ["tach viec T-12 thanh viec con", "tasks"],
      ["xuất danh sách việc trễ ra excel", "data"],
      ["dịch trang Launch plan sang tiếng Anh", "docs"],
      ["lap danh sach onboarding cho nhan vien moi", "tasks"],
    ];
    for (const [q, area] of cases) expect([...areasOf(q)], q).toContain(area);
  });
});
