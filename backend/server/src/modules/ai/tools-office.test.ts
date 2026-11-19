import { describe, expect, it } from "vitest";
import { selectTools } from "./tool-select.js";
import { fileName, WRITE } from "./tools-office.js";
import { previewOf, WORKSPACE_TOOL_NAMES, WORKSPACE_WRITE_TOOLS } from "./workspace-tools.js";

describe("the Office tools", () => {
  it("are registered, the ones that make files behind a card", () => {
    for (const n of ["read_office_file", "analyze_sheet", "explain_formula", "check_formulas"]) expect(WORKSPACE_TOOL_NAMES).toContain(n);
    for (const w of WRITE) expect(WORKSPACE_WRITE_TOOLS).toContain(w.tool.name);
    expect(WRITE.map((w) => w.tool.name)).toEqual([
      "create_word_document",
      "fill_word_template",
      "create_spreadsheet",
      "image_to_spreadsheet",
      "edit_spreadsheet",
      "create_presentation",
      "convert_office",
    ]);
  });

  it("are shown for office questions in Vietnamese (with or without accents), English and for an attached workbook", () => {
    const names = [...WORKSPACE_TOOL_NAMES];
    expect(selectTools(names, "Tạo file Excel bảng lương 5 nhân viên có cột tổng").has("create_spreadsheet")).toBe(true);
    expect(selectTools(names, "lam slide 5 trang gioi thieu du an").has("create_presentation")).toBe(true);
    expect(selectTools(names, "Make a deck about our launch").has("create_presentation")).toBe(true);
    expect(selectTools(names, "Tổng hợp theo phòng ban luong.xlsx").has("analyze_sheet")).toBe(true);
    expect(selectTools(names, "Ai đang quá tải?").has("create_spreadsheet")).toBe(false);
  });

  it("show PDF questions the Office tools, and the picture tool only when pictures come with the question", () => {
    const names = [...WORKSPACE_TOOL_NAMES];
    expect(selectTools(names, "tóm tắt hop-dong.pdf").has("read_office_file")).toBe(true);
    expect(selectTools(names, "xuất file này ra PDF").has("convert_office")).toBe(true);
    expect(selectTools(names, "Chuyển hóa đơn này thành bảng Excel", "ask", true).has("image_to_spreadsheet")).toBe(true);
    expect(selectTools(names, "nhap danh thiep vao bang", "ask", true).has("image_to_spreadsheet")).toBe(true);
    expect(selectTools(names, "Chuyển hóa đơn này thành bảng Excel").has("image_to_spreadsheet")).toBe(false);
    expect(selectTools(names, "Ảnh này là gì?", "ask", true).has("image_to_spreadsheet")).toBe(false);
  });

  it("keep what was read from a picture as data: no formula from a photo, unreadable cells flagged on the card", () => {
    const w = WRITE.find((x) => x.tool.name === "image_to_spreadsheet")!;
    const card = w.preview(
      {
        fileName: "Hóa đơn",
        columns: [{ header: "Ngày" }, { header: "Số tiền" }],
        rows: [
          ["2026-11-18", 120000],
          ["?", "=HYPERLINK(1)"],
        ],
      },
      "vi",
    );
    expect(card.fields.some((f) => f.value.includes("Ngày | Số tiền"))).toBe(true);
    expect(card.note).toMatch(/1 ô không đọc rõ/);
  });

  it("read a column's `name` as its header instead of refusing the call", () => {
    const w = WRITE.find((x) => x.tool.name === "image_to_spreadsheet")!;
    const input = w.tool.input.parse({ fileName: "x", columns: [{ name: "Mặt hàng" }, { title: "Số tiền", type: "currency" }], rows: [["A", 1]] }) as {
      columns: { header: string }[];
    };
    expect(input.columns.map((c) => c.header)).toEqual(["Mặt hàng", "Số tiền"]);
  });

  it("make clean file names with the right extension", () => {
    expect(fileName('Bảng lương: tháng 11/2026 "final".xlsx', "xlsx")).toBe("Bảng lương tháng 11 2026 final .xlsx".replace(" .", "."));
    expect(fileName("", "docx")).toBe("file.docx");
    expect(fileName("report.DOCX", "docx")).toBe("report.docx");
  });

  it("show what will be made and where, in both languages", () => {
    const sheet = previewOf(
      "create_spreadsheet",
      { fileName: "Lương", task: "T-12", sheets: [{ name: "T11", columns: [{ header: "Tên" }, { header: "Lương" }], rows: [["An", 1]], totals: true }] },
      "vi",
    )!;
    expect(sheet.title).toBe("Tạo tệp Excel");
    expect(sheet.fields).toEqual(
      expect.arrayContaining([
        { label: "Tệp", value: "Lương.xlsx" },
        { label: "Lưu vào", value: "Việc T-12" },
        { label: "Trang tính", value: "T11: Tên | Lương — 1 dòng + dòng tổng" },
      ]),
    );
    const deck = previewOf("create_presentation", { fileName: "Ra mắt", outline: "# Ra mắt\n## Mục tiêu\n- a\n## Lịch" }, "en")!;
    expect(deck.fields).toEqual(
      expect.arrayContaining([
        { label: "Saved to", value: "Your Drive" },
        { label: "Slides", value: "# Ra mắt\n## Mục tiêu\n## Lịch" },
      ]),
    );
    const edit = previewOf(
      "edit_spreadsheet",
      {
        file: "a.xlsx",
        ops: [
          { op: "set", cell: "B2", value: 5 },
          { op: "sort", column: "C", desc: true },
        ],
      },
      "en",
    )!;
    expect(edit.title).toMatch(/new file/);
    expect(edit.fields.find((f) => f.label === "Changes")?.value).toBe("set B2 = 5\nsort C");
    // A card never fails on a half-written input.
    for (const w of WRITE) expect(() => w.preview({}, "vi")).not.toThrow();
  });
});
