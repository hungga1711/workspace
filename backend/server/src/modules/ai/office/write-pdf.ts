import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inlines, parseMarkdown, plain, type MdBlock } from "./markdown.js";

/**
 * A PDF from the model's Markdown, in the Word builder's house style: a title, headings, paragraphs with
 * bold and italic, bullet and numbered lists, tables whose header repeats on every page, `---` page breaks and page
 * numbers. Text is set in Noto Sans (assets/fonts: Latin and Vietnamese, kerning only, embedded and subset again per file),
 * so every Vietnamese letter renders on any reader. pdfkit is loaded on the first PDF only.
 */

type Doc = InstanceType<typeof import("pdfkit")>;
let lib: Promise<typeof import("pdfkit")> | null = null;
const load = () => (lib ??= import("pdfkit").then((m) => (m as unknown as { default: typeof import("pdfkit") }).default ?? m));

let fonts: string | null = null;
/** assets/fonts of the server package, found from wherever this code runs (src/ under tsx, dist/, the one-file bundle). */
function fontDir(): string {
  if (fonts) return fonts;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const f = join(dir, "assets", "fonts");
    if (existsSync(join(f, "NotoSans-Regular.ttf"))) return (fonts = f);
    dir = dirname(dir);
  }
  throw new Error("PDF fonts (assets/fonts) not found");
}

export interface PdfInput {
  title?: string | undefined;
  markdown: string;
  landscape?: boolean | undefined;
}

const INK = "#1F2A44";
const INK2 = "#2B3A67";
const MUTED = "#6B7280";
const RULE = "#C9CED9";
const HEAD_FILL = "#EEF0F6";
const PAGES_MAX = 500;

export async function buildPdf(input: PdfInput): Promise<Buffer> {
  const PDFDocument = await load();
  const dir = fontDir();
  const doc: Doc = new PDFDocument({
    size: "A4",
    layout: input.landscape ? "landscape" : "portrait",
    margins: { top: 56, bottom: 60, left: 56, right: 56 },
    bufferPages: true,
    // The first font is ours, so pdfkit never loads its built-in Helvetica.
    font: join(dir, "NotoSans-Regular.ttf"),
    info: { Title: input.title?.trim() || "Document", Creator: "Workspace AI", Producer: "Workspace" },
  } as ConstructorParameters<typeof PDFDocument>[0]);
  doc.registerFont("r", join(dir, "NotoSans-Regular.ttf"));
  doc.registerFont("b", join(dir, "NotoSans-Bold.ttf"));
  doc.registerFont("i", join(dir, "NotoSans-Italic.ttf"));
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve, reject) => {
    doc.on("end", () => resolve());
    doc.on("error", reject);
  });

  const left = () => doc.page.margins.left;
  const width = () => doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom;
  const room = (h: number) => {
    if (doc.y + h > bottom()) doc.addPage();
  };
  /** One line of Markdown with **bold** / *italic*, from (x, y) in a column `w` wide. */
  const rich = (text: string, x: number, y: number, w: number, size: number, color = "#111827", base: "r" | "i" = "r") => {
    const parts = inlines(text);
    if (!parts.length) parts.push({ text: " " });
    doc.fontSize(size).fillColor(color);
    parts.forEach((p, k) => {
      doc.font(p.bold ? "b" : p.italic || base === "i" ? "i" : "r");
      const opts = { width: w, continued: k < parts.length - 1, lineGap: 2.5 };
      if (k === 0) doc.text(p.text, x, y, opts);
      else doc.text(p.text, opts);
    });
  };

  // Composed letters (NFC): the fonts carry every Vietnamese letter whole and are subset without mark positioning,
  // which also keeps the PDF's text copyable and searchable letter for letter.
  const blocks: MdBlock[] = parseMarkdown(input.markdown.normalize("NFC"));
  const title = input.title?.normalize("NFC");
  const first = blocks[0];
  if (title?.trim() && first?.type === "heading" && first.text.trim().toLowerCase() === title.trim().toLowerCase()) blocks.shift();
  if (title?.trim()) {
    doc.font("b").fontSize(22).fillColor(INK).text(plain(title.trim()), left(), doc.y, { width: width() });
    doc.moveDown(0.6);
  }

  const counters: number[] = [];
  for (const b of blocks) {
    if (doc.bufferedPageRange().count > PAGES_MAX) break;
    if (b.type !== "p" || b.list !== "number") counters.length = 0;
    if (b.type === "heading") {
      const size = [18, 15, 13, 12, 11, 11][Math.min(5, b.level - 1)]!;
      // A heading never sits alone at the bottom of a page.
      room(size * 3.2);
      doc.moveDown(b.level <= 2 ? 0.5 : 0.3);
      doc
        .font("b")
        .fontSize(size)
        .fillColor(b.level <= 1 ? INK : INK2)
        .text(plain(b.text), left(), doc.y, { width: width() });
      doc.moveDown(0.25);
    } else if (b.type === "break") {
      if (doc.y > doc.page.margins.top + 1) doc.addPage();
    } else if (b.type === "table") table(doc, b.rows, left(), width(), bottom);
    else if (b.list) {
      const level = b.level ?? 0;
      let marker = "•";
      if (b.list === "number") {
        counters.length = level + 1;
        counters[level] = (counters[level] ?? 0) + 1;
        marker = level % 2 ? `${String.fromCharCode(96 + Math.min(26, counters[level]!))}.` : `${counters[level]}.`;
      }
      const indent = 18 * (level + 1);
      room(16);
      const y = doc.y;
      doc
        .font("r")
        .fontSize(10.5)
        .fillColor("#111827")
        .text(marker, left() + indent - 16, y, { width: 15, lineBreak: false });
      rich(b.text, left() + indent, y, width() - indent, 10.5);
      doc.moveDown(0.2);
    } else if (/^>\s?/.test(b.text)) {
      room(16);
      rich(b.text.replace(/^>\s?/, ""), left() + 12, doc.y, width() - 12, 10, MUTED, "i");
      doc.moveDown(0.5);
    } else {
      room(16);
      rich(b.text, left(), doc.y, width(), 10.5);
      doc.moveDown(0.55);
    }
  }

  // Page numbers, drawn last when the count is known; the bottom margin is lifted so the footer adds no page.
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const keep = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc
      .font("r")
      .fontSize(8)
      .fillColor(MUTED)
      .text(`${i + 1} / ${range.count}`, 0, doc.page.height - 36, { width: doc.page.width, align: "center", lineBreak: false });
    doc.page.margins.bottom = keep;
  }
  doc.end();
  await done;
  return Buffer.concat(chunks);
}

/** A table with a shaded header row that repeats on each page; columns sized by their content. */
function table(doc: Doc, rows: string[][], x0: number, w: number, bottom: () => number) {
  const cols = Math.max(...rows.map((r) => r.length));
  if (!cols) return;
  const size = cols > 8 ? 7.5 : cols > 5 ? 8.5 : 9.5;
  const pad = 4;
  const grid = rows.map((r) => Array.from({ length: cols }, (_, i) => plain(r[i] ?? "")));
  // Each column gets room for its longest word and a share of the rest by its typical length.
  doc.fontSize(size);
  const want = Array.from({ length: cols }, (_, c) => {
    let longest = 0;
    let wordMax = 0;
    for (const [ri, r] of grid.entries()) {
      doc.font(ri === 0 ? "b" : "r");
      longest = Math.max(longest, Math.min(doc.widthOfString(r[c]!), w * 0.6));
      for (const word of r[c]!.split(/\s+/)) wordMax = Math.max(wordMax, Math.min(doc.widthOfString(word), w * 0.3));
    }
    return { longest: longest + 2 * pad, min: wordMax + 2 * pad };
  });
  // Every column first gets its longest word (a date or an amount never breaks), then the rest goes to the columns
  // whose text is longer than that, by how much longer.
  const sumMin = want.reduce((s, c) => s + c.min, 0);
  const need = want.map((c) => Math.max(0, c.longest - c.min));
  const totalNeed = need.reduce((s, x) => s + x, 0);
  const extra = w - sumMin;
  const widths =
    extra <= 0
      ? want.map((c) => (c.min * w) / sumMin)
      : totalNeed <= extra
        ? want.map((c, i) => c.min + need[i]! + (extra - totalNeed) / cols)
        : want.map((c, i) => c.min + (extra * need[i]!) / totalNeed);
  const usable = bottom() - doc.page.margins.top;
  const heightOf = (r: string[], bold: boolean) => {
    doc.font(bold ? "b" : "r").fontSize(size);
    return Math.min(usable - 4, Math.max(...r.map((t, c) => doc.heightOfString(t || " ", { width: widths[c]! - 2 * pad }))) + 2 * pad);
  };
  const draw = (r: string[], y: number, h: number, head: boolean) => {
    let x = x0;
    if (head) doc.rect(x0, y, w, h).fill(HEAD_FILL);
    doc.lineWidth(0.5).strokeColor(RULE);
    for (const [c, t] of r.entries()) {
      doc.rect(x, y, widths[c]!, h).stroke();
      const numeric = !head && /^[-+]?[\d.,\s]+(%|₫|đ)?$/.test(t.trim()) && /\d/.test(t);
      doc
        .font(head ? "b" : "r")
        .fontSize(size)
        .fillColor("#111827")
        .text(t, x + pad, y + pad, { width: widths[c]! - 2 * pad, height: h - pad, ellipsis: true, align: numeric ? "right" : "left", lineGap: 1 });
      x += widths[c]!;
    }
  };
  const [head, ...body] = grid;
  const headH = heightOf(head!, true);
  if (doc.y + headH * 2 > bottom()) doc.addPage();
  let y = doc.y;
  draw(head!, y, headH, true);
  y += headH;
  for (const r of body) {
    const h = heightOf(r, false);
    if (y + h > bottom()) {
      doc.addPage();
      y = doc.page.margins.top;
      draw(head!, y, headH, true);
      y += headH;
    }
    draw(r, y, h, false);
    y += h;
  }
  doc.x = x0;
  doc.y = y + 10;
}
