import { z } from "zod";
import { featureDisabled } from "@workspace/shared";
import type { AnswerBlock } from "./answer-blocks.js";
import type { Loc } from "./locale.js";
import { ToolProblem, type AttachedFile, type Source, type Tool, type ToolContext } from "./tools.js";
import { clip, en, enc, F, field, L, str, work, type Say, type Write } from "./workspace-kit.js";
import { checkFormulas, formulaFacts } from "./office/formulas.js";
import { kindOf, MIME, OfficeRefused } from "./office/guard.js";
import { blocksToMarkdown } from "./office/markdown.js";
import { isPdf, readPdf, scanNote } from "./office/pdf.js";
import { parseCsv, readOffice, renderOffice, type CellValue, type OfficeRead, type Sheet } from "./office/read.js";
import { QueryProblem, resultMarkdown, runQuery, SheetQuery, type QueryResult } from "./office/sheet-query.js";
import { fillTemplate, zipFiles } from "./office/template.js";
import { buildDocx } from "./office/write-docx.js";
import { buildPdf } from "./office/write-pdf.js";
import { buildPptx, outlineToSlides, SlideSpec, THEMES } from "./office/write-pptx.js";
import { buildXlsx, EditOp, editXlsx, gridToXlsx, SheetSpec } from "./office/write-xlsx.js";

/**
 * The assistant's Office tools: read, analyse, create and change Word, Excel, PowerPoint
 * and PDF files, with
 * any connected AI. The model only describes the content (Markdown, rows, an outline, a query); the server builds and
 * reads the files itself (office/), so a small local model can make a spreadsheet as well as a large one. Files come
 * from the question's attachments, the asker's earlier Hỏi đáp attachments, a task or the Drive, read as the asker;
 * what the tools make is saved on a task or in the asker's Drive, only after they approve the card.
 */

// ── Where files come from ────────────────────────────────────────────────────────────────────────────────

interface Opened {
  name: string;
  data: Buffer;
  /** Where it lives in the workspace (none for a file attached in Hỏi đáp). */
  source?: Source;
}
interface Found {
  fileId: string;
  name: string;
  contentType: string;
  size: number;
  where: { type: "task"; id: string; code: string; title: string } | { type: "drive"; id: string };
}

/** The byte-order mark Excel needs to read a CSV as UTF-8 (Vietnamese letters intact). */
const BOM = String.fromCharCode(0xfeff);
const BOM_RE = new RegExp(`^${BOM}`);

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase().trim();
const bare = (n: string) => fold(n).replace(/\.[a-z0-9]+$/, "");
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const fileSource = (f: { fileId: string; name: string }): Source => ({ type: "file", id: f.fileId, title: f.name, url: `/app/files/${f.fileId}` });

function pickAttached(list: AttachedFile[], ref: string): AttachedFile[] {
  const q = fold(ref);
  const exact = list.filter((f) => fold(f.name) === q);
  if (exact.length) return exact;
  const stem = list.filter((f) => bare(f.name) === bare(ref));
  return stem.length ? stem : list.filter((f) => fold(f.name).includes(bare(ref)));
}

/**
 * The file a tool works on: an attachment of this question, a task's attachment, an earlier Hỏi đáp attachment, a
 * Drive file by name, or a file id. Several matches are a question for the person, never a guess.
 */
async function openFile(ctx: ToolContext, ref: string, task?: string): Promise<Opened> {
  const want = ref.trim();
  if (!task && ctx.files?.length) {
    const hit = want ? pickAttached(ctx.files, want) : ctx.files.length === 1 ? ctx.files : [];
    if (hit.length) return { name: hit[0]!.name, data: hit[0]!.data };
  }
  const fetchOne = async (f: Found): Promise<Opened> => {
    const r = await work<Found & { data: string }>(ctx, "GET", `/office/files/${enc(f.fileId)}/content`);
    return { name: r.name, data: Buffer.from(r.data, "base64"), source: fileSource(r) };
  };
  if (task) {
    const r = await work<{ files: Found[] }>(ctx, "GET", `/office/files?task=${enc(task)}${want ? `&name=${enc(want)}` : ""}`);
    if (r.files.length === 1) return fetchOne(r.files[0]!);
    if (!r.files.length) throw new ToolProblem(`Task ${task} has no Word, Excel, PowerPoint, PDF or CSV file${want ? ` named like "${want}"` : ""}.`);
    throw new ToolProblem(`Task ${task} has several such files: ${r.files.map((f) => f.name).join(", ")}. Ask which one.`);
  }
  if (ULID.test(want)) return fetchOne({ fileId: want } as Found);
  if (!want) throw new ToolProblem("Name the file (or attach it to the question).");
  const stored = await ctx.storedFile?.(want).catch(() => []);
  if (stored?.length) return { name: stored[0]!.name, data: stored[0]!.data };
  if (featureDisabled("docs")) throw new ToolProblem(`No attached file is called "${want}". Attach it to the question, or name the task it is on.`);
  const r = await work<{ files: Found[] }>(ctx, "GET", `/office/files?name=${enc(want)}`);
  if (r.files.length === 1 || (r.files.length > 1 && fold(r.files[0]!.name) === fold(want) && fold(r.files[1]!.name) !== fold(want))) return fetchOne(r.files[0]!);
  if (!r.files.length)
    throw new ToolProblem(`No file called "${want}" in this question, your earlier questions or the Drive files you can open. Attach it or name the task it is on.`);
  throw new ToolProblem(`Several files match "${want}": ${r.files.map((f) => `${f.name}${f.where.type === "task" ? ` (task ${f.where.code})` : ""}`).join(", ")}. Ask which one.`);
}

/**
 * A file opened as its structure; a CSV is a one-sheet workbook, a PDF its pages' text. Refusals (macros, bombs,
 * damage, a password, a scan with no text) become ToolProblems.
 */
async function structure(f: Opened): Promise<OfficeRead> {
  if (isPdf(f.name)) {
    try {
      const r = await readPdf(f.data, f.name);
      if (r.scanned) throw new ToolProblem(scanNote(f.name));
      return r;
    } catch (e) {
      if (e instanceof OfficeRefused) throw new ToolProblem(e.message);
      throw e;
    }
  }
  if (/\.(csv|tsv|txt)$/i.test(f.name)) {
    const grid = parseCsv(f.data.toString("utf8").replace(BOM_RE, ""));
    return { kind: "xlsx", sheets: [{ name: f.name.replace(/\.[a-z]+$/i, ""), grid, cells: [], rowCount: grid.length, colCount: Math.max(0, ...grid.map((r) => r.length)) }] };
  }
  try {
    return await readOffice(f.data, f.name);
  } catch (e) {
    if (e instanceof OfficeRefused) throw new ToolProblem(e.message);
    throw e;
  }
}

function sheetOf(r: OfficeRead, name?: string): Sheet {
  if (r.kind !== "xlsx") throw new ToolProblem(`That is not a spreadsheet (Excel .xlsx or CSV)${r.kind === "pdf" ? "; a table in a PDF can be read with read_office_file" : ""}.`);
  if (!name) {
    const first = r.sheets.find((s) => s.grid.length) ?? r.sheets[0];
    if (!first) throw new ToolProblem("The workbook has no sheets.");
    return first;
  }
  const s = r.sheets.find((x) => fold(x.name) === fold(name)) ?? r.sheets.find((x) => fold(x.name).includes(fold(name)));
  if (!s) throw new ToolProblem(`No sheet "${name}". The sheets are: ${r.sheets.map((x) => x.name).join(", ")}.`);
  return s;
}

// ── Where files go ───────────────────────────────────────────────────────────────────────────────────────

interface Saved {
  fileId: string;
  name: string;
  size: number;
  where: { type: "task"; id: string; code: string; title: string } | { type: "drive"; id: string };
}

/** A name with the right extension and nothing a file system dislikes. */
export function fileName(raw: string, ext: string): string {
  const base = raw
    .trim()
    // eslint-disable-next-line no-control-regex -- control characters are exactly what a file name must not carry
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\.(docx?|xlsx?|pptx?|csv|md|zip|pdf)$/i, "")
    .slice(0, 120)
    .trim();
  return `${base || "file"}.${ext}`;
}

async function save(ctx: ToolContext, name: string, data: Buffer, task?: string): Promise<{ saved: Saved; source: Source; where: string }> {
  if (!task && featureDisabled("docs")) throw new ToolProblem("This installation has no Drive. Name a task to attach the file to.");
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";
  const contentType =
    MIME[ext as keyof typeof MIME] ??
    (ext === "pdf" ? "application/pdf" : ext === "csv" ? "text/csv" : ext === "zip" ? "application/zip" : ext === "md" ? "text/markdown" : "application/octet-stream");
  const saved = await work<Saved>(ctx, "POST", "/office/files", { name, contentType, data: data.toString("base64"), ...(task ? { task } : {}) });
  const where =
    saved.where.type === "task"
      ? en(ctx)
        ? `attached to task ${saved.where.code} (${saved.where.title})`
        : `đã gắn vào việc ${saved.where.code} (${saved.where.title})`
      : en(ctx)
        ? "saved in your Drive"
        : "đã lưu trong Drive của bạn";
  return { saved, source: fileSource(saved), where };
}

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const savedLine = (ctx: ToolContext, s: { saved: Saved; where: string }) =>
  `${en(ctx) ? "Saved" : "Đã tạo"} ${s.saved.name} (${kb(s.saved.size)}), ${s.where}. ${en(ctx) ? "The person downloads it from the link under the answer." : "Người dùng tải về từ liên kết dưới câu trả lời."}`;

// ── Tables for the answer ────────────────────────────────────────────────────────────────────────────────

function tableBlock(id: string, title: string, r: QueryResult): AnswerBlock {
  const cell = (v: CellValue): string | number | null => (v === null ? null : typeof v === "boolean" ? String(v) : v);
  return {
    kind: "table",
    id,
    title: title.slice(0, 120),
    columns: r.columns.slice(0, 8).map((c, i) => ({ key: `c${i}`, label: c.slice(0, 40), ...(r.rows.some((row) => typeof row[i] === "number") ? { num: true } : {}) })),
    rows: r.rows.slice(0, 40).map((row) => ({ cells: Object.fromEntries(r.columns.slice(0, 8).map((_, i) => [`c${i}`, cell(row[i] ?? null)])) })),
    ...(r.rows.length > 40 ? { more: r.rows.length - 40 } : {}),
  };
}
/** A bar chart of a grouping with one figure (department → total), when it is small enough to read. */
function barBlock(id: string, title: string, r: QueryResult): AnswerBlock | null {
  if (r.columns.length !== 2 || r.rows.length < 2 || r.rows.length > 20 || !r.rows.every((x) => typeof x[1] === "number")) return null;
  return {
    kind: "chart",
    id,
    title: title.slice(0, 120),
    chart: "bars",
    rows: r.rows.filter((x) => String(x[0] ?? "") !== "Total").map((x) => ({ label: String(x[0] ?? "—").slice(0, 40), value: x[1] as number })),
  };
}

// ── Inputs ───────────────────────────────────────────────────────────────────────────────────────────────

const FILE_HELP =
  'the file: its name as attached to this question or an earlier one ("bang-luong.xlsx"), a Drive file\'s name, or a file id. With `task`, a file attached to that task';
const fileInput = { file: z.string().max(200).default(""), task: z.string().max(80).optional() };
const fileSchema = { file: str(FILE_HELP), task: str("a task code (T-041) whose attachment it is (optional)") };
const saveInput = { task: z.string().max(80).optional() };
const saveSchema = { task: str("attach the new file to this task (a code like T-041); leave out to save it in the person's Drive") };

/** Card labels of this file (the shared F has the common ones). */
const C = {
  file: { en: "File", vi: "Tệp" },
  where: { en: "Saved to", vi: "Lưu vào" },
  drive: { en: "Your Drive", vi: "Drive của bạn" },
  outline: { en: "Content", vi: "Nội dung" },
  sheets: { en: "Sheets", vi: "Trang tính" },
  slides: { en: "Slides", vi: "Trang chiếu" },
  changes: { en: "Changes", vi: "Thay đổi" },
  from: { en: "From", vi: "Từ tệp" },
  values: { en: "Values", vi: "Giá trị" },
  rows: { en: "One file per row of", vi: "Mỗi dòng một tệp, từ" },
  to: { en: "Convert to", vi: "Chuyển sang" },
} satisfies Record<string, Say>;
const whereField = (loc: Loc, task: unknown) => field(loc, C.where, task ? `${L(loc, { en: "Task", vi: "Việc" })} ${String(task)}` : L(loc, C.drive));

/** One line naming what a read file is. */
function headOf(name: string, r: OfficeRead): string {
  if (r.kind === "xlsx") return `${name}: workbook, sheets ${r.sheets.map((s) => `"${s.name}" (${s.rowCount}×${s.colCount})`).join(", ")}`;
  if (r.kind === "pptx") return `${name}: presentation, ${r.slides.length} slides`;
  if (r.kind === "pdf") return `${name}: PDF, ${r.total} pages${r.total > r.pages.length ? ` (the first ${r.pages.length} are read)` : ""}`;
  return `${name}: document, ${r.blocks.filter((b) => b.type === "heading").length} headings`;
}

/**
 * A file's text for the tools that work on any text (summarize_document, doc_to_tasks, extract_action_items): opened
 * like read_office_file, as the asker, in parts of about `size` characters.
 */
export async function fileText(
  ctx: ToolContext,
  file: string,
  task: string | undefined,
  part = 1,
  size = 20_000,
): Promise<{ head: string; text: string; parts: number; source: Source | null }> {
  const f = await openFile(ctx, file, task);
  const r = await structure(f);
  const { text, parts } = renderOffice(r, part, size);
  const more = parts > 1 ? ` (part ${Math.min(part, parts)} of ${parts}; ask for part=${Math.min(part, parts) + 1} for more)` : "";
  return { head: `${headOf(f.name, r)}${more}`, text, parts, source: f.source ?? null };
}

// ── Read tools ───────────────────────────────────────────────────────────────────────────────────────────

const READ: Tool[] = [
  {
    name: "read_office_file",
    description:
      "Read a Word (.docx), Excel (.xlsx), PowerPoint (.pptx), PDF or CSV file in full, as its structure: a document's headings, lists and tables; every sheet's cells with their values AND formulas (A1 addresses); every slide's title, text, tables and speaker notes; a PDF's text page by page (cite pages as \"p. 3\"). Long files come in parts (`part`). Use it before answering about a file's details, summarizing or translating a file, turning it into tasks, explaining a workbook, or changing a file.",
    permission: "file.read",
    input: z.object({ ...fileInput, part: z.number().int().min(1).max(200).optional(), sheet: z.string().max(120).optional() }),
    jsonSchema: {
      type: "object",
      properties: { ...fileSchema, part: { type: "integer", description: "which part of a long file (1, 2, …)" }, sheet: str("only this sheet of a workbook (optional)") },
    },
    async run(ctx, input) {
      const f = await openFile(ctx, input.file, input.task);
      const r = await structure(f);
      const { text, parts } = renderOffice(r, input.part ?? 1, 14_000, input.sheet);
      const more = parts > 1 ? `\n(Part ${Math.min(input.part ?? 1, parts)} of ${parts}; read the next with part=${Math.min(input.part ?? 1, parts) + 1}.)` : "";
      return { ok: true, content: `${headOf(f.name, r)}${more}\n\n${text}`, sources: f.source ? [f.source] : [] };
    },
  },
  {
    name: "analyze_sheet",
    description:
      "Answer a question about a spreadsheet (xlsx or CSV) exactly, computed by the server: filter rows, group and add up / average / count, pivot, sort, top-N, totals, list duplicates, blanks or error cells. Columns are named by their header text (any case, accents optional) or letter. Prefer it to adding numbers yourself. A totals row at the bottom of the sheet is left out automatically.",
    permission: "file.read",
    input: SheetQuery.extend(fileInput),
    jsonSchema: {
      type: "object",
      properties: {
        ...fileSchema,
        sheet: str("sheet name (default: the first with data)"),
        headerRow: { type: "integer", description: "1-based row of the headers (found by itself when left out)" },
        filter: {
          type: "array",
          items: {
            type: "object",
            properties: {
              column: str("header or letter"),
              op: { type: "string", enum: ["=", "!=", ">", ">=", "<", "<=", "contains", "starts", "empty", "notEmpty"] },
              value: { type: ["string", "number"] },
            },
            required: ["column", "op"],
          },
        },
        select: { type: "array", items: { type: "string" }, description: "columns to show (all when left out)" },
        groupBy: { type: "array", items: { type: "string" }, description: "group by these columns" },
        measures: {
          type: "array",
          items: {
            type: "object",
            properties: { fn: { type: "string", enum: ["sum", "avg", "count", "min", "max", "countDistinct"] }, column: { type: "string" } },
            required: ["fn"],
          },
          description: "figures per group (count when left out)",
        },
        pivot: {
          type: "object",
          properties: {
            rows: { type: "string" },
            columns: { type: "string" },
            value: { type: "string" },
            fn: { type: "string", enum: ["sum", "avg", "count", "min", "max", "countDistinct"] },
          },
          required: ["rows", "columns"],
        },
        sort: { type: "array", items: { type: "object", properties: { column: { type: "string" }, desc: { type: "boolean" } }, required: ["column"] } },
        limit: { type: "integer", description: "at most this many result rows (top-N with sort)" },
        find: { type: "string", enum: ["duplicates", "blanks", "errors"] },
        keys: { type: "array", items: { type: "string" }, description: "with find=duplicates: the columns that make two rows the same" },
        totals: { type: "boolean", description: "add a Total row to the result" },
      },
    },
    async run(ctx, input) {
      const { file, task, ...q } = input;
      const f = await openFile(ctx, file, task);
      const sheet = sheetOf(await structure(f), q.sheet);
      let r: QueryResult;
      try {
        r = runQuery(sheet.grid, q);
      } catch (e) {
        if (e instanceof QueryProblem) throw new ToolProblem(e.message);
        throw e;
      }
      const title = `${f.name} · ${sheet.name}`;
      const blocks = [
        tableBlock(`analyze_sheet:${f.name}:${JSON.stringify(q).slice(0, 80)}`, title, r),
        ...[barBlock(`analyze_sheet:chart:${f.name}:${JSON.stringify(q.groupBy ?? q.pivot ?? "")}`, title, r)].filter((b): b is AnswerBlock => !!b),
      ];
      const head = `${title}: ${r.matched} of ${r.total} rows matched${r.notes.length ? `. ${r.notes.join(" ")}` : ""}.`;
      return { ok: true, content: `${head}\n\n${r.rows.length ? resultMarkdown(r) : en(ctx) ? "No rows." : "Không có dòng nào."}`, sources: f.source ? [f.source] : [], blocks };
    },
  },
  {
    name: "explain_formula",
    description:
      'Explain an Excel formula in plain words: give `formula` ("=VLOOKUP(A2,Bảng!A:C,3,FALSE)"), or a `file` and `cell` ("B5" or "Lương!E7") to read it from. Returns the functions with what each does, the ranges it reads and likely mistakes; write the explanation from these.',
    permission: "file.read",
    input: z.object({ formula: z.string().max(2000).optional(), cell: z.string().max(60).optional(), ...fileInput }),
    jsonSchema: { type: "object", properties: { formula: str("the formula (optional when file+cell are given)"), cell: str("a cell like B5 or Sheet!B5"), ...fileSchema } },
    async run(ctx, input) {
      let formula = input.formula;
      let where = "";
      if (!formula) {
        if (!input.cell || !input.file) throw new ToolProblem("Give the formula, or the file and the cell.");
        const f = await openFile(ctx, input.file, input.task);
        const [sheetName, ref] = input.cell.includes("!") ? [input.cell.split("!")[0]!.replace(/^'|'$/g, ""), input.cell.split("!")[1]!] : [undefined, input.cell];
        const sheet = sheetOf(await structure(f), sheetName);
        const cell = sheet.cells.find((c) => c.ref === ref.replace(/\$/g, "").toUpperCase());
        if (!cell?.formula) throw new ToolProblem(`${sheet.name}!${ref.toUpperCase()} has no formula${cell ? ` (it holds ${String(cell.value)})` : ""}.`);
        formula = cell.formula;
        where = `${f.name} · ${sheet.name}!${cell.ref}${cell.value !== null ? ` (shows ${String(cell.value)})` : ""}\n`;
      }
      const facts = formulaFacts(formula, en(ctx) ? "en" : "vi");
      const lines = [
        `${where}Formula: ${facts.formula}`,
        `Functions: ${facts.functions.map((f) => `${f.name}${f.does ? ` — ${f.does}` : ""}`).join("; ") || "none"}`,
        `Reads: ${facts.ranges.join(", ") || "no cells"}${facts.sheets.length ? ` (other sheets: ${facts.sheets.join(", ")})` : ""}`,
        facts.absolute ? "Has absolute references ($) that stay fixed when copied." : "",
        facts.problems.length ? `Possible problems: ${facts.problems.join(" ")}` : "",
      ].filter(Boolean);
      return { ok: true, content: lines.join("\n"), sources: [] };
    },
  },
  {
    name: "check_formulas",
    description:
      "Check a workbook's formulas: cells showing an error (#REF!, #DIV/0!, #VALUE!, #N/A…), formulas pointing to deleted cells, and cells that break their column's pattern (a different formula, or a number typed over a formula). Use it when someone asks whether a spreadsheet is right.",
    permission: "file.read",
    input: z.object({ ...fileInput, sheet: z.string().max(120).optional() }),
    jsonSchema: { type: "object", properties: { ...fileSchema, sheet: str("only this sheet (optional)") } },
    async run(ctx, input) {
      const f = await openFile(ctx, input.file, input.task);
      const r = await structure(f);
      if (r.kind !== "xlsx") throw new ToolProblem("That is not an Excel workbook.");
      const sheets = input.sheet ? [sheetOf(r, input.sheet)] : r.sheets;
      const lang = en(ctx) ? "en" : "vi";
      const found = sheets.flatMap((s) => checkFormulas(s, lang).map((p) => ({ ...p, sheet: s.name })));
      const formulas = sheets.reduce((n, s) => n + s.cells.filter((c) => c.formula).length, 0);
      if (!found.length)
        return {
          ok: true,
          content: en(ctx) ? `${f.name}: ${formulas} formulas checked, no problems found.` : `${f.name}: đã kiểm tra ${formulas} công thức, không thấy lỗi.`,
          sources: f.source ? [f.source] : [],
        };
      const label = { error: en(ctx) ? "error" : "lỗi", ref: en(ctx) ? "deleted reference" : "tham chiếu đã xoá", pattern: en(ctx) ? "breaks the pattern" : "khác mẫu cột" };
      const rows = found.slice(0, 60).map((p) => `- ${p.sheet}!${p.ref} (${label[p.kind]}): ${p.detail}`);
      return {
        ok: true,
        content: `${f.name}: ${formulas} formulas, ${found.length} ${en(ctx) ? "to look at" : "chỗ cần xem"}:\n${rows.join("\n")}${found.length > 60 ? "\n…" : ""}`,
        sources: f.source ? [f.source] : [],
      };
    },
  },
];

// ── Write tools ──────────────────────────────────────────────────────────────────────────────────────────

/** Columns a totals row leaves alone: row numbers, unit prices, rates, percentages, codes and phone numbers. */
const NOT_SUMMED =
  /^(stt|tt|#|no\.?|so thu tu|ma\b.*|code|id|gia( ban| nhap| le| goc)?|price|unit cost|nam sinh|year)$|don gia|unit price|\brate\b|ty le|thue suat|%|phan tram|dien thoai|phone|sdt/;

const lines = (v: unknown, max = 8) => {
  const all = String(v ?? "")
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
  return all.slice(0, max).join("\n") + (all.length > max ? "\n…" : "");
};

const WRITE: Write[] = [
  {
    title: { en: "Create a Word document", vi: "Tạo tệp Word" },
    preview: (i, loc) => ({
      title: L(loc, i.format === "pdf" ? { en: "Create a PDF document", vi: "Tạo tệp PDF" } : { en: "Create a Word document", vi: "Tạo tệp Word" }),
      fields: [
        ...field(loc, C.file, fileName(String(i.fileName ?? ""), i.format === "pdf" ? "pdf" : "docx")),
        ...field(loc, F.title, i.title),
        ...whereField(loc, i.task),
        ...field(loc, F.text, clip(String(i.markdown ?? ""), 1500)),
      ],
    }),
    tool: {
      name: "create_word_document",
      description:
        'Create a Word (.docx) file, or a PDF with format="pdf" (to send, sign or print as it is): a letter, minutes, a report, a proposal, a contract draft, a procedure, a translation of a file. Write the content in Markdown: # headings, paragraphs, - bullets and 1. numbered lists (indent two spaces per level), | tables |, **bold**, *italic*, --- for a page break. It is saved in the person\'s Drive, or attached to `task`.',
      permission: "file.upload",
      input: z.object({
        fileName: z.string().min(1).max(150),
        title: z.string().max(200).optional(),
        markdown: z.string().min(1).max(60_000),
        landscape: z.boolean().optional(),
        format: z.enum(["docx", "pdf"]).optional(),
        ...saveInput,
      }),
      jsonSchema: {
        type: "object",
        properties: {
          fileName: str('the file name, e.g. "Biên bản họp 18-11"'),
          title: str("the document's title shown at the top (optional)"),
          markdown: str("the whole content in Markdown"),
          landscape: { type: "boolean", description: "landscape pages (wide tables)" },
          format: { type: "string", enum: ["docx", "pdf"], description: "docx (default, editable) or pdf" },
          ...saveSchema,
        },
        required: ["fileName", "markdown"],
      },
      async run(ctx, input) {
        const pdf = input.format === "pdf";
        const name = fileName(input.fileName, pdf ? "pdf" : "docx");
        const doc = { title: input.title, markdown: input.markdown, landscape: input.landscape };
        const data = pdf ? await buildPdf(doc) : await buildDocx(doc);
        const s = await save(ctx, name, data, input.task);
        return { ok: true, content: savedLine(ctx, s), sources: [s.source] };
      },
    },
  },
  {
    title: { en: "Fill a Word template", vi: "Điền mẫu Word" },
    preview: (i, loc) => ({
      title: L(loc, { en: "Fill a Word template", vi: "Điền mẫu Word" }),
      fields: [
        ...field(loc, C.from, i.template),
        ...field(
          loc,
          C.values,
          i.values && typeof i.values === "object"
            ? Object.entries(i.values as Record<string, unknown>)
                .slice(0, 12)
                .map(([k, v]) => `${k}: ${String(v)}`)
                .join("\n")
            : undefined,
        ),
        ...field(loc, C.rows, i.rowsFrom ? `${String(i.rowsFrom)}${i.rowsSheet ? ` · ${String(i.rowsSheet)}` : ""}` : undefined),
        ...field(loc, C.file, i.fileName ? fileName(String(i.fileName), i.rowsFrom ? "zip" : "docx") : undefined),
        ...whereField(loc, i.saveToTask),
      ],
    }),
    tool: {
      name: "fill_word_template",
      description:
        'Fill a Word template\'s {{placeholders}} (keeping its formatting): give `values` ({"ho_ten": "Nguyễn Văn An"}), or `rowsFrom` a spreadsheet to make one document per row (mail merge; its headers are the placeholder names; up to 50 rows, delivered as one .zip). Read the template with read_office_file first to see its placeholders.',
      permission: "file.upload",
      input: z.object({
        template: z.string().min(1).max(200),
        templateTask: z.string().max(80).optional(),
        values: z.record(z.union([z.string().max(5000), z.number(), z.null()])).optional(),
        rowsFrom: z.string().max(200).optional(),
        rowsSheet: z.string().max(120).optional(),
        nameColumn: z.string().max(120).optional(),
        fileName: z.string().max(150).optional(),
        saveToTask: z.string().max(80).optional(),
      }),
      jsonSchema: {
        type: "object",
        properties: {
          template: str("the template .docx (attached, earlier attachment, Drive name or file id)"),
          templateTask: str("the task the template is attached to (optional)"),
          values: { type: "object", additionalProperties: { type: ["string", "number", "null"] }, description: "placeholder → value" },
          rowsFrom: str("a spreadsheet: one document per row (mail merge)"),
          rowsSheet: str("its sheet (optional)"),
          nameColumn: str("the column that names each document (optional)"),
          fileName: str("the result's name (optional)"),
          saveToTask: str("attach the result to this task (optional; else the person's Drive)"),
        },
        required: ["template"],
      },
      async run(ctx, input) {
        const tpl = await openFile(ctx, input.template, input.templateTask);
        if (kindOf(tpl.name) !== "docx") throw new ToolProblem(`${tpl.name} is not a Word (.docx) template.`);
        const fill = async (values: Record<string, string | number | null>) => {
          try {
            return await fillTemplate(tpl.data, tpl.name, values);
          } catch (e) {
            if (e instanceof OfficeRefused) throw new ToolProblem(e.message);
            throw e;
          }
        };
        if (input.rowsFrom) {
          const sheet = sheetOf(await structure(await openFile(ctx, input.rowsFrom)), input.rowsSheet);
          const [head = [], ...rows] = sheet.grid.filter((r) => r.some((v) => v !== null && v !== ""));
          if (!rows.length) throw new ToolProblem("The spreadsheet has no rows under its headers.");
          if (rows.length > 50) throw new ToolProblem(`The spreadsheet has ${rows.length} rows; at most 50 documents are made at once. Filter it first.`);
          const headers = head.map((h) => String(h ?? ""));
          const nameAt = input.nameColumn ? headers.findIndex((h) => fold(h) === fold(input.nameColumn!)) : 0;
          const docs = [];
          let missing: string[] = [];
          for (const [i, r] of rows.entries()) {
            const out = await fill(
              Object.fromEntries(headers.map((h, j) => [h, r[j] === undefined ? null : typeof r[j] === "boolean" ? String(r[j]) : (r[j] as string | number | null)])),
            );
            missing = out.missing;
            docs.push({ name: fileName(`${bare(tpl.name)} - ${String(r[Math.max(0, nameAt)] ?? i + 1)}`, "docx"), data: out.buffer });
          }
          const zipName = fileName(input.fileName ?? `${tpl.name.replace(/\.docx$/i, "")} (${docs.length})`, "zip");
          const s = await save(ctx, zipName, await zipFiles(docs), input.saveToTask);
          return {
            ok: true,
            content: `${savedLine(ctx, s)} ${docs.length} ${en(ctx) ? "documents" : "tài liệu"}.${missing.length ? ` ${en(ctx) ? "Placeholders with no column" : "Chỗ trống không có cột tương ứng"}: ${missing.join(", ")}.` : ""}`,
            sources: [s.source],
          };
        }
        if (!input.values || !Object.keys(input.values).length) throw new ToolProblem("Give the values for the placeholders, or rowsFrom a spreadsheet.");
        const out = await fill(input.values);
        if (!out.used.length)
          throw new ToolProblem(`None of the values matched a placeholder in ${tpl.name}. Its placeholders: ${out.missing.join(", ") || "none ({{name}} style)"}.`);
        const s = await save(ctx, fileName(input.fileName ?? `${tpl.name.replace(/\.docx$/i, "")} - filled`, "docx"), out.buffer, input.saveToTask);
        return {
          ok: true,
          content: `${savedLine(ctx, s)}${out.missing.length ? ` ${en(ctx) ? "Still empty" : "Còn trống"}: ${out.missing.join(", ")}.` : ""}`,
          sources: [s.source],
        };
      },
    },
  },
  {
    title: { en: "Create a spreadsheet", vi: "Tạo tệp Excel" },
    preview: (i, loc) => {
      const sheets = Array.isArray(i.sheets) ? (i.sheets as { name?: string; columns?: { header?: string }[]; rows?: unknown[][]; totals?: boolean }[]) : [];
      return {
        title: L(loc, { en: "Create a spreadsheet", vi: "Tạo tệp Excel" }),
        fields: [
          ...field(loc, C.file, fileName(String(i.fileName ?? ""), "xlsx")),
          ...whereField(loc, i.task),
          ...field(
            loc,
            C.sheets,
            sheets
              .map(
                (s) =>
                  `${s.name ?? ""}: ${(s.columns ?? []).map((c) => c.header).join(" | ")} — ${(s.rows ?? []).length} ${L(loc, { en: "rows", vi: "dòng" })}${s.totals ? ` + ${L(loc, { en: "totals", vi: "dòng tổng" })}` : ""}`,
              )
              .join("\n"),
          ),
        ],
      };
    },
    tool: {
      name: "create_spreadsheet",
      description:
        'Create an Excel (.xlsx) file: one or more sheets with headers, column types (text, number, integer, currency in VND, percent, date), rows, and formulas written as text starting with "=" using A1 references ("=D4*E4", "=SUM(F4:F20)", "=IF(G4>0,…)", VLOOKUP/XLOOKUP, SUMIF…): they stay live formulas in Excel. Rows start right under the header (row 2, or row 4 with a title). Optional title row and an automatic totals row. Header styled, frozen, with filters.',
      permission: "file.upload",
      input: z.object({ fileName: z.string().min(1).max(150), sheets: z.array(SheetSpec).min(1).max(10), ...saveInput }),
      jsonSchema: {
        type: "object",
        properties: {
          fileName: str('the file name, e.g. "Bảng lương 11-2026"'),
          sheets: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: str("sheet name (≤31 characters)"),
                title: str("a title row above the table (optional; then the header is row 3 and data starts at row 4)"),
                columns: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      header: { type: "string" },
                      type: { type: "string", enum: ["text", "number", "integer", "currency", "percent", "date"] },
                      width: { type: "number" },
                      sum: { type: "boolean", description: "add it up in the totals row (default: number and currency columns; false for a unit price or a rate)" },
                    },
                    required: ["header"],
                  },
                },
                rows: {
                  type: "array",
                  items: { type: "array", items: { type: ["string", "number", "boolean", "null"] } },
                  description: 'values in column order; "=…" for a formula; dates as YYYY-MM-DD',
                },
                totals: { type: "boolean", description: "add a totals row (SUM of number/integer/currency columns)" },
                totalsLabel: str('its label (default "Tổng")'),
              },
              required: ["name", "columns", "rows"],
            },
          },
          ...saveSchema,
        },
        required: ["fileName", "sheets"],
      },
      async run(ctx, input) {
        const data = await buildXlsx(input.sheets);
        const s = await save(ctx, fileName(input.fileName, "xlsx"), data, input.task);
        return { ok: true, content: savedLine(ctx, s), sources: [s.source] };
      },
    },
  },
  {
    title: { en: "Turn a picture into a spreadsheet", vi: "Chuyển ảnh thành bảng Excel" },
    preview: (i, loc) => {
      const columns = Array.isArray(i.columns) ? (i.columns as { header?: string; name?: string }[]).map((c) => ({ header: c.header ?? c.name })) : [];
      const rows = Array.isArray(i.rows) ? (i.rows as unknown[][]) : [];
      const unclear = rows.reduce((n, r) => n + (Array.isArray(r) ? r.filter((v) => typeof v === "string" && v.trim() === "?").length : 0), 0);
      return {
        title: L(loc, { en: "Turn a picture into a spreadsheet", vi: "Chuyển ảnh thành bảng Excel" }),
        fields: [
          ...field(loc, C.file, fileName(String(i.fileName ?? ""), "xlsx")),
          ...whereField(loc, i.task),
          ...field(loc, { en: "Columns", vi: "Các cột" }, columns.map((c) => c.header).join(" | ")),
          ...field(
            loc,
            { en: "Rows", vi: "Các dòng" },
            `${rows.length}${i.totals ? ` + ${L(loc, { en: "totals", vi: "dòng tổng" })}` : ""}\n${rows
              .slice(0, 6)
              .map((r) => (Array.isArray(r) ? r.map((v) => (v === null ? "" : String(v))).join(" | ") : ""))
              .join("\n")}${rows.length > 6 ? "\n…" : ""}`,
          ),
        ],
        ...(unclear
          ? {
              note: L(loc, {
                en: `${unclear} cell(s) could not be read and are marked "?": check them against the picture.`,
                vi: `${unclear} ô không đọc rõ, đã ghi "?": hãy đối chiếu lại với ảnh.`,
              }),
            }
          : {}),
      };
    },
    tool: {
      name: "image_to_spreadsheet",
      description:
        'Save the table you read in the picture(s) attached to this question as an Excel (.xlsx) file: receipts, invoices, bills, business cards, a printed or handwritten table, a price list, a screenshot of a table. YOU read the picture (it comes with the question) and pass what it says: the columns with types, then the rows exactly as written. Several receipts or cards: one row each (date, seller, item, amount…; name, title, company, phone, email…). Numbers as numbers (1.250.000 ₫ → 1250000), dates as YYYY-MM-DD. Never guess: a value you cannot read is "?", and name those cells in `unclear`. If you cannot see any picture with this question, do NOT call this tool: say this AI does not read pictures and suggest another model.',
      permission: "file.upload",
      input: z.object({
        fileName: z.string().min(1).max(150),
        sheetName: z.string().trim().max(31).optional(),
        title: z.string().max(200).optional(),
        columns: SheetSpec.shape.columns,
        rows: z
          .array(z.array(z.union([z.string().max(2000), z.number(), z.boolean(), z.null()])).max(60))
          .min(1)
          .max(2000),
        totals: z.boolean().optional(),
        unclear: z.array(z.string().max(200)).max(100).optional(),
        ...saveInput,
      }),
      jsonSchema: {
        type: "object",
        properties: {
          fileName: str('the file name, e.g. "Hóa đơn tháng 11"'),
          sheetName: str("the sheet's name (optional)"),
          title: str("a title row above the table (optional)"),
          columns: {
            type: "array",
            items: {
              type: "object",
              properties: {
                header: { type: "string" },
                type: { type: "string", enum: ["text", "number", "integer", "currency", "percent", "date"] },
                sum: { type: "boolean", description: "add it up in the totals row (default: amounts and quantities; never a unit price, a rate or a row number)" },
              },
              required: ["header"],
            },
          },
          rows: {
            type: "array",
            items: { type: "array", items: { type: ["string", "number", "boolean", "null"] } },
            description: 'values in column order, as read from the picture; "?" for what cannot be read',
          },
          totals: { type: "boolean", description: "add a totals row (sums the number and currency columns)" },
          unclear: { type: "array", items: { type: "string" }, description: 'the cells marked "?", e.g. "row 3, Amount"' },
          ...saveSchema,
        },
        required: ["fileName", "columns", "rows"],
      },
      async run(ctx, input) {
        // What was read from a picture is data, never a formula: text in a photo must not become one.
        const read = input.rows as (string | number | boolean | null)[][];
        const rows = read.map((r) => r.map((v) => (typeof v === "string" && /^[=+@]/.test(v.trim()) && !/^[+]?\d/.test(v.trim()) ? `'${v}` : v)));
        // A totals row adds amounts, never a row number, a unit price or a rate the model left typed as a number.
        const columns = (input.columns as z.infer<typeof SheetSpec>["columns"]).map((c) => (c.sum === undefined && NOT_SUMMED.test(fold(c.header)) ? { ...c, sum: false } : c));
        const data = await buildXlsx([
          {
            name: input.sheetName?.trim() || (en(ctx) ? "Data" : "Dữ liệu"),
            ...(input.title ? { title: input.title } : {}),
            columns,
            rows,
            ...(input.totals ? { totals: true, totalsLabel: en(ctx) ? "Total" : "Tổng" } : {}),
          },
        ]);
        const s = await save(ctx, fileName(input.fileName, "xlsx"), data, input.task);
        const unclear = read.flatMap((r) => r.filter((v) => typeof v === "string" && v.trim() === "?")).length;
        // What the totals row adds, so the answer describes the file it made rather than a guess.
        const summed = input.totals
          ? columns.filter((c, i) => i > 0 && (c.sum ?? (c.type === "number" || c.type === "integer" || c.type === "currency"))).map((c) => c.header)
          : [];
        const list = input.unclear?.length ? `: ${input.unclear.slice(0, 20).join("; ")}` : "";
        return {
          ok: true,
          content: `${savedLine(ctx, s)} ${input.rows.length} ${en(ctx) ? "rows" : "dòng"}.${
            input.totals ? ` ${en(ctx) ? "The totals row adds up" : "Dòng tổng cộng các cột"}: ${summed.join(", ") || "—"}.` : ""
          }${
            unclear || input.unclear?.length
              ? ` ${en(ctx) ? `Cells that could not be read are marked "?"${list}. Tell the person to check them against the picture.` : `Các ô không đọc rõ được ghi "?"${list}. Hãy nhắc người dùng đối chiếu lại với ảnh.`}`
              : ""
          }`,
          sources: [s.source],
        };
      },
    },
  },
  {
    title: { en: "Change a spreadsheet", vi: "Sửa tệp Excel" },
    preview: (i, loc) => ({
      title: L(loc, { en: "Change a spreadsheet (saved as a new file)", vi: "Sửa tệp Excel (lưu thành tệp mới)" }),
      fields: [
        ...field(loc, C.from, i.file),
        ...field(loc, C.file, fileName(String(i.newName ?? `${String(i.file ?? "").replace(/\.xlsx$/i, "")} (sửa)`), "xlsx")),
        ...whereField(loc, i.saveToTask ?? i.task),
        ...field(
          loc,
          C.changes,
          Array.isArray(i.ops)
            ? (i.ops as Record<string, unknown>[])
                .slice(0, 15)
                .map(
                  (o) =>
                    `${String(o.op)} ${[o.sheet, o.cell, o.range, o.column, o.at, o.start, o.name, o.to].filter((x) => x !== undefined).join(" ")}${o.value !== undefined ? ` = ${String(o.value)}` : o.formula ? ` = ${String(o.formula)}` : o.rows ? ` (${(o.rows as unknown[]).length})` : ""}`,
                )
                .join("\n")
            : undefined,
        ),
      ],
    }),
    tool: {
      name: "edit_spreadsheet",
      description:
        'Change an existing Excel workbook and save the result as a NEW file (the original is never overwritten): set cells or formulas, write a block, append/insert/delete rows, insert/delete a column (optionally filled with a formula using {r} for the row: "=C{r}*D{r}"), fill a column with a formula, add/rename/delete a sheet, sort by a column, add a totals row, format as currency/date/percent, highlight cells by a rule, freeze rows, add filters. Read the file with read_office_file first so the cell addresses are right. Formulas move like in Excel when rows or columns are inserted or deleted.',
      permission: "file.upload",
      input: z.object({ ...fileInput, ops: z.array(EditOp).min(1).max(40), newName: z.string().max(150).optional(), saveToTask: z.string().max(80).optional() }),
      jsonSchema: {
        type: "object",
        properties: {
          ...fileSchema,
          ops: {
            type: "array",
            description:
              'changes in order. Shapes: {op:"set",cell,value} {op:"setRange",start,rows} {op:"appendRows",rows} {op:"insertRows",at,rows} {op:"deleteRows",from,count} {op:"insertColumn",at:"C",header?,formula?,headerRow?} {op:"deleteColumn",column} {op:"fill",column,formula,from?,to?} {op:"addSheet",name,columns?,rows?} {op:"renameSheet",from,to} {op:"deleteSheet",name} {op:"sort",column,desc?,headerRow?} {op:"totals",columns:["E","F"],label?,headerRow?} {op:"format",range,as:"currency|date|percent|number|integer|text"} {op:"highlight",range,when:">|>=|<|<=|=|!=|contains|blank|duplicate",value?,color?:"red|yellow|green|blue"} {op:"freeze",rows?,columns?} {op:"autofilter",headerRow?}; every op but addSheet/renameSheet/deleteSheet takes an optional sheet',
            items: { type: "object" },
          },
          newName: str("the new file's name (optional)"),
          saveToTask: str("attach the new file to this task (optional; default: the task the file came from, else the person's Drive)"),
        },
        required: ["file", "ops"],
      },
      async run(ctx, input) {
        const f = await openFile(ctx, input.file, input.task);
        if (kindOf(f.name) !== "xlsx")
          throw new ToolProblem(`${f.name} is not an Excel (.xlsx) workbook${/\.csv$/i.test(f.name) ? "; use convert_office to make it one first" : ""}.`);
        let out: { buffer: Buffer; done: string[] };
        try {
          out = await editXlsx(f.data, f.name, input.ops);
        } catch (e) {
          if (e instanceof OfficeRefused) throw new ToolProblem(e.message);
          throw e;
        }
        const s = await save(
          ctx,
          fileName(input.newName ?? `${f.name.replace(/\.xlsx$/i, "")} (${en(ctx) ? "edited" : "sửa"})`, "xlsx"),
          out.buffer,
          input.saveToTask ?? input.task,
        );
        return { ok: true, content: `${savedLine(ctx, s)}\n${out.done.map((d) => `- ${d}`).join("\n")}`, sources: [s.source, ...(f.source ? [f.source] : [])] };
      },
    },
  },
  {
    title: { en: "Create a presentation", vi: "Tạo bài trình chiếu" },
    preview: (i, loc) => {
      const slides = Array.isArray(i.slides) ? (i.slides as { title?: string; layout?: string }[]) : [];
      const outline = slides.length
        ? slides.map((s, n) => `${n + 1}. ${s.title ?? ""}${s.layout && s.layout !== "bullets" ? ` (${s.layout})` : ""}`).join("\n")
        : i.outline
          ? lines(
              String(i.outline)
                .split("\n")
                .filter((l) => /^\s*#/.test(l))
                .join("\n"),
              14,
            )
          : i.fromPage
            ? `${L(loc, { en: "From the page", vi: "Từ trang" })} ${String(i.fromPage)}`
            : "";
      return {
        title: L(loc, { en: "Create a presentation", vi: "Tạo bài trình chiếu" }),
        fields: [
          ...field(loc, C.file, fileName(String(i.fileName ?? ""), "pptx")),
          ...whereField(loc, i.task),
          ...field(loc, C.slides, outline),
          ...field(loc, { en: "Theme", vi: "Giao diện" }, i.theme),
        ],
      };
    },
    tool: {
      name: "create_presentation",
      description:
        "Create a PowerPoint (.pptx) deck on a clean 16:9 theme (light, dark or blue). Prefer an `outline` in Markdown (# deck title, ## one slide per heading, - bullets, | tables |, > speaker notes): the shortest way. Use `slides` only for special layouts (twoColumns, image from an attached picture, section), or `fromPage` (a Docs page's code) to turn a page into slides. Keep 3–6 bullets per slide.",
      permission: "file.upload",
      input: z.object({
        fileName: z.string().min(1).max(150),
        title: z.string().max(200).optional(),
        theme: z.enum(THEMES).optional(),
        slides: z.array(SlideSpec).max(60).optional(),
        outline: z.string().max(40_000).optional(),
        fromPage: z.string().max(80).optional(),
        ...saveInput,
      }),
      jsonSchema: {
        type: "object",
        properties: {
          fileName: str("the file name"),
          title: str("the deck's title"),
          theme: { type: "string", enum: [...THEMES] },
          slides: {
            type: "array",
            items: {
              type: "object",
              properties: {
                layout: { type: "string", enum: ["title", "bullets", "twoColumns", "table", "image", "section"] },
                title: { type: "string" },
                subtitle: { type: "string" },
                bullets: { type: "array", items: { type: "string" }, description: "two leading spaces per sub-level" },
                leftTitle: { type: "string" },
                left: { type: "array", items: { type: "string" } },
                rightTitle: { type: "string" },
                right: { type: "array", items: { type: "string" } },
                table: { type: "array", items: { type: "array", items: { type: "string" } }, description: "first row is the header" },
                image: str("name of an attached PNG/JPEG"),
                notes: str("speaker notes"),
              },
            },
          },
          outline: str("the deck as a Markdown outline (instead of slides)"),
          fromPage: str("a Docs page code (D-012) to turn into slides (instead of slides)"),
          ...saveSchema,
        },
        required: ["fileName"],
      },
      async run(ctx, input) {
        let deck: { title?: string | undefined; slides: z.infer<typeof SlideSpec>[] };
        if (input.slides?.length) deck = { title: input.title, slides: input.slides };
        else if (input.outline?.trim()) deck = outlineToSlides(input.outline);
        else if (input.fromPage) {
          if (featureDisabled("docs")) throw new ToolProblem("This installation has no Docs pages.");
          const d = await work<{ document: { title: string }; content: string; format: string; text: string }>(ctx, "GET", `/docs/${enc(input.fromPage.trim())}?track=0`);
          const md = d.format === "markdown" ? d.content : d.text;
          deck = outlineToSlides(/^\s*#\s/m.test(md) ? md : `# ${d.document.title}\n${md}`);
          if (!/^\s*#\s/m.test(md)) deck.title = d.document.title;
        } else throw new ToolProblem("Give the slides, an outline, or a page to turn into slides.");
        if (!deck.slides.length) throw new ToolProblem("The outline has no slides: use ## headings, one per slide.");
        const images = new Map((ctx.files ?? []).filter((f) => /^image\//.test(f.contentType) || /\.(png|jpe?g)$/i.test(f.name)).map((f) => [f.name.toLowerCase(), f.data]));
        const out = await buildPptx({ title: input.title ?? deck.title, theme: input.theme, slides: deck.slides }, images);
        const s = await save(ctx, fileName(input.fileName, "pptx"), out.buffer, input.task);
        return {
          ok: true,
          content: `${savedLine(ctx, s)} ${deck.slides.length} ${en(ctx) ? "slides" : "trang chiếu"}.${out.missing.length ? ` ${en(ctx) ? "Pictures not found (attach them)" : "Không thấy ảnh (hãy đính kèm)"}: ${out.missing.join(", ")}.` : ""}`,
          sources: [s.source],
        };
      },
    },
  },
  {
    title: { en: "Convert a file", vi: "Chuyển định dạng tệp" },
    preview: (i, loc) => ({
      title: L(loc, { en: "Convert a file", vi: "Chuyển định dạng tệp" }),
      fields: [...field(loc, C.from, i.file), ...field(loc, C.to, i.to), ...whereField(loc, i.saveToTask ?? i.task)],
    }),
    tool: {
      name: "convert_office",
      description:
        "Convert a file and save the result: Word, PowerPoint (one slide per page), Excel/CSV (a sheet as a table) or Markdown → PDF; Word → Markdown or PowerPoint (headings become slides); PowerPoint → Word (an outline with the notes) or Markdown; PDF → Word or Markdown (its text, not its layout); Excel → CSV (one sheet); CSV → Excel. The original stays as it is.",
      permission: "file.upload",
      input: z.object({
        ...fileInput,
        to: z.enum(["pdf", "markdown", "docx", "pptx", "csv", "xlsx"]),
        sheet: z.string().max(120).optional(),
        saveToTask: z.string().max(80).optional(),
      }),
      jsonSchema: {
        type: "object",
        properties: {
          ...fileSchema,
          to: { type: "string", enum: ["pdf", "markdown", "docx", "pptx", "csv", "xlsx"] },
          sheet: str("for Excel → CSV or PDF: the sheet (PDF: all sheets when left out)"),
          saveToTask: str("attach the result to this task (optional)"),
        },
        required: ["file", "to"],
      },
      async run(ctx, input) {
        const f = await openFile(ctx, input.file, input.task);
        const stem = f.name.replace(/\.[a-z0-9]+$/i, "");
        // A Markdown file (one the tools made, or attached) converts to PDF or Word as written.
        if (/\.(md|markdown)$/i.test(f.name)) {
          if (input.to !== "pdf" && input.to !== "docx") throw new ToolProblem("A Markdown file converts to PDF or Word.");
          const markdown = f.data.toString("utf8");
          const data = input.to === "pdf" ? await buildPdf({ markdown }) : await buildDocx({ markdown });
          const s = await save(ctx, fileName(stem, input.to), data, input.saveToTask ?? input.task);
          return { ok: true, content: savedLine(ctx, s), sources: [s.source, ...(f.source ? [f.source] : [])] };
        }
        const r = await structure(f);
        const deckMarkdown = (slides: { title: string; lines: string[]; notes: string; tables: string[][][] }[]) =>
          slides
            .map((s) =>
              [
                `## ${s.title || "—"}`,
                ...s.lines.map((l) => `- ${l}`),
                ...s.tables.map((t) => t.map((row, k) => `| ${row.join(" | ")} |${k === 0 ? `\n|${row.map(() => "---").join("|")}|` : ""}`).join("\n")),
                s.notes ? `> ${s.notes.replace(/\n/g, "\n> ")}` : "",
              ]
                .filter(Boolean)
                .join("\n"),
            )
            .join("\n\n");
        let data: Buffer;
        let ext: string;
        if (input.to === "pdf") {
          if (r.kind === "pdf") throw new ToolProblem("It is already a PDF.");
          if (r.kind === "docx") data = await buildPdf({ markdown: blocksToMarkdown(r.blocks) });
          else if (r.kind === "pptx")
            data = await buildPdf({
              landscape: true,
              markdown: deckMarkdown(r.slides.map((x) => ({ ...x, title: x.title || `${x.n}` })))
                .replace(/^## /gm, "# ")
                .split(/\n\n(?=# )/)
                .join("\n\n---\n\n"),
            });
          else {
            const sheets = input.sheet ? [sheetOf(r, input.sheet)] : r.sheets.filter((x) => x.grid.length);
            if (!sheets.length) throw new ToolProblem("The workbook has no data to print.");
            const wide = sheets.some((x) => x.colCount > 5);
            data = await buildPdf({ landscape: wide, markdown: sheets.map((x) => `## ${x.name}\n\n${gridMarkdown(x.grid)}`).join("\n\n---\n\n") });
          }
          ext = "pdf";
        } else if (input.to === "markdown") {
          const md = r.kind === "docx" ? blocksToMarkdown(r.blocks) : r.kind === "pptx" ? deckMarkdown(r.slides) : r.kind === "pdf" ? pdfMarkdown(r.pages) : null;
          if (md === null) throw new ToolProblem("A spreadsheet converts to CSV or PDF, not Markdown.");
          data = Buffer.from(md, "utf8");
          ext = "md";
        } else if (input.to === "pptx") {
          if (r.kind !== "docx") throw new ToolProblem("Only a Word document converts to PowerPoint.");
          const md = blocksToMarkdown(r.blocks);
          const deck = outlineToSlides(/^#\s/m.test(md) ? md : `# ${stem}\n${md}`);
          data = (await buildPptx({ title: deck.title ?? stem, slides: deck.slides })).buffer;
          ext = "pptx";
        } else if (input.to === "docx") {
          if (r.kind === "pdf") data = await buildDocx({ markdown: pdfMarkdown(r.pages) });
          else if (r.kind !== "pptx") throw new ToolProblem(r.kind === "docx" ? "It is already a Word document." : "Only a presentation or a PDF converts to Word here.");
          else data = await buildDocx({ title: stem, markdown: deckMarkdown(r.slides).replace(/^> (.*)$/gm, "*$1*") });
          ext = "docx";
        } else if (input.to === "csv") {
          const sheet = sheetOf(r, input.sheet);
          const cell = (v: CellValue) => {
            const s = v === null ? "" : String(v);
            return /[",\n;]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"` : s;
          };
          data = Buffer.from(`${BOM}${sheet.grid.map((row) => row.map(cell).join(",")).join("\r\n")}`, "utf8");
          ext = "csv";
        } else {
          if (r.kind !== "xlsx" || kindOf(f.name)) throw new ToolProblem("Only a CSV converts to Excel.");
          data = await gridToXlsx(stem, r.sheets[0]!.grid);
          ext = "xlsx";
        }
        const s = await save(ctx, fileName(stem, ext), data, input.saveToTask ?? input.task);
        return { ok: true, content: savedLine(ctx, s), sources: [s.source, ...(f.source ? [f.source] : [])] };
      },
    },
  },
];

/** A sheet as a Markdown table (header first), at most 3,000 rows, for a PDF. */
export function gridMarkdown(grid: CellValue[][]): string {
  const rows = grid.filter((r) => r.some((v) => v !== null && v !== "")).slice(0, 3001);
  const width = Math.max(0, ...rows.map((r) => r.length));
  const cell = (v: CellValue | undefined) =>
    (v === null || v === undefined ? "" : typeof v === "number" ? (Number.isInteger(v) ? v.toLocaleString("vi-VN") : String(Math.round(v * 100) / 100)) : String(v))
      .replace(/\|/g, "/")
      .replace(/\s+/g, " ");
  return rows.map((r, i) => `| ${Array.from({ length: width }, (_, c) => cell(r[c])).join(" | ")} |${i === 0 ? `\n|${Array(width).fill("---").join("|")}|` : ""}`).join("\n");
}

/**
 * A PDF's text as Markdown paragraphs: a PDF breaks every line, so a line joins the next unless it ends a sentence or
 * stops well short of the page's usual line length; bullets stay list items, pages are separated by a page break.
 */
export function pdfMarkdown(pages: { n: number; text: string }[]): string {
  return pages
    .filter((p) => p.text.trim())
    .map((p) => {
      const lines = p.text.split("\n").map((l) => l.trim());
      const usual = Math.max(20, ...lines.map((l) => l.length)) * 0.7;
      const out: string[] = [];
      let para = "";
      const flush = () => {
        if (para) out.push(para);
        para = "";
      };
      for (const l of lines) {
        if (!l) {
          flush();
          continue;
        }
        const bullet = /^[•●▪◦‣\-–*]\s+(.*)$/.exec(l);
        if (bullet) {
          flush();
          para = `- ${bullet[1]}`;
        } else para = para ? `${para} ${l}` : l;
        if (/[.!?:;]$/.test(l) || l.length < usual) flush();
      }
      flush();
      return out.join("\n\n");
    })
    .join("\n\n---\n\n");
}

const TITLES: Record<string, Say> = {
  read_office_file: { en: "Read an Office file", vi: "Đọc tệp Office" },
  analyze_sheet: { en: "Analyse a spreadsheet", vi: "Phân tích bảng tính" },
  explain_formula: { en: "Explain a formula", vi: "Giải thích công thức" },
  check_formulas: { en: "Check formulas", vi: "Kiểm tra công thức" },
};

export { READ, WRITE, TITLES };
