import { fold, type Lang } from "./local-model.js";

/**
 * The built-in model's whiteboard answers (ADR 0024): summary, grouping and ideas without a model, in English and
 * Vietnamese, so the whiteboard AI panel is useful on AI_LOCAL_MODEL=1 (demos, air-gapped trials). Pure functions over
 * the board lines the AI controller sends (whiteboard.ts boardLines), unit-tested in whiteboard-local.test.ts.
 */
export interface BoardNote {
  id: string;
  text: string;
  x: number;
  y: number;
}
export interface BoardLabel {
  text: string;
  x: number;
  y: number;
}

/** `[note <id> <x>,<y>] text` and `[label <x>,<y>] text`, one per line (what boardLines writes). */
export function parseBoardLines(body: string): { notes: BoardNote[]; labels: BoardLabel[] } {
  const notes: BoardNote[] = [];
  const labels: BoardLabel[] = [];
  for (const line of body.split("\n")) {
    const n = line.match(/^\[note ([A-Za-z0-9_-]{1,64}) (-?\d+),(-?\d+)\] (.*)$/);
    if (n) {
      notes.push({ id: n[1]!, x: Number(n[2]), y: Number(n[3]), text: n[4]!.trim() });
      continue;
    }
    const l = line.match(/^\[label (-?\d+),(-?\d+)\] (.*)$/);
    if (l && l[3]!.trim()) labels.push({ x: Number(l[1]), y: Number(l[2]), text: l[3]!.trim() });
  }
  return { notes, labels };
}

/**
 * The heading a note sits under: the nearest label above it (or level with it) in the same column, judged by
 * horizontal distance first. Retro, Kanban, SWOT and meeting boards put their headings at the top of each column.
 */
function headingOf(n: BoardNote, labels: BoardLabel[]): BoardLabel | null {
  const above = labels.filter((l) => l.y <= n.y + 20 && Math.abs(l.x - n.x) < 360);
  if (!above.length) return null;
  return above.sort((a, b) => Math.abs(a.x - n.x) - Math.abs(b.x - n.x) || b.y - a.y)[0]!;
}

const clip = (t: string, n = 160) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);

/** Markdown: the board's title, how many notes, then the notes under their headings (or as one list). */
export function summarizeBoard(title: string, body: string, lang: Lang): string {
  const en = lang === "en";
  const { notes, labels } = parseBoardLines(body);
  const filled = notes.filter((n) => n.text);
  if (!filled.length && !labels.length) return en ? "This whiteboard is empty so far." : "Bảng trắng này chưa có nội dung.";
  const head = `**${title}** · ${en ? `${filled.length} note${filled.length === 1 ? "" : "s"}` : `${filled.length} ghi chú`}`;
  const groups = new Map<string, string[]>();
  const loose: string[] = [];
  for (const n of filled) {
    const h = headingOf(n, labels);
    if (h) groups.set(h.text, [...(groups.get(h.text) ?? []), n.text]);
    else loose.push(n.text);
  }
  const out = [head];
  // Headings in reading order (top to bottom, left to right), each with its notes; empty ones say so.
  const ordered = [...labels].sort((a, b) => Math.round(a.y / 40) - Math.round(b.y / 40) || a.x - b.x);
  const seen = new Set<string>();
  for (const l of ordered) {
    if (seen.has(l.text)) continue;
    seen.add(l.text);
    const items = [...new Set(groups.get(l.text) ?? [])];
    if (!items.length && filled.length) continue;
    out.push("", `### ${l.text}`, ...(items.length ? items.slice(0, 12).map((t) => `- ${clip(t)}`) : [en ? "- (nothing yet)" : "- (chưa có)"]));
  }
  if (loose.length) out.push("", ...(groups.size ? [`### ${en ? "Other notes" : "Ghi chú khác"}`] : []), ...[...new Set(loose)].slice(0, 15).map((t) => `- ${clip(t)}`));
  return out.join("\n");
}

const STOP = new Set(
  (
    "the a an and or of to in on for with from by at is are be this that it we our you your they their more less new make use add get need " +
    "va voi cho cua la cac nhung mot de duoc co khong da se dang thi ma nay kia do hon it nhieu moi lam can them"
  ).split(" "),
);

/** The words of a note worth grouping by (folded, stop words and short words gone). */
const termsOf = (t: string) => [
  ...new Set(
    fold(t)
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w)),
  ),
];

/**
 * Notes grouped by a shared word: the word most notes share first, each note in one group, groups of two or more;
 * what is left goes under "Other". The group's title is the word as the notes write it (accents kept).
 */
export function clusterNotes(body: string, lang: Lang, max = 8): { title: string; elementIds: string[] }[] {
  const { notes } = parseBoardLines(body);
  const filled = notes.filter((n) => n.text);
  const terms = new Map(filled.map((n) => [n.id, termsOf(n.text)]));
  const df = new Map<string, number>();
  for (const ts of terms.values()) for (const t of ts) df.set(t, (df.get(t) ?? 0) + 1);
  const left = new Set(filled.map((n) => n.id));
  const groups: { title: string; elementIds: string[] }[] = [];
  for (const [term] of [...df.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || (a[0] < b[0] ? -1 : 1))) {
    if (groups.length >= max - 1) break;
    const ids = filled.filter((n) => left.has(n.id) && terms.get(n.id)!.includes(term)).map((n) => n.id);
    if (ids.length < 2) continue;
    ids.forEach((id) => left.delete(id));
    // The word as written in the first note that has it, with the next word when every note in the group shares
    // the pair ("khách hàng", not "khách": Vietnamese words are often two syllables).
    const words = filled
      .find((n) => n.id === ids[0])!
      .text.split(/\s+/)
      .map((w) => w.replace(/[^\p{L}\p{N}-]/gu, ""));
    const at = words.findIndex((w) => fold(w).replace(/[^a-z0-9]/g, "") === term);
    const next = at >= 0 ? words[at + 1] : undefined;
    const pair = next ? fold(`${words[at]} ${next}`) : "";
    const both = !!pair && ids.every((id) => fold(filled.find((n) => n.id === id)!.text).includes(pair));
    const shown = at < 0 ? term : both ? `${words[at]} ${next}` : words[at]!;
    groups.push({ title: shown.charAt(0).toUpperCase() + shown.slice(1), elementIds: ids });
  }
  if (left.size) groups.push({ title: lang === "en" ? "Other" : "Khác", elementIds: [...left] });
  return groups;
}

const IDEAS: Record<Lang, ((t: string) => string)[]> = {
  en: [
    (t) => `Ask three customers what is hardest about ${t}`,
    (t) => `List quick wins for ${t} we can ship this week`,
    (t) => `Pick one number that shows ${t} is working`,
    (t) => `Remove one step from ${t}`,
    (t) => `Run a two-week experiment on ${t}`,
    (t) => `Find a team that already solved ${t} and learn from them`,
    (t) => `Write down the biggest risk in ${t} and how to reduce it`,
    (t) => `Decide who owns ${t} and by when`,
  ],
  vi: [
    (t) => `Hỏi ba khách hàng điều gì khó nhất về ${t}`,
    (t) => `Liệt kê việc nhỏ làm ngay được cho ${t} trong tuần này`,
    (t) => `Chọn một con số cho thấy ${t} đang hiệu quả`,
    (t) => `Bỏ bớt một bước trong ${t}`,
    (t) => `Thử nghiệm ${t} trong hai tuần`,
    (t) => `Tìm nhóm đã giải quyết ${t} để học hỏi`,
    (t) => `Ghi rõ rủi ro lớn nhất của ${t} và cách giảm`,
    (t) => `Chốt người phụ trách ${t} và hạn hoàn thành`,
  ],
};

/**
 * New sticky texts about the topic (the request, else the board's title), skipping any the board already has. Each
 * is a concrete next step, the shape a person would write on a note.
 */
export function suggestIdeas(title: string, body: string, request: string, lang: Lang, n = 6): string[] {
  const topic = (request.trim() || title.trim())
    .replace(/^(ideas?|y tuong|ý tưởng|suggest|gợi ý|goi y)( (for|about|on|cho|về|ve))?[:\s]+/i, "")
    .replace(/[.!?:;,]+$/, "")
    .trim();
  // Mid-sentence, a topic starts lower-case ("Onboarding" → "…about onboarding"), unless it is a name or an acronym.
  const first = topic.split(/\s/)[0] ?? "";
  const t = !topic ? (lang === "en" ? "this" : "việc này") : /\p{Lu}/u.test(first.slice(1)) ? topic : topic.charAt(0).toLowerCase() + topic.slice(1);
  const have = new Set(parseBoardLines(body).notes.map((x) => fold(x.text)));
  return IDEAS[lang]
    .map((f) => f(t))
    .filter((i) => !have.has(fold(i)))
    .slice(0, n);
}
