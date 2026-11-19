/**
 * What an answer shows besides its words: a chart or a table drawn from the data a workspace tool read.
 * The tool builds the block from the same rows it writes for the model, so the picture never says more than the
 * person may read. Blocks travel with the answer (the stream's `done`, the saved message) and the web app draws them;
 * an app that does not know them shows the text alone.
 *
 * Kept small on purpose: at most MAX_BLOCKS per answer, MAX_ROWS rows each, short labels.
 */

/** Where a click on a bar or a row leads: a screen of the app, or a follow-up question put in the composer. */
export interface Drill {
  url?: string;
  ask?: string;
}

export interface ChartRow {
  label: string;
  value: number;
  /** A second series drawn beside the first (trend: added next to done). */
  compare?: number;
  /** The row that matters (an overloaded person): drawn in the accent. */
  highlight?: boolean;
  drill?: Drill;
}

export interface ChartBlock {
  kind: "chart";
  /** Stable within an answer (the tool and what it was asked), so one tool called twice draws once. */
  id: string;
  title: string;
  /** `bars`: categories (people, departments, models), one row each. `trend`: periods in order, oldest first. */
  chart: "bars" | "trend";
  rows: ChartRow[];
  /** Names of `value` and `compare` when there is a second series. */
  series?: [string, string];
  /** Shown after a value ("%", "₫", " days"). */
  unit?: string;
}

export interface TableColumn {
  key: string;
  label: string;
  /** Right-aligned, tabular figures. */
  num?: boolean;
}
export interface TableRow {
  cells: Record<string, string | number | null>;
  drill?: Drill;
  highlight?: boolean;
}
export interface TableBlock {
  kind: "table";
  id: string;
  title: string;
  columns: TableColumn[];
  rows: TableRow[];
  /** More rows exist than are shown. */
  more?: number;
}

export type AnswerBlock = ChartBlock | TableBlock;

export const MAX_BLOCKS = 4;
const MAX_ROWS = 40;
const MAX_COLS = 8;
const text = (s: unknown, n: number) => String(s ?? "").slice(0, n);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) / 100 : 0);

function drill(d: Drill | undefined): Drill | undefined {
  if (!d) return undefined;
  // Only the app's own screens: a block is data, never a way out of the app.
  const url = typeof d.url === "string" && /^\/app\/[\w\-/?=&%.:]*$/.test(d.url) ? d.url.slice(0, 300) : undefined;
  const ask = typeof d.ask === "string" && d.ask.trim() ? d.ask.trim().slice(0, 200) : undefined;
  return url || ask ? { ...(url ? { url } : {}), ...(ask ? { ask } : {}) } : undefined;
}

/** A block as it may leave the server: bounded, plain values only; null when there is nothing to draw. */
export function cleanBlock(b: AnswerBlock): AnswerBlock | null {
  if (b.kind === "chart") {
    const rows = b.rows.slice(0, MAX_ROWS).map((r) => {
      const d = drill(r.drill);
      return {
        label: text(r.label, 60),
        value: num(r.value),
        ...(r.compare !== undefined ? { compare: num(r.compare) } : {}),
        ...(r.highlight ? { highlight: true } : {}),
        ...(d ? { drill: d } : {}),
      };
    });
    if (!rows.length || rows.every((r) => r.value === 0 && !r.compare)) return null;
    return {
      kind: "chart",
      id: text(b.id, 80),
      title: text(b.title, 120),
      chart: b.chart === "trend" ? "trend" : "bars",
      rows,
      ...(b.series ? { series: [text(b.series[0], 40), text(b.series[1], 40)] as [string, string] } : {}),
      ...(b.unit ? { unit: text(b.unit, 12) } : {}),
    };
  }
  const columns = b.columns.slice(0, MAX_COLS).map((c) => ({ key: text(c.key, 30), label: text(c.label, 40), ...(c.num ? { num: true } : {}) }));
  const rows = b.rows.slice(0, MAX_ROWS).map((r) => {
    const d = drill(r.drill);
    const cells: Record<string, string | number | null> = {};
    for (const c of columns) {
      const v = r.cells[c.key];
      cells[c.key] = v === null || v === undefined ? null : typeof v === "number" ? num(v) : text(v, 120);
    }
    return { cells, ...(d ? { drill: d } : {}), ...(r.highlight ? { highlight: true } : {}) };
  });
  if (!columns.length || !rows.length) return null;
  const more = (b.more ?? 0) + Math.max(0, b.rows.length - MAX_ROWS);
  return { kind: "table", id: text(b.id, 80), title: text(b.title, 120), columns, rows, ...(more > 0 ? { more } : {}) };
}

/** Adds blocks to an answer's list: the same id once (the latest wins), at most MAX_BLOCKS. */
export function addBlocks(into: AnswerBlock[], more: AnswerBlock[] | undefined): void {
  for (const b of more ?? []) {
    const c = cleanBlock(b);
    if (!c) continue;
    const at = into.findIndex((x) => x.id === c.id);
    if (at >= 0) into[at] = c;
    else if (into.length < MAX_BLOCKS) into.push(c);
  }
}

/** Blocks read back from storage or a client: anything that is not a well-formed block is dropped. */
export function parseBlocks(raw: unknown): AnswerBlock[] {
  if (!Array.isArray(raw)) return [];
  const out: AnswerBlock[] = [];
  for (const b of raw) {
    if (!b || typeof b !== "object") continue;
    const x = b as { kind?: unknown; rows?: unknown; columns?: unknown };
    try {
      if (x.kind === "chart" && Array.isArray(x.rows)) addBlocks(out, [x as unknown as ChartBlock]);
      else if (x.kind === "table" && Array.isArray(x.columns) && Array.isArray(x.rows)) addBlocks(out, [x as unknown as TableBlock]);
    } catch {
      // A block that cannot be read is left out; the answer's text still stands.
    }
  }
  return out;
}
