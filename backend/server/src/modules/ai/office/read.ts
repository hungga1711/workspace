import { unzip } from "@workspace/service-kit";
import { checkOffice, OfficeRefused, type OfficeKind } from "./guard.js";
import type { PdfRead } from "./pdf.js";
import { colName, gridOf, readBook, type CellValue } from "./xlsx.js";
import { unxml } from "./xml.js";

export { colIndex, colName, type CellValue } from "./xlsx.js";
export { unxml } from "./xml.js";

/**
 * Word, Excel and PowerPoint files read as their structure: a document's headings, paragraphs, lists and
 * tables; a workbook's sheets with every cell's value and formula (A1 addresses); a deck's slides with title, text and
 * speaker notes. The text the model reads comes from here, in parts when a file is long. Every file goes through
 * checkOffice first.
 */

export type DocBlock =
  | { type: "heading"; level: number; text: string }
  | { type: "p"; text: string; list?: "bullet" | "number" }
  | { type: "table"; rows: string[][] }
  | { type: "break" };
export interface Cell {
  ref: string;
  value: CellValue;
  formula?: string;
  /** An error the cell shows (#REF!, #DIV/0!, …). */
  error?: string;
}
export interface Sheet {
  name: string;
  /** Rows of values, top-left first; formulas' last results. */
  grid: CellValue[][];
  /** Every non-empty cell with its formula, in reading order. */
  cells: Cell[];
  rowCount: number;
  colCount: number;
}
export interface Slide {
  n: number;
  title: string;
  lines: string[];
  notes: string;
  tables: string[][][];
}
/** A PDF (office/pdf.ts) reads as its pages' text; the tools open it beside the Office kinds. */
export type OfficeRead = { kind: "docx"; blocks: DocBlock[] } | { kind: "xlsx"; sheets: Sheet[] } | { kind: "pptx"; slides: Slide[] } | PdfRead;

const ROWS_MAX = 20_000;

const attr = (xml: string, name: string) => {
  const m = new RegExp(`${name}="([^"]*)"`).exec(xml);
  return m ? unxml(m[1]!) : undefined;
};

// ── Word ─────────────────────────────────────────────────────────────────────────────────────────────────

function wordText(xml: string): string {
  let out = "";
  for (const m of xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br(?:\s[^>]*)?\/>/g))
    out += m[1] !== undefined ? unxml(m[1]) : m[0].startsWith("<w:tab") ? "\t" : "\n";
  return out;
}

function headingLevels(stylesXml: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of stylesXml.matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)) {
    const id = attr(m[1]!, "w:styleId");
    if (!id) continue;
    const name = attr(/<w:name\b[^>]*\/>/.exec(m[2]!)?.[0] ?? "", "w:val") ?? "";
    const outline = attr(/<w:outlineLvl\b[^>]*\/>/.exec(m[2]!)?.[0] ?? "", "w:val");
    if (/^title$/i.test(name)) out.set(id, 0);
    else if (outline !== undefined && Number(outline) < 9) out.set(id, Number(outline) + 1);
    else if (/heading\s*(\d)/i.test(name)) out.set(id, Number(/heading\s*(\d)/i.exec(name)![1]));
  }
  return out;
}

function listFormats(numberingXml: string): Map<string, "bullet" | "number"> {
  const abstract = new Map<string, "bullet" | "number">();
  for (const m of numberingXml.matchAll(/<w:abstractNum\b([^>]*)>([\s\S]*?)<\/w:abstractNum>/g)) {
    const fmt = attr(/<w:numFmt\b[^>]*\/>/.exec(m[2]!)?.[0] ?? "", "w:val");
    abstract.set(attr(m[1]!, "w:abstractNumId") ?? "", fmt === "bullet" ? "bullet" : "number");
  }
  const out = new Map<string, "bullet" | "number">();
  for (const m of numberingXml.matchAll(/<w:num\b([^>]*)>([\s\S]*?)<\/w:num>/g))
    out.set(attr(m[1]!, "w:numId") ?? "", abstract.get(attr(/<w:abstractNumId\b[^>]*\/>/.exec(m[2]!)?.[0] ?? "", "w:val") ?? "") ?? "number");
  return out;
}

function readDocx(zip: Map<string, () => Buffer>): DocBlock[] {
  const xml = zip.get("word/document.xml")!().toString("utf8");
  const levels = headingLevels(zip.get("word/styles.xml")?.().toString("utf8") ?? "");
  const lists = listFormats(zip.get("word/numbering.xml")?.().toString("utf8") ?? "");
  const body = /<w:body>([\s\S]*)<\/w:body>/.exec(xml)?.[1] ?? xml;
  const blocks: DocBlock[] = [];
  for (const m of body.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p\b[^>]*\/>|<w:p\b[\s\S]*?<\/w:p>/g)) {
    const el = m[0];
    if (el.startsWith("<w:tbl")) {
      const rows = [...el.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].map((r) => [...r[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map((c) => wordText(c[0]).trim()));
      if (rows.length) blocks.push({ type: "table", rows });
      continue;
    }
    if (/<w:br\b[^>]*w:type="page"/.test(el) && !wordText(el.replace(/<w:br\b[^>]*w:type="page"[^>]*\/>/g, "")).trim()) {
      blocks.push({ type: "break" });
      continue;
    }
    const text = wordText(el).trim();
    if (!text) continue;
    const style = attr(/<w:pStyle\b[^>]*\/>/.exec(el)?.[0] ?? "", "w:val");
    const level = style ? levels.get(style) : undefined;
    if (level !== undefined) blocks.push({ type: "heading", level, text });
    else {
      const numId = attr(/<w:numId\b[^>]*\/>/.exec(el)?.[0] ?? "", "w:val");
      blocks.push(numId && numId !== "0" ? { type: "p", text, list: lists.get(numId) ?? "number" } : { type: "p", text });
    }
  }
  return blocks;
}

// ── PowerPoint ───────────────────────────────────────────────────────────────────────────────────────────

const drawText = (xml: string) =>
  xml
    .split(/<\/a:p>/)
    .map((p) => [...p.matchAll(/<a:t>([^<]*)<\/a:t>|<a:br\/>/g)].map((t) => (t[1] !== undefined ? unxml(t[1]) : "\n")).join(""))
    .map((s) => s.trim())
    .filter(Boolean);

function rels(zip: Map<string, () => Buffer>, path: string): Map<string, string> {
  const xml = zip.get(path)?.().toString("utf8") ?? "";
  return new Map([...xml.matchAll(/<Relationship\b[^>]*>/g)].map((m) => [attr(m[0], "Id") ?? "", attr(m[0], "Target") ?? ""]));
}

function readPptx(zip: Map<string, () => Buffer>): Slide[] {
  const pres = zip.get("ppt/presentation.xml")!().toString("utf8");
  const r = rels(zip, "ppt/_rels/presentation.xml.rels");
  const order = [...pres.matchAll(/<p:sldId\b[^>]*>/g)].map((m) => r.get(attr(m[0], "r:id") ?? "") ?? "").filter(Boolean);
  const paths = order.map((t) => `ppt/${t.replace(/^\/?ppt\//, "").replace(/^\.\.\//, "")}`).filter((p) => zip.has(p));
  return paths.map((path, i) => {
    const xml = zip.get(path)!().toString("utf8");
    let title = "";
    const shapes = [...xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)].map((sp) => ({ xml: sp[0], text: drawText(sp[0]) })).filter((x) => x.text.length);
    // The title placeholder when there is one; a deck drawn without placeholders has its title as the first text.
    const titled = shapes.findIndex((x) => /<p:ph\b[^>]*type="(?:title|ctrTitle)"/.test(x.xml));
    const at = titled >= 0 ? titled : shapes.length > 1 || !/<p:ph\b/.test(shapes[0]?.xml ?? "") ? 0 : -1;
    if (at >= 0) title = shapes[at]!.text.join(" ");
    const lines = shapes.filter((_, i) => i !== at).flatMap((x) => x.text);
    const tables = [...xml.matchAll(/<a:tbl>[\s\S]*?<\/a:tbl>/g)].map((t) =>
      [...t[0].matchAll(/<a:tr\b[\s\S]*?<\/a:tr>/g)].map((row) => [...row[0].matchAll(/<a:tc\b[\s\S]*?<\/a:tc>/g)].map((c) => drawText(c[0]).join(" "))),
    );
    const slideRels = rels(zip, path.replace(/slides\/(slide\d+\.xml)$/, "slides/_rels/$1.rels"));
    const notesTarget = [...slideRels.values()].find((t) => /notesSlide/.test(t));
    const notesPath = notesTarget ? `ppt/${notesTarget.replace(/^\.\.\//, "")}` : "";
    const notesXml = notesPath ? (zip.get(notesPath)?.().toString("utf8") ?? "") : "";
    // The notes page repeats the slide's picture and its number: only the body placeholder is the notes.
    const notes = [...notesXml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)]
      .filter((sp) => /<p:ph\b[^>]*type="body"/.test(sp[0]))
      .flatMap((sp) => drawText(sp[0]))
      .join("\n");
    return { n: i + 1, title, lines, notes, tables };
  });
}

// ── Excel ────────────────────────────────────────────────────────────────────────────────────────────────

const ERR_RE = /^#(REF!|DIV\/0!|VALUE!|NAME\?|N\/A|NUM!|NULL!|SPILL!|CALC!)/;

/** Every part of a zip that is XML, as text (what readBook needs). */
export function xmlParts(zip: Map<string, () => Buffer>): Map<string, string> {
  return new Map([...zip.entries()].filter(([k]) => /\.(xml|rels)$/i.test(k)).map(([k, get]) => [k, get().toString("utf8")]));
}

export function sheetsOf(files: Map<string, string>): Sheet[] {
  return readBook(files).sheets.map((s) => {
    const grid = gridOf(s);
    const cells: Cell[] = [];
    let cols = 0;
    for (const row of s.rows)
      for (const c of row.cells) {
        if (c.value === null && !c.formula) continue;
        cols = Math.max(cols, c.col + 1);
        const error = (c.t === "e" || (typeof c.value === "string" && ERR_RE.test(c.value))) && typeof c.value === "string" ? c.value : undefined;
        cells.push({ ref: `${colName(c.col)}${row.r}`, value: c.value, ...(c.formula ? { formula: c.formula } : {}), ...(error ? { error } : {}) });
      }
    return { name: s.name, grid: grid.slice(0, ROWS_MAX), cells, rowCount: grid.length, colCount: cols };
  });
}

/** A CSV's rows (quoted fields, commas or semicolons or tabs, whichever the first line uses). */
export function parseCsv(text: string): CellValue[][] {
  const first = text.split("\n", 1)[0] ?? "";
  const sep = [",", ";", "\t"].sort((a, b) => first.split(b).length - first.split(a).length)[0]!;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      if (rows.length >= ROWS_MAX) break;
    } else cell += ch;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows.filter((r) => r.some((c) => c !== "")).map((r) => r.map((c) => numberOf(c)));
}

/** "1.234.567", "1,234.5", "12%", "1 234 ₫" → numbers; anything else stays text. */
export function numberOf(s: string): CellValue {
  const t = s.trim();
  if (!t) return null;
  // A leading zero is a phone number or a code ("0912…", "007"), not a number.
  if (/^-?\d+(\.\d+)?$/.test(t)) return /^-?0\d/.test(t) || t.replace(/\D/g, "").length > 15 ? t : Number(t);
  const money = t.replace(/[\s₫đ$€]|VND|vnđ/gi, "");
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(money)) return Number(money.replace(/\./g, "").replace(",", "."));
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(money)) return Number(money.replace(/,/g, ""));
  if (/^-?\d+(\.\d+)?%$/.test(t)) return Number(t.slice(0, -1)) / 100;
  return t;
}

/** Opens an Office file (checked first). Throws OfficeRefused with a reason the model can relay. */
export async function readOffice(buf: Buffer, name: string): Promise<OfficeRead> {
  const kind: OfficeKind = checkOffice(buf, name);
  try {
    const zip = unzip(buf);
    if (kind === "xlsx") return { kind, sheets: sheetsOf(xmlParts(zip)) };
    return kind === "docx" ? { kind, blocks: readDocx(zip) } : { kind, slides: readPptx(zip) };
  } catch (e) {
    if (e instanceof OfficeRefused) throw e;
    throw new OfficeRefused(`${name} could not be read: it may be damaged.`);
  }
}

// ── As text for the model ────────────────────────────────────────────────────────────────────────────────

const cellText = (v: CellValue) => (v === null ? "" : typeof v === "number" ? String(Math.round(v * 1e6) / 1e6) : String(v)).replace(/\s+/g, " ").slice(0, 200);

/** The whole file as structured text, in parts of about `size` characters; `part` is 1-based. */
export function renderOffice(r: OfficeRead, part = 1, size = 14_000, sheet?: string): { text: string; parts: number } {
  const units: string[] = [];
  if (r.kind === "docx")
    for (const b of r.blocks)
      units.push(
        b.type === "heading"
          ? `${"#".repeat(Math.max(1, b.level))} ${b.text}`
          : b.type === "table"
            ? b.rows
                .map((row, i) => `| ${row.map((c) => c.replace(/\|/g, "/").replace(/\n/g, " ")).join(" | ")} |${i === 0 ? `\n|${row.map(() => "---").join("|")}|` : ""}`)
                .join("\n")
            : b.type === "break"
              ? "--- page break ---"
              : `${b.list === "bullet" ? "- " : b.list === "number" ? "1. " : ""}${b.text}`,
      );
  else if (r.kind === "pdf") for (const p of r.pages) units.push(`## Page ${p.n}\n${p.text || "(no text on this page)"}`);
  else if (r.kind === "pptx")
    for (const s of r.slides)
      units.push(
        [
          `## Slide ${s.n}${s.title ? `: ${s.title}` : ""}`,
          ...s.lines.map((l) => `- ${l}`),
          ...s.tables.map((t) => t.map((row) => `| ${row.join(" | ")} |`).join("\n")),
          s.notes ? `Notes: ${s.notes}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
  else
    for (const s of r.sheets.filter((x) => !sheet || x.name.toLowerCase() === sheet.toLowerCase())) {
      units.push(`## Sheet "${s.name}" (${s.rowCount} rows × ${s.colCount} columns). Cells as A1: value, formulas as {=…}`);
      const formulas = new Map(s.cells.filter((c) => c.formula).map((c) => [c.ref, c.formula!]));
      s.grid.forEach((row, ri) => {
        const cells = row
          .map((v, ci) => {
            const ref = `${colName(ci)}${ri + 1}`;
            const f = formulas.get(ref);
            return v === null && !f ? "" : `${ref}=${cellText(v)}${f ? ` {=${f}}` : ""}`;
          })
          .filter(Boolean);
        if (cells.length) units.push(cells.join(" · "));
      });
    }
  const parts: string[] = [];
  let cur = "";
  for (const u of units) {
    if (cur && cur.length + u.length > size) {
      parts.push(cur);
      cur = "";
    }
    cur += (cur ? "\n" : "") + u;
  }
  if (cur) parts.push(cur);
  const n = Math.max(1, parts.length);
  return { text: parts[Math.min(Math.max(1, part), n) - 1] ?? "", parts: n };
}
