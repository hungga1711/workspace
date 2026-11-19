import { describe, expect, it } from "vitest";
import { gridMarkdown, pdfMarkdown } from "../tools-office.js";
import { buildDocx } from "./write-docx.js";
import { OfficeRefused } from "./guard.js";
import { pdfAsText, readPdf } from "./pdf.js";
import { readOffice, renderOffice } from "./read.js";
import { buildPdf } from "./write-pdf.js";

const MINUTES = `# Biên bản họp dự án

Ngày **18/11/2026**, phòng họp *Tầng 3*. Thành phần: Nguyễn Văn An, Trần Thị Bích.

## Quyết định
- Chốt phạm vi phiên bản đầu tiên
  - Bỏ xuất báo cáo nâng cao
1. Hoàn thiện thiết kế
2. Kiểm thử với khách hàng

| Hạng mục | Người phụ trách | Chi phí |
|---|---|---|
${Array.from({ length: 70 }, (_, i) => `| Việc số ${i + 1} | Phạm Thu Hằng | ${(i + 1) * 150000} |`).join("\n")}

---

## Phụ lục
> Ghi chú: tài liệu nội bộ.
`;

describe("PDF", () => {
  it("is written in Vietnamese that reads back letter for letter, with tables over pages, page breaks and page numbers", async () => {
    const buf = await buildPdf({ title: "Biên bản họp dự án", markdown: MINUTES });
    expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
    const r = await readPdf(buf, "bien-ban.pdf");
    expect(r.scanned).toBe(false);
    expect(r.total).toBeGreaterThanOrEqual(3);
    const all = r.pages.map((p) => p.text).join("\n");
    // The title shows once (the same first heading is dropped), every letter comes back as typed.
    expect(all.match(/Biên bản họp dự án/g)).toHaveLength(1);
    for (const w of ["Thành phần: Nguyễn Văn An, Trần Thị Bích", "Chốt phạm vi phiên bản đầu tiên", "Kiểm thử với khách hàng", "Việc số 70", "Ghi chú: tài liệu nội bộ."])
      expect(all).toContain(w);
    // The table's header repeats on the page it continues on; the page break puts the appendix on a page of its own.
    expect(r.pages.filter((p) => p.text.includes("Người phụ trách")).length).toBeGreaterThanOrEqual(2);
    expect(r.pages.at(-1)!.text).toMatch(/^Phụ lục/);
    expect(r.pages[0]!.text).toContain(`1 / ${r.total}`);
  });

  it("reads as pages the tools can quote and cut into parts", async () => {
    const r = await readPdf(await buildPdf({ markdown: `${"Đoạn văn dài. ".repeat(200)}\n\n---\n\nTrang hai` }), "x.pdf");
    const { text, parts } = renderOffice(r, 1, 1000);
    expect(text).toMatch(/^## Page 1\n/);
    expect(parts).toBeGreaterThanOrEqual(2);
    expect(pdfAsText(r, "x.pdf")).toMatch(/--- Page 2 ---\nTrang hai/);
  });

  it("refuses what it must not open: not a PDF, damaged, password-protected; a scan reads as a scan", async () => {
    await expect(readPdf(Buffer.from("hello"), "a.pdf")).rejects.toThrow(OfficeRefused);
    await expect(readPdf(Buffer.from("%PDF-1.7\n garbage garbage"), "b.pdf")).rejects.toThrow(/damaged/);
    const PDFDocument = (await import("pdfkit")).default;
    const make = (opts: Record<string, unknown>, draw: (d: InstanceType<typeof PDFDocument>) => void) =>
      new Promise<Buffer>((resolve) => {
        const d = new PDFDocument(opts);
        const out: Buffer[] = [];
        d.on("data", (c: Buffer) => out.push(c));
        d.on("end", () => resolve(Buffer.concat(out)));
        draw(d);
        d.end();
      });
    const locked = await make({ userPassword: "secret" }, (d) => d.text("Bí mật"));
    await expect(readPdf(locked, "khoa.pdf")).rejects.toThrow(/password/);
    const scan = await readPdf(await make({}, (d) => d.rect(50, 50, 400, 600).fill("#999999")), "scan.pdf");
    expect(scan.scanned).toBe(true);
    expect(pdfAsText(scan, "scan.pdf")).toMatch(/no text layer/);
  });

  it("caps the pages it reads and says so", async () => {
    const r = await readPdf(await buildPdf({ markdown: ["Trang một", "Trang hai", "Trang ba", "Trang bốn"].join("\n\n---\n\n") }), "x.pdf", 2);
    expect(r.total).toBe(4);
    expect(r.pages).toHaveLength(2);
    expect(pdfAsText(r, "x.pdf")).toMatch(/first 2 of 4 pages/);
  });

  it("turns a PDF's broken lines back into paragraphs and lists for Word", async () => {
    const md = pdfMarkdown([
      {
        n: 1,
        text: "Hợp đồng này được lập giữa hai bên với các điều khoản\nvà điều kiện như sau đây, có hiệu lực từ ngày ký.\n• Bên A thanh toán\n• Bên B giao hàng\nĐiều 2",
      },
      { n: 2, text: "Trang hai." },
    ]);
    expect(md).toBe(
      "Hợp đồng này được lập giữa hai bên với các điều khoản và điều kiện như sau đây, có hiệu lực từ ngày ký.\n\n- Bên A thanh toán\n\n- Bên B giao hàng\n\nĐiều 2\n\n---\n\nTrang hai.",
    );
    const doc = await readOffice(await buildDocx({ markdown: md }), "x.docx");
    expect(doc.kind === "docx" && doc.blocks.filter((b) => b.type === "p" && b.list === "bullet")).toHaveLength(2);
  });

  it("prints a sheet as a table with Vietnamese number grouping", () => {
    expect(
      gridMarkdown([
        ["Tên", "Lương"],
        ["An", 12500000],
        [null, null],
        ["Bình | B", 9000000.456],
      ]),
    ).toBe("| Tên | Lương |\n|---|---|\n| An | 12.500.000 |\n| Bình / B | 9000000.46 |");
  });
});
