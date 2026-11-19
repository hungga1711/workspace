import { colIndex, colName } from "./xlsx.js";

/**
 * The result of the simple formulas the tools write, stored with the formula so a file shows its totals
 * before Excel recalculates: in a preview, a phone's viewer, or when the assistant reads it back. Numbers, same-sheet
 * cells and ranges, + − × ÷ ^, parentheses, and SUM, AVERAGE, MIN, MAX, COUNT, ROUND, ABS. Anything else (text,
 * comparisons, lookups, other sheets) gives null: no cached result, and Excel computes it on open as before.
 */

/** A cell as a formula sees it: a number, empty (0 in arithmetic, skipped by SUM), text, or a formula not computed yet. */
type CellRead = number | "empty" | "text" | "pending";
type Get = (col: number, row: number) => CellRead;
type Tok =
  | { t: "num"; v: number }
  | { t: "ref"; c: number; r: number }
  | { t: "range"; c1: number; r1: number; c2: number; r2: number }
  | { t: "fn"; v: string }
  | { t: "op"; v: string };

const FUNCS = new Set(["SUM", "AVERAGE", "MIN", "MAX", "COUNT", "ROUND", "ABS"]);

function tokens(f: string): Tok[] | null {
  const out: Tok[] = [];
  const re =
    /\s*(?:(\d+(?:\.\d+)?(?:E[+-]?\d+)?)|(\$?[A-Z]{1,3}\$?\d{1,7}):(\$?[A-Z]{1,3}\$?\d{1,7})|(\$?[A-Z]{1,3}\$?\d{1,7})(?![A-Z0-9(])|([A-Z][A-Z0-9.]*)\s*\(|([-+*/^(),%]))/giy;
  let m: RegExpExecArray | null;
  let at = 0;
  while (at < f.length) {
    re.lastIndex = at;
    m = re.exec(f);
    if (!m || m[0].length === 0) return /^\s*$/.test(f.slice(at)) ? out : null;
    at = re.lastIndex;
    const ref = (s: string) => {
      const x = /^\$?([A-Z]+)\$?(\d+)$/i.exec(s)!;
      return { c: colIndex(x[1]!), r: Number(x[2]) };
    };
    if (m[1]) out.push({ t: "num", v: Number(m[1]) });
    else if (m[2]) {
      const a = ref(m[2]);
      const b = ref(m[3]!);
      out.push({ t: "range", c1: Math.min(a.c, b.c), r1: Math.min(a.r, b.r), c2: Math.max(a.c, b.c), r2: Math.max(a.r, b.r) });
    } else if (m[4]) out.push({ t: "ref", ...ref(m[4]) });
    else if (m[5]) {
      const name = m[5].toUpperCase();
      if (!FUNCS.has(name)) return null;
      out.push({ t: "fn", v: name }, { t: "op", v: "(" });
    } else out.push({ t: "op", v: m[6]! });
  }
  return out;
}

/** A formula's value, or null when it uses anything this does not compute or reads a cell without a number. */
export function evaluate(formula: string, get: Get): number | null {
  const toks = tokens(formula.trim().replace(/^=/, ""));
  if (!toks) return null;
  let i = 0;
  const peek = () => toks[i];
  const isOp = (v: string) => peek()?.t === "op" && (peek() as { v: string }).v === v;
  const fail = (): never => {
    throw new Error("unsupported");
  };
  const cells = (t: Tok): number[] => {
    if (t.t === "ref") {
      const v = get(t.c, t.r);
      if (v === "pending") return fail();
      return typeof v === "number" ? [v] : [];
    }
    if (t.t !== "range" || (t.r2 - t.r1 + 1) * (t.c2 - t.c1 + 1) > 200_000) return fail();
    const out: number[] = [];
    for (let r = t.r1; r <= t.r2; r++)
      for (let c = t.c1; c <= t.c2; c++) {
        const v = get(c, r);
        if (v === "pending") return fail();
        if (typeof v === "number") out.push(v);
      }
    return out;
  };
  const args = (): number[] => {
    const out: number[] = [];
    if (isOp(")")) return out;
    for (;;) {
      const t = peek();
      // A range (or a lone cell) as an argument gives its numbers; anything else is an expression.
      const next = toks[i + 1];
      if (t && (t.t === "range" || (t.t === "ref" && next?.t === "op" && (next.v === "," || next.v === ")")))) {
        i++;
        out.push(...cells(t));
      } else out.push(expr());
      if (isOp(",")) i++;
      else return out;
    }
  };
  const call = (name: string): number => {
    i++; // "("
    const a = args();
    if (!isOp(")")) fail();
    i++;
    switch (name) {
      case "SUM":
        return a.reduce((x, y) => x + y, 0);
      case "AVERAGE":
        return a.length ? a.reduce((x, y) => x + y, 0) / a.length : fail();
      case "MIN":
        return a.length ? Math.min(...a) : 0;
      case "MAX":
        return a.length ? Math.max(...a) : 0;
      case "COUNT":
        return a.length;
      case "ABS":
        return Math.abs(a[0] ?? fail());
      default: {
        const p = 10 ** (a[1] ?? 0);
        return Math.round((a[0] ?? fail()) * p) / p;
      }
    }
  };
  const atom = (): number => {
    const t = toks[i++];
    if (!t) return fail();
    if (t.t === "num") return t.v;
    if (t.t === "ref") {
      const v = get(t.c, t.r);
      // An empty cell counts as 0, as in Excel; text in arithmetic is an error there, so no result here.
      return typeof v === "number" ? v : v === "empty" ? 0 : fail();
    }
    if (t.t === "fn") return call(t.v);
    if (t.t === "op" && t.v === "(") {
      const v = expr();
      if (!isOp(")")) fail();
      i++;
      return v;
    }
    if (t.t === "op" && t.v === "-") return -atom();
    if (t.t === "op" && t.v === "+") return atom();
    return fail();
  };
  const pct = (): number => {
    let v = atom();
    while (isOp("%")) {
      i++;
      v /= 100;
    }
    return v;
  };
  const pow = (): number => {
    const v = pct();
    if (isOp("^")) {
      i++;
      return v ** pow();
    }
    return v;
  };
  const term = (): number => {
    let v = pow();
    while (isOp("*") || isOp("/")) {
      const op = (toks[i++] as { v: string }).v;
      const r = pow();
      if (op === "/" && r === 0) fail();
      v = op === "*" ? v * r : v / r;
    }
    return v;
  };
  const expr = (): number => {
    let v = term();
    while (isOp("+") || isOp("-")) {
      const op = (toks[i++] as { v: string }).v;
      v = op === "+" ? v + term() : v - term();
    }
    return v;
  };
  try {
    const v = expr();
    if (i !== toks.length || !Number.isFinite(v)) return null;
    // Excel's own precision (15 significant digits): shares of a total add up to exactly 1.
    return Number(v.toPrecision(15));
  } catch {
    return null;
  }
}

/**
 * The results of a sheet's formulas, each from the cells' numbers and the results before it (a total of totals),
 * repeated until nothing changes. `values` maps "C4" → its number or text; `formulas` maps "F4" → "D4+E4".
 */
export function evaluateSheet(values: Map<string, number | string>, formulas: Map<string, string>): Map<string, number> {
  const out = new Map<string, number>();
  const get: Get = (c, r) => {
    const k = `${colName(c)}${r}`;
    const done = out.get(k);
    if (done !== undefined) return done;
    if (formulas.has(k)) return "pending";
    const v = values.get(k);
    return v === undefined || v === "" ? "empty" : typeof v === "number" ? v : "text";
  };
  for (let pass = 0; pass < 6; pass++) {
    let changed = false;
    for (const [ref, f] of formulas) {
      if (out.has(ref)) continue;
      const v = evaluate(f, get);
      if (v !== null) {
        out.set(ref, v);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return out;
}
