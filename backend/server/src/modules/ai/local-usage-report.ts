/**
 * Token use on people's own computers (coding agents such as Claude Code and Codex, read from their local logs by
 * workspace-usage.mjs) next to the company AI, as one picture: totals, the token mix, a day-by-day calendar, by tool,
 * model and person. Pure, so the controller and the weekly report share it and tests need no database.
 *
 * Two kinds of money, never added together: `costUsd` is what the company AI really cost (metered per call), and
 * `listValueUsd` is what the computers' tokens would cost at public API prices (people are usually on a flat
 * subscription, so it is a value, not a bill). A model with no known price is counted as unpriced tokens instead of
 * a guess. The company's own prices (Admin › AI › prices) win over the built-in table.
 *
 * Token totals are work tokens (metrics.ts workTokens): cache reads are reported in the mix but left out of totals.
 */
import { workTokens } from "./metrics.js";

/** USD per million tokens. Cache read and write default to 0.1× and 1.25× input (Anthropic's rule). */
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
const p = (input: number, output: number, cacheRead = input * 0.1, cacheWrite = input * 1.25): Price => ({ input, output, cacheRead, cacheWrite });

/** Public API list prices (2026-11), most specific prefix first. Unknown models stay unpriced. */
const BUILT_IN: [string, Price][] = [
  ["claude-fable-5", p(10, 50)],
  ["claude-opus-5-5", p(4, 20, 0.2, 5)],
  ["claude-opus-5", p(5, 25)],
  ["claude-sonnet-5", p(2, 10, 0.2, 2.5)],
  ["claude-haiku-5", p(0.1, 0.5)],
  ["claude-opus-4-1", p(15, 75)],
  ["claude-opus-4-0", p(15, 75)],
  ["claude-opus-4-2025", p(15, 75)],
  ["claude-opus-4", p(5, 25)],
  ["claude-sonnet-4", p(3, 15)],
  ["claude-3-7-sonnet", p(3, 15)],
  ["claude-3-5-sonnet", p(3, 15)],
  ["claude-haiku-4", p(1, 5)],
  ["claude-3-5-haiku", p(0.8, 4)],
  ["gpt-5.5", p(5, 30, 0.5, 0)],
  ["gpt-5.4-mini", p(0.75, 4.5, 0.075, 0)],
  ["gpt-5.4", p(2.5, 15, 0.25, 0)],
  ["gpt-5.3", p(1.75, 14, 0.175, 0)],
  ["gpt-5.2", p(1.75, 14, 0.175, 0)],
  ["gpt-5-mini", p(0.25, 2, 0.025, 0)],
  ["gpt-5-nano", p(0.05, 0.4, 0.005, 0)],
  ["gpt-5", p(1.25, 10, 0.125, 0)],
  ["gpt-4.1-mini", p(0.4, 1.6, 0.1, 0)],
  ["gpt-4.1", p(2, 8, 0.5, 0)],
  ["gpt-4o-mini", p(0.15, 0.6, 0.075, 0)],
  ["gpt-4o", p(2.5, 10, 1.25, 0)],
  ["o4-mini", p(1.1, 4.4, 0.275, 0)],
  ["o3", p(2, 8, 0.5, 0)],
  ["gemini-2.5-pro", p(1.25, 10, 0.31, 0)],
  ["gemini-2.5-flash", p(0.3, 2.5, 0.075, 0)],
];

const norm = (m: string) => m.toLowerCase().replace(/^(anthropic|openai|google)\//, "");

/** The price for a model: the company's (prefix match, longest first), else the built-in table, else null. */
export function priceOf(model: string, company: { model: string; input: number; output: number }[] = []): Price | null {
  const m = norm(model);
  const own = company
    .filter((x) => m === norm(x.model) || m.startsWith(`${norm(x.model)}-`) || m.startsWith(`${norm(x.model)}:`))
    .sort((a, b) => b.model.length - a.model.length)[0];
  if (own) return p(own.input, own.output);
  return BUILT_IN.find(([k]) => m === k || m.startsWith(`${k}-`) || m.startsWith(`${k}.`) || m.startsWith(`${k}@`))?.[1] ?? null;
}

export interface TokenRow {
  userId: string;
  /** "claude-code", "codex", "gemini-cli", "opencode", "other", or "company" (the company AI in the app). */
  tool: string;
  model: string;
  /** YYYY-MM-DD. */
  day: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  turns: number;
  sessions: number;
  /** Known cost (the company AI's metered cost); local rows are priced here. */
  costUsd?: number | null;
}

export interface Mix {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  total: number;
}
const zero = (): Mix => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 });
const add = (a: Mix, r: TokenRow) => {
  a.input += r.input;
  a.output += r.output;
  a.cacheRead += r.cacheRead;
  a.cacheWrite += r.cacheWrite;
  a.reasoning += r.reasoning;
  a.total += workTokens(r);
};

export interface TokenReport {
  days: number;
  from: string;
  to: string;
  totals: Mix & { turns: number; sessions: number; costUsd: number; listValueUsd: number; unpricedTokens: number; previous: number };
  /** Share of input served from cache: cache read / (new input + cache read). */
  cacheReuse: number | null;
  activeDays: number;
  bestStreak: number;
  busiest: { day: string; total: number } | null;
  daily: { day: string; total: number; tools: Record<string, number> }[];
  tools: { tool: string; total: number; costUsd: number; people: number; sessions: number }[];
  models: { model: string; tool: string; total: number; costUsd: number | null }[];
  people: { userId: string; total: number; costUsd: number; listValueUsd: number; tools: Record<string, number>; activeDays: number; previous: number }[];
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
export const dayRange = (days: number, today: string): string[] => {
  const end = new Date(`${today}T00:00:00Z`).getTime();
  return Array.from({ length: days }, (_, i) => isoDay(new Date(end - (days - 1 - i) * 86_400_000)));
};

/**
 * Rows of the window, plus last window's totals per person (`previous`), into the report. `today` is the window's
 * last day (YYYY-MM-DD).
 */
export function buildTokenReport(
  rows: TokenRow[],
  previous: { userId: string; total: number }[],
  days: number,
  today: string,
  company: { model: string; input: number; output: number }[] = [],
): TokenReport {
  const range = dayRange(days, today);
  const inRange = new Set(range);
  const totals = { ...zero(), turns: 0, sessions: 0, costUsd: 0, listValueUsd: 0, unpricedTokens: 0, previous: 0 };
  const daily = new Map(range.map((d) => [d, { day: d, total: 0, tools: {} as Record<string, number> }]));
  const tools = new Map<string, { tool: string; total: number; costUsd: number; people: Set<string>; sessions: number }>();
  const models = new Map<string, { model: string; tool: string; total: number; cost: number; priced: boolean }>();
  const people = new Map<string, { userId: string; total: number; costUsd: number; listValueUsd: number; tools: Record<string, number>; days: Set<string>; previous: number }>();
  for (const r of rows) {
    if (!inRange.has(r.day)) continue;
    const total = workTokens(r);
    if (total + r.cacheRead <= 0 && !r.turns) continue;
    const metered = r.costUsd !== undefined;
    const price = r.costUsd === undefined ? priceOf(r.model, company) : null;
    const cost =
      r.costUsd !== undefined
        ? r.costUsd
        : price
          ? (r.input * price.input + r.output * price.output + r.cacheRead * price.cacheRead + r.cacheWrite * price.cacheWrite) / 1_000_000
          : null;
    add(totals, r);
    totals.turns += r.turns;
    totals.sessions += r.sessions;
    if (cost === null) totals.unpricedTokens += total;
    else if (metered) totals.costUsd += cost;
    else totals.listValueUsd += cost;
    const d = daily.get(r.day)!;
    d.total += total;
    d.tools[r.tool] = (d.tools[r.tool] ?? 0) + total;
    const t = tools.get(r.tool) ?? { tool: r.tool, total: 0, costUsd: 0, people: new Set<string>(), sessions: 0 };
    t.total += total;
    t.costUsd += cost ?? 0;
    t.people.add(r.userId);
    t.sessions += r.sessions;
    tools.set(r.tool, t);
    const mk = `${r.tool}\u0000${r.model}`;
    const m = models.get(mk) ?? { model: r.model, tool: r.tool, total: 0, cost: 0, priced: false };
    m.total += total;
    m.cost += cost ?? 0;
    m.priced ||= cost !== null;
    models.set(mk, m);
    const pp = people.get(r.userId) ?? { userId: r.userId, total: 0, costUsd: 0, listValueUsd: 0, tools: {}, days: new Set<string>(), previous: 0 };
    pp.total += total;
    if (metered) pp.costUsd += cost ?? 0;
    else pp.listValueUsd += cost ?? 0;
    pp.tools[r.tool] = (pp.tools[r.tool] ?? 0) + total;
    pp.days.add(r.day);
    people.set(r.userId, pp);
  }
  for (const x of previous) {
    totals.previous += x.total;
    const pp = people.get(x.userId);
    if (pp) pp.previous += x.total;
    else people.set(x.userId, { userId: x.userId, total: 0, costUsd: 0, listValueUsd: 0, tools: {}, days: new Set(), previous: x.total });
  }
  const series = [...daily.values()];
  let streak = 0;
  let best = 0;
  for (const d of series) {
    streak = d.total > 0 ? streak + 1 : 0;
    best = Math.max(best, streak);
  }
  const top = series.reduce<{ day: string; total: number } | null>((a, d) => (d.total > 0 && (!a || d.total > a.total) ? { day: d.day, total: d.total } : a), null);
  const byTotal = <T extends { total: number }>(a: T, b: T) => b.total - a.total;
  return {
    days,
    from: range[0]!,
    to: today,
    totals,
    cacheReuse: totals.input + totals.cacheRead > 0 ? totals.cacheRead / (totals.input + totals.cacheRead) : null,
    activeDays: series.filter((d) => d.total > 0).length,
    bestStreak: best,
    busiest: top,
    daily: series,
    tools: [...tools.values()].map((t) => ({ tool: t.tool, total: t.total, costUsd: t.costUsd, people: t.people.size, sessions: t.sessions })).sort(byTotal),
    models: [...models.values()]
      .sort(byTotal)
      .slice(0, 12)
      .map((m) => ({ model: m.model, tool: m.tool, total: m.total, costUsd: m.priced ? m.cost : null })),
    people: [...people.values()]
      .map((x) => ({ userId: x.userId, total: x.total, costUsd: x.costUsd, listValueUsd: x.listValueUsd, tools: x.tools, activeDays: x.days.size, previous: x.previous }))
      .sort(byTotal),
  };
}
