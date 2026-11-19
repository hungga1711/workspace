import { z } from "zod";
import { checkOffice, OfficeRefused } from "./guard.js";
import { isTotalsRow } from "./sheet-query.js";
import {
  bookParts,
  cellXml,
  colIndex,
  colName,
  dateSerial,
  DXF,
  esc,
  NUMFMT,
  readBook,
  splitRef,
  Styles,
  type CellValue,
  type NumFmt,
  type RawCell,
  type RawSheet,
  type SheetOut,
} from "./xlsx.js";
import { evaluateSheet } from "./evaluate.js";
import { unxml } from "./xml.js";
import { makeZip, openZip } from "./zip.js";

/**
 * Workbooks built and changed by the server from what the model describes. Formulas stay formulas: a
 * value written as "=SUM(B2:B6)" is stored as that formula, so the file keeps working when someone edits it in Excel
 * (which recalculates every formula when the file opens). An edit never changes the file it read: the result is saved
 * as a new file, with the rest of the workbook (styles, widths, other sheets) as it was.
 */

const TYPES = ["text", "number", "integer", "currency", "percent", "date"] as const;
type ColType = (typeof TYPES)[number];
const Value = z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]);
type Value = z.infer<typeof Value>;

export const SheetSpec = z.object({
  name: z.string().trim().min(1).max(31),
  /** A title row above the table (merged across it), e.g. "Bảng lương tháng 11/2026". */
  title: z.string().max(200).optional(),
  columns: z
    .array(
      // A model sometimes names the header `name`, `title` or `label`: read as the header, not refused.
      z.preprocess(
        (v) =>
          v && typeof v === "object" && !("header" in v)
            ? { ...v, header: (v as Record<string, unknown>).name ?? (v as Record<string, unknown>).title ?? (v as Record<string, unknown>).label }
            : v,
        z.object({
          header: z.string().max(120),
          type: z.enum(TYPES).optional(),
          width: z.number().min(4).max(80).optional(),
          /** In the totals row: by default the number, integer and currency columns; a unit price or a rate says false. */
          sum: z.boolean().optional(),
        }),
      ),
    )
    .min(1)
    .max(60),
  /** Values in column order; a text starting with "=" is a formula ("=C4*D4"), with A1 references as in Excel. */
  rows: z.array(z.array(Value).max(60)).max(5000),
  /** A last row adding up every number, currency and integer column (SUM formulas). */
  totals: z.boolean().optional(),
  totalsLabel: z.string().max(60).optional(),
});
export type SheetSpec = z.infer<typeof SheetSpec>;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$|^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
function dateValue(v: string): number | null {
  const m = DATE_RE.exec(v.trim());
  if (!m) return null;
  const [y, mo, d] = m[1] ? [Number(m[1]), Number(m[2]), Number(m[3])] : [Number(m[6]), Number(m[5]), Number(m[4])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return dateSerial(new Date(Date.UTC(y, mo - 1, d)));
}

/** A value as the cell stores it: a formula, a date as its day number in date columns, numbers out of "1.200.000 ₫". */
export function storeValue(v: Value, type?: ColType): CellValue | { formula: string } {
  if (typeof v === "string") {
    const t = v.trim();
    if (t.startsWith("=") && t.length > 1) return { formula: t.slice(1) };
    if (type === "date") return dateValue(t) ?? v;
    if (type && type !== "text") {
      const n = t
        .replace(/[\s₫đ]|VND/gi, "")
        .replace(/\.(?=\d{3}\b)/g, "")
        .replace(",", ".");
      if (/^-?\d+(\.\d+)?%?$/.test(n)) return n.endsWith("%") ? Number(n.slice(0, -1)) / 100 : Number(n);
    }
    if (!type && /^-?\d+(\.\d+)?$/.test(t) && t.length < 16 && !/^0\d/.test(t)) return Number(t);
  }
  return v;
}

const width = (v: Value) => (typeof v === "string" ? (v.startsWith("=") ? 12 : v.length) : typeof v === "number" ? String(v).length + 4 : 6);

/** A new workbook from the model's sheets. */
export async function buildXlsx(sheets: SheetSpec[]): Promise<Buffer> {
  const styles = new Styles();
  const outs: SheetOut[] = [];
  const names = new Set<string>();
  for (const s of sheets) {
    let name = s.name.replace(/[\\/?*[\]:]/g, " ").slice(0, 31);
    for (let i = 2; names.has(name.toLowerCase()); i++) name = `${s.name.slice(0, 26)} (${i})`;
    names.add(name.toLowerCase());
    const cols = s.columns.length;
    const rows = new Map<number, string[]>();
    const merges: string[] = [];
    let head = 1;
    if (s.title?.trim()) {
      rows.set(1, [cellXml("A1", s.title.trim(), styles.index({ font: 2 }))]);
      if (cols > 1) merges.push(`A1:${colName(cols - 1)}1`);
      head = 3;
    }
    // Cells are collected first, so the formulas' results can be worked out before the XML is written.
    type Out = { ref: string; v: CellValue | { formula: string }; s: number };
    const grid = new Map<number, Out[]>();
    const headStyle = styles.index({ font: 1, fill: 2, border: 1, wrap: true });
    grid.set(
      head,
      s.columns.map((c, i) => ({ ref: `${colName(i)}${head}`, v: c.header, s: headStyle })),
    );
    const colStyle = s.columns.map((c) => (c.type && c.type !== "text" ? styles.index({ fmt: c.type }) : 0));
    s.rows.forEach((row, i) => {
      const r = head + 1 + i;
      grid.set(
        r,
        row.slice(0, cols).map((v, c) => ({ ref: `${colName(c)}${r}`, v: storeValue(v, s.columns[c]?.type), s: colStyle[c]! })),
      );
    });
    const last = head + s.rows.length;
    if (s.totals && s.rows.length) {
      const r = last + 1;
      const bold = styles.index({ font: 1, border: 2 });
      grid.set(
        r,
        s.columns.map((c, i): Out => {
          if (i === 0) return { ref: `A${r}`, v: s.totalsLabel?.trim() || "Tổng", s: bold };
          const sum = c.sum ?? (c.type === "number" || c.type === "integer" || c.type === "currency");
          return {
            ref: `${colName(i)}${r}`,
            v: sum ? { formula: `SUM(${colName(i)}${head + 1}:${colName(i)}${last})` } : null,
            s: styles.index({ font: 1, border: 2, ...(c.type && c.type !== "text" ? { fmt: c.type } : {}) }),
          };
        }),
      );
    }
    const values = new Map<string, number | string>();
    const formulas = new Map<string, string>();
    for (const list of grid.values())
      for (const x of list)
        if (x.v !== null && typeof x.v === "object") formulas.set(x.ref, x.v.formula);
        else if (typeof x.v === "number" || typeof x.v === "string") values.set(x.ref, x.v);
    const results = evaluateSheet(values, formulas);
    for (const [r, list] of grid)
      rows.set(
        r,
        list.map((x) => cellXml(x.ref, x.v, x.s, results.get(x.ref))),
      );
    const widths = s.columns.map((c, i) => c.width ?? Math.min(60, Math.max(8, c.header.length + 2, ...s.rows.slice(0, 500).map((r) => width(r[i] ?? null) + 2))));
    outs.push({
      name,
      rows,
      widths,
      freezeRows: head,
      ...(s.rows.length ? { autoFilter: `A${head}:${colName(cols - 1)}${last}` } : {}),
      merges,
      conditional: [],
    });
  }
  return makeZip(bookParts(outs, styles) as Map<string, string | Buffer>);
}

/** A grid (CSV, a query's result) as a one-sheet workbook; the first row is the header. */
export async function gridToXlsx(name: string, grid: CellValue[][]): Promise<Buffer> {
  const [head = [], ...rows] = grid;
  const cols = Math.max(1, head.length, ...rows.map((r) => r.length));
  return buildXlsx([
    {
      name: name.slice(0, 31) || "Sheet1",
      columns: Array.from({ length: cols }, (_, i) => ({ header: head[i] === null || head[i] === undefined ? colName(i) : String(head[i]) })),
      rows: rows.map((r) => r.map((v) => (typeof v === "string" && v.startsWith("=") ? `'${v}` : v))),
    },
  ]);
}

// ── Changes to an existing workbook ──────────────────────────────────────────────────────────────────────

const Cell = z.string().regex(/^\$?[A-Za-z]{1,3}\$?\d{1,7}$/, "a cell like B5");
const Range = z.string().regex(/^\$?[A-Za-z]{1,3}\$?\d{1,7}(:\$?[A-Za-z]{1,3}\$?\d{1,7})?$/, "a range like C2:C40");
const Col = z.string().regex(/^[A-Za-z]{1,3}$/, "a column letter like C");
const sheet = z.string().max(31).optional();
const Rows = z.array(z.array(Value).max(60));

export const EditOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set"), sheet, cell: Cell, value: Value }),
  z.object({ op: z.literal("setRange"), sheet, start: Cell, rows: Rows.max(2000) }),
  z.object({ op: z.literal("appendRows"), sheet, rows: Rows.min(1).max(2000) }),
  z.object({ op: z.literal("insertRows"), sheet, at: z.number().int().min(1), rows: Rows.min(1).max(2000) }),
  z.object({ op: z.literal("deleteRows"), sheet, from: z.number().int().min(1), count: z.number().int().min(1).max(5000) }),
  z.object({
    op: z.literal("insertColumn"),
    sheet,
    at: Col,
    header: z.string().max(120).optional(),
    formula: z.string().max(500).optional(),
    headerRow: z.number().int().min(1).max(50).optional(),
  }),
  z.object({ op: z.literal("deleteColumn"), sheet, column: Col }),
  z.object({ op: z.literal("fill"), sheet, column: Col, formula: z.string().min(2).max(500), from: z.number().int().min(1).optional(), to: z.number().int().min(1).optional() }),
  z.object({ op: z.literal("addSheet"), name: z.string().min(1).max(31), columns: z.array(z.string().max(120)).max(60).optional(), rows: Rows.max(5000).optional() }),
  z.object({ op: z.literal("renameSheet"), from: z.string().max(31), to: z.string().min(1).max(31) }),
  z.object({ op: z.literal("deleteSheet"), name: z.string().max(31) }),
  z.object({ op: z.literal("sort"), sheet, column: Col, desc: z.boolean().optional(), headerRow: z.number().int().min(1).max(50).optional() }),
  z.object({ op: z.literal("totals"), sheet, columns: z.array(Col).min(1).max(30), label: z.string().max(60).optional(), headerRow: z.number().int().min(1).max(50).optional() }),
  z.object({ op: z.literal("format"), sheet, range: Range, as: z.enum(TYPES) }),
  z.object({
    op: z.literal("highlight"),
    sheet,
    range: Range,
    when: z.enum([">", ">=", "<", "<=", "=", "!=", "contains", "blank", "duplicate"]),
    value: z.union([z.string().max(200), z.number()]).optional(),
    color: z.enum(["red", "yellow", "green", "blue"]).optional(),
  }),
  z.object({ op: z.literal("freeze"), sheet, rows: z.number().int().min(0).max(20).optional(), columns: z.number().int().min(0).max(10).optional() }),
  z.object({ op: z.literal("autofilter"), sheet, headerRow: z.number().int().min(1).max(50).optional() }),
]);
export type EditOp = z.infer<typeof EditOp>;

/** A cell being edited: as read (kept byte for byte unless changed) or new. */
interface Live {
  s?: string | undefined;
  t?: string | undefined;
  raw?: string | undefined;
  value: CellValue;
  formula?: string | undefined;
  /** Changed or moved: written from value/formula, its stale cached result dropped. */
  dirty?: boolean;
  /** A changed formula's result worked out here (evaluate.ts). */
  cached?: number;
}
interface Model {
  sheet: RawSheet;
  name: string;
  rows: Map<number, { attrs: string; cells: Map<number, Live> }>;
  xml: string;
  touched: boolean;
}

const fromRaw = (c: RawCell): Live => ({ s: c.s, t: c.t, raw: c.raw, value: c.value, formula: c.formula });

function liveXml(ref: string, c: Live): string {
  const s = c.s && c.s !== "0" ? ` s="${c.s}"` : "";
  if (c.formula)
    return `<c r="${ref}"${s}${!c.dirty && c.t === "str" ? ' t="str"' : ""}><f>${esc(c.formula)}</f>${c.cached !== undefined ? `<v>${c.cached}</v>` : !c.dirty && c.raw !== undefined ? `<v>${esc(c.raw)}</v>` : ""}</c>`;
  // Unchanged cells go back as they were read (a date stays its day number, a shared string its index).
  if (!c.dirty && c.raw !== undefined && c.t !== "inlineStr") return `<c r="${ref}"${s}${c.t && c.t !== "n" ? ` t="${c.t}"` : ""}><v>${esc(c.raw)}</v></c>`;
  if (c.value === null) return s ? `<c r="${ref}"${s}/>` : "";
  return cellXml(ref, c.value, c.s);
}

const QUOTE = (n: string) => (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(n) ? n : `'${n.replace(/'/g, "''")}'`);

/**
 * References moved by an inserted or deleted block of rows or columns, as Excel moves them (absolute ones too).
 * `own`: references without a sheet name belong to the changed sheet; `sheetName`: only references naming it move.
 */
function moveRefs(formula: string, axis: "row" | "col", at: number, n: number, del: boolean, own: boolean, sheetName: string): string {
  const shiftOne = (v: number, end?: "start" | "end"): number | null => {
    if (v < at) return v;
    if (!del) return v + n;
    if (v >= at + n) return v - n;
    return end === "start" ? at : end === "end" ? at - 1 : null;
  };
  const qn = `(?:'${sheetName.replace(/'/g, "''").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'|${sheetName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})!`;
  const re = new RegExp(`(^|[^A-Za-z0-9_.!'])((?:'[^']+'|[A-Za-z0-9_.]+)!)?(\\$?)([A-Z]{1,3})(\\$?)(\\d{1,7})(?::(\\$?)([A-Z]{1,3})(\\$?)(\\d{1,7}))?(?![A-Za-z0-9_(])`, "g");
  return formula
    .split(/("(?:[^"]|"")*")/)
    .map((part, i) =>
      i % 2
        ? part
        : part.replace(re, (m, pre: string, sh: string | undefined, ca: string, c: string, ra: string, r: string, ca2?: string, c2?: string, ra2?: string, r2?: string) => {
            const mine = sh ? new RegExp(`^${qn}$`).test(sh) : own;
            if (!mine) return m;
            const one = (col: string, row: string, end?: "start" | "end") => {
              if (axis === "row") {
                const v = shiftOne(Number(row), end);
                return v === null ? null : { col, row: String(v) };
              }
              const v = shiftOne(colIndex(col) + 1, end);
              return v === null ? null : { col: colName(v - 1), row };
            };
            if (c2 && r2) {
              const a = one(c, r, "start");
              const b = one(c2, r2, "end");
              if (!a || !b || (axis === "row" ? Number(b.row) < Number(a.row) : colIndex(b.col) < colIndex(a.col))) return `${pre}${sh ?? ""}#REF!`;
              return `${pre}${sh ?? ""}${ca}${a.col}${ra}${a.row}:${ca2}${b.col}${ra2}${b.row}`;
            }
            const a = one(c, r);
            return a ? `${pre}${sh ?? ""}${ca}${a.col}${ra}${a.row}` : `${pre}${sh ?? ""}#REF!`;
          }),
    )
    .join("");
}

/** A range string ("A1:C9 E2") moved like moveRefs; a part that disappears is dropped. */
function moveSqref(sqref: string, axis: "row" | "col", at: number, n: number, del: boolean): string {
  return sqref
    .split(/\s+/)
    .map((p) => moveRefs(p, axis, at, n, del, true, "\u0000"))
    .filter((p) => p && !p.includes("#REF!"))
    .join(" ");
}

class StylesEdit {
  constructor(public xml: string) {}
  private fmtIds = new Map<NumFmt, number>();
  private cloned = new Map<string, number>();
  private fmtId(fmt: NumFmt): number {
    const known = this.fmtIds.get(fmt);
    if (known !== undefined) return known;
    const f = NUMFMT[fmt];
    if (f.id < 164) {
      this.fmtIds.set(fmt, f.id);
      return f.id;
    }
    const existing = [...this.xml.matchAll(/<numFmt\b[^>]*>/g)].find((m) => unxml(/formatCode="([^"]*)"/.exec(m[0])?.[1] ?? "") === f.code);
    if (existing) {
      const id = Number(/numFmtId="(\d+)"/.exec(existing[0])![1]);
      this.fmtIds.set(fmt, id);
      return id;
    }
    const id = Math.max(163, ...[...this.xml.matchAll(/<numFmt\b[^>]*numFmtId="(\d+)"/g)].map((m) => Number(m[1]))) + 1;
    const tag = `<numFmt numFmtId="${id}" formatCode="${esc(f.code)}"/>`;
    if (/<numFmts\b[^>]*\/>/.test(this.xml)) this.xml = this.xml.replace(/<numFmts\b[^>]*\/>/, `<numFmts count="1">${tag}</numFmts>`);
    else if (/<numFmts\b/.test(this.xml))
      this.xml = this.xml.replace(/(<numFmts\b[^>]*>)/, `$1${tag}`).replace(/<numFmts count="(\d+)"/, (_m, c: string) => `<numFmts count="${Number(c) + 1}"`);
    else this.xml = this.xml.replace(/(<styleSheet\b[^>]*>)/, `$1<numFmts count="1">${tag}</numFmts>`);
    this.fmtIds.set(fmt, id);
    return id;
  }
  private xfs(): string[] {
    const body = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(this.xml)?.[1] ?? "";
    return [...body.matchAll(/<xf\b[^>]*\/>|<xf\b[^>]*>[\s\S]*?<\/xf>/g)].map((m) => m[0]);
  }
  private addXf(xf: string): number {
    const list = this.xfs();
    this.xml = this.xml.replace(/<\/cellXfs>/, `${xf}</cellXfs>`).replace(/<cellXfs count="\d+"/, `<cellXfs count="${list.length + 1}"`);
    return list.length;
  }
  /** The style index of style `s` with number format `fmt`. */
  withFormat(s: string | undefined, fmt: NumFmt): string {
    const key = `${s ?? "0"}|${fmt}`;
    const hit = this.cloned.get(key);
    if (hit !== undefined) return String(hit);
    const id = this.fmtId(fmt);
    const base = this.xfs()[Number(s ?? 0)] ?? '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>';
    const xf = base
      .replace(/numFmtId="\d+"/, `numFmtId="${id}"`)
      .replace(/<xf\b/, (m) => (/applyNumberFormat=/.test(base) ? m : `${m} applyNumberFormat="1"`))
      .replace(/applyNumberFormat="0"/, 'applyNumberFormat="1"');
    const at = this.addXf(xf);
    this.cloned.set(key, at);
    return String(at);
  }
  /** A bold style (for a totals row or a new header), added once. */
  bold(): string {
    const hit = this.cloned.get("bold");
    if (hit !== undefined) return String(hit);
    const fonts = /<fonts\b[^>]*>([\s\S]*?)<\/fonts>/.exec(this.xml)?.[1] ?? "";
    const count = [...fonts.matchAll(/<font\b[^>]*\/>|<font\b[^>]*>[\s\S]*?<\/font>/g)].length;
    this.xml = this.xml.replace(/<\/fonts>/, `<font><b/><sz val="11"/><name val="Arial"/></font></fonts>`).replace(/<fonts count="\d+"/, `<fonts count="${count + 1}"`);
    const at = this.addXf(`<xf numFmtId="0" fontId="${count}" fillId="0" borderId="0" xfId="0" applyFont="1"/>`);
    this.cloned.set("bold", at);
    return String(at);
  }
  /** The dxf index of a highlight colour, added once. */
  dxf(color: keyof typeof DXF): number {
    const key = `dxf:${color}`;
    const hit = this.cloned.get(key);
    if (hit !== undefined) return hit;
    const argb = ["FFFDE2E1", "FFFFF4CC", "FFE3F5E6", "FFE3ECFB"][DXF[color]]!;
    const tag = `<dxf><fill><patternFill patternType="solid"><bgColor rgb="${argb}"/></patternFill></fill></dxf>`;
    let at: number;
    if (/<dxfs\b[^>]*\/>/.test(this.xml)) {
      this.xml = this.xml.replace(/<dxfs\b[^>]*\/>/, `<dxfs count="1">${tag}</dxfs>`);
      at = 0;
    } else if (/<dxfs\b/.test(this.xml)) {
      at = [...(/<dxfs\b[^>]*>([\s\S]*?)<\/dxfs>/.exec(this.xml)?.[1] ?? "").matchAll(/<dxf>/g)].length;
      this.xml = this.xml.replace(/<\/dxfs>/, `${tag}</dxfs>`).replace(/<dxfs count="\d+"/, `<dxfs count="${at + 1}"`);
    } else {
      this.xml = this.xml.replace(/(<\/cellStyles>|<\/cellXfs>)(?![\s\S]*(<\/cellStyles>))/, `$1<dxfs count="1">${tag}</dxfs>`);
      at = 0;
    }
    this.cloned.set(key, at);
    return at;
  }
}

/** Inserts a worksheet element where the schema's order allows (before the first of the elements that follow it). */
function insertInSheet(xml: string, el: string, before: string[]): string {
  const re = new RegExp(`<(${before.join("|")})\\b`);
  const m = re.exec(xml);
  return m ? `${xml.slice(0, m.index)}${el}${xml.slice(m.index)}` : xml.replace(/<\/worksheet>/, `${el}</worksheet>`);
}
const AFTER_CF = [
  "dataValidations",
  "hyperlinks",
  "printOptions",
  "pageMargins",
  "pageSetup",
  "headerFooter",
  "rowBreaks",
  "colBreaks",
  "customProperties",
  "cellWatches",
  "ignoredErrors",
  "smartTags",
  "drawing",
  "legacyDrawing",
  "legacyDrawingHF",
  "picture",
  "oleObjects",
  "controls",
  "webPublishItems",
  "tableParts",
  "extLst",
];
const AFTER_FILTER = ["sortState", "dataConsolidate", "customSheetViews", "mergeCells", "phoneticPr", "conditionalFormatting", ...AFTER_CF];

/** Applies the changes in order and returns the new file and one line per change for the answer. */
export async function editXlsx(buf: Buffer, name: string, ops: EditOp[]): Promise<{ buffer: Buffer; done: string[] }> {
  if (checkOffice(buf, name) !== "xlsx") throw new OfficeRefused(`${name} is not an Excel workbook (.xlsx).`);
  const parts = await openZip(buf);
  const texts = new Map([...parts.entries()].filter((e): e is [string, string] => typeof e[1] === "string"));
  const book = readBook(texts);
  const styles = new StylesEdit(texts.get("xl/styles.xml") ?? "");
  let workbook = texts.get("xl/workbook.xml") ?? "";
  let wbRels = texts.get("xl/_rels/workbook.xml.rels") ?? "";
  let types = texts.get("[Content_Types].xml") ?? "";
  const models: Model[] = book.sheets.map((s) => ({
    sheet: s,
    name: s.name,
    xml: s.xml,
    touched: false,
    rows: new Map(s.rows.map((r) => [r.r, { attrs: r.attrs, cells: new Map(r.cells.map((c) => [c.col, fromRaw(c)])) }])),
  }));
  const pick = (s?: string): Model => {
    const m = s ? models.find((x) => x.name.toLowerCase() === s.toLowerCase()) : models[0];
    if (!m) throw new OfficeRefused(`No sheet "${s}". The sheets are: ${models.map((x) => x.name).join(", ")}.`);
    m.touched = true;
    return m;
  };
  const lastRow = (m: Model) => Math.max(0, ...[...m.rows.entries()].filter(([, r]) => [...r.cells.values()].some((c) => c.value !== null || c.formula)).map(([n]) => n));
  const lastCol = (m: Model) => Math.max(0, ...[...m.rows.values()].flatMap((r) => [...r.cells.entries()].filter(([, c]) => c.value !== null || c.formula).map(([c]) => c + 1)));
  const row = (m: Model, r: number) => {
    let x = m.rows.get(r);
    if (!x) m.rows.set(r, (x = { attrs: "", cells: new Map() }));
    return x;
  };
  /** The style a new cell takes: the cell above it, so an added row looks like the rows before. */
  const styleAbove = (m: Model, r: number, c: number) => {
    for (let k = r - 1; k >= Math.max(1, r - 3); k--) {
      const s = m.rows.get(k)?.cells.get(c)?.s;
      if (s) return s;
    }
    return undefined;
  };
  const put = (m: Model, r: number, c: number, v: Value, keepStyle = true) => {
    const cur = m.rows.get(r)?.cells.get(c);
    const stored = storeValue(v);
    const s = keepStyle ? (cur?.s ?? styleAbove(m, r, c)) : undefined;
    row(m, r).cells.set(
      c,
      typeof stored === "object" && stored !== null ? { s, value: null, formula: stored.formula, dirty: true } : { s, value: stored as CellValue, dirty: true },
    );
  };
  /** Every formula of every sheet, through f (moving references after a structural change). */
  const eachFormula = (f: (formula: string, own: Model) => string) => {
    for (const m of models)
      for (const r of m.rows.values())
        for (const c of r.cells.values())
          if (c.formula) {
            const next = f(c.formula, m);
            if (next !== c.formula) {
              c.formula = next;
              c.dirty = true;
              m.touched = true;
            }
          }
  };
  const shiftSheetXml = (m: Model, axis: "row" | "col", at: number, n: number, del: boolean) => {
    m.xml = m.xml
      .replace(/(<mergeCell ref=")([^"]+)(")/g, (_x, a: string, ref: string, b: string) => {
        const moved = moveSqref(ref, axis, at, n, del);
        return moved ? `${a}${moved}${b}` : "";
      })
      .replace(/<mergeCell ref=""\/>/g, "")
      .replace(/(<autoFilter ref=")([^"]+)(")/, (_x, a: string, ref: string, b: string) => `${a}${moveSqref(ref, axis, at, n, del) || ref}${b}`)
      .replace(/(<conditionalFormatting\b[^>]*sqref=")([^"]+)(")/g, (_x, a: string, ref: string, b: string) => `${a}${moveSqref(ref, axis, at, n, del) || ref}${b}`);
  };
  const shiftRows = (m: Model, at: number, n: number, del: boolean) => {
    const next = new Map<number, { attrs: string; cells: Map<number, Live> }>();
    for (const [r, x] of m.rows) {
      if (del && r >= at && r < at + n) continue;
      const to = r >= at ? (del ? r - n : r + n) : r;
      if (to !== r) for (const c of x.cells.values()) c.dirty = c.dirty || !!c.formula;
      next.set(to, x);
    }
    m.rows = next;
    eachFormula((f, own) => moveRefs(f, "row", at, n, del, own === m, m.name));
    shiftSheetXml(m, "row", at, n, del);
  };
  const shiftCols = (m: Model, at: number, n: number, del: boolean) => {
    for (const x of m.rows.values()) {
      const next = new Map<number, Live>();
      for (const [c, cell] of x.cells) {
        if (del && c >= at && c < at + n) continue;
        next.set(c >= at ? (del ? c - n : c + n) : c, cell);
      }
      x.cells = next;
    }
    eachFormula((f, own) => moveRefs(f, "col", at + 1, n, del, own === m, m.name));
    shiftSheetXml(m, "col", at + 1, n, del);
    // Column widths move with their columns.
    m.xml = m.xml.replace(/<col\b([^>]*)\/>/g, (tag, a: string) => {
      const min = Number(/min="(\d+)"/.exec(a)?.[1]);
      const max = Number(/max="(\d+)"/.exec(a)?.[1]);
      const mv = (v: number) => (v - 1 >= at ? (del ? v - n : v + n) : v);
      if (del && min - 1 >= at && max - 1 < at + n) return "";
      return tag.replace(/min="\d+"/, `min="${Math.max(1, mv(min))}"`).replace(/max="\d+"/, `max="${Math.max(1, mv(max))}"`);
    });
  };
  const done: string[] = [];

  for (const op of ops) {
    switch (op.op) {
      case "set": {
        const m = pick(op.sheet);
        const at = splitRef(op.cell)!;
        put(m, at.row, at.col, op.value);
        done.push(`${m.name}!${op.cell.toUpperCase().replace(/\$/g, "")} = ${String(op.value)}`);
        break;
      }
      case "setRange": {
        const m = pick(op.sheet);
        const at = splitRef(op.start)!;
        op.rows.forEach((r, i) => r.forEach((v, j) => put(m, at.row + i, at.col + j, v)));
        done.push(`${m.name}: ${op.rows.length} rows written from ${op.start.toUpperCase()}`);
        break;
      }
      case "appendRows": {
        const m = pick(op.sheet);
        const from = lastRow(m) + 1;
        op.rows.forEach((r, i) => r.forEach((v, j) => put(m, from + i, j, v)));
        done.push(`${m.name}: ${op.rows.length} rows added from row ${from}`);
        break;
      }
      case "insertRows": {
        const m = pick(op.sheet);
        shiftRows(m, op.at, op.rows.length, false);
        op.rows.forEach((r, i) => r.forEach((v, j) => put(m, op.at + i, j, v)));
        done.push(`${m.name}: ${op.rows.length} rows inserted at row ${op.at}`);
        break;
      }
      case "deleteRows": {
        const m = pick(op.sheet);
        shiftRows(m, op.from, op.count, true);
        done.push(`${m.name}: rows ${op.from}–${op.from + op.count - 1} deleted`);
        break;
      }
      case "insertColumn": {
        const m = pick(op.sheet);
        const at = colIndex(op.at);
        shiftCols(m, at, 1, false);
        const head = op.headerRow ?? 1;
        if (op.header) put(m, head, at, op.header);
        if (op.formula) for (let r = head + 1; r <= lastRow(m); r++) put(m, r, at, `=${op.formula.replace(/^=/, "").replace(/\{r\}/g, String(r))}`);
        done.push(`${m.name}: column ${op.at.toUpperCase()} inserted${op.header ? ` (${op.header})` : ""}`);
        break;
      }
      case "deleteColumn": {
        const m = pick(op.sheet);
        shiftCols(m, colIndex(op.column), 1, true);
        done.push(`${m.name}: column ${op.column.toUpperCase()} deleted`);
        break;
      }
      case "fill": {
        const m = pick(op.sheet);
        const from = op.from ?? 2;
        const to = Math.min(op.to ?? lastRow(m), from + 20_000);
        const c = colIndex(op.column);
        // "{r}" is the row being filled: "=C{r}*D{r}" becomes =C2*D2, =C3*D3, …
        for (let r = from; r <= to; r++) put(m, r, c, `=${op.formula.replace(/^=/, "").replace(/\{r\}/g, String(r))}`);
        done.push(`${m.name}: ${op.column.toUpperCase()}${from}:${op.column.toUpperCase()}${to} = ${op.formula}`);
        break;
      }
      case "sort": {
        const m = pick(op.sheet);
        const head = op.headerRow ?? 1;
        let last = lastRow(m);
        // A totals row stays at the bottom.
        if (isTotalsRow([...(m.rows.get(last)?.cells.entries() ?? [])].sort((a, b) => a[0] - b[0]).map(([, c]) => c.value))) last--;
        const c = colIndex(op.column);
        const body = [...m.rows.entries()].filter(([r]) => r > head && r <= last).sort((a, b) => a[0] - b[0]);
        const key = (x: { cells: Map<number, Live> }) => x.cells.get(c)?.value ?? null;
        const sorted = [...body].sort((a, b) => {
          const x = key(a[1]);
          const y = key(b[1]);
          if (x === null || x === "") return 1;
          if (y === null || y === "") return -1;
          const cmp = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "vi");
          return op.desc ? -cmp : cmp;
        });
        sorted.forEach(([from, x], i) => {
          const to = body[i]![0];
          for (const cell of x.cells.values())
            if (cell.formula && from !== to) {
              // A sorted row keeps pointing at its own cells ("=C5*D5" moved to row 2 reads "=C2*D2").
              cell.formula = cell.formula.replace(/(^|[^A-Za-z0-9_.$])(\$?[A-Z]{1,3})(\d+)(?![\d(A-Za-z_])/g, (mm, pre: string, col: string, r: string) =>
                Number(r) === from ? `${pre}${col}${to}` : mm,
              );
              cell.dirty = true;
            }
          m.rows.set(to, x);
        });
        done.push(`${m.name}: rows ${head + 1}–${last} sorted by ${op.column.toUpperCase()}${op.desc ? " (high to low)" : ""}`);
        break;
      }
      case "totals": {
        const m = pick(op.sheet);
        const head = op.headerRow ?? 1;
        const last = lastRow(m);
        const at = last + 1;
        const bold = styles.bold();
        row(m, at).cells.set(0, { s: bold, value: op.label?.trim() || "Tổng", dirty: true });
        for (const col of op.columns) {
          const c = colIndex(col);
          const above = styleAbove(m, at, c);
          row(m, at).cells.set(c, { s: above ?? bold, value: null, formula: `SUM(${col.toUpperCase()}${head + 1}:${col.toUpperCase()}${last})`, dirty: true });
        }
        done.push(`${m.name}: totals in row ${at} (${op.columns.map((x) => x.toUpperCase()).join(", ")})`);
        break;
      }
      case "format": {
        const m = pick(op.sheet);
        const [a, b] = op.range.replace(/\$/g, "").toUpperCase().split(":");
        const s = splitRef(a!)!;
        const e = splitRef(b ?? a!)!;
        for (let r = s.row; r <= Math.min(e.row, s.row + 20_000); r++)
          for (let c = s.col; c <= e.col; c++) {
            const cell = m.rows.get(r)?.cells.get(c);
            if (!cell) continue;
            cell.s = styles.withFormat(cell.s, op.as);
            // Only the style changes; a date typed as text ("15/06/2025") becomes a real date.
            if (op.as === "date" && typeof cell.value === "string" && (cell.t === "s" || cell.t === "inlineStr" || cell.t === "str")) {
              const d = dateValue(cell.value);
              if (d !== null) {
                cell.value = d;
                cell.t = undefined;
                cell.dirty = true;
              }
            }
          }
        done.push(`${m.name}!${op.range.toUpperCase()} as ${op.as}`);
        break;
      }
      case "highlight": {
        const m = pick(op.sheet);
        const ref = op.range.replace(/\$/g, "").toUpperCase();
        const first = ref.split(":")[0]!;
        const dxf = styles.dxf(op.color ?? "yellow");
        const v = typeof op.value === "number" ? String(op.value) : `"${String(op.value ?? "").replace(/"/g, '""')}"`;
        const priority = (m.xml.match(/<cfRule\b/g) ?? []).length + 1;
        const rule =
          op.when === "duplicate"
            ? `<cfRule type="duplicateValues" dxfId="${dxf}" priority="${priority}"/>`
            : `<cfRule type="expression" dxfId="${dxf}" priority="${priority}"><formula>${esc(op.when === "blank" ? `LEN(TRIM(${first}))=0` : op.when === "contains" ? `ISNUMBER(SEARCH(${v},${first}))` : `${first}${op.when === "!=" ? "<>" : op.when}${v}`)}</formula></cfRule>`;
        m.xml = insertInSheet(m.xml, `<conditionalFormatting sqref="${ref}">${rule}</conditionalFormatting>`, AFTER_CF);
        done.push(`${m.name}!${ref} highlighted when ${op.when}${op.value !== undefined ? ` ${op.value}` : ""}`);
        break;
      }
      case "freeze": {
        const m = pick(op.sheet);
        const rows = op.rows ?? 1;
        const cols = op.columns ?? 0;
        const top = `${colName(cols)}${rows + 1}`;
        const pane =
          rows || cols
            ? `<pane${cols ? ` xSplit="${cols}"` : ""}${rows ? ` ySplit="${rows}"` : ""} topLeftCell="${top}" activePane="${rows && cols ? "bottomRight" : rows ? "bottomLeft" : "topRight"}" state="frozen"/>`
            : "";
        const view = `<sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews>`;
        m.xml = /<sheetViews\b[\s\S]*?<\/sheetViews>|<sheetViews\b[^>]*\/>/.test(m.xml)
          ? m.xml.replace(/<sheetViews\b[\s\S]*?<\/sheetViews>|<sheetViews\b[^>]*\/>/, view)
          : insertInSheet(m.xml, view, ["sheetFormatPr", "cols", "sheetData"]);
        done.push(`${m.name}: ${rows} rows${cols ? ` and ${cols} columns` : ""} frozen`);
        break;
      }
      case "autofilter": {
        const m = pick(op.sheet);
        const head = op.headerRow ?? 1;
        const ref = `A${head}:${colName(Math.max(0, lastCol(m) - 1))}${Math.max(head, lastRow(m))}`;
        m.xml = /<autoFilter\b/.test(m.xml)
          ? m.xml.replace(/<autoFilter\b[^>]*\/>|<autoFilter\b[\s\S]*?<\/autoFilter>/, `<autoFilter ref="${ref}"/>`)
          : insertInSheet(m.xml, `<autoFilter ref="${ref}"/>`, AFTER_FILTER);
        done.push(`${m.name}: filter on ${ref}`);
        break;
      }
      case "addSheet": {
        if (models.some((x) => x.name.toLowerCase() === op.name.toLowerCase())) throw new OfficeRefused(`A sheet named "${op.name}" already exists.`);
        const n = Math.max(0, ...[...parts.keys()].map((k) => Number(/^xl\/worksheets\/sheet(\d+)\.xml$/.exec(k)?.[1] ?? 0))) + 1;
        const path = `xl/worksheets/sheet${n}.xml`;
        const rid = `rId${Math.max(0, ...[...wbRels.matchAll(/Id="rId(\d+)"/g)].map((x) => Number(x[1]))) + 1}`;
        const sheetId = Math.max(0, ...[...workbook.matchAll(/<sheet\b[^>]*sheetId="(\d+)"/g)].map((x) => Number(x[1]))) + 1;
        const safe = op.name.replace(/[\\/?*[\]:]/g, " ").slice(0, 31);
        workbook = workbook.replace(/<\/sheets>/, `<sheet name="${esc(safe)}" sheetId="${sheetId}" r:id="${rid}"/></sheets>`);
        wbRels = wbRels.replace(
          /<\/Relationships>/,
          `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${n}.xml"/></Relationships>`,
        );
        types = types.replace(/<\/Types>/, `<Override PartName="/${path}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`);
        const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><sheetData/><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`;
        const m: Model = { sheet: { name: safe, path, xml, rows: [] }, name: safe, xml, rows: new Map(), touched: true };
        models.push(m);
        const bold = op.columns?.length ? styles.bold() : undefined;
        op.columns?.forEach((h, c) => row(m, 1).cells.set(c, { s: bold, value: h, dirty: true }));
        (op.rows ?? []).forEach((r, i) => r.forEach((v, c) => put(m, (op.columns?.length ? 2 : 1) + i, c, v, false)));
        done.push(`sheet "${safe}" added`);
        break;
      }
      case "renameSheet": {
        const m = pick(op.from);
        const to = op.to.replace(/[\\/?*[\]:]/g, " ").slice(0, 31);
        const old = m.name;
        workbook = workbook.replace(new RegExp(`(<sheet\\b[^>]*name=")${esc(old).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(")`), `$1${esc(to)}$2`);
        const oldRef = new RegExp(`(?:'${old.replace(/'/g, "''").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'|\\b${old.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})!`, "g");
        eachFormula((f) => f.replace(oldRef, `${QUOTE(to)}!`));
        workbook = workbook.replace(
          /(<definedName\b[^>]*>)([^<]*)(<\/definedName>)/g,
          (_x, a: string, body: string, b: string) => `${a}${esc(unxml(body).replace(oldRef, `${QUOTE(to)}!`))}${b}`,
        );
        m.name = to;
        done.push(`sheet "${old}" renamed "${to}"`);
        break;
      }
      case "deleteSheet": {
        const m = pick(op.name);
        if (models.length < 2) throw new OfficeRefused("A workbook keeps at least one sheet.");
        const rid = [...wbRels.matchAll(/<Relationship\b[^>]*>/g)].find(
          (x) => x[0].includes(`Target="${m.sheet.path.replace(/^xl\//, "")}"`) || x[0].includes(`Target="/${m.sheet.path}"`),
        )?.[0];
        const id = rid ? /Id="([^"]+)"/.exec(rid)?.[1] : undefined;
        if (id) workbook = workbook.replace(new RegExp(`<sheet\\b[^>]*r:id="${id}"[^>]*/>`), "");
        if (rid) wbRels = wbRels.replace(rid, "");
        types = types.replace(new RegExp(`<Override PartName="/${m.sheet.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*/>`), "");
        parts.delete(m.sheet.path);
        models.splice(models.indexOf(m), 1);
        done.push(`sheet "${m.name}" deleted`);
        break;
      }
    }
  }

  // Excel recalculates every formula when the file opens; its old calculation order would only be wrong now.
  if (!/fullCalcOnLoad/.test(workbook))
    workbook = /<calcPr\b/.test(workbook)
      ? workbook.replace(/<calcPr\b/, '<calcPr fullCalcOnLoad="1"')
      : workbook.replace(/<\/workbook>/, '<calcPr fullCalcOnLoad="1"/></workbook>');
  if (parts.has("xl/calcChain.xml")) {
    parts.delete("xl/calcChain.xml");
    wbRels = wbRels.replace(/<Relationship\b[^>]*Target="calcChain\.xml"[^>]*\/>/, "");
    types = types.replace(/<Override PartName="\/xl\/calcChain\.xml"[^>]*\/>/, "");
  }
  for (const m of models) {
    if (!m.touched) continue;
    // Changed formulas get their result again where it can be worked out here (Excel recalculates the rest on open).
    const values = new Map<string, number | string>();
    const formulas = new Map<string, string>();
    for (const [r, x] of m.rows)
      for (const [c, cell] of x.cells) {
        const ref = `${colName(c)}${r}`;
        // Every formula is worked out again: one changed cell moves the totals that read it.
        if (cell.formula) formulas.set(ref, cell.formula);
        // A date reads as its ISO text but is a day number in the cell.
        else if (cell.raw !== undefined && cell.t === undefined && Number.isFinite(Number(cell.raw))) values.set(ref, Number(cell.raw));
        else if (typeof cell.value === "number" || typeof cell.value === "string") values.set(ref, cell.value);
      }
    const results = evaluateSheet(values, formulas);
    for (const [r, x] of m.rows)
      for (const [c, cell] of x.cells) {
        const v = cell.formula ? results.get(`${colName(c)}${r}`) : undefined;
        if (v !== undefined) cell.cached = v;
      }
    const nums = [...m.rows.keys()].sort((a, b) => a - b);
    let maxCol = 0;
    const data = nums
      .map((r) => {
        const x = m.rows.get(r)!;
        const cells = [...x.cells.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([c, cell]) => {
            maxCol = Math.max(maxCol, c + 1);
            return liveXml(`${colName(c)}${r}`, cell);
          });
        const body = cells.join("");
        return body || x.attrs.trim() ? `<row r="${r}"${x.attrs}>${body}</row>` : "";
      })
      .join("");
    let xml = m.xml.replace(/<sheetData\b[^>]*\/>|<sheetData\b[^>]*>[\s\S]*<\/sheetData>/, `<sheetData>${data}</sheetData>`);
    const dim = nums.length ? `A1:${colName(Math.max(0, maxCol - 1))}${nums.at(-1)}` : "A1";
    xml = /<dimension\b/.test(xml) ? xml.replace(/<dimension\b[^>]*\/>/, `<dimension ref="${dim}"/>`) : xml;
    parts.set(m.sheet.path, xml);
  }
  parts.set("xl/styles.xml", styles.xml);
  parts.set("xl/workbook.xml", workbook);
  parts.set("xl/_rels/workbook.xml.rels", wbRels);
  parts.set("[Content_Types].xml", types);
  return { buffer: await makeZip(parts), done };
}
