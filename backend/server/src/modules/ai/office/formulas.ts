import { colIndex, colName, type Sheet } from "./read.js";

/**
 * Excel formulas, without running them: what a formula does in plain words (the functions it uses and
 * the ranges it reads), and a sheet's formula problems (error results, #REF! in the formula, a cell whose formula
 * breaks the pattern of the column around it). The model writes the explanation from these facts.
 */

type Say = { en: string; vi: string };
/** The common functions, what each does. */
const FUNCTIONS: Record<string, Say> = {
  SUM: { en: "adds up", vi: "cộng tổng" },
  SUMIF: { en: "adds up the values that meet one condition", vi: "cộng các giá trị thỏa một điều kiện" },
  SUMIFS: { en: "adds up the values that meet every condition", vi: "cộng các giá trị thỏa mọi điều kiện" },
  AVERAGE: { en: "averages", vi: "tính trung bình" },
  AVERAGEIF: { en: "averages the values that meet a condition", vi: "tính trung bình các giá trị thỏa điều kiện" },
  AVERAGEIFS: { en: "averages the values that meet every condition", vi: "tính trung bình các giá trị thỏa mọi điều kiện" },
  COUNT: { en: "counts the numbers", vi: "đếm các ô có số" },
  COUNTA: { en: "counts the non-empty cells", vi: "đếm các ô không trống" },
  COUNTIF: { en: "counts the cells that meet a condition", vi: "đếm các ô thỏa điều kiện" },
  COUNTIFS: { en: "counts the rows that meet every condition", vi: "đếm các dòng thỏa mọi điều kiện" },
  COUNTBLANK: { en: "counts the empty cells", vi: "đếm ô trống" },
  MIN: { en: "takes the smallest", vi: "lấy giá trị nhỏ nhất" },
  MAX: { en: "takes the largest", vi: "lấy giá trị lớn nhất" },
  ROUND: { en: "rounds to a number of digits", vi: "làm tròn tới số chữ số" },
  ROUNDUP: { en: "rounds up", vi: "làm tròn lên" },
  ROUNDDOWN: { en: "rounds down", vi: "làm tròn xuống" },
  IF: { en: "chooses one of two results by a condition", vi: "chọn một trong hai kết quả theo điều kiện" },
  IFS: { en: "takes the result of the first condition that is true", vi: "lấy kết quả của điều kiện đúng đầu tiên" },
  IFERROR: { en: "shows a fallback when the inside gives an error", vi: "hiện giá trị thay thế khi bên trong bị lỗi" },
  AND: { en: "true when every condition is", vi: "đúng khi mọi điều kiện đều đúng" },
  OR: { en: "true when any condition is", vi: "đúng khi có ít nhất một điều kiện đúng" },
  NOT: { en: "reverses a condition", vi: "đảo điều kiện" },
  VLOOKUP: { en: "looks a value up in the first column of a table and returns a column of that row", vi: "tìm một giá trị ở cột đầu của bảng và trả về một cột của dòng đó" },
  HLOOKUP: { en: "looks a value up in the first row of a table", vi: "tìm một giá trị ở dòng đầu của bảng" },
  XLOOKUP: { en: "looks a value up in one range and returns the matching item of another", vi: "tìm một giá trị trong một vùng và trả về ô tương ứng ở vùng khác" },
  INDEX: { en: "takes the cell at a row (and column) of a range", vi: "lấy ô ở vị trí dòng (và cột) trong một vùng" },
  MATCH: { en: "finds the position of a value in a range", vi: "tìm vị trí của một giá trị trong vùng" },
  CONCAT: { en: "joins texts", vi: "nối chuỗi" },
  CONCATENATE: { en: "joins texts", vi: "nối chuỗi" },
  TEXTJOIN: { en: "joins texts with a separator", vi: "nối chuỗi với dấu phân cách" },
  LEFT: { en: "takes characters from the start of a text", vi: "lấy ký tự đầu chuỗi" },
  RIGHT: { en: "takes characters from the end of a text", vi: "lấy ký tự cuối chuỗi" },
  MID: { en: "takes characters from the middle of a text", vi: "lấy ký tự giữa chuỗi" },
  LEN: { en: "counts the characters of a text", vi: "đếm số ký tự" },
  TRIM: { en: "removes extra spaces", vi: "bỏ khoảng trắng thừa" },
  UPPER: { en: "makes a text upper case", vi: "chuyển chữ hoa" },
  LOWER: { en: "makes a text lower case", vi: "chuyển chữ thường" },
  TEXT: { en: "formats a number or date as text", vi: "định dạng số hoặc ngày thành chuỗi" },
  VALUE: { en: "turns a text into a number", vi: "chuyển chuỗi thành số" },
  TODAY: { en: "is today's date", vi: "là ngày hôm nay" },
  NOW: { en: "is the current date and time", vi: "là ngày giờ hiện tại" },
  DATE: { en: "builds a date from year, month, day", vi: "tạo ngày từ năm, tháng, ngày" },
  YEAR: { en: "takes the year of a date", vi: "lấy năm của ngày" },
  MONTH: { en: "takes the month of a date", vi: "lấy tháng của ngày" },
  DAY: { en: "takes the day of a date", vi: "lấy ngày trong tháng" },
  EOMONTH: { en: "is the last day of a month", vi: "là ngày cuối tháng" },
  DATEDIF: { en: "counts the time between two dates", vi: "tính khoảng cách giữa hai ngày" },
  NETWORKDAYS: { en: "counts the working days between two dates", vi: "đếm số ngày làm việc giữa hai ngày" },
  WORKDAY: { en: "moves a date by working days", vi: "cộng/trừ ngày làm việc" },
  ABS: { en: "drops the sign", vi: "lấy giá trị tuyệt đối" },
  SUMPRODUCT: { en: "multiplies ranges item by item and adds the products", vi: "nhân từng cặp phần tử rồi cộng lại" },
  UNIQUE: { en: "lists the distinct values", vi: "liệt kê giá trị không trùng" },
  FILTER: { en: "keeps the rows that meet a condition", vi: "lọc các dòng thỏa điều kiện" },
  SORT: { en: "sorts a range", vi: "sắp xếp một vùng" },
  PMT: { en: "is the payment of a loan per period", vi: "là số tiền trả mỗi kỳ của khoản vay" },
  RANK: { en: "ranks a number in a list", vi: "xếp hạng một số trong danh sách" },
  "RANK.EQ": { en: "ranks a number in a list", vi: "xếp hạng một số trong danh sách" },
};

export interface FormulaFacts {
  formula: string;
  functions: { name: string; does: string | null }[];
  ranges: string[];
  /** Other sheets it reads. */
  sheets: string[];
  absolute: boolean;
  problems: string[];
}

/** What a formula is made of, for the model to explain. */
export function formulaFacts(formula: string, lang: "en" | "vi"): FormulaFacts {
  const f = formula.trim().replace(/^=/, "");
  // Text in quotes is not code: "SUM(" inside a string is not a function call.
  const code = f.replace(/"(?:[^"]|"")*"/g, '""');
  const names = [...new Set([...code.matchAll(/([A-Z][A-Z0-9.]*)\s*\(/gi)].map((m) => m[1]!.toUpperCase().replace(/^_XLFN\./, "")))];
  const ranges = [
    ...new Set([...code.matchAll(/(?:'[^']+'|[A-Za-z0-9_À-ỹ]+)?!?\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?|\$?[A-Z]{1,3}:\$?[A-Z]{1,3}/g)].map((m) => m[0])),
  ].filter((r) => !names.includes(r.toUpperCase()));
  const sheets = [...new Set([...code.matchAll(/('[^']+'|[A-Za-z0-9_À-ỹ]+)!/g)].map((m) => m[1]!.replace(/^'|'$/g, "")))];
  const problems: string[] = [];
  if (/#REF!/i.test(f)) problems.push(lang === "vi" ? "Công thức trỏ tới ô đã bị xoá (#REF!)." : "It points to a deleted cell (#REF!).");
  const open = (code.match(/\(/g) ?? []).length;
  const close = (code.match(/\)/g) ?? []).length;
  if (open !== close) problems.push(lang === "vi" ? "Thiếu hoặc thừa dấu ngoặc." : "Its parentheses do not match.");
  if (/VLOOKUP\([^)]*,\s*(TRUE|1)\s*\)/i.test(code) || /VLOOKUP\((?:[^,()]+,){2}[^,()]+\)/i.test(code))
    problems.push(
      lang === "vi"
        ? "VLOOKUP đang dò gần đúng (thiếu FALSE ở cuối): dữ liệu chưa sắp xếp sẽ cho kết quả sai."
        : "VLOOKUP looks for an approximate match (no FALSE at the end): unsorted data gives wrong results.",
    );
  return {
    formula: `=${f}`,
    functions: names.map((n) => ({ name: n, does: FUNCTIONS[n]?.[lang] ?? null })),
    ranges,
    sheets,
    absolute: /\$[A-Z]|\$\d/.test(code),
    problems,
  };
}

/** A formula with its references made relative to its own cell (R1C1-like), so the same pattern down a column compares equal. */
function shape(formula: string, ref: string): string {
  const at = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!at) return formula;
  const c0 = colIndex(at[1]!);
  const r0 = Number(at[2]);
  return formula.replace(
    /(\$?)([A-Z]{1,3})(\$?)(\d+)/g,
    (_m, ca: string, c: string, ra: string, r: string) => `${ca ? `C${colIndex(c)}` : `C[${colIndex(c) - c0}]`}${ra ? `R${r}` : `R[${Number(r) - r0}]`}`,
  );
}

export interface FormulaProblem {
  ref: string;
  kind: "error" | "ref" | "pattern";
  detail: string;
}

/** A sheet's formula problems: error results, broken references, and cells that break their column's pattern. */
export function checkFormulas(sheet: Sheet, lang: "en" | "vi"): FormulaProblem[] {
  const out: FormulaProblem[] = [];
  for (const c of sheet.cells) {
    if (c.formula && /#REF!/i.test(c.formula)) out.push({ ref: c.ref, kind: "ref", detail: `=${c.formula}` });
    else if (c.error || (typeof c.value === "string" && /^#(REF!|DIV\/0!|VALUE!|NAME\?|N\/A|NUM!|NULL!)/.test(c.value)))
      out.push({ ref: c.ref, kind: "error", detail: `${c.error ?? c.value}${c.formula ? ` ← =${c.formula}` : ""}` });
  }
  // Down each column: when most formulas share one shape, the ones that do not are suspects (a typed-over total).
  const byCol = new Map<string, { ref: string; shape: string; formula?: string; row: number }[]>();
  for (const c of sheet.cells) {
    const m = /^([A-Z]+)(\d+)$/.exec(c.ref)!;
    const list = byCol.get(m[1]!) ?? [];
    list.push({
      ref: c.ref,
      row: Number(m[2]),
      shape: c.formula ? shape(c.formula, c.ref) : typeof c.value === "number" ? "#number" : "#other",
      ...(c.formula ? { formula: c.formula } : {}),
    });
    byCol.set(m[1]!, list);
  }
  for (const [, list] of byCol) {
    const withF = list.filter((x) => x.formula);
    if (withF.length < 3) continue;
    const counts = new Map<string, number>();
    for (const x of withF) counts.set(x.shape, (counts.get(x.shape) ?? 0) + 1);
    const [main, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
    if (n < withF.length * 0.6) continue;
    const first = Math.min(...withF.filter((x) => x.shape === main).map((x) => x.row));
    const last = Math.max(...withF.filter((x) => x.shape === main).map((x) => x.row));
    for (const x of list)
      if (x.row > first && x.row < last && x.shape !== main)
        out.push({
          ref: x.ref,
          kind: "pattern",
          detail: x.formula
            ? lang === "vi"
              ? `công thức khác các ô cùng cột (=${x.formula})`
              : `formula differs from the rest of the column (=${x.formula})`
            : lang === "vi"
              ? "ô nhập số tay giữa một cột công thức"
              : "a typed value in a column of formulas",
        });
  }
  return out.slice(0, 200);
}

export { colName };
