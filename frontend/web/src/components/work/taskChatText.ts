import { dateFormat } from "@/lib/intl";
/** Text helpers for the task chat (TaskChat.tsx): citations, the answer as plain text, its steps. Pure, tested. */

import { workspaceTimeZone, zoneOffset } from "@/lib/timezone";

export interface ChatSource {
  n: number;
  type: "task" | "document" | "message" | "project";
  id: string;
  title: string;
  url: string;
}

const SUP = "⁰¹²³⁴⁵⁶⁷⁸⁹";
const sup = (n: number) => String(n).replace(/\d/g, (d) => SUP[Number(d)]!);
/** "[2]" in an answer becomes a small link to that source; numbers the answer made up stay as written. */
export function linkCitations(text: string, sources: ChatSource[]): string {
  // A model may write a source as a link to its number ("[the runbook](#3)"): read as "the runbook [3]".
  return text
    .replace(/\[(\d+)\]\(#\d+\)/g, "[$1]")
    .replace(/\[([^\]\n]+)\]\(#(\d+)\)/g, "$1 [$2]")
    .replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (whole, list: string) => {
      const parts = list.split(",").map((x) => Number(x.trim()));
      const links = parts.map((n) => sources.find((s) => s.n === n)).filter((s): s is ChatSource => !!s);
      return links.length === parts.length ? links.map((s) => `[${sup(s.n)}](${s.url})`).join("") : whole;
    });
}
/** The answer as plain text for a comment or the description: citation numbers out, links kept as text. */
export function plainAnswer(text: string): string {
  return text
    .replace(/\[([^\]\n]+)\]\(#\d+\)/g, "$1")
    .replace(/\s*\[\d+(?:\s*,\s*\d+)*\]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
const CODE = /\s*[([]?\b[A-Z][A-Z0-9]{0,9}-\d{1,6}\b[)\]]?\s*[:：—–-]?\s*/g;

/**
 * A subtask title from a step: task codes out (a model invents T-717 for a step that is no task yet), a deadline kept
 * at the end, and short: the first clause when the step is a whole sentence, cut at a word at 80 characters.
 */
export function shortTitle(step: string): string {
  const bracket = /\s*[[(（][^\])）]*[\])）]\.?\s*$/.exec(step);
  // Only a deadline is kept as the tail; "(T-718)" is a code to drop, not a date.
  const due = bracket && /(hạn|due|deadline|by|截止|期限|vence|fecha)/i.test(bracket[0]) ? bracket : null;
  const tail = due ? due[0].trim().replace(/\.$/, "") : "";
  let core = (due ? step.slice(0, due.index) : step)
    .replace(CODE, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  core = core.replace(/[.。]$/, "").trim();
  if (core.length > 80) {
    const clause = /^(.{12,80}?)(?:[:：;；]|\s[—–]\s|\.\s|。|,\s(?=and |then |và |rồi |y |luego ))/u.exec(core)?.[1];
    core = clause ?? `${core.slice(0, 79).replace(/\s+\S*$/, "")}…`;
  }
  return tail ? `${core} ${tail}` : core;
}

/** The steps of an answer (a numbered or bulleted list), as subtask titles; fewer than two is not a plan. */
export function stepsOf(text: string): string[] {
  const steps = [...plainAnswer(text).matchAll(/^\s*(?:\d+[.)]|[-*•])\s+(?:\[[ x]\]\s+)?(.+)$/gm)]
    .map((m) =>
      m[1]!
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/[*_`]/g, "")
        .replace(/[:：]\s*$/, "")
        .trim(),
    )
    .map(shortTitle)
    .filter((s) => s.length > 1);
  return steps.length >= 2 ? steps.slice(0, 12) : [];
}

const WEEKDAY: Record<string, number> = {
  // Monday 0 … Sunday 6
  "2": 0,
  hai: 0,
  monday: 0,
  mon: 0,
  "3": 1,
  ba: 1,
  tuesday: 1,
  tue: 1,
  "4": 2,
  tư: 2,
  tu: 2,
  wednesday: 2,
  wed: 2,
  "5": 3,
  năm: 3,
  nam: 3,
  thursday: 3,
  thu: 3,
  "6": 4,
  sáu: 4,
  sau: 4,
  friday: 4,
  fri: 4,
  "7": 5,
  bảy: 5,
  bay: 5,
  saturday: 5,
  sat: 5,
  cn: 6,
  "chủ nhật": 6,
  "chu nhat": 6,
  sunday: 6,
  sun: 6,
};

/** Y/M/D of `now` on the wall clock of `tz`. */
function today(now: Date, tz: string): { y: number; m: number; d: number } {
  const p = Object.fromEntries(
    dateFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(now)
      .map((x) => [x.type, Number(x.value)]),
  );
  return { y: p.year!, m: p.month!, d: p.day! };
}

/** A day written by a person or a model ("thứ 2 tuần tới", "14/11", "ngày mai", "next Friday") as [y, m, d], or null. */
export function dayOf(text: string, now: Date, tz: string): [number, number, number] | null {
  const s = text
    .toLowerCase()
    .trim()
    .replace(/[.,;]+$/, "");
  const t = today(now, tz);
  const base = Date.UTC(t.y, t.m - 1, t.d);
  const at = (ms: number): [number, number, number] => {
    const x = new Date(ms);
    return [x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate()];
  };
  const dm = /(\d{1,2})\s*[/.-]\s*(\d{1,2})(?:\s*[/.-]\s*(\d{2,4}))?/.exec(s);
  if (dm) {
    const d = Number(dm[1]);
    const m = Number(dm[2]);
    let y = dm[3] ? Number(dm[3]) : t.y;
    if (y < 100) y += 2000;
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    // "05/01" written in December means next January.
    if (!dm[3] && Date.UTC(y, m - 1, d) < base - 60 * 86400_000) y += 1;
    return [y, m, d];
  }
  if (/\b(hôm nay|today|hoy)\b|今天/.test(s)) return at(base);
  if (/\b(ngày mai|tomorrow|mañana)\b|^mai$|明天/.test(s)) return at(base + 86400_000);
  const dow = (new Date(base).getUTCDay() + 6) % 7;
  const nextWeek = /(tuần (tới|sau)|next week|\bnext\b|próxima semana|semana que viene|下周)/.test(s);
  const weekAfter = /tuần sau nữa/.test(s);
  const wd =
    /(?:thứ\s*(2|3|4|5|6|7|hai|ba|tư|tu|năm|nam|sáu|sau|bảy|bay)\b|(chủ nhật|chu nhat|\bcn\b)|\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b)/.exec(
      s,
    );
  const target = wd ? WEEKDAY[(wd[1] ?? wd[2] ?? wd[3])!] : /cuối tuần|end of (the )?week|fin de semana|周末/.test(s) ? 4 : nextWeek || weekAfter ? 4 : undefined;
  if (target === undefined) return null;
  const weekStart = base - dow * 86400_000 + (weekAfter ? 14 : nextWeek ? 7 : 0) * 86400_000;
  let day = weekStart + target * 86400_000;
  // "thứ 2" with no week, already past this week: the coming one.
  if (!nextWeek && !weekAfter && !/tuần này|this week/.test(s) && day < base) day += 7 * 86400_000;
  return at(day);
}

/** A day (YYYY-MM-DD) as a due moment: the end of that working day, 17:00 on the workspace's clock. */
export function dueOn(day: string, tz = workspaceTimeZone()): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 17, 0, 0);
  return Number.isNaN(wall) ? null : new Date(wall - zoneOffset(new Date(wall), tz)).toISOString();
}

/**
 * A subtask step with its deadline taken out of the title: "Gửi báo giá [Hạn: Thứ 2 tuần tới]." becomes the title
 * "Gửi báo giá" due that Monday at 17:00 workspace time. A deadline that cannot be read stays in the title.
 */
export function splitDue(step: string, now = new Date(), tz = workspaceTimeZone(), asked = ""): { title: string; dueAt: string | null } {
  const word = "hạn chót|hạn|deadline|due|by|截止(?:日期)?|期限|vence|fecha límite|para el";
  const clauses = [
    new RegExp(`\\s*[[(（]\\s*(?:${word})\\s*[:：]?\\s*([^\\])）]+)[\\])）]\\.?\\s*$`, "iu"),
    new RegExp(`\\s*[—–-]\\s*(?:${word})\\s*[:：]?\\s*(.+?)\\.?\\s*$`, "iu"),
    new RegExp(`\\s*[,;]?\\s*(?:hạn chót|hạn|deadline|due|截止|vence)\\s*[:：]\\s*(.+?)\\.?\\s*$`, "iu"),
    // A bare trailing phrase ("… by Friday", "… trước thứ 6", "… antes del viernes"): kept only when it reads as a day.
    /\s+(?:by|before|due|until|trước|hạn|antes del|para el|vence el)\s+((?:\S+\s+){0,2}\S+?)\.?\s*$/iu,
  ];
  for (const re of clauses) {
    const m = re.exec(step);
    if (!m?.[1]) continue;
    let day = dayOf(m[1], now, tz);
    if (!day) continue;
    // Asked for "next week", a model's date inside this week (often its Sunday) is moved to next week's Friday.
    if (/(tuần (tới|sau)|next week|próxima semana|semana que viene|下周)/i.test(asked)) {
      const nextFriday = dayOf("next week", now, tz)!;
      const monday = Date.UTC(nextFriday[0], nextFriday[1] - 1, nextFriday[2]) - 4 * 86400_000;
      if (Date.UTC(day[0], day[1] - 1, day[2]) < monday) day = nextFriday;
    }
    const [y, mo, d] = day;
    const wall = Date.UTC(y, mo - 1, d, 17, 0, 0);
    const offset = zoneOffset(new Date(wall), tz);
    const title = step
      .slice(0, m.index)
      .replace(/[\s.,;:—–-]+$/, "")
      .trim();
    return { title: title || step, dueAt: new Date(wall - offset).toISOString() };
  }
  return { title: step, dueAt: null };
}
