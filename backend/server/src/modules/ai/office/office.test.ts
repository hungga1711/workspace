import { describe, expect, it } from "vitest";
import { checkFormulas, formulaFacts } from "./formulas.js";
import { checkOffice, OfficeRefused } from "./guard.js";
import { parseMarkdown } from "./markdown.js";
import { numberOf, parseCsv, readOffice, renderOffice, type Sheet } from "./read.js";
import { QueryProblem, runQuery } from "./sheet-query.js";
import { fillParagraph, fillTemplate, placeholdersOf } from "./template.js";
import { buildDocx } from "./write-docx.js";
import { buildPptx, imageSize, outlineToSlides } from "./write-pptx.js";
import { buildXlsx, editXlsx } from "./write-xlsx.js";
import { readBook, shiftFormula } from "./xlsx.js";
import { makeZip } from "./zip.js";

const sheetOf = async (buf: Buffer, name = "x.xlsx", i = 0): Promise<Sheet> => {
  const r = await readOffice(buf, name);
  if (r.kind !== "xlsx") throw new Error("not a workbook");
  return r.sheets[i]!;
};
const cell = (s: Sheet, ref: string) => s.cells.find((c) => c.ref === ref);

const PAYROLL = () =>
  buildXlsx([
    {
      name: "Lương",
      title: "Bảng lương 11/2026",
      columns: [
        { header: "Họ tên" },
        { header: "Phòng" },
        { header: "Ngày vào", type: "date" },
        { header: "Lương", type: "currency" },
        { header: "Thưởng", type: "currency" },
        { header: "Tổng", type: "currency" },
      ],
      rows: [
        ["Nguyễn Văn An", "IT", "2024-03-01", 20_000_000, 2_000_000, "=D4+E4"],
        ["Trần Bình", "IT", "15/06/2025", "18.000.000 ₫", 1_000_000, "=D5+E5"],
        ["Lê Chi", "HR", "2023-01-10", 15_000_000, 500_000, "=D6+E6"],
      ],
      totals: true,
    },
  ]);

describe("Excel workbooks", () => {
  it("writes live formulas, typed values and a totals row that read back the same", async () => {
    const s = await sheetOf(await PAYROLL());
    expect(s.name).toBe("Lương");
    expect(cell(s, "A1")?.value).toBe("Bảng lương 11/2026");
    expect(cell(s, "A4")?.value).toBe("Nguyễn Văn An");
    expect(cell(s, "C5")?.value).toBe("2025-06-15");
    // "18.000.000 ₫" in a currency column is the number.
    expect(cell(s, "D5")?.value).toBe(18_000_000);
    expect(cell(s, "F4")?.formula).toBe("D4+E4");
    expect(cell(s, "D7")?.formula).toBe("SUM(D4:D6)");
    expect(cell(s, "A7")?.value).toBe("Tổng");
  });

  it("moves formulas when rows and columns are inserted or deleted, as Excel does", async () => {
    const book = await PAYROLL();
    const ins = await sheetOf((await editXlsx(book, "p.xlsx", [{ op: "insertRows", at: 5, rows: [["Mới", "IT", null, 1, 1, "=D5+E5"]] }])).buffer);
    expect(cell(ins, "F4")?.formula).toBe("D4+E4");
    expect(cell(ins, "F6")?.formula).toBe("D6+E6");
    expect(cell(ins, "D8")?.formula).toBe("SUM(D4:D7)");
    const del = await sheetOf((await editXlsx(book, "p.xlsx", [{ op: "deleteRows", from: 5, count: 1 }])).buffer);
    expect(cell(del, "A5")?.value).toBe("Lê Chi");
    expect(cell(del, "F5")?.formula).toBe("D5+E5");
    expect(cell(del, "D6")?.formula).toBe("SUM(D4:D5)");
    const col = await sheetOf((await editXlsx(book, "p.xlsx", [{ op: "insertColumn", at: "C", header: "Ghi chú", headerRow: 3 }])).buffer);
    expect(cell(col, "C3")?.value).toBe("Ghi chú");
    expect(cell(col, "G4")?.formula).toBe("E4+F4");
    const gone = await sheetOf((await editXlsx(book, "p.xlsx", [{ op: "deleteColumn", column: "D" }])).buffer);
    // The formulas that read the deleted column say so.
    expect(cell(gone, "E4")?.formula).toContain("#REF!");
  });

  it("sorts rows with their own formulas, keeps the totals row last, adds totals, sheets and formats", async () => {
    const out = await editXlsx(await PAYROLL(), "p.xlsx", [
      { op: "sort", column: "D", desc: true, headerRow: 3 },
      { op: "renameSheet", from: "Lương", to: "Lương T11" },
      { op: "addSheet", name: "Tóm tắt", columns: ["Phòng", "Tổng"], rows: [["IT", "=SUMIF('Lương T11'!B4:B6,\"IT\",'Lương T11'!F4:F6)"]] },
      { op: "highlight", sheet: "Lương T11", range: "D4:D6", when: ">", value: 16_000_000, color: "green" },
      { op: "freeze", sheet: "Lương T11", rows: 3, columns: 1 },
    ]);
    expect(out.done).toHaveLength(5);
    const r = await readOffice(out.buffer, "p.xlsx");
    if (r.kind !== "xlsx") throw new Error();
    const s = r.sheets[0]!;
    expect(s.name).toBe("Lương T11");
    expect([cell(s, "A4")?.value, cell(s, "A5")?.value, cell(s, "A6")?.value]).toEqual(["Nguyễn Văn An", "Trần Bình", "Lê Chi"]);
    expect(cell(s, "F6")?.formula).toBe("D6+E6");
    expect(cell(s, "A7")?.value).toBe("Tổng");
    // Dates kept as dates through the rewrite.
    expect(cell(s, "C6")?.value).toBe("2023-01-10");
    expect(r.sheets[1]!.cells.find((c) => c.ref === "B2")?.formula).toContain("'Lương T11'!F4:F6");
    const book = readBook(new Map([["xl/workbook.xml", ""]]));
    expect(book.sheets).toEqual([]);
  });

  it("renaming a sheet updates the formulas of other sheets that read it", async () => {
    const two = await buildXlsx([
      { name: "Data", columns: [{ header: "N", type: "number" }], rows: [[1], [2]] },
      { name: "Sum", columns: [{ header: "Total" }], rows: [["=SUM(Data!A2:A3)"]] },
    ]);
    const out = await editXlsx(two, "t.xlsx", [{ op: "renameSheet", from: "Data", to: "Dữ liệu" }]);
    const r = await readOffice(out.buffer, "t.xlsx");
    if (r.kind !== "xlsx") throw new Error();
    expect(r.sheets[1]!.cells.find((c) => c.ref === "A2")?.formula).toBe("SUM('Dữ liệu'!A2:A3)");
  });

  it("reads shared formulas as each cell's own formula", () => {
    const sheet = `<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><f t="shared" ref="B1:B3" si="0">A1*2</f><v>2</v></c></row><row r="2"><c r="A2"><v>2</v></c><c r="B2"><f t="shared" si="0"/><v>4</v></c></row><row r="3"><c r="B3"><f t="shared" si="0"/></c></row></sheetData></worksheet>`;
    const book = readBook(
      new Map([
        ["xl/workbook.xml", `<workbook><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`],
        ["xl/_rels/workbook.xml.rels", `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`],
        ["xl/worksheets/sheet1.xml", sheet],
      ]),
    );
    expect(book.sheets[0]!.rows.map((r) => r.cells.find((c) => c.col === 1)?.formula)).toEqual(["A1*2", "A2*2", "A3*2"]);
  });

  it("copies references like Excel: $ parts stay, text in quotes is left alone", () => {
    expect(shiftFormula('SUM(A1:B2)+$C$1+D$1&"A1"', 2, 1)).toBe('SUM(B3:C4)+$C$1+E$1&"A1"');
    expect(shiftFormula("LOG10(A1)", 1, 0)).toBe("LOG10(A2)");
  });
});

describe("formula results stored with the formulas", () => {
  it("works out sums, arithmetic and totals of totals, and leaves what it cannot compute to Excel", async () => {
    const s = await sheetOf(
      await buildXlsx([
        {
          name: "S",
          columns: [{ header: "Tên" }, { header: "A", type: "number" }, { header: "B", type: "number" }, { header: "Kết quả" }],
          rows: [
            ["x", 10, 2, "=B2*C2+ROUND(B2/3,1)"],
            ["y", null, 4, "=B3+C3"],
            ["z", 5, 0, "=B4/C4"],
            ["w", 1, 1, '=IF(B5>0,"yes","no")'],
          ],
          totals: true,
        },
      ]),
    );
    expect(cell(s, "D2")?.value).toBe(23.3);
    // An empty cell counts as 0, as in Excel.
    expect(cell(s, "D3")?.value).toBe(4);
    // Division by zero and IF are left to Excel: no stored result.
    expect(cell(s, "D4")?.value).toBeNull();
    expect(cell(s, "D5")?.value).toBeNull();
    expect(cell(s, "B6")?.value).toBe(16);
    expect(cell(s, "C6")?.value).toBe(7);
  });

  it("keeps shares of a total adding up to exactly 1", async () => {
    const s = await sheetOf(
      await buildXlsx([
        {
          name: "S",
          columns: [{ header: "Khoản" }, { header: "Tiền", type: "currency" }, { header: "Tỷ trọng", type: "percent" }],
          rows: [
            ["a", 12_000_000, "=B2/$B$6"],
            ["b", 8_000_000, "=B3/$B$6"],
            ["c", 3_500_000, "=B4/$B$6"],
            ["d", 15_000_000, "=B5/$B$6"],
            ["Tổng", "=SUM(B2:B5)", "=SUM(C2:C5)"],
          ],
        },
      ]),
    );
    expect(cell(s, "C6")?.value).toBe(1);
  });

  it("recomputes a changed formula when a workbook is edited", async () => {
    const out = await editXlsx(await PAYROLL(), "p.xlsx", [
      { op: "set", cell: "D4", value: 21_000_000 },
      { op: "fill", column: "G", formula: "=F{r}*2", from: 4, to: 6 },
    ]);
    const s = await sheetOf(out.buffer);
    expect(cell(s, "G4")?.value).toBe(46_000_000);
  });
});

describe("sheet queries", () => {
  const grid = [
    ["Bảng lương"],
    [],
    ["Họ tên", "Phòng ban", "Lương", "Email"],
    ["An", "IT", 20, "an@x.vn"],
    ["Bình", "IT", 18, "binh@x.vn"],
    ["Chi", "HR", 15, null],
    ["Dũng", "HR", 15, "an@x.vn"],
    ["Tổng cộng", null, 68, null],
  ];
  it("groups and adds up by a header named without accents, leaving the totals row out", () => {
    const r = runQuery(grid, { groupBy: ["phong ban"], measures: [{ fn: "sum", column: "luong" }, { fn: "count" }] });
    expect(r.columns).toEqual(["Phòng ban", "sum Lương", "count"]);
    expect(r.rows).toEqual([
      ["IT", 38, 2],
      ["HR", 30, 2],
    ]);
    expect(r.total).toBe(4);
    expect(r.notes.join(" ")).toMatch(/totals row/);
  });
  it("filters, sorts, limits, pivots and finds duplicates and blanks", () => {
    expect(runQuery(grid, { filter: [{ column: "Lương", op: ">=", value: 18 }], select: ["Họ tên"], sort: [{ column: "Họ tên", desc: true }] }).rows).toEqual([["Bình"], ["An"]]);
    expect(runQuery(grid, { sort: [{ column: "Lương", desc: true }], limit: 1, select: ["Họ tên", "Lương"] }).rows).toEqual([["An", 20]]);
    const p = runQuery(grid, { pivot: { rows: "Phòng ban", columns: "Lương", fn: "count" } });
    expect(p.columns).toEqual(["Phòng ban", "15", "18", "20"]);
    expect(runQuery(grid, { find: "duplicates", keys: ["Email"] }).rows).toEqual([["an@x.vn", "4, 7", 2]]);
    expect(runQuery(grid, { find: "blanks", select: ["Email"] }).rows).toEqual([[6, "Email"]]);
  });
  it("names the columns there are when one is not found", () => {
    expect(() => runQuery(grid, { select: ["Lương tháng 13"] })).toThrow(QueryProblem);
    expect(() => runQuery(grid, { select: ["Lương tháng 13"] })).toThrow(/Họ tên, Phòng ban, Lương, Email/);
  });
});

describe("formulas", () => {
  it("names the functions, ranges and a risky VLOOKUP", () => {
    const f = formulaFacts("=VLOOKUP(A2,'Bảng giá'!A:C,3)", "vi");
    expect(f.functions[0]).toEqual({ name: "VLOOKUP", does: expect.stringContaining("tìm") });
    expect(f.sheets).toEqual(["Bảng giá"]);
    expect(f.problems.join(" ")).toMatch(/gần đúng/);
    expect(formulaFacts('=IF(B2>0,"SUM(",1)', "en").functions.map((x) => x.name)).toEqual(["IF"]);
  });
  it("finds error results, broken references and a typed-over formula in a column", async () => {
    const s = await sheetOf(
      await buildXlsx([
        {
          name: "S",
          columns: [{ header: "A", type: "number" }, { header: "B", type: "number" }, { header: "C" }],
          rows: [
            [1, 2, "=A2*B2"],
            [3, 4, "=A3*B3"],
            [5, 6, 30],
            [7, 8, "=A5*B5"],
            [9, 1, "=#REF!*B6"],
          ],
        },
      ]),
    );
    const found = checkFormulas(s, "en");
    expect(found.map((x) => [x.ref, x.kind])).toEqual(
      expect.arrayContaining([
        ["C6", "ref"],
        ["C4", "pattern"],
      ]),
    );
  });
});

describe("Word documents and templates", () => {
  it("builds headings, lists, tables and page breaks that read back, Vietnamese intact", async () => {
    const buf = await buildDocx({
      title: "Biên bản họp",
      markdown: "# Thành phần\n- Anh **Hùng**\n  - Chị Lan\n\n1. Duyệt ngân sách\n\n| Việc | Hạn |\n|---|---|\n| Viết tài liệu | 20/11 |\n\n---\nĐoạn cuối *nghiêng*.",
    });
    const r = await readOffice(buf, "b.docx");
    if (r.kind !== "docx") throw new Error();
    expect(r.blocks.slice(0, 4)).toEqual([
      { type: "heading", level: 0, text: "Biên bản họp" },
      { type: "heading", level: 1, text: "Thành phần" },
      { type: "p", text: "Anh Hùng", list: "bullet" },
      { type: "p", text: "Chị Lan", list: "bullet" },
    ]);
    expect(r.blocks).toContainEqual({
      type: "table",
      rows: [
        ["Việc", "Hạn"],
        ["Viết tài liệu", "20/11"],
      ],
    });
    expect(r.blocks).toContainEqual({ type: "break" });
    expect(renderOffice(r).text).toContain("Đoạn cuối nghiêng.");
  });

  it("shows a title written again as the first heading once, and code and links as their words", async () => {
    const r = await readOffice(await buildDocx({ title: "Biên bản", markdown: "# Biên bản\nXem `workspace://x` và [trang](https://a.vn/b)." }), "x.docx");
    if (r.kind !== "docx") throw new Error();
    expect(r.blocks).toEqual([
      { type: "heading", level: 0, text: "Biên bản" },
      { type: "p", text: "Xem workspace://x và trang." },
    ]);
  });

  it("fills a placeholder Word split over several runs, keeping the first run's formatting", () => {
    const p = `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Kính gửi {{ho</w:t></w:r><w:r><w:t>_ten}}</w:t></w:r><w:r><w:t>, ngày {{ngay}}.</w:t></w:r></w:p>`;
    const used = new Set<string>();
    const missing = new Set<string>();
    const out = fillParagraph(p, new Map([["ho_ten", "Nguyễn Văn An"]]), used, missing);
    expect(out).toContain("<w:b/></w:rPr><w:t>Kính gửi Nguyễn Văn An</w:t>");
    expect(out).toContain("<w:t></w:t>");
    expect([...used]).toEqual(["ho_ten"]);
    expect([...missing]).toEqual(["ngay"]);
  });

  it("fills a real template and lists its placeholders", async () => {
    const tpl = await buildDocx({ markdown: "Kính gửi {{Họ tên}},\n\nSố tiền: {{so_tien}} & <thêm>" });
    expect(await placeholdersOf(tpl, "t.docx")).toEqual(["Họ tên", "so_tien"]);
    const out = await fillTemplate(tpl, "t.docx", { ho_ten: "Trần Bình", "Số tiền": "1.000.000 ₫ <đã duyệt>" });
    const r = await readOffice(out.buffer, "o.docx");
    expect(renderOffice(r).text).toContain("Kính gửi Trần Bình,");
    expect(renderOffice(r).text).toContain("Số tiền: 1.000.000 ₫ <đã duyệt> & <thêm>");
  });
});

describe("presentations", () => {
  it("turns an outline into slides with notes and a table, read back with their titles", async () => {
    const deck = outlineToSlides(
      "# Ra mắt v1\nGiới thiệu dự án\n## Mục tiêu\n- Ra mắt 1/12\n  - Bản desktop\n> Nhấn mạnh ngày ra mắt\n## Lịch\n| Mốc | Ngày |\n|---|---|\n| Beta | 20/11 |",
    );
    expect(deck.slides.map((s) => s.layout)).toEqual(["title", "bullets", "table"]);
    const { buffer } = await buildPptx({ title: deck.title, slides: deck.slides });
    const r = await readOffice(buffer, "d.pptx");
    if (r.kind !== "pptx") throw new Error();
    expect(r.slides.map((s) => s.title)).toEqual(["Ra mắt v1", "Mục tiêu", "Lịch"]);
    expect(r.slides[1]!.lines).toEqual(["Ra mắt 1/12", "Bản desktop"]);
    expect(r.slides[1]!.notes).toBe("Nhấn mạnh ngày ra mắt");
    expect(r.slides[2]!.tables[0]).toEqual([
      ["Mốc", "Ngày"],
      ["Beta", "20/11"],
    ]);
  });
  it("places an attached PNG measured by its header, and reports a missing one", async () => {
    // A 2×1 PNG header is enough to measure.
    const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000002000000010806000000f478d4fa0000000d49444154789c63f8cfc0f01f0005fe02fea7d6a5b60000000049454e44ae426082", "hex");
    expect(imageSize(png)).toEqual({ w: 2, h: 1, type: "png" });
    const out = await buildPptx(
      {
        slides: [
          { layout: "image", title: "Ảnh", image: "logo.png" },
          { layout: "image", title: "Thiếu", image: "none.png" },
        ],
      },
      new Map([["logo.png", png]]),
    );
    expect(out.missing).toEqual(["none.png"]);
  });
});

describe("untrusted files", () => {
  const zip = (files: Record<string, string>) => makeZip(new Map(Object.entries(files)));
  it("refuses macros, old formats, password-protected files, bombs and non-Office files", async () => {
    expect(() => checkOffice(Buffer.from("x"), "a.xlsm")).toThrow(/macros/);
    expect(() => checkOffice(Buffer.from("x"), "a.doc")).toThrow(/old binary/);
    expect(() => checkOffice(Buffer.from("d0cf11e0a1b11ae1", "hex"), "a.docx")).toThrow(/password/);
    expect(() => checkOffice(Buffer.from("not a zip"), "a.docx")).toThrow(OfficeRefused);
    const macro = await zip({ "word/document.xml": "<w/>", "word/vbaProject.bin": "x" });
    expect(() => checkOffice(macro, "a.docx")).toThrow(/macros/);
    const bomb = await zip({ "word/document.xml": "<w/>", "word/big.xml": "0".repeat(5_000_000) });
    expect(() => checkOffice(bomb, "a.docx")).toThrow(/zip bomb/);
    const wrong = await zip({ "x.xml": "<x/>" });
    expect(() => checkOffice(wrong, "a.pptx")).toThrow(/not a valid pptx/);
    expect(checkOffice(await zip({ "word/document.xml": "<w/>" }), "a.docx")).toBe("docx");
  });
});

describe("CSV and numbers", () => {
  it("reads quoted fields, semicolons and Vietnamese number formats", () => {
    expect(parseCsv('Tên;Số tiền\n"Lê, Chi";"1.250.000"\nAn;12,5%\n')).toEqual([
      ["Tên", "Số tiền"],
      ["Lê, Chi", 1_250_000],
      ["An", "12,5%"],
    ]);
    expect(numberOf("1,234.5")).toBe(1234.5);
    expect(numberOf("12%")).toBe(0.12);
    // A phone number or a code with a leading zero stays text.
    expect(numberOf("0912345678")).toBe("0912345678");
  });
  it("parses the Markdown the model writes", () => {
    expect(parseMarkdown("## A\ntext\nmore\n\n  - sub\n1) one")).toEqual([
      { type: "heading", level: 2, text: "A" },
      { type: "p", text: "text more" },
      { type: "p", text: "sub", list: "bullet", level: 1 },
      { type: "p", text: "one", list: "number", level: 0 },
    ]);
  });
});
