/**
 * What an answer shows besides its words (the ai module's answer-blocks.ts): a chart or a table drawn from the data a
 * workspace tool read. Anything that does not read as a block is dropped here, so a malformed block never reaches a
 * component and the answer's text still stands.
 */

export interface Drill {
  /** A screen of the app (always "/app/…"). */
  url?: string;
  /** A follow-up question put in the composer. */
  ask?: string;
}
export interface ChartRow {
  label: string;
  value: number;
  compare?: number;
  highlight?: boolean;
  drill?: Drill;
}
export interface ChartBlock {
  kind: "chart";
  id: string;
  title: string;
  chart: "bars" | "trend";
  rows: ChartRow[];
  series?: [string, string];
  unit?: string;
}
export interface TableBlock {
  kind: "table";
  id: string;
  title: string;
  columns: { key: string; label: string; num?: boolean }[];
  rows: { cells: Record<string, string | number | null>; drill?: Drill; highlight?: boolean }[];
  more?: number;
}
export type AnswerBlock = ChartBlock | TableBlock;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const fin = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function drill(v: unknown): Drill | undefined {
  if (!isObj(v)) return undefined;
  const url = str(v.url).startsWith("/app/") ? str(v.url) : "";
  const ask = str(v.ask).trim();
  return url || ask ? { ...(url ? { url } : {}), ...(ask ? { ask } : {}) } : undefined;
}

/** The blocks of an answer as the server sent or stored them; at most four, each well-formed. */
export function readBlocks(raw: unknown): AnswerBlock[] {
  if (!Array.isArray(raw)) return [];
  const out: AnswerBlock[] = [];
  for (const b of raw.slice(0, 4)) {
    if (!isObj(b) || !Array.isArray(b.rows)) continue;
    const id = str(b.id) || `b${out.length}`;
    const title = str(b.title);
    if (b.kind === "chart") {
      const rows: ChartRow[] = [];
      for (const r of b.rows.slice(0, 40)) {
        if (!isObj(r) || fin(r.value) === null) continue;
        const d = drill(r.drill);
        const c = fin(r.compare);
        rows.push({
          label: str(r.label),
          value: fin(r.value)!,
          ...(c !== null ? { compare: c } : {}),
          ...(r.highlight === true ? { highlight: true } : {}),
          ...(d ? { drill: d } : {}),
        });
      }
      if (!rows.length) continue;
      const series = Array.isArray(b.series) && b.series.length === 2 ? ([str(b.series[0]), str(b.series[1])] as [string, string]) : undefined;
      out.push({ kind: "chart", id, title, chart: b.chart === "trend" ? "trend" : "bars", rows, ...(series ? { series } : {}), ...(str(b.unit) ? { unit: str(b.unit) } : {}) });
    } else if (b.kind === "table" && Array.isArray(b.columns)) {
      const columns = b.columns
        .filter(isObj)
        .map((c) => ({ key: str(c.key), label: str(c.label), ...(c.num === true ? { num: true } : {}) }))
        .filter((c) => c.key);
      if (!columns.length) continue;
      const rows: TableBlock["rows"] = [];
      for (const r of b.rows.slice(0, 40)) {
        if (!isObj(r) || !isObj(r.cells)) continue;
        const cells: Record<string, string | number | null> = {};
        for (const c of columns) {
          const v = r.cells[c.key];
          cells[c.key] = typeof v === "number" || typeof v === "string" ? v : null;
        }
        const d = drill(r.drill);
        rows.push({ cells, ...(d ? { drill: d } : {}), ...(r.highlight === true ? { highlight: true } : {}) });
      }
      if (!rows.length) continue;
      const more = fin(b.more);
      out.push({ kind: "table", id, title, columns, rows, ...(more && more > 0 ? { more } : {}) });
    }
  }
  return out;
}

/**
 * What to do next after an answer, from which workspace tools it used (no AI call): a follow-up put in the composer,
 * or a screen of the app. Keys are i18n keys under `aiw.answer.act` (label) and `aiw.answer.ask` (the follow-up).
 */
export interface AnswerAction {
  key: string;
  ask?: true;
  url?: string;
}
const ACTIONS: Record<string, AnswerAction[]> = {
  workload_balance: [{ key: "rebalance", ask: true }],
  overdue_tasks: [{ key: "nudgeOwners", ask: true }],
  blockers_report: [{ key: "unblock", ask: true }],
  unanswered_questions: [{ key: "draftReplies", ask: true }],
  summarize_channel: [{ key: "makeTasks", ask: true }],
  extract_action_items: [{ key: "makeTasks", ask: true }],
  doc_to_tasks: [{ key: "makeTasks", ask: true }],
  find_meeting_slot: [{ key: "bookSlot", ask: true }],
  find_duplicate_tasks: [{ key: "closeDuplicates", ask: true }],
  weekly_report_text: [{ key: "saveReport", ask: true }],
  person_progress: [{ key: "checkIn", ask: true }],
  department_compare: [{ key: "openProgress", url: "/app/ai/progress" }],
  trend_metric: [{ key: "openProgress", url: "/app/ai/progress" }],
  ai_spend: [{ key: "openAdoption", url: "/app/ai/adoption" }],
  ai_usage_vs_output: [{ key: "openAdoption", url: "/app/ai/adoption" }],
  suggest_ai_adoption: [{ key: "openAdoption", url: "/app/ai/adoption" }],
  prompt_topics: [{ key: "openAdoption", url: "/app/ai/adoption" }],
  attendance_summary: [{ key: "openTime", url: "/app/time" }],
};

/** The actions for the tools an answer used successfully, in the order they ran, at most three, each once. */
export function actionsFor(tools: { serverId: string; tool: string; outcome: string }[] | undefined): AnswerAction[] {
  const out: AnswerAction[] = [];
  for (const x of tools ?? []) {
    if (x.serverId !== "workspace" || x.outcome !== "ok") continue;
    for (const a of ACTIONS[x.tool] ?? []) if (!out.some((y) => y.key === a.key) && out.length < 3) out.push(a);
  }
  return out;
}

/** Cards shown under an answer; the rest of what it read stays as the small source links. */
export const CARDS_SHOWN = 4;
// A file the answer made comes first: it is usually what was asked for.
const CARD_RANK = ["file", "task", "employee", "document", "meeting"];

/** The items of an answer that become cards: tasks first, then people, pages and meetings, a few at most. */
export function cardsOf<S extends { type: string; id: string }>(sources: S[] | undefined | null): S[] {
  const seen = new Set<string>();
  const list = (sources ?? []).filter((x) => x && x.id && CARD_RANK.includes(x.type) && !seen.has(`${x.type}:${x.id}`) && seen.add(`${x.type}:${x.id}`));
  return list.sort((a, b) => CARD_RANK.indexOf(a.type) - CARD_RANK.indexOf(b.type)).slice(0, CARDS_SHOWN);
}

/** One chip of an answer's next steps: an action from the tools it used, or a question to ask next. */
export interface NextStep {
  id: string;
  kind: "action" | "question";
  label: string;
  /** What fills the box (an action's request, or the question itself). */
  text: string;
  /** An action that opens a screen instead. */
  url?: string;
}

const words = (s: string) =>
  new Set(
    s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/đ/gi, "d")
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 2),
  );
/** Two texts that ask for much the same thing (half their longer words shared). */
function sameIntent(a: string, b: string): boolean {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return a.trim().toLowerCase() === b.trim().toLowerCase();
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / Math.min(x.size, y.size) >= 0.5;
}

export const MAX_NEXT_STEPS = 4;

/**
 * The answer's actions first, then its follow-up questions; a question that asks what an action already does is left
 * out, and so is one asked twice. Without a box to fill (`canAsk` false) only actions that open a screen remain.
 */
export function nextSteps(
  tools: { serverId: string; tool: string; outcome: string }[] | undefined,
  followUps: string[] | undefined,
  text: (key: string) => { label: string; ask: string },
  canAsk: boolean,
): NextStep[] {
  const out: NextStep[] = [];
  for (const a of actionsFor(tools)) {
    if (!a.url && !canAsk) continue;
    const t = text(a.key);
    out.push({ id: `a:${a.key}`, kind: "action", label: t.label, text: t.ask, ...(a.url ? { url: a.url } : {}) });
  }
  if (canAsk)
    for (const q of followUps ?? []) {
      if (out.length >= MAX_NEXT_STEPS) break;
      const s = q.trim();
      if (!s || out.some((x) => sameIntent(x.text, s) || sameIntent(x.label, s))) continue;
      out.push({ id: `q:${s}`, kind: "question", label: s, text: s });
    }
  return out.slice(0, MAX_NEXT_STEPS);
}
