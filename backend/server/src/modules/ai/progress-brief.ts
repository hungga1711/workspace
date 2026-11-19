import { Controller, Get, HttpException, Inject, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import type { Principal } from "@workspace/shared";
import { assertAllowed, requirePrincipal } from "@workspace/service-kit";
import { DEPS } from "./ai.controller.js";
import { guardAi } from "./budgets.js";
import { assistSystem } from "./prompts.js";
import { meteredGenerate, parseJson, replyLanguage, untrusted, type Deps } from "./runtime.js";

/**
 * AI › Tiến độ: who needs attention and why. The findings come from Follow-up's numbers by rules, so the page works
 * without a model; with one, the manager can ask for a reading of the same numbers: a short summary and, per person,
 * why they need attention and a drafted nudge. The manager sends a nudge themselves (work's task nudge); the AI never
 * sends anything. Everything is read through the work module AS THE CALLER, so the model sees only what the caller's
 * own Follow-up shows. People without reports get their own work ("self").
 */

export interface TaskLine {
  id: string;
  code: string;
  title: string;
  status: string;
  dueAt: string | null;
  updatedAt?: string;
  overdue?: boolean;
  stale?: boolean;
  atRisk?: boolean;
  blockedReason?: string | null;
  progress?: number | null;
  lastNote?: { text: string };
  /** Times AI helped with this task (work's task_ai_assists), when it has. */
  aiAssists?: number;
}
export interface TeamPerson {
  userId: string;
  displayName: string;
  title?: string | null;
  department?: string | null;
  open: number;
  overdue: number;
  stale: number;
  blocked: number;
  atRisk: number;
  done7: number;
  doneWeeks?: number[];
  onTimeRate: number | null;
  lastActivityAt: string | null;
  tasks: TaskLine[];
}
interface TeamStatus {
  scope?: "reports" | "everyone" | "none";
  people: TeamPerson[];
  departments: unknown[];
  totals: Record<string, number>;
}

export type ReasonKind = "overdue" | "blocked" | "atRisk" | "stale" | "quiet" | "slowing" | "overloaded";
export interface Reason {
  kind: ReasonKind;
  count?: number;
  days?: number;
}
export interface Attention {
  userId: string;
  displayName: string;
  title: string | null;
  department: string | null;
  reasons: Reason[];
  tasks: { id: string; code: string; title: string; status: string; dueAt: string | null; blockedReason: string | null; flag: "overdue" | "blocked" | "atRisk" | "stale" }[];
  /** The task a nudge goes on: the most urgent of `tasks`. */
  nudgeTaskId: string | null;
  score: number;
}

/** No activity on open work for this many days counts as "quiet" (Follow-up's stale is per task, 3 days). */
const QUIET_DAYS = 5;
/**
 * "Needs attention" is a short list a manager can act on today: a late or blocked task, at-risk work with another
 * sign, or open work gone quiet (score 3 and up), at most ATTENTION_MAX of them, worst first. Lighter signs (one
 * stale task, a slower week, a heavy load) go to `watch`, so a team with old data does not put everyone on the list.
 */
export const ATTENTION_MIN_SCORE = 3;
export const ATTENTION_MAX = 10;
const DAY = 86400_000;

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/**
 * The rules: late, blocked, at-risk and quiet work; a person whose finished work fell to under half their usual week;
 * a person with twice the team's usual open load. Worst first. `highlights` are people with a good week (several
 * things done, nothing late, mostly on time), so the page is not only bad news.
 */
export function progressFindings(people: TeamPerson[], now = Date.now()) {
  const typicalOpen = median(people.map((x) => x.open));
  const attention: Attention[] = [];
  for (const x of people) {
    const reasons: Reason[] = [];
    if (x.overdue) reasons.push({ kind: "overdue", count: x.overdue });
    if (x.blocked) reasons.push({ kind: "blocked", count: x.blocked });
    if (x.atRisk) reasons.push({ kind: "atRisk", count: x.atRisk });
    const quietDays = x.lastActivityAt ? Math.floor((now - new Date(x.lastActivityAt).getTime()) / DAY) : null;
    if (x.open && quietDays !== null && quietDays >= QUIET_DAYS) reasons.push({ kind: "quiet", days: quietDays });
    else if (x.stale) reasons.push({ kind: "stale", count: x.stale });
    const weeks = x.doneWeeks ?? [];
    const before = weeks.slice(0, 3);
    const usual = before.length ? before.reduce((n, w) => n + w, 0) / before.length : 0;
    if (usual >= 2 && (weeks[3] ?? 0) < usual / 2) reasons.push({ kind: "slowing", count: weeks[3] ?? 0 });
    if (people.length > 2 && x.open >= 8 && x.open >= typicalOpen * 2) reasons.push({ kind: "overloaded", count: x.open });
    if (!reasons.length) continue;
    const rank = (t: TaskLine) => (t.overdue ? 0 : t.blockedReason ? 1 : t.atRisk ? 2 : t.stale ? 3 : 4);
    const tasks = x.tasks
      .filter((t) => t.status !== "done" && rank(t) < 4)
      .sort((a, b) => rank(a) - rank(b) || (a.dueAt ?? "9").localeCompare(b.dueAt ?? "9"))
      .slice(0, 3)
      .map((t) => ({
        id: t.id,
        code: t.code,
        title: t.title,
        status: t.status,
        dueAt: t.dueAt,
        blockedReason: t.blockedReason ?? null,
        flag: (t.overdue ? "overdue" : t.blockedReason ? "blocked" : t.atRisk ? "atRisk" : "stale") as Attention["tasks"][number]["flag"],
      }));
    const score = 3 * x.overdue + 3 * x.blocked + 2 * x.atRisk + x.stale + (reasons.some((r) => r.kind === "quiet") ? 3 : 0) + (reasons.some((r) => r.kind === "slowing") ? 1 : 0);
    attention.push({
      userId: x.userId,
      displayName: x.displayName,
      title: x.title ?? null,
      department: x.department ?? null,
      reasons,
      tasks,
      nudgeTaskId: tasks[0]?.id ?? null,
      score,
    });
  }
  attention.sort((a, b) => b.score - a.score || a.displayName.localeCompare(b.displayName));
  const serious = attention.filter((a) => a.score >= ATTENTION_MIN_SCORE);
  const watch = [...serious.slice(ATTENTION_MAX), ...attention.filter((a) => a.score < ATTENTION_MIN_SCORE)];
  const highlights = people
    .filter((x) => x.done7 >= 3 && !x.overdue && !x.blocked && (x.onTimeRate === null || x.onTimeRate >= 80))
    .sort((a, b) => b.done7 - a.done7)
    .slice(0, 3)
    .map((x) => ({ userId: x.userId, displayName: x.displayName, done7: x.done7, onTimeRate: x.onTimeRate }));
  return { attention: serious.slice(0, ATTENTION_MAX), watch, highlights };
}

/** The model's reading: one summary, then per person why and a nudge the manager may edit and send. */
export interface ProgressReading {
  summary: string;
  people: { userId: string; why: string; nudge: string }[];
  next: string[];
}

const clip = (s: unknown, n: number) => (typeof s === "string" ? s.trim().slice(0, n) : "");

export function cleanReading(raw: Partial<ProgressReading> | null, known: Set<string>): ProgressReading {
  return {
    summary: clip(raw?.summary, 1200),
    people: (Array.isArray(raw?.people) ? raw.people : [])
      .filter((x) => x && known.has(String(x.userId)))
      .slice(0, 15)
      .map((x) => ({ userId: String(x.userId), why: clip(x.why, 400), nudge: clip(x.nudge, 600) })),
    next: (Array.isArray(raw?.next) ? raw.next : [])
      .map((s) => clip(s, 300))
      .filter(Boolean)
      .slice(0, 5),
  };
}

/**
 * A reading written as prose instead of JSON (small models do): the paragraphs are the summary and the bullet or
 * numbered lines the next steps. Null when there is nothing usable.
 */
export function readingFromText(text: string): Partial<ProgressReading> | null {
  const t = text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^[\s\S]*?<\/think>/i, "")
    .replace(/```[a-z]*\n?/gi, "")
    .trim();
  if (!t || t.startsWith("{")) return null;
  const lines = t.split("\n").map((l) => l.trim());
  const item = /^(?:[-*•]|\d+[.)])\s+/;
  const next = lines.filter((l) => item.test(l)).map((l) => l.replace(item, "").replace(/\*\*/g, ""));
  const summary = lines
    .filter((l) => l && !item.test(l) && !/^#+\s/.test(l))
    .join(" ")
    .replace(/\*\*/g, "");
  return summary || next.length ? { summary, people: [], next } : null;
}

/** People the model named by name instead of userId get their id back (small models copy the name field). */
export function withIds(raw: Partial<ProgressReading>, top: { userId: string; displayName: string }[]): Partial<ProgressReading> {
  if (!Array.isArray(raw.people)) return raw;
  const byName = new Map(top.map((a) => [a.displayName.toLowerCase(), a.userId]));
  const ids = new Set(top.map((a) => a.userId));
  return {
    ...raw,
    people: raw.people.map((x) => {
      const id = String((x as { userId?: unknown })?.userId ?? "");
      if (ids.has(id)) return x;
      const name = String((x as { name?: unknown })?.name ?? id).toLowerCase();
      return { ...x, userId: byName.get(name) ?? id };
    }),
  };
}

@Controller()
export class ProgressBriefController {
  constructor(@Inject(DEPS) private readonly d: Deps) {}

  /** The caller's team (or their own work), as Follow-up shows it to them. */
  private async load(p: Principal): Promise<{ scope: "team" | "self"; team: TeamStatus }> {
    const work = this.d.services.work;
    const team = await work.request<TeamStatus>("GET", "/followup/team", undefined, p);
    if (team.scope !== "none" && team.people.length) return { scope: "team", team };
    const me = await work.request<{ me: TeamPerson | null }>("GET", "/followup/me", undefined, p);
    const people = me.me ? [{ ...me.me, userId: p.id }] : [];
    return { scope: "self", team: { people, departments: [], totals: team.totals } };
  }

  @Get("progress/brief")
  async brief(@Req() req: Request) {
    const p = requirePrincipal(req);
    assertAllowed(p, "task.read");
    const { scope, team } = await this.load(p);
    const { attention, watch, highlights } = progressFindings(team.people);
    // `watch` goes out as a count: the page names the people who need something today, not everyone with a sign.
    return { scope, people: team.people.length, totals: team.totals, departments: team.departments, attention, watching: watch.length, highlights };
  }

  @Post("progress/analyze")
  async analyze(@Req() req: Request) {
    const p = requirePrincipal(req);
    assertAllowed(p, "ai.use");
    const lang = replyLanguage(req);
    return guardAi(async () => {
      const { scope, team } = await this.load(p);
      const { attention, highlights } = progressFindings(team.people);
      const top = attention.slice(0, 12);
      const byId = new Map(team.people.map((x) => [x.userId, x]));
      // Numbers are facts; titles, blocked reasons and progress notes are what people typed, so they go in the
      // untrusted block and can only inform the reading, never instruct it.
      const facts = {
        scope,
        people: team.people.length,
        totals: team.totals,
        attention: top.map((a) => ({ userId: a.userId, name: a.displayName, department: a.department, reasons: a.reasons, open: byId.get(a.userId)?.open ?? 0 })),
        doingWell: highlights.map((h) => ({ name: h.displayName, done7: h.done7 })),
      };
      const typed = top
        .map((a) => {
          const lines = (byId.get(a.userId)?.tasks ?? [])
            .filter((t) => t.status !== "done" && (t.overdue || t.blockedReason || t.atRisk || t.stale))
            .slice(0, 5)
            .map((t) => `- [${a.userId}] ${t.title}${t.blockedReason ? ` (blocked: ${t.blockedReason})` : ""}${t.lastNote ? ` (note: ${t.lastNote.text})` : ""}`);
          return lines.join("\n");
        })
        .filter(Boolean)
        .join("\n");
      const shape = `{"summary": string, "people": [{"userId": string, "why": string, "nudge": string}], "next": [string]}`;
      const extra =
        scope === "team"
          ? "You help a manager follow their team. summary: 3-5 sentences on the team's state and the one or two things that matter most this week. people: one entry per person in attention (same userId), why = the cause in one sentence grounded in the numbers and tasks, nudge = a short, friendly message the manager could send that person asking about the most urgent task (no blame, ask what would help). next: up to 3 concrete actions for the manager."
          : "You help one person with their own work. summary: 2-4 sentences on where their work stands. people: empty. next: up to 4 concrete next steps in order, naming the task titles.";
      const r = await meteredGenerate(
        this.d,
        { principal: p, agentId: null, feature: "progress_brief" },
        {
          tier: "fast",
          system: assistSystem(lang, "progress_brief", shape, extra),
          maxTokens: 1400,
          messages: [{ role: "user", content: `<facts>${JSON.stringify(facts)}</facts>\n${typed ? untrusted(typed) : ""}` }],
        },
      );
      const raw = parseJson<Partial<ProgressReading>>(r.text) ?? readingFromText(r.text);
      if (!raw) throw new HttpException({ error: "ai_malformed_output" }, 502);
      return { scope, ...cleanReading(withIds(raw, top), new Set(top.map((a) => a.userId))) };
    });
  }
}
