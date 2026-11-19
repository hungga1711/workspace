import { z } from "zod";
import { colIndex, colName, type CellValue } from "./read.js";

/**
 * Questions about a table answered by the server, not guessed by the model: the model fills a small
 * query (filter, group, add up, pivot, sort, find duplicates or blanks) and this runs it over the sheet's rows. No
 * code from the model is ever run. Columns are named by their header (any case, with or without accents) or letter.
 */

const OPS = ["=", "!=", ">", ">=", "<", "<=", "contains", "starts", "empty", "notEmpty"] as const;
const FNS = ["sum", "avg", "count", "min", "max", "countDistinct"] as const;

export const SheetQuery = z.object({
  sheet: z.string().max(120).optional(),
  /** 1-based row of the headers; found by itself when left out. */
  headerRow: z.number().int().min(1).max(50).optional(),
  filter: z
    .array(z.object({ column: z.string().min(1).max(120), op: z.enum(OPS), value: z.union([z.string().max(200), z.number()]).optional() }))
    .max(10)
    .optional(),
  select: z.array(z.string().min(1).max(120)).max(30).optional(),
  groupBy: z.array(z.string().min(1).max(120)).max(3).optional(),
  measures: z
    .array(z.object({ fn: z.enum(FNS), column: z.string().max(120).optional() }))
    .max(8)
    .optional(),
  pivot: z.object({ rows: z.string().max(120), columns: z.string().max(120), value: z.string().max(120).optional(), fn: z.enum(FNS).default("sum") }).optional(),
  sort: z
    .array(z.object({ column: z.string().min(1).max(120), desc: z.boolean().optional() }))
    .max(3)
    .optional(),
  limit: z.number().int().min(1).max(500).optional(),
  find: z.enum(["duplicates", "blanks", "errors"]).optional(),
  /** With `find: "duplicates"`: the columns that make two rows the same (all selected columns when left out). */
  keys: z.array(z.string().max(120)).max(5).optional(),
  totals: z.boolean().optional(),
});
export type SheetQuery = z.infer<typeof SheetQuery>;

export interface QueryResult {
  columns: string[];
  rows: CellValue[][];
  /** Rows the filter kept (before grouping and the limit). */
  matched: number;
  /** Rows in the sheet below the headers. */
  total: number;
  notes: string[];
}

export class QueryProblem extends Error {}

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase().replace(/\s+/g, " ").trim();

/** The header row: the first of the first ten whose cells are mostly text and that has a row below it. */
export function headerRowOf(grid: CellValue[][]): number {
  for (let i = 0; i < Math.min(10, grid.length - 1); i++) {
    const row = grid[i]!.filter((v) => v !== null && v !== "");
    if (row.length >= 2 && row.filter((v) => typeof v === "string").length >= row.length * 0.7) return i;
  }
  return 0;
}

const num = (v: CellValue): number | null => (typeof v === "number" ? v : typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : null);
const blank = (v: CellValue) => v === null || (typeof v === "string" && !v.trim());
const ERR = /^#(REF!|DIV\/0!|VALUE!|NAME\?|N\/A|NUM!|NULL!|SPILL!|CALC!)/;

function aggregate(fn: (typeof FNS)[number], values: CellValue[]): CellValue {
  if (fn === "count") return values.filter((v) => !blank(v)).length;
  if (fn === "countDistinct") return new Set(values.filter((v) => !blank(v)).map((v) => fold(String(v)))).size;
  const nums = values.map(num).filter((v): v is number => v !== null);
  if (!nums.length) return null;
  if (fn === "sum") return round(nums.reduce((a, b) => a + b, 0));
  if (fn === "avg") return round(nums.reduce((a, b) => a + b, 0) / nums.length);
  return fn === "min" ? Math.min(...nums) : Math.max(...nums);
}
const round = (n: number) => Math.round(n * 1e6) / 1e6;

function compare(a: CellValue, b: CellValue): number {
  const x = num(a);
  const y = num(b);
  if (x !== null && y !== null) return x - y;
  if (blank(a)) return blank(b) ? 0 : 1;
  if (blank(b)) return -1;
  return String(a).localeCompare(String(b), "vi");
}

/** A row that sums the ones above it: its first text says so ("Tổng", "Tổng cộng", "Total", "Cộng"). */
export function isTotalsRow(row: CellValue[]): boolean {
  const first = row.find((v) => !blank(v));
  return typeof first === "string" && /^(tong( cong)?|cong|total|totals|grand total|sum|合计|总计|total general)\b/.test(fold(first));
}

/** Runs a query over a sheet's grid. Throws QueryProblem naming the columns there are when one is not found. */
export function runQuery(grid: CellValue[][], q: SheetQuery): QueryResult {
  if (!grid.length) throw new QueryProblem("The sheet is empty.");
  const h = q.headerRow ? q.headerRow - 1 : headerRowOf(grid);
  const width = Math.max(...grid.map((r) => r.length));
  const headers = Array.from({ length: width }, (_, i) => {
    const v = grid[h]?.[i];
    return v === null || v === undefined || v === "" ? colName(i) : String(v).trim();
  });
  const col = (name: string): number => {
    const want = fold(name);
    const byName = headers.findIndex((x) => fold(x) === want);
    if (byName >= 0) return byName;
    if (/^[A-Z]{1,3}$/i.test(name.trim())) {
      const i = colIndex(name.trim());
      if (i < width) return i;
    }
    const partial = headers.findIndex((x) => fold(x).includes(want));
    if (partial >= 0 && want.length >= 3) return partial;
    throw new QueryProblem(`No column "${name}". The columns are: ${headers.join(", ")}.`);
  };
  const body = grid.slice(h + 1).filter((r) => r.some((v) => !blank(v)));
  const notes: string[] = [];
  // A totals row at the bottom is the sheet's own sum, not data: counting it would double every total.
  while (body.length && isTotalsRow(body.at(-1)!)) {
    body.pop();
    notes.push("The sheet's totals row was left out.");
  }
  let rows = body;
  for (const f of q.filter ?? []) {
    const i = col(f.column);
    const want = f.value;
    rows = rows.filter((r) => {
      const v = r[i] ?? null;
      switch (f.op) {
        case "empty":
          return blank(v);
        case "notEmpty":
          return !blank(v);
        case "contains":
          return fold(String(v ?? "")).includes(fold(String(want ?? "")));
        case "starts":
          return fold(String(v ?? "")).startsWith(fold(String(want ?? "")));
        case "=":
          return num(v) !== null && num(want ?? null) !== null ? num(v) === num(want ?? null) : fold(String(v ?? "")) === fold(String(want ?? ""));
        case "!=":
          return num(v) !== null && num(want ?? null) !== null ? num(v) !== num(want ?? null) : fold(String(v ?? "")) !== fold(String(want ?? ""));
        default: {
          const c = compare(v, want ?? null);
          return f.op === ">" ? c > 0 : f.op === ">=" ? c >= 0 : f.op === "<" ? c < 0 : c <= 0;
        }
      }
    });
  }
  const matched = rows.length;
  let columns: string[];
  let out: CellValue[][];

  if (q.find === "blanks") {
    const pick = (q.select ?? headers).map(col);
    columns = ["Row", "Empty columns"];
    out = rows
      .map((r) => [grid.indexOf(r) + 1, pick.filter((i) => blank(r[i] ?? null)).map((i) => headers[i]!)] as const)
      .filter(([, empty]) => empty.length)
      .map(([n, empty]) => [n, empty.join(", ")]);
  } else if (q.find === "errors") {
    columns = ["Cell", "Error"];
    out = [];
    grid.forEach((r, ri) => r.forEach((v, ci) => typeof v === "string" && ERR.test(v) && out.push([`${colName(ci)}${ri + 1}`, v])));
  } else if (q.find === "duplicates") {
    const keys = (q.keys?.length ? q.keys : (q.select ?? headers)).map(col);
    const seen = new Map<string, number[]>();
    for (const r of rows) {
      const k = keys.map((i) => fold(String(r[i] ?? ""))).join("\u0001");
      if (keys.every((i) => blank(r[i] ?? null))) continue;
      seen.set(k, [...(seen.get(k) ?? []), grid.indexOf(r) + 1]);
    }
    columns = [...keys.map((i) => headers[i]!), "Rows", "Times"];
    out = [...seen.entries()]
      .filter(([, at]) => at.length > 1)
      .map(([k, at]) => [...k.split("\u0001").map((x, j) => (rows.find((r) => grid.indexOf(r) + 1 === at[0])?.[keys[j]!] ?? x) as CellValue), at.join(", "), at.length]);
  } else if (q.pivot) {
    const ri = col(q.pivot.rows);
    const ci = col(q.pivot.columns);
    const vi = q.pivot.value ? col(q.pivot.value) : -1;
    const across = [...new Set(rows.map((r) => String(r[ci] ?? "")))].sort((a, b) => a.localeCompare(b, "vi")).slice(0, 30);
    const down = [...new Set(rows.map((r) => String(r[ri] ?? "")))];
    columns = [headers[ri]!, ...across];
    out = down.map((d) => [
      d,
      ...across.map((a) =>
        aggregate(
          q.pivot!.fn,
          rows.filter((r) => String(r[ri] ?? "") === d && String(r[ci] ?? "") === a).map((r) => (vi >= 0 ? (r[vi] ?? null) : 1)),
        ),
      ),
    ]);
    if (across.length >= 30) notes.push("Only the first 30 column values are shown.");
  } else if (q.groupBy?.length || q.measures?.length) {
    const gi = (q.groupBy ?? []).map(col);
    const measures = q.measures?.length ? q.measures : [{ fn: "count" as const }];
    const mi = measures.map((m) => (m.column ? col(m.column) : -1));
    const groups = new Map<string, CellValue[][]>();
    for (const r of rows) {
      const k = gi.map((i) => String(r[i] ?? "")).join("\u0001");
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    columns = [...gi.map((i) => headers[i]!), ...measures.map((m, j) => `${m.fn}${mi[j]! >= 0 ? ` ${headers[mi[j]!]}` : ""}`)];
    out = [...groups.entries()].map(([k, rs]) => [
      ...(gi.length ? k.split("\u0001") : []),
      ...measures.map((m, j) =>
        aggregate(
          m.fn,
          rs.map((r) => (mi[j]! >= 0 ? (r[mi[j]!] ?? null) : 1)),
        ),
      ),
    ]);
    if (!q.sort?.length && measures.length) {
      const at = gi.length;
      out.sort((a, b) => compare(b[at] ?? null, a[at] ?? null));
    }
  } else {
    const pick = (q.select ?? headers).map(col);
    columns = pick.map((i) => headers[i]!);
    out = rows.map((r) => pick.map((i) => r[i] ?? null));
  }

  for (const s of [...(q.sort ?? [])].reverse()) {
    const i = columns.findIndex((c) => fold(c) === fold(s.column) || fold(c).endsWith(` ${fold(s.column)}`));
    if (i < 0) throw new QueryProblem(`Cannot sort by "${s.column}": the result's columns are ${columns.join(", ")}.`);
    out.sort((a, b) => (s.desc ? -1 : 1) * compare(a[i] ?? null, b[i] ?? null));
  }
  if (q.totals && out.length) {
    const sums = columns.map((_, i) =>
      i > 0 && out.every((r) => blank(r[i] ?? null) || num(r[i] ?? null) !== null)
        ? aggregate(
            "sum",
            out.map((r) => r[i] ?? null),
          )
        : null,
    );
    out.push(["Total", ...sums.slice(1)]);
  }
  const limit = q.limit ?? 200;
  if (out.length > limit) notes.push(`${out.length} rows; the first ${limit} are shown.`);
  return { columns, rows: out.slice(0, limit), matched, total: body.length, notes };
}

/** The result as a Markdown table for the model. */
export function resultMarkdown(r: QueryResult, max = 120): string {
  const cell = (v: CellValue) => (v === null ? "" : typeof v === "number" ? String(v) : String(v).replace(/\|/g, "/").replace(/\n/g, " ").slice(0, 120));
  const lines = [`| ${r.columns.join(" | ")} |`, `|${r.columns.map(() => "---").join("|")}|`, ...r.rows.slice(0, max).map((row) => `| ${row.map(cell).join(" | ")} |`)];
  return lines.join("\n");
}
