/**
 * The arithmetic behind the assistant's report tools (tools-reports.ts), kept pure so it is tested without a server:
 * who carries too much, a department table, AI use next to output, what staff ask AI about, and a weekly report.
 */

export interface TeamTask {
  code: string;
  title: string;
  status: string;
  dueAt: string | null;
  overdue?: boolean;
  atRisk?: boolean;
  blockedReason?: string | null;
}
export interface TeamPersonRow {
  userId: string;
  displayName: string;
  department?: string | null;
  open: number;
  inProgress: number;
  overdue: number;
  atRisk?: number;
  stale: number;
  blocked: number;
  done7: number;
  tasks?: TeamTask[];
}

export type Load = "overloaded" | "busy" | "normal" | "room";
export interface Workload {
  userId: string;
  displayName: string;
  department: string | null;
  open: number;
  dueSoon: number;
  overdue: number;
  blocked: number;
  load: Load;
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/**
 * Load per person: open tasks plus those due in the next 7 days, against the team's median. Overloaded: well above
 * the median or three late tasks; room: well below it with nothing late. Most loaded first.
 */
export function workloadBalance(people: TeamPersonRow[], now: number): { median: number; people: Workload[] } {
  const week = now + 7 * 86400_000;
  const rows = people.map((x) => {
    const open = (x.tasks ?? []).filter((t) => t.status !== "done" && t.status !== "cancelled");
    const dueSoon = open.filter((t) => t.dueAt && Date.parse(t.dueAt) >= now && Date.parse(t.dueAt) < week).length;
    return { userId: x.userId, displayName: x.displayName, department: x.department ?? null, open: x.open, dueSoon, overdue: x.overdue, blocked: x.blocked };
  });
  const m = median(rows.map((x) => x.open));
  const load = (x: (typeof rows)[number]): Load => {
    const weight = x.open + x.dueSoon;
    if (x.overdue >= 3 || (x.open >= 4 && x.open >= m * 1.5 + 2) || weight >= Math.max(12, m * 2.5)) return "overloaded";
    if (x.open > m * 1.2 || x.overdue > 0) return "busy";
    if (x.open <= Math.max(1, m * 0.5)) return "room";
    return "normal";
  };
  const order: Record<Load, number> = { overloaded: 0, busy: 1, normal: 2, room: 3 };
  return {
    median: m,
    people: rows
      .map((x) => ({ ...x, load: load(x) }))
      .sort((a, b) => order[a.load] - order[b.load] || b.open + b.dueSoon - (a.open + a.dueSoon) || a.displayName.localeCompare(b.displayName)),
  };
}

export interface DepartmentRow {
  name: string | null;
  people: number;
  open: number;
  inProgress: number;
  overdue: number;
  atRisk: number;
  blocked: number;
  done7: number;
  onTimeRate: number | null;
  doneWeeks: number[];
  health: string;
}
export interface DepartmentLine {
  name: string | null;
  people: number;
  open: number;
  done: number;
  donePerPerson: number;
  overdue: number;
  overdueShare: number;
  blocked: number;
  onTimeRate: number | null;
  health: string;
}

/** Departments side by side over the last `weeks` weeks (1–4): done, done per person, late share, on-time rate. */
export function compareDepartments(rows: DepartmentRow[], weeks: number): DepartmentLine[] {
  const n = Math.min(Math.max(Math.trunc(weeks) || 1, 1), 4);
  return rows
    .map((d) => {
      const done = d.doneWeeks.slice(-n).reduce((a, b) => a + b, 0);
      return {
        name: d.name,
        people: d.people,
        open: d.open,
        done,
        donePerPerson: d.people ? Math.round((done / d.people) * 10) / 10 : 0,
        overdue: d.overdue,
        overdueShare: d.open ? Math.round((d.overdue / d.open) * 100) : 0,
        blocked: d.blocked,
        onTimeRate: d.onTimeRate,
        health: d.health,
      };
    })
    .sort((a, b) => Number(a.name === null) - Number(b.name === null) || b.donePerPerson - a.donePerPerson || a.overdueShare - b.overdueShare);
}

export interface AiProfile {
  userId: string;
  displayName: string;
  department: string | null;
  uses: number;
  prevUses: number;
  pattern: string;
}
export interface OutputRow {
  userId: string;
  done: number;
  donePrev: number;
  dated: number;
  onTime: number;
}
export interface AiOutputLine {
  userId: string;
  displayName: string;
  department: string | null;
  uses: number;
  usesChange: number | null;
  done: number;
  doneChange: number | null;
  onTimeRate: number | null;
  regular: boolean;
}
export interface AiOutputGroup {
  people: number;
  done: number;
  donePrev: number;
  /** Change in tasks done against the window before, in percent; null when nothing was done before. */
  change: number | null;
}

const pct = (now: number, before: number) => (before ? Math.round(((now - before) / before) * 100) : null);
const REGULAR = new Set(["power", "regular"]);

/**
 * AI use beside output per person, and the two groups (regular AI users, everyone else) compared on how their
 * output moved against the window before. A comparison, not a cause: the tool says so.
 */
export function aiVsOutput(profiles: AiProfile[], output: OutputRow[]): { people: AiOutputLine[]; regular: AiOutputGroup; others: AiOutputGroup } {
  const by = new Map(output.map((o) => [o.userId, o]));
  const people = profiles.map((x) => {
    const o = by.get(x.userId) ?? { done: 0, donePrev: 0, dated: 0, onTime: 0 };
    return {
      userId: x.userId,
      displayName: x.displayName,
      department: x.department,
      uses: x.uses,
      usesChange: pct(x.uses, x.prevUses),
      done: o.done,
      doneChange: pct(o.done, o.donePrev),
      onTimeRate: o.dated ? Math.round((o.onTime / o.dated) * 100) : null,
      regular: REGULAR.has(x.pattern),
    };
  });
  const group = (xs: typeof people): AiOutputGroup => {
    const done = xs.reduce((n, x) => n + x.done, 0);
    const donePrev = xs.reduce((n, x) => n + (by.get(x.userId)?.donePrev ?? 0), 0);
    return { people: xs.length, done, donePrev, change: pct(done, donePrev) };
  };
  people.sort((a, b) => b.uses - a.uses || b.done - a.done || a.displayName.localeCompare(b.displayName));
  return { people, regular: group(people.filter((x) => x.regular)), others: group(people.filter((x) => !x.regular)) };
}

export interface OversightPerson {
  userId: string;
  displayName: string;
  department: string | null;
  prompts: number;
  sources: Record<string, number>;
  topics: Record<string, number>;
}
export interface TopicLine {
  topic: string;
  prompts: number;
  people: number;
  outside: number;
  departments: { name: string; prompts: number }[];
}

/**
 * Prompts per topic over everyone in view: how many, how many people, how many went to assistants outside the
 * company's own, and the departments asking most. Sources are counted per person, so the outside share of a
 * topic is that person's outside share applied to their prompts on it.
 */
export function topicBreakdown(people: OversightPerson[]): TopicLine[] {
  const by = new Map<string, { prompts: number; people: Set<string>; outside: number; departments: Map<string, number> }>();
  for (const x of people) {
    const total = Object.values(x.sources).reduce((a, b) => a + b, 0);
    const outsideShare = total ? (total - (x.sources.company ?? 0)) / total : 0;
    for (const [topic, n] of Object.entries(x.topics)) {
      if (!n) continue;
      const t = by.get(topic) ?? { prompts: 0, people: new Set<string>(), outside: 0, departments: new Map<string, number>() };
      t.prompts += n;
      t.people.add(x.userId);
      t.outside += n * outsideShare;
      if (x.department) t.departments.set(x.department, (t.departments.get(x.department) ?? 0) + n);
      by.set(topic, t);
    }
  }
  return [...by.entries()]
    .map(([topic, t]) => ({
      topic,
      prompts: t.prompts,
      people: t.people.size,
      outside: Math.round(t.outside),
      departments: [...t.departments.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([name, prompts]) => ({ name, prompts })),
    }))
    .sort((a, b) => b.prompts - a.prompts || a.topic.localeCompare(b.topic));
}

export interface ReportPerson extends TeamPersonRow {
  late?: { code: string; title: string; dueAt: string | null }[];
  now?: { code: string; title: string; progress?: number | null }[];
  doneRecently?: { code: string; title: string }[];
  onTimeRate?: number | null;
}

/** A weekly progress report in Markdown: totals, then per person what got done, what is in hand and what is late. */
export function weeklyMarkdown(subject: string, people: ReportPerson[], lang: "en" | "vi", day: string): { title: string; markdown: string } {
  const en = lang === "en";
  const sum = (k: "open" | "overdue" | "blocked" | "done7" | "stale") => people.reduce((n, x) => n + x[k], 0);
  const title = en ? `Weekly report: ${subject} (${day})` : `Báo cáo tuần: ${subject} (${day})`;
  const lines: string[] = [];
  lines.push(
    en
      ? `**${people.length} people** · ${sum("done7")} done in 7 days · ${sum("open")} open · ${sum("overdue")} overdue · ${sum("blocked")} blocked · ${sum("stale")} without an update`
      : `**${people.length} người** · xong ${sum("done7")} việc trong 7 ngày · ${sum("open")} việc mở · ${sum("overdue")} trễ hạn · ${sum("blocked")} bị chặn · ${sum("stale")} lâu chưa cập nhật`,
  );
  const attention = people.filter((x) => x.overdue || x.blocked);
  if (attention.length) {
    lines.push("", en ? "## Needs attention" : "## Cần chú ý");
    for (const x of attention) lines.push(`- **${x.displayName}**: ${en ? `${x.overdue} overdue, ${x.blocked} blocked` : `${x.overdue} trễ hạn, ${x.blocked} bị chặn`}`);
  }
  lines.push("", en ? "## By person" : "## Theo từng người");
  for (const x of [...people].sort((a, b) => b.done7 - a.done7 || a.displayName.localeCompare(b.displayName))) {
    lines.push(
      "",
      `### ${x.displayName}${x.department ? ` · ${x.department}` : ""}`,
      en
        ? `${x.done7} done · ${x.open} open (${x.inProgress} in progress) · ${x.overdue} overdue${x.onTimeRate != null ? ` · ${x.onTimeRate}% on time` : ""}`
        : `Xong ${x.done7} · ${x.open} việc mở (${x.inProgress} đang làm) · ${x.overdue} trễ hạn${x.onTimeRate != null ? ` · ${x.onTimeRate}% đúng hạn` : ""}`,
    );
    if (x.doneRecently?.length) lines.push(`- ${en ? "Done" : "Đã xong"}: ${x.doneRecently.map((t) => `${t.code} ${t.title}`).join("; ")}`);
    if (x.now?.length) lines.push(`- ${en ? "In hand" : "Đang làm"}: ${x.now.map((t) => `${t.code} ${t.title}${t.progress != null ? ` (${t.progress}%)` : ""}`).join("; ")}`);
    if (x.late?.length) lines.push(`- ${en ? "Late" : "Trễ"}: ${x.late.map((t) => `${t.code} ${t.title}${t.dueAt ? ` (${t.dueAt.slice(0, 10)})` : ""}`).join("; ")}`);
  }
  if (!people.length) lines.push("", en ? "Nobody to report on." : "Không có ai để báo cáo.");
  return { title, markdown: lines.join("\n") };
}
