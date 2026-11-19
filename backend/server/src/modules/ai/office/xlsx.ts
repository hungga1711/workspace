import { unxml } from "./xml.js";

/**
 * Excel workbooks read and written as SpreadsheetML by hand. The Excel libraries pull in a pile of
 * polyfills that the dev server's loader cannot run, and we need only part of the format: cell values, formulas,
 * number formats, a styled header, frozen rows, filters, merged title cells and conditional highlights. An edit keeps
 * the rest of the file (its styles, column widths, other sheets) as it was.
 */

export type CellValue = string | number | boolean | null;

/** Column letters of a 0-based index (0 → A, 27 → AB). */
export function colName(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}
/** 0-based index of column letters (A → 0). */
export const colIndex = (letters: string) => [...letters.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
export const splitRef = (ref: string) => {
  const m = /^\$?([A-Z]{1,3})\$?(\d+)$/i.exec(ref);
  return m ? { col: colIndex(m[1]!), row: Number(m[2]) } : null;
};
export const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // Characters XML 1.0 cannot carry at all.
    // eslint-disable-next-line no-control-regex -- matching control characters is the point
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
const attr = (xml: string, name: string) => {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(xml);
  return m ? unxml(m[1]!) : undefined;
};

/**
 * A formula's references moved by rows and columns, as Excel does when a formula is copied: `$` parts stay. Text in
 * quotes and function names are left alone.
 */
export function shiftFormula(formula: string, dRow: number, dCol: number, onlyRowsFrom = 0): string {
  if (!dRow && !dCol) return formula;
  return formula
    .split(/("(?:[^"]|"")*")/)
    .map((part, i) =>
      i % 2
        ? part
        : part.replace(/(^|[^A-Za-z0-9_.])(\$?)([A-Z]{1,3})(\$?)(\d{1,7})(?![A-Za-z0-9_(])/g, (m, pre: string, ca: string, c: string, ra: string, r: string) => {
            const row = Number(r);
            if (onlyRowsFrom && row < onlyRowsFrom) return m;
            const col = ca ? c : colName(Math.max(0, colIndex(c) + dCol));
            const nr = ra && !onlyRowsFrom ? row : Math.max(1, row + dRow);
            return `${pre}${ca}${col}${ra}${nr}`;
          }),
    )
    .join("");
}

// ── Reading ──────────────────────────────────────────────────────────────────────────────────────────────

export interface RawCell {
  /** 0-based column. */
  col: number;
  /** The cell's style index (`s`), kept on edit. */
  s?: string;
  /** `t`: s (shared string), str, inlineStr, b, e, n. */
  t?: string;
  formula?: string;
  value: CellValue;
  /** The <v> as written (a shared-string index for t="s"), kept on edit. */
  raw?: string;
}
export interface RawRow {
  r: number;
  /** The row's own attributes except r and spans (height, style), kept on edit. */
  attrs: string;
  cells: RawCell[];
}
export interface RawSheet {
  name: string;
  path: string;
  xml: string;
  rows: RawRow[];
}
export interface Book {
  files: Map<string, string>;
  shared: string[];
  sheets: RawSheet[];
  /** Style indexes whose number format is a date. */
  dateStyles: Set<number>;
}

const BUILTIN_DATES = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function dateStylesOf(styles: string): Set<number> {
  const custom = new Map([...styles.matchAll(/<numFmt\b[^>]*>/g)].map((m) => [Number(attr(m[0], "numFmtId")), attr(m[0], "formatCode") ?? ""]));
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? "";
  const out = new Set<number>();
  [...xfs.matchAll(/<xf\b[^>]*\/?>/g)].forEach((m, i) => {
    const id = Number(attr(m[0], "numFmtId") ?? 0);
    const code = custom.get(id) ?? "";
    if (BUILTIN_DATES.has(id) || (/[dmy]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]/g, "")) && !/[#0]/.test(code))) out.add(i);
  });
  return out;
}

/** Excel's day number (1900 system) as an ISO date. */
export const serialDate = (n: number) => new Date(Math.round((n - 25569) * 86400_000)).toISOString().slice(0, 10);
export const dateSerial = (d: Date) => d.getTime() / 86400_000 + 25569;

function readCells(rowXml: string, shared: string[], dates: Set<number>, sharedF: Map<string, { formula: string; row: number; col: number }>, r: number): RawCell[] {
  const cells: RawCell[] = [];
  let next = 0;
  for (const m of rowXml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const a = m[1]!;
    const body = m[2] ?? "";
    const ref = attr(a, "r");
    const col = ref ? (splitRef(ref)?.col ?? next) : next;
    next = col + 1;
    const t = attr(a, "t");
    const s = attr(a, "s");
    const v = /<v>([^<]*)<\/v>/.exec(body)?.[1];
    const fTag = /<f\b([^>]*)(?:\/>|>([^<]*)<\/f>)/.exec(body);
    let formula: string | undefined;
    if (fTag) {
      const fa = fTag[1]!;
      const text = fTag[2] !== undefined ? unxml(fTag[2]) : "";
      const si = attr(fa, "si");
      if (attr(fa, "t") === "shared" && si !== undefined) {
        if (text) {
          sharedF.set(si, { formula: text, row: r, col });
          formula = text;
        } else {
          const master = sharedF.get(si);
          if (master) formula = shiftFormula(master.formula, r - master.row, col - master.col);
        }
      } else if (text) formula = text;
    }
    let value: CellValue = null;
    if (t === "s") value = v !== undefined ? (shared[Number(v)] ?? "") : null;
    else if (t === "inlineStr") value = [...body.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((x) => unxml(x[1]!)).join("");
    else if (t === "str" || t === "e") value = v !== undefined ? unxml(v) : null;
    else if (t === "b") value = v === "1";
    else if (v !== undefined && v !== "") {
      const n = Number(v);
      // A day number shown as a date (up to the year 9999); anything larger is a number in a date format.
      value = Number.isFinite(n) ? (s !== undefined && dates.has(Number(s)) && n > 0 && n < 2_958_466 ? serialDate(n) : n) : unxml(v);
    }
    cells.push({ col, ...(s !== undefined ? { s } : {}), ...(t ? { t } : {}), ...(formula ? { formula } : {}), value, ...(v !== undefined ? { raw: v } : {}) });
  }
  return cells;
}

const ROWS_MAX = 50_000;

/** A workbook's parts: every XML part as text (the zip's other parts are kept as bytes by the caller). */
export function readBook(files: Map<string, string>): Book {
  const wb = files.get("xl/workbook.xml") ?? "";
  const rels = new Map([...(files.get("xl/_rels/workbook.xml.rels") ?? "").matchAll(/<Relationship\b[^>]*>/g)].map((m) => [attr(m[0], "Id") ?? "", attr(m[0], "Target") ?? ""]));
  const shared = [...(files.get("xl/sharedStrings.xml") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((si) =>
    // Phonetic runs (<rPh>) are a reading aid, not the text.
    [...si[1]!.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((x) => unxml(x[1]!)).join(""),
  );
  const dates = dateStylesOf(files.get("xl/styles.xml") ?? "");
  const sheets: RawSheet[] = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const target = rels.get(attr(m[0], "r:id") ?? "") ?? "";
    const path = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
    const xml = files.get(path);
    if (!xml) continue;
    const sharedF = new Map<string, { formula: string; row: number; col: number }>();
    const rows: RawRow[] = [];
    let n = 0;
    for (const row of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const r = Number(attr(row[1]!, "r") ?? n + 1);
      n = r;
      rows.push({ r, attrs: row[1]!.replace(/\s*\br="[^"]*"/, "").replace(/\s*\bspans="[^"]*"/, ""), cells: readCells(row[2] ?? "", shared, dates, sharedF, r) });
      if (rows.length >= ROWS_MAX) break;
    }
    sheets.push({ name: attr(m[0], "name") ?? `Sheet${sheets.length + 1}`, path, xml, rows });
  }
  return { files, shared, sheets, dateStyles: dates };
}

/** A sheet's values as a grid (row 1 first), trailing empty rows dropped. */
export function gridOf(sheet: RawSheet): CellValue[][] {
  const grid: CellValue[][] = [];
  for (const row of sheet.rows) {
    const line: CellValue[] = grid[row.r - 1] ?? [];
    for (const c of row.cells) if (c.col < 200) line[c.col] = c.value;
    grid[row.r - 1] = line;
  }
  const out = Array.from({ length: grid.length }, (_, i) => Array.from({ length: grid[i]?.length ?? 0 }, (_, j) => grid[i]?.[j] ?? null));
  while (out.length && !out.at(-1)!.some((v) => v !== null && v !== "")) out.pop();
  return out;
}

// ── Writing ──────────────────────────────────────────────────────────────────────────────────────────────

/** The number formats the tools write; ids from 164 are the file's own. */
export const NUMFMT = {
  text: { id: 49, code: "@" },
  number: { id: 164, code: "#,##0.##" },
  integer: { id: 3, code: "#,##0" },
  currency: { id: 165, code: '#,##0 "₫"' },
  percent: { id: 166, code: "0.0%" },
  date: { id: 167, code: "dd/mm/yyyy" },
} as const;
export type NumFmt = keyof typeof NUMFMT;

export interface StyleKey {
  fmt?: NumFmt | undefined;
  /** 0 normal, 1 bold, 2 title (bold, larger). */
  font?: 0 | 1 | 2;
  /** 0 none, 2 the header fill. */
  fill?: 0 | 2;
  /** 0 none, 1 line below, 2 line above. */
  border?: 0 | 1 | 2;
  wrap?: boolean;
}

/** The styles part of a workbook the tools write: a small fixed set of fonts, fills and borders, and one xf per mix. */
export class Styles {
  private readonly xfs: StyleKey[] = [{}];
  index(k: StyleKey): number {
    const key = JSON.stringify(k);
    const at = this.xfs.findIndex((x) => JSON.stringify(x) === key);
    if (at >= 0) return at;
    this.xfs.push(k);
    return this.xfs.length - 1;
  }
  xml(): string {
    const custom = Object.values(NUMFMT).filter((f) => f.id >= 164);
    const xf = (k: StyleKey) => {
      const fmt = k.fmt ? NUMFMT[k.fmt].id : 0;
      return `<xf numFmtId="${fmt}" fontId="${k.font ?? 0}" fillId="${k.fill ?? 0}" borderId="${k.border ?? 0}" xfId="0"${fmt ? ' applyNumberFormat="1"' : ""}${k.font ? ' applyFont="1"' : ""}${k.fill ? ' applyFill="1"' : ""}${k.border ? ' applyBorder="1"' : ""}${k.wrap ? ' applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>' : "/>"}`;
    };
    return (
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `<numFmts count="${custom.length}">${custom.map((f) => `<numFmt numFmtId="${f.id}" formatCode="${esc(f.code)}"/>`).join("")}</numFmts>` +
      `<fonts count="3"><font><sz val="11"/><name val="Arial"/><family val="2"/></font><font><b/><sz val="11"/><color rgb="FF1F2A44"/><name val="Arial"/><family val="2"/></font><font><b/><sz val="14"/><color rgb="FF1F2A44"/><name val="Arial"/><family val="2"/></font></fonts>` +
      `<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEEF0F6"/><bgColor indexed="64"/></patternFill></fill></fills>` +
      `<borders count="3"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FF9AA3B5"/></bottom><diagonal/></border><border><left/><right/><top style="thin"><color rgb="FF9AA3B5"/></top><bottom/><diagonal/></border></borders>` +
      `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
      `<cellXfs count="${this.xfs.length}">${this.xfs.map(xf).join("")}</cellXfs>` +
      `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
      `<dxfs count="4">${["FFFDE2E1", "FFFFF4CC", "FFE3F5E6", "FFE3ECFB"].map((c) => `<dxf><fill><patternFill patternType="solid"><bgColor rgb="${c}"/></patternFill></fill></dxf>`).join("")}</dxfs>` +
      `</styleSheet>`
    );
  }
}
/** The dxf index of each highlight colour in Styles.xml(). */
export const DXF = { red: 0, yellow: 1, green: 2, blue: 3 } as const;

/** One cell as XML: formulas as <f>, text inline, numbers and booleans as values. */
export function cellXml(ref: string, v: CellValue | { formula: string }, s?: number | string, cached?: number): string {
  const st = s !== undefined && s !== 0 && s !== "0" ? ` s="${s}"` : "";
  if (v === null || v === undefined || v === "") return st ? `<c r="${ref}"${st}/>` : "";
  if (typeof v === "object") return `<c r="${ref}"${st}><f>${esc(v.formula)}</f>${cached !== undefined ? `<v>${cached}</v>` : ""}</c>`;
  if (typeof v === "number") return Number.isFinite(v) ? `<c r="${ref}"${st}><v>${v}</v></c>` : "";
  if (typeof v === "boolean") return `<c r="${ref}"${st} t="b"><v>${v ? 1 : 0}</v></c>`;
  return `<c r="${ref}"${st} t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
}

export interface SheetOut {
  name: string;
  /** Rows of XML cells already built, by 1-based row number. */
  rows: Map<number, string[]>;
  widths: number[];
  freezeRows?: number;
  autoFilter?: string;
  merges: string[];
  conditional: string[];
}

export function sheetXml(s: SheetOut): string {
  const rowNums = [...s.rows.keys()].sort((a, b) => a - b);
  const data = rowNums.map((r) => `<row r="${r}">${s.rows.get(r)!.join("")}</row>`).join("");
  const pane = s.freezeRows
    ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${s.freezeRows}" topLeftCell="A${s.freezeRows + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft"/></sheetView></sheetViews>`
    : `<sheetViews><sheetView workbookViewId="0"/></sheetViews>`;
  const cols = s.widths.length ? `<cols>${s.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>` : "";
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `${pane}<sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${data}</sheetData>` +
    `${s.autoFilter ? `<autoFilter ref="${s.autoFilter}"/>` : ""}` +
    `${s.merges.length ? `<mergeCells count="${s.merges.length}">${s.merges.map((m) => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>` : ""}` +
    s.conditional.join("") +
    `<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`
  );
}

/** The parts of a new workbook around its sheets. */
export function bookParts(sheets: SheetOut[], styles: Styles): Map<string, string> {
  const files = new Map<string, string>();
  const head = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`;
  files.set(
    "[Content_Types].xml",
    `${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
  );
  files.set(
    "_rels/.rels",
    `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`,
  );
  files.set(
    "docProps/core.xml",
    `${head}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>Workspace AI</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d+Z$/, "Z")}</dcterms:created></cp:coreProperties>`,
  );
  files.set(
    "docProps/app.xml",
    `${head}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Workspace</Application></Properties>`,
  );
  const quote = (n: string) => `'${n.replace(/'/g, "''")}'`;
  const names = sheets
    .map((s, i) =>
      s.autoFilter
        ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${esc(quote(s.name))}!${s.autoFilter.replace(/([A-Z]+)(\d+)/g, "$$$1$$$2")}</definedName>`
        : "",
    )
    .join("");
  files.set(
    "xl/workbook.xml",
    `${head}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>${names ? `<definedNames>${names}</definedNames>` : ""}<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`,
  );
  files.set(
    "xl/_rels/workbook.xml.rels",
    `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  );
  files.set("xl/styles.xml", styles.xml());
  sheets.forEach((s, i) => files.set(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)));
  return files;
}
