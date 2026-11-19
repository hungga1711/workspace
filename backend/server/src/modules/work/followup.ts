import type { PoolClient } from "pg";
import { ddmm as ddmmIn, DEFAULT_TIME_ZONE, type Principal } from "@workspace/shared";
import { allowedAny } from "./common.js";
import { atRisk, canReadTask, insertComment, TASK_COLS, type TaskRow } from "./tasks.js";
import { Forbidden } from "./errors.js";

/**
 * Follow-up (the manager's question: "who is doing what, and where is what I asked for?").
 *
 *  - Delegated: tasks I created and gave to someone else, with how fresh each one is.
 *  - Team: for everyone in my reporting line (from the employee module, asked as me), what they are
 *    working on, what is late, what is stuck, what they finished this week.
 *
 * A manager sees the title, status and dates of work assigned to their reports, which is the point
 * of the view; a report's private to-dos (no project, made for themselves) stay private, and opening
 * a task still follows the normal task rules.
 */

/** No update for this long on an open task counts as "quiet": worth a nudge. */
const STALE_DAYS = 3;
const OPEN = ["todo", "in_progress", "review"];

export interface Person {
  userId: string;
  displayName: string;
  title?: string | null;
  managerId?: string | null;
  depth?: number;
  /** Department name from the employee module (Admin › Nhóm & phòng ban); null when not set. */
  department?: string | null;
}

const brief = (t: TaskRow, now: number) => ({
  id: t.id,
  code: t.code,
  title: t.title,
  status: t.status,
  priority: t.priority,
  ownerId: t.owner_id,
  assigneeId: t.assignee_id,
  projectId: t.project_id,
  dueAt: t.due_at,
  updatedAt: t.updated_at,
  completedAt: t.completed_at,
  blockedReason: t.blocked_reason,
  progress: t.progress,
  etaAt: t.eta_at,
  checkinAt: t.checkin_at,
  atRisk: atRisk(t, now),
  overdue: !!t.due_at && t.due_at.getTime() < now && OPEN.includes(t.status),
  stale: OPEN.includes(t.status) && now - t.updated_at.getTime() > STALE_DAYS * 86400_000,
});
export type TaskBrief = ReturnType<typeof brief>;

/** Tasks I handed to others: open ones first (late, then quiet, then by due date), then recently done. */
export async function delegated(c: PoolClient, p: Principal) {
  const now = Date.now();
  const rows = (
    await c.query<TaskRow>(
      `SELECT ${TASK_COLS} FROM tasks
        WHERE owner_id = $1 AND assignee_id IS NOT NULL AND assignee_id <> $1
          AND (status IN ('todo','in_progress','review') OR (status = 'done' AND completed_at > now() - interval '14 days'))
        ORDER BY updated_at DESC LIMIT 300`,
      [p.id],
    )
  ).rows;
  const tasks = rows.map((t) => brief(t, now));
  const rank = (t: TaskBrief) => (t.status === "done" ? 4 : t.overdue ? 0 : t.atRisk ? 1 : t.stale ? 2 : 3);
  tasks.sort((a, b) => rank(a) - rank(b) || (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity));
  const open = tasks.filter((t) => t.status !== "done");
  return {
    summary: {
      open: open.length,
      overdue: open.filter((t) => t.overdue).length,
      stale: open.filter((t) => t.stale).length,
      blocked: open.filter((t) => t.blockedReason).length,
      atRisk: open.filter((t) => t.atRisk).length,
      done14: tasks.length - open.length,
    },
    tasks,
  };
}

/**
 * My team's work. `people` is my reporting line (or, for an admin in a workspace without a chart,
 * everyone). Per person: what is in progress now, late, quiet and blocked, and what got done in 7 days.
 */
export async function teamStatus(c: PoolClient, p: Principal, people: Person[]) {
  const now = Date.now();
  const ids = people.map((x) => x.userId).filter((id) => id !== p.id);
  if (!ids.length) return { people: [], departments: [], totals: { open: 0, overdue: 0, atRisk: 0, stale: 0, blocked: 0, done7: 0, donePrev7: 0, overdueWeekAgo: 0 } };
  // Up to 200 recent tasks per person (not 3,000 for the whole team): one busy person cannot push a colleague's work
  // out of the window, and the total stays people × 200 whatever the workspace's size.
  const rows = (
    await c.query<TaskRow>(
      `SELECT t.* FROM unnest($1::text[]) AS u(user_id)
         CROSS JOIN LATERAL (
           SELECT ${TASK_COLS} FROM tasks
            WHERE assignee_id = u.user_id
              AND (status IN ('todo','in_progress','review') OR (status = 'done' AND completed_at > now() - interval '28 days'))
              -- a report's own private to-dos stay private
              AND NOT (project_id IS NULL AND owner_id = assignee_id)
            ORDER BY updated_at DESC LIMIT 200) t`,
      [ids],
    )
  ).rows;
  // The latest progress note ("📍 Tiến độ …") on each open task: what the person said, not only the %.
  const openIds = rows.filter((t) => OPEN.includes(t.status)).map((t) => t.id);
  const notes = new Map<string, { text: string; at: Date }>();
  if (openIds.length)
    for (const r of (
      await c.query<{ task_id: string; body: string; created_at: Date }>(
        `SELECT DISTINCT ON (task_id) task_id, body, created_at FROM task_comments
          WHERE task_id = ANY($1::text[]) AND body LIKE '%📍 %' ORDER BY task_id, created_at DESC`,
        [openIds],
      )
    ).rows) {
      const text = r.body.split("\n").slice(1).join(" ").trim();
      if (text) notes.set(r.task_id, { text: text.slice(0, 280), at: r.created_at });
    }
  // Open tasks AI already helped with (task_ai_assists: the company AI on the task, or an AI conversation linked to it),
  // so Áp dụng AI does not offer AI for work that already has it.
  const assisted = new Map<string, number>();
  if (openIds.length)
    for (const r of (await c.query<{ task_id: string; calls: number }>("SELECT task_id, calls FROM task_ai_assists WHERE task_id = ANY($1::text[])", [openIds])).rows)
      assisted.set(r.task_id, r.calls);
  // Late a week ago (Home's "vs last week"): open then, due before then. Done-since-then counts too; work created
  // after that moment does not.
  const weekAgo = now - 7 * 86400_000;
  const lateThen = new Map<string, number>();
  for (const t of rows)
    if (t.due_at && t.due_at.getTime() < weekAgo && t.created_at.getTime() < weekAgo && (OPEN.includes(t.status) || (t.completed_at && t.completed_at.getTime() > weekAgo)))
      lateThen.set(t.assignee_id!, (lateThen.get(t.assignee_id!) ?? 0) + 1);
  const byPerson = new Map<string, (TaskBrief & { lastNote?: { text: string; at: Date }; aiAssists?: number })[]>();
  for (const t of rows) {
    const list = byPerson.get(t.assignee_id!) ?? [];
    list.push({ ...brief(t, now), ...(notes.has(t.id) ? { lastNote: notes.get(t.id)! } : {}), ...(assisted.has(t.id) ? { aiAssists: assisted.get(t.id)! } : {}) });
    byPerson.set(t.assignee_id!, list);
  }
  const out = people
    .filter((x) => x.userId !== p.id)
    .map((x) => {
      const all = byPerson.get(x.userId) ?? [];
      // Done in the last 28 days with a due date: how many landed on time (the "reliability" number).
      const done28 = all.filter((t) => t.status === "done");
      const dated = done28.filter((t) => t.dueAt && t.completedAt);
      const onTime = dated.filter((t) => t.completedAt!.getTime() <= t.dueAt!.getTime() + 86400_000 - 1).length;
      const tasks = all.filter((t) => t.status !== "done" || (t.completedAt && now - t.completedAt.getTime() < 7 * 86400_000));
      const open = tasks.filter((t) => t.status !== "done");
      const withProgress = open.filter((t) => t.progress != null);
      const last = tasks.reduce<Date | null>((m, t) => (!m || t.updatedAt > m ? t.updatedAt : m), null);
      return {
        ...x,
        open: open.length,
        inProgress: open.filter((t) => t.status === "in_progress" || t.status === "review").length,
        overdue: open.filter((t) => t.overdue).length,
        overdueWeekAgo: lateThen.get(x.userId) ?? 0,
        stale: open.filter((t) => t.stale).length,
        blocked: open.filter((t) => t.blockedReason).length,
        atRisk: open.filter((t) => t.atRisk).length,
        done7: tasks.length - open.length,
        done28: done28.length,
        // Finished per week, oldest first (4 weeks): the trend behind the numbers.
        doneWeeks: [3, 2, 1, 0].map(
          (w) => done28.filter((t) => t.completedAt && now - t.completedAt.getTime() >= w * 7 * 86400_000 && now - t.completedAt.getTime() < (w + 1) * 7 * 86400_000).length,
        ),
        onTimeRate: dated.length ? Math.round((onTime / dated.length) * 100) : null,
        avgProgress: withProgress.length ? Math.round(withProgress.reduce((n, t) => n + t.progress!, 0) / withProgress.length) : null,
        lastActivityAt: last,
        // What they are on now, then what is late: the few lines a manager actually reads.
        now: open
          .filter((t) => t.status === "in_progress" || t.status === "review")
          .slice(0, 3)
          .map(({ id, code, title, dueAt, overdue, stale, status, progress, etaAt, atRisk }) => ({ id, code, title, dueAt, overdue, stale, status, progress, etaAt, atRisk })),
        late: open
          .filter((t) => t.overdue)
          .slice(0, 5)
          .map(({ id, code, title, dueAt, status }) => ({ id, code, title, dueAt, status })),
        doneRecently: tasks
          .filter((t) => t.status === "done")
          .slice(0, 5)
          .map(({ id, code, title, completedAt }) => ({ id, code, title, completedAt })),
        tasks,
      };
    });
  // Who needs attention first: late work, then quiet work, then no activity at all.
  out.sort((a, b) => b.overdue - a.overdue || b.atRisk - a.atRisk || b.stale - a.stale || b.open - a.open || a.displayName.localeCompare(b.displayName));
  const sum = (k: "open" | "overdue" | "overdueWeekAgo" | "atRisk" | "stale" | "blocked" | "done7") => out.reduce((n, x) => n + x[k], 0);
  return {
    people: out,
    departments: departmentRollup(out),
    totals: {
      open: sum("open"),
      overdue: sum("overdue"),
      atRisk: sum("atRisk"),
      stale: sum("stale"),
      blocked: sum("blocked"),
      done7: sum("done7"),
      // Done in the 7 days before these 7, and late as of a week ago: the "▲▼ vs last week" on Home.
      donePrev7: out.reduce((n, x) => n + (x.doneWeeks[2] ?? 0), 0),
      overdueWeekAgo: sum("overdueWeekAgo"),
    },
  };
}

interface PersonNumbers {
  userId: string;
  department?: string | null;
  open: number;
  inProgress: number;
  overdue: number;
  atRisk: number;
  stale: number;
  blocked: number;
  done7: number;
  done28: number;
  doneWeeks?: number[];
  onTimeRate: number | null;
  avgProgress: number | null;
}

/**
 * Per department: the same numbers as per person, added up, plus how reliable the department is
 * (on-time share of work finished in 28 days) and how far its work in progress is on average.
 * People without a department are grouped under `name: null`. Worst first (late, then at risk).
 */
export function departmentRollup(people: PersonNumbers[]) {
  const groups = new Map<string, typeof people>();
  for (const x of people) {
    const k = x.department ?? "";
    groups.set(k, [...(groups.get(k) ?? []), x]);
  }
  return [...groups.entries()]
    .map(([name, xs]) => {
      const add = (k: "open" | "overdue" | "atRisk" | "stale" | "blocked" | "done7" | "inProgress") => xs.reduce((n, x) => n + x[k], 0);
      const rated = xs.filter((x) => x.onTimeRate != null);
      const prog = xs.filter((x) => x.avgProgress != null);
      const health = add("overdue") > 2 ? "risk" : add("overdue") || add("atRisk") || add("blocked") ? "watch" : "ok";
      return {
        name: name || null,
        people: xs.length,
        userIds: xs.map((x) => x.userId),
        open: add("open"),
        inProgress: add("inProgress"),
        overdue: add("overdue"),
        atRisk: add("atRisk"),
        stale: add("stale"),
        blocked: add("blocked"),
        done7: add("done7"),
        onTimeRate: rated.length
          ? Math.round(
              rated.reduce((n, x) => n + x.onTimeRate! * x.done28, 0) /
                Math.max(
                  1,
                  rated.reduce((n, x) => n + x.done28, 0),
                ),
            )
          : null,
        avgProgress: prog.length ? Math.round(prog.reduce((n, x) => n + x.avgProgress!, 0) / prog.length) : null,
        doneWeeks: [0, 1, 2, 3].map((i) => xs.reduce((n, x) => n + (x.doneWeeks?.[i] ?? 0), 0)),
        health,
      };
    })
    .sort((a, b) => Number(a.name === null) - Number(b.name === null) || b.overdue - a.overdue || b.atRisk - a.atRisk || (a.name ?? "").localeCompare(b.name ?? ""));
}

/** Admins of a workspace with no reporting lines yet see everyone (the CEO's first day). */
export function seesEveryone(p: Principal): boolean {
  return allowedAny(p, "task.edit", [{}]);
}

/**
 * "Nhắc cập nhật tiến độ": one nudge on every open task I can follow up (I assigned it, or it is my
 * report's) that has no progress update for STALE_DAYS, skipping tasks I already asked about in the
 * last day so nobody is spammed. Returns how many people and tasks were asked.
 */
export async function nudgeAll(c: PoolClient, p: Principal, tasks: TaskBrief[], managerOf: (userId: string) => boolean, locale: "vi" | "en" = "vi") {
  const now = Date.now();
  const due = tasks.filter(
    (t) =>
      t.status !== "done" &&
      t.assigneeId &&
      t.assigneeId !== p.id &&
      (!t.checkinAt || now - t.checkinAt.getTime() > STALE_DAYS * 86400_000) &&
      (t.ownerId === p.id || managerOf(t.assigneeId)),
  );
  const ids = [...new Set(due.map((t) => t.id))];
  if (!ids.length) return { tasks: 0, people: 0 };
  const recent = new Set(
    (
      await c.query<{ task_id: string }>("SELECT DISTINCT task_id FROM task_comments WHERE task_id = ANY($1) AND author_id = $2 AND created_at > now() - interval '20 hours'", [
        ids,
        p.id,
      ])
    ).rows.map((r) => r.task_id),
  );
  const ask = ids.filter((id) => !recent.has(id)).slice(0, 100);
  for (const id of ask) await nudge(c, p, id, NUDGE[locale].all, managerOf, locale);
  return { tasks: ask.length, people: new Set(due.filter((t) => ask.includes(t.id)).map((t) => t.assigneeId)).size };
}

/**
 * "Any update on this?": a comment on the task that mentions the assignee, so they get the usual
 * mention notification. Anyone who can see the task, or the assignee's manager chain (checked by
 * the caller), may nudge; the assignee never does.
 */
/** Default nudge texts, in the asker's language (the comment is theirs; the assignee reads it in chat). */
const NUDGE = {
  vi: {
    all: "Bạn cập nhật giúp tiến độ việc này nhé (bấm Cập nhật tiến độ: đã xong bao nhiêu %, dự kiến khi nào xong).",
    one: "Việc này đang tiến triển thế nào rồi? Bạn cập nhật giúp nhé.",
  },
  en: {
    all: "Could you update the progress on this one? (Press Update progress: how far along, and when it will be done.)",
    one: "How is this one going? A quick update, please.",
  },
} as const;

export async function nudge(c: PoolClient, p: Principal, taskId: string, message: string, managerOf: (userId: string) => boolean, locale: "vi" | "en" = "vi") {
  const t = (await c.query<TaskRow>(`SELECT ${TASK_COLS} FROM tasks WHERE id = $1`, [taskId])).rows[0];
  if (!t || !t.assignee_id) throw new Forbidden("nothing to follow up");
  // Anyone who can see the task may ask how it is going , plus the assignee's managers,
  // who may not otherwise open it; only the person doing it never asks themselves.
  if (t.assignee_id === p.id) throw new Forbidden("the assignee reports progress instead of asking for it");
  if (t.owner_id !== p.id && !managerOf(t.assignee_id) && !canReadTask(p, t)) throw new Forbidden("cannot see this task");
  const body = `<@${t.assignee_id}> ${message.trim() || NUDGE[locale].one}`.slice(0, 2000);
  // Written directly: a manager may not otherwise open a report's task, but the nudge still reaches them.
  return insertComment(c, p, t, body);
}

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
const L = {
  vi: {
    title: (from: string, to: string) => `Báo cáo tuần ${from} – ${to}`,
    intro: "Tạo tự động từ Tiến độ › Đội ngũ: việc đang mở, trễ hạn, có nguy cơ trễ và đã xong trong 7 ngày của đội. Số liệu tính tại thời điểm tạo trang.",
    overview: "Tổng quan",
    open: "Đang mở",
    overdue: "Trễ hạn",
    atRisk: "Có nguy cơ trễ",
    stale: "3+ ngày chưa cập nhật",
    blocked: "Bị chặn",
    done: "Xong trong 7 ngày",
    people: "Từng người",
    person: "Người",
    doing: "Đang làm",
    attention: "Cần chú ý",
    noAttention: "Không có việc nào trễ, có nguy cơ trễ hay bị chặn.",
    finished: "Đã xong",
    noneFinished: "Chưa có việc nào xong trong 7 ngày.",
    delegated: "Việc tôi giao",
    due: "hạn",
    eta: "dự kiến xong",
    noProgress: "chưa báo tiến độ",
    blockedBy: "bị chặn",
    departments: "Theo phòng ban",
    department: "Phòng ban",
    noDepartment: "Chưa có phòng ban",
    progress: "Tiến độ trung bình",
    onTime: "Đúng hạn (28 ngày)",
    ai: "AI trong tuần",
    aiSummary: (active: number, people: number, prompts: number, outside: number, flagged: number) =>
      `${active}/${people} người dùng AI, ${prompts} câu hỏi, ${outside}% trên ChatGPT, Claude, Gemini${flagged ? `, ${flagged} cảnh báo dữ liệu nhạy cảm` : ""}.`,
    prompts: "Câu hỏi",
    tools: "Công cụ",
    topics: "Dùng để làm gì",
    alerts: "Cảnh báo",
    source: { company: "Trợ lý AI công ty", chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini", copilot: "Copilot" } as Record<string, string>,
    topic: {
      code: "Lập trình",
      writing: "Soạn thảo",
      analysis: "Phân tích số liệu",
      translation: "Dịch thuật",
      research: "Tìm hiểu",
      sales: "Khách hàng, bán hàng",
      hr: "Nhân sự",
      design: "Thiết kế",
      planning: "Lập kế hoạch",
      other: "Khác",
    } as Record<string, string>,
    goals: "Mục tiêu quý",
    goal: "Mục tiêu",
    company: "Toàn công ty",
    expected: "Theo thời gian",
    state: "Tình trạng",
    health: { done: "Hoàn thành", on_track: "Đúng tiến độ", at_risk: "Có nguy cơ", behind: "Chậm", not_started: "Chưa bắt đầu" } as Record<string, string>,
    nextSteps: "Bước tiếp theo",
    next: "Hỏi tiến độ những việc trong mục Cần chú ý (nút Hỏi tiến độ ở Tiến độ › Đội ngũ).",
  },
  en: {
    title: (from: string, to: string) => `Weekly report ${from} – ${to}`,
    intro: "Generated from Progress › Team: the team's open, late, at-risk and finished work over 7 days, as of when this page was created.",
    overview: "Overview",
    open: "Open",
    overdue: "Late",
    atRisk: "At risk",
    stale: "No update 3+ days",
    blocked: "Blocked",
    done: "Done in 7 days",
    people: "By person",
    person: "Person",
    doing: "In progress",
    attention: "Needs attention",
    noAttention: "Nothing late, at risk or blocked.",
    finished: "Finished",
    noneFinished: "Nothing finished in 7 days.",
    delegated: "Work I assigned",
    due: "due",
    eta: "expected",
    noProgress: "no progress update",
    blockedBy: "blocked",
    departments: "By department",
    department: "Department",
    noDepartment: "No department",
    progress: "Avg progress",
    onTime: "On time (28 days)",
    ai: "AI this week",
    aiSummary: (active: number, people: number, prompts: number, outside: number, flagged: number) =>
      `${active}/${people} people used AI, ${prompts} prompts, ${outside}% on ChatGPT, Claude, Gemini${flagged ? `, ${flagged} sensitive-data alerts` : ""}.`,
    prompts: "Prompts",
    tools: "Tools",
    topics: "Used for",
    alerts: "Alerts",
    source: { company: "Company AI assistant", chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini", copilot: "Copilot" } as Record<string, string>,
    topic: {
      code: "Coding",
      writing: "Writing",
      analysis: "Data analysis",
      translation: "Translation",
      research: "Research",
      sales: "Customers & sales",
      hr: "People & HR",
      design: "Design",
      planning: "Planning",
      other: "Other",
    } as Record<string, string>,
    goals: "Goals this quarter",
    goal: "Goal",
    company: "Whole company",
    expected: "Expected by now",
    state: "Status",
    health: { done: "Done", on_track: "On track", at_risk: "At risk", behind: "Behind", not_started: "Not started" } as Record<string, string>,
    nextSteps: "Next steps",
    next: "Ask for an update on everything under Needs attention (Ask for an update in Progress › Team).",
  },
};

/**
 * The weekly report as a page (HTML): the same numbers as Follow-up, per person,
 * then what needs attention and what got done, with people as @mentions. No AI needed, so it works
 * on every plan; the page's own AI panel can summarise or rewrite it.
 */
/** The slice of the ai module's oversight the weekly report uses. */
export interface WeeklyAi {
  totals: { people: number; active: number; prompts: number; outside: number; flagged: number };
  people: { userId: string; displayName: string; prompts: number; flagged: number; sources: Record<string, number>; topics: Record<string, number> }[];
}

export function weeklyReport(
  team: Awaited<ReturnType<typeof teamStatus>>,
  mine: Awaited<ReturnType<typeof delegated>>,
  names: Map<string, string>,
  locale: "vi" | "en",
  now = new Date(),
  ai: WeeklyAi | null = null,
  goals: { title: string; department: string | null; progress: number; expected: number; health: string }[] = [],
  timeZone = DEFAULT_TIME_ZONE,
) {
  const l = L[locale];
  const ddmm = (d: Date) => ddmmIn(d, timeZone);
  const who = (id: string | null) => (id ? `<span data-type="mention" data-id="${esc(id)}" data-label="${esc(names.get(id) ?? id)}">@${esc(names.get(id) ?? id)}</span>` : "");
  const line = (t: TaskBrief) => {
    const bits = [
      t.dueAt ? `${l.due} ${ddmm(t.dueAt)}` : "",
      t.progress != null ? `${t.progress}%${t.etaAt ? ` · ${l.eta} ${ddmm(t.etaAt)}` : ""}` : l.noProgress,
      t.blockedReason ? `${l.blockedBy}: ${esc(t.blockedReason)}` : "",
    ].filter(Boolean);
    const tag = t.overdue ? l.overdue : t.atRisk ? l.atRisk : t.blockedReason ? l.blocked : t.stale ? l.stale : "";
    return `<li><p>${tag ? `<strong>${tag}</strong> · ` : ""}${esc(t.code)} ${esc(t.title)} ${who(t.assigneeId)} (${bits.join(", ")})</p></li>`;
  };
  const cell = (s: string | number, h = false) => (h ? `<th><p>${s}</p></th>` : `<td><p>${s}</p></td>`);
  const row = (cells: (string | number)[], h = false) => `<tr>${cells.map((x) => cell(x, h)).join("")}</tr>`;
  const all = new Map<string, TaskBrief>();
  for (const x of team.people) for (const t of x.tasks) all.set(t.id, t);
  for (const t of mine.tasks) all.set(t.id, t);
  const open = [...all.values()].filter((t) => t.status !== "done");
  const done = [...all.values()].filter((t) => t.status === "done" && t.completedAt && now.getTime() - t.completedAt.getTime() < 7 * 86400_000);
  const attention = open.filter((t) => t.overdue || t.atRisk || t.blockedReason).sort((a, b) => Number(b.overdue) - Number(a.overdue) || Number(b.atRisk) - Number(a.atRisk));
  const html = [
    `<p>${l.intro}</p>`,
    `<h2>${l.overview}</h2>`,
    `<table><tbody>${row([l.open, l.overdue, l.atRisk, l.stale, l.blocked, l.done], true)}${row([
      open.length,
      open.filter((t) => t.overdue).length,
      open.filter((t) => t.atRisk && !t.overdue).length,
      open.filter((t) => t.stale).length,
      open.filter((t) => t.blockedReason).length,
      done.length,
    ])}</tbody></table>`,
    ...(team.people.length
      ? [
          `<h2>${l.people}</h2>`,
          `<table><tbody>${row([l.person, l.doing, l.overdue, l.atRisk, l.stale, l.done], true)}${team.people
            .map((x) => row([who(x.userId) || esc(x.displayName), x.inProgress, x.overdue, x.atRisk, x.stale, x.done7]))
            .join("")}</tbody></table>`,
        ]
      : []),
    ...(team.departments.some((d) => d.name)
      ? [
          `<h2>${l.departments}</h2>`,
          `<table><tbody>${row([l.department, l.doing, l.overdue, l.atRisk, l.done, l.progress, l.onTime], true)}${team.departments
            .map((d) =>
              row([
                esc(d.name ?? l.noDepartment),
                d.inProgress,
                d.overdue,
                d.atRisk,
                d.done7,
                d.avgProgress == null ? "–" : `${d.avgProgress}%`,
                d.onTimeRate == null ? "–" : `${d.onTimeRate}%`,
              ]),
            )
            .join("")}</tbody></table>`,
        ]
      : []),
    ...(goals.length
      ? [
          `<h2>${l.goals}</h2>`,
          `<table><tbody>${row([l.goal, l.department, l.progress, l.expected, l.state], true)}${goals
            .map((g) => row([esc(g.title), esc(g.department ?? l.company), `${g.progress}%`, `${g.expected}%`, l.health[g.health] ?? g.health]))
            .join("")}</tbody></table>`,
        ]
      : []),
    ...(ai && ai.totals.people
      ? [
          `<h2>${l.ai}</h2>`,
          `<p>${l.aiSummary(ai.totals.active, ai.totals.people, ai.totals.prompts, ai.totals.prompts ? Math.round((ai.totals.outside / ai.totals.prompts) * 100) : 0, ai.totals.flagged)}</p>`,
          `<table><tbody>${row([l.person, l.prompts, l.tools, l.topics, l.alerts], true)}${ai.people
            .filter((x) => x.prompts)
            .slice(0, 30)
            .map((x) =>
              row([
                who(x.userId) || esc(x.displayName),
                x.prompts,
                esc(
                  topKeys(x.sources, 3)
                    .map((k) => l.source[k] ?? k)
                    .join(", "),
                ),
                esc(
                  topKeys(x.topics, 2)
                    .map((k) => l.topic[k] ?? k)
                    .join(", "),
                ),
                x.flagged || "",
              ]),
            )
            .join("")}</tbody></table>`,
        ]
      : []),
    `<h2>${l.attention}</h2>`,
    attention.length ? `<ul>${attention.slice(0, 50).map(line).join("")}</ul>` : `<p>${l.noAttention}</p>`,
    `<h2>${l.finished}</h2>`,
    done.length
      ? `<ul>${done
          .slice(0, 50)
          .map((t) => `<li><p>✓ ${esc(t.code)} ${esc(t.title)} ${who(t.assigneeId)}</p></li>`)
          .join("")}</ul>`
      : `<p>${l.noneFinished}</p>`,
    ...(mine.tasks.some((t) => t.status !== "done")
      ? [
          `<h2>${l.delegated}</h2>`,
          `<ul>${mine.tasks
            .filter((t) => t.status !== "done")
            .slice(0, 50)
            .map(line)
            .join("")}</ul>`,
        ]
      : []),
    ...(attention.length ? [`<h2>${l.nextSteps}</h2>`, `<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>${l.next}</p></li></ul>`] : []),
  ].join("");
  return { title: l.title(ddmm(new Date(now.getTime() - 6 * 86400_000)), ddmm(now)), html };
}

const topKeys = (r: Record<string, number>, n: number) =>
  Object.entries(r)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k]) => k);
