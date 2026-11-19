import { describe, expect, it } from "vitest";
import { boardLines } from "./whiteboard.js";
import { clusterNotes, parseBoardLines, suggestIdeas, summarizeBoard } from "./whiteboard-local.js";

const retroEn = boardLines({
  stickies: [
    { elementId: "n1", text: "Code reviews were fast", x: 0, y: 100 },
    { elementId: "n2", text: "Release notes were late", x: 340, y: 100 },
    { elementId: "n3", text: "Customers liked the new onboarding", x: 0, y: 320 },
    { elementId: "n4", text: "Automate release notes", x: 680, y: 100 },
    { elementId: "n5", text: "", x: 680, y: 320 },
  ],
  labels: [
    { text: "Went well", x: 16, y: 14 },
    { text: "To improve", x: 356, y: 14 },
    { text: "Actions", x: 696, y: 14 },
  ],
});

describe("board lines", () => {
  it("round-trip: what the controller writes, the local model reads", () => {
    const { notes, labels } = parseBoardLines(retroEn);
    expect(notes.map((n) => n.id)).toEqual(["n1", "n2", "n3", "n4"]);
    expect(labels.map((l) => l.text)).toEqual(["Went well", "To improve", "Actions"]);
  });
});

describe("summarizeBoard", () => {
  it("puts notes under the heading of their column, in English", () => {
    const s = summarizeBoard("Sprint 12 retro", retroEn, "en");
    expect(s).toBe(
      "**Sprint 12 retro** · 4 notes\n\n### Went well\n- Code reviews were fast\n- Customers liked the new onboarding\n\n### To improve\n- Release notes were late\n\n### Actions\n- Automate release notes",
    );
  });

  it("writes Vietnamese, and lists notes without headings as one list", () => {
    const lines = boardLines({
      stickies: [
        { elementId: "a", text: "Giảm thời gian chờ duyệt", x: 0, y: 0 },
        { elementId: "b", text: "Thêm mẫu báo giá", x: 240, y: 0 },
      ],
      labels: [],
    });
    expect(summarizeBoard("Ý tưởng quý 4", lines, "vi")).toBe("**Ý tưởng quý 4** · 2 ghi chú\n\n- Giảm thời gian chờ duyệt\n- Thêm mẫu báo giá");
    expect(summarizeBoard("Trống", "", "vi")).toBe("Bảng trắng này chưa có nội dung.");
  });
});

describe("clusterNotes", () => {
  it("groups notes sharing a word, every note once, the rest under Other", () => {
    const g = clusterNotes(retroEn, "en");
    expect(g).toEqual([
      { title: "Release notes", elementIds: ["n2", "n4"] },
      { title: "Other", elementIds: ["n1", "n3"] },
    ]);
  });

  it("groups Vietnamese notes by a shared word, accents kept in the title", () => {
    const lines = boardLines({
      stickies: [
        { elementId: "a", text: "Khách hàng chờ phản hồi lâu", x: 0, y: 0 },
        { elementId: "b", text: "Gọi lại khách hàng cũ", x: 0, y: 0 },
        { elementId: "c", text: "Báo giá gửi chậm", x: 0, y: 0 },
        { elementId: "d", text: "Mẫu báo giá mới", x: 0, y: 0 },
      ],
      labels: [],
    });
    const g = clusterNotes(lines, "vi");
    expect(g.map((x) => x.elementIds.sort())).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(g.map((x) => x.title)).toEqual(["Khách hàng", "Báo giá"]);
  });
});

describe("suggestIdeas", () => {
  it("suggests concrete notes about the request, in the reader's language", () => {
    const en = suggestIdeas("Sprint 12 retro", retroEn, "Onboarding", "en");
    expect(en).toHaveLength(6);
    expect(en[0]).toBe("Ask three customers what is hardest about onboarding");
    const vi = suggestIdeas("Kế hoạch quý 4", "", "", "vi", 3);
    expect(vi).toEqual([
      "Hỏi ba khách hàng điều gì khó nhất về kế hoạch quý 4",
      "Liệt kê việc nhỏ làm ngay được cho kế hoạch quý 4 trong tuần này",
      "Chọn một con số cho thấy kế hoạch quý 4 đang hiệu quả",
    ]);
    // "Ý tưởng cho …" / "Ideas for …" asks about what follows.
    expect(suggestIdeas("", "", "Ý tưởng cho tuyển dụng", "vi", 1)).toEqual(["Hỏi ba khách hàng điều gì khó nhất về tuyển dụng"]);
  });

  it("does not repeat a note already on the board, and keeps acronyms as written", () => {
    const lines = boardLines({ stickies: [{ elementId: "a", text: "Ask three customers what is hardest about CRM", x: 0, y: 0 }], labels: [] });
    expect(suggestIdeas("", lines, "CRM", "en")[0]).toBe("List quick wins for CRM we can ship this week");
  });
});
