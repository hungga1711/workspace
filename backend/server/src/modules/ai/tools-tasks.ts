import { z } from "zod";
import { deptMatches } from "./ground.js";
import type { Loc } from "./locale.js";
import { ToolProblem, type Tool, type ToolContext } from "./tools.js";
import { lateTable } from "./tool-blocks.js";
import { en, enc, F, field, isoDate, L, niceTime, person, str, taskOf, taskSource, work, type Say, type Write } from "./workspace-kit.js";

/**
 * Task tools beyond create / change / comment: who is late, reassigning with the new assignee's load in
 * view, splitting work into subtasks, changing many tasks at once, duplicates, a task's history, a due-date estimate
 * from similar finished work, dependencies, and an onboarding checklist. Reads go through work's task-tools endpoints
 * (work/task-tools.ts), which filter by what the asker may read; writes reuse the same endpoints the app uses, so the
 * work module authorizes every change again.
 */

interface TaskDto {
  id: string;
  code: string;
  title: string;
  status: string;
  assigneeId: string | null;
  projectId: string | null;
  dueAt: string | null;
  progress: number | null;
  etaAt: string | null;
  blockedReason: string | null;
  createdAt?: string;
}
interface Employee {
  userId: string;
  displayName: string;
  department?: string | null;
}

const STATUS = ["todo", "in_progress", "review", "done", "cancelled"] as const;
const PRIORITY = ["low", "medium", "high", "urgent"] as const;
const DAY = 86_400_000;

const directory = async (ctx: ToolContext) =>
  (await ctx.services.employee.request<{ employees: Employee[] }>("GET", "/employees?all=1", undefined, ctx.principal).catch(() => ({ employees: [] as Employee[] }))).employees;
const day = (ctx: ToolContext, iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString(en(ctx) ? "en-GB" : "vi-VN", { day: "2-digit", month: "2-digit", timeZone: ctx.timeZone ?? "UTC" }) : "";
const when = (ctx: ToolContext, iso: string) =>
  new Date(iso).toLocaleString(en(ctx) ? "en-GB" : "vi-VN", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: ctx.timeZone ?? "UTC" });
const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);

// Card labels of these tools only; the shared ones (title, assignee, due …) come from workspace-kit's F.
const T = {
  tasks: { en: "Tasks", vi: "Các việc" },
  subtasks: { en: "Subtasks", vi: "Việc con" },
  parent: { en: "Under", vi: "Thuộc việc" },
  link: { en: "Link", vi: "Liên kết" },
  addLabels: { en: "Add labels", vi: "Thêm nhãn" },
  removeLabels: { en: "Remove labels", vi: "Bỏ nhãn" },
  newHire: { en: "New hire", vi: "Nhân viên mới" },
  starts: { en: "First day", vi: "Ngày đầu" },
  manager: { en: "Manager", vi: "Quản lý" },
  steps: { en: "Steps", vi: "Các bước" },
} satisfies Record<string, Say>;

/** Blocked spans from a task's activity (newest first, as the task endpoint returns it), for task_history. */
export function blockedTime(
  activity: { action: string; changes: Record<string, { from: unknown; to: unknown }> | null; at: string }[],
  current: { blockedReason: string | null; createdAt?: string | undefined },
  now = Date.now(),
): { totalMs: number; spans: { from: string; to: string | null; reason: string }[] } {
  const asc = activity.filter((a) => a.changes && "blocked_reason" in a.changes).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const spans: { from: string; to: string | null; reason: string }[] = [];
  // Blocked before the oldest change we can see (the endpoint keeps the last 100 entries): counted from creation.
  const first = asc[0]?.changes?.blocked_reason?.from;
  let open: { from: string; reason: string } | null = first ? { from: current.createdAt ?? asc[0]!.at, reason: String(first) } : null;
  if (!asc.length && current.blockedReason && current.createdAt) open = { from: current.createdAt, reason: current.blockedReason };
  for (const a of asc) {
    const to = a.changes!.blocked_reason!.to;
    if (to && !open) open = { from: a.at, reason: String(to) };
    else if (!to && open) {
      spans.push({ ...open, to: a.at });
      open = null;
    }
  }
  if (open) spans.push({ ...open, to: null });
  const totalMs = spans.reduce((n, s) => n + ((s.to ? Date.parse(s.to) : now) - Date.parse(s.from)), 0);
  return { totalMs, spans };
}

/**
 * One activity entry in words. Only an "updated" entry holds `{ field: { from, to } }`; the others carry their own
 * shape (created: the title; moved: a status `from`/`to`; dependency_added: the other task's code).
 */
export function historyWhat(action: string, changes: Record<string, unknown> | null, show: (k: string, v: unknown) => string = (_k, v) => String(v ?? "—")): string {
  const c = changes ?? {};
  const isDiff = (v: unknown): v is { from: unknown; to: unknown } => !!v && typeof v === "object" && "from" in v && "to" in v;
  if (action === "updated") {
    const parts = Object.entries(c)
      .filter(([, v]) => isDiff(v))
      .map(([k, v]) => `${k.replace(/_id$/, "")}: ${show(k, (v as { from: unknown }).from)} → ${show(k, (v as { to: unknown }).to)}`);
    return parts.length ? parts.join(", ") : "updated";
  }
  if (action === "moved" && "to" in c) return `status: ${show("status", c.from)} → ${show("status", c.to)}`;
  if (action === "created") return "created";
  if (action === "dependency_added" && c.predecessor) return `now waits on ${String(c.predecessor)}`;
  if (action === "recurred" && c.nextCode) return `repeated as ${String(c.nextCode)}`;
  if (action === "duplicated" && c.copyCode) return `copied to ${String(c.copyCode)}`;
  return action.replace(/_/g, " ");
}

/** The asker's ids for a department name, or the one person named; undefined for "everyone I can see". */
async function assigneesFor(ctx: ToolContext, input: { person?: string | undefined; department?: string | undefined }): Promise<{ ids?: string[]; label: string }> {
  if (input.person) {
    const p = await person(ctx, input.person);
    return { ids: [p.userId], label: p.displayName };
  }
  if (input.department) {
    const ids = (await directory(ctx)).filter((e) => e.department && deptMatches(e.department, input.department!)).map((e) => e.userId);
    if (!ids.length) throw new ToolProblem(`No department called "${input.department}". Use find_people to see the departments.`);
    return { ids, label: input.department };
  }
  return { label: "" };
}

const READ: Tool[] = [
  {
    name: "overdue_tasks",
    description:
      "Tasks that are overdue, or at risk of being late (the assignee's own expected finish is after the due date, or little progress with the due date close), among the tasks the user may see. Narrow by a person, a department or a project. Grouped by assignee.",
    permission: "task.read",
    input: z.object({ person: z.string().max(120).optional(), department: z.string().max(80).optional(), project: z.string().max(80).optional() }),
    jsonSchema: {
      type: "object",
      properties: { person: str("a colleague's name (optional)"), department: str("a department name (optional)"), project: str("a project code (optional)") },
    },
    async run(ctx, input) {
      const who = await assigneesFor(ctx, input);
      const q = [who.ids ? `assignees=${enc(who.ids.join(","))}` : "", input.project ? `project=${enc(input.project)}` : ""].filter(Boolean).join("&");
      const r = await work<{ overdue: TaskDto[]; atRisk: TaskDto[]; truncated: boolean }>(ctx, "GET", `/task-tools/late${q ? `?${q}` : ""}`);
      if (!r.overdue.length && !r.atRisk.length)
        return { ok: true, content: en(ctx) ? "Nothing is overdue or at risk." : "Không có việc nào trễ hoặc có nguy cơ trễ.", sources: [] };
      const names = new Map((await directory(ctx)).map((e) => [e.userId, e.displayName]));
      const nobody = en(ctx) ? "Unassigned" : "Chưa giao";
      const by = new Map<string, string[]>();
      const add = (t: TaskDto, late: boolean) => {
        const who = t.assigneeId ? (names.get(t.assigneeId) ?? t.assigneeId) : nobody;
        const days = t.dueAt ? Math.floor((Date.now() - Date.parse(t.dueAt)) / DAY) : 0;
        const tag = late ? (en(ctx) ? `${days}d late` : `trễ ${days} ngày`) : en(ctx) ? "at risk" : "có nguy cơ trễ";
        const extra = [
          t.progress != null ? `${t.progress}%` : "",
          t.etaAt ? `${en(ctx) ? "expected" : "dự kiến"} ${day(ctx, t.etaAt)}` : "",
          t.blockedReason ? `${en(ctx) ? "blocked" : "bị chặn"}: ${t.blockedReason}` : "",
        ]
          .filter(Boolean)
          .join(", ");
        (by.get(who) ?? by.set(who, []).get(who)!).push(`${t.code} ${t.title} (${en(ctx) ? "due" : "hạn"} ${day(ctx, t.dueAt)}, ${tag}${extra ? `, ${extra}` : ""})`);
      };
      r.overdue.forEach((t) => add(t, true));
      r.atRisk.forEach((t) => add(t, false));
      const head = en(ctx)
        ? `[late${who.label ? ` · ${who.label}` : ""}] ${r.overdue.length} overdue, ${r.atRisk.length} at risk.`
        : `[trễ${who.label ? ` · ${who.label}` : ""}] ${r.overdue.length} việc trễ hạn, ${r.atRisk.length} việc có nguy cơ trễ.`;
      const lines = [...by].sort((a, b) => b[1].length - a[1].length).map(([n, ts]) => `[${n}] ${ts.slice(0, 15).join("; ")}${ts.length > 15 ? " …" : ""}`);
      return {
        ok: true,
        content: [head, ...lines, r.truncated ? (en(ctx) ? "(Only the first 3000 were checked.)" : "(Chỉ kiểm tra 3000 việc đầu.)") : ""].filter(Boolean).join("\n"),
        sources: [...r.overdue, ...r.atRisk].slice(0, 10).map(taskSource),
        blocks: [
          lateTable(
            { vi: !en(ctx), now: Date.now(), day: (iso) => day(ctx, iso) },
            [...r.overdue.map((t) => ({ t, overdue: true })), ...r.atRisk.map((t) => ({ t, overdue: false }))].map(({ t, overdue }) => ({
              code: t.code,
              title: t.title,
              assignee: t.assigneeId ? (names.get(t.assigneeId) ?? "?") : nobody,
              dueAt: t.dueAt,
              overdue,
              progress: t.progress,
            })),
          ),
        ].filter((x) => x !== null),
      };
    },
  },
  {
    name: "find_duplicate_tasks",
    description: "Open tasks whose titles say nearly the same thing (likely duplicates), optionally in one project or for one assignee. Best matches first.",
    permission: "task.read",
    input: z.object({ project: z.string().max(80).optional(), person: z.string().max(120).optional() }),
    jsonSchema: { type: "object", properties: { project: str("a project code (optional)"), person: str("an assignee's name (optional)") } },
    async run(ctx, input) {
      const assignee = input.person ? (await person(ctx, input.person)).userId : null;
      const q = [input.project ? `project=${enc(input.project)}` : "", assignee ? `assignee=${enc(assignee)}` : ""].filter(Boolean).join("&");
      const r = await work<{ pairs: { a: TaskDto; b: TaskDto; score: number }[]; scanned: number }>(ctx, "GET", `/task-tools/duplicates${q ? `?${q}` : ""}`);
      if (!r.pairs.length)
        return {
          ok: true,
          content: en(ctx) ? `No likely duplicates among ${r.scanned} open tasks.` : `Không thấy việc trùng trong ${r.scanned} việc đang mở.`,
          sources: [],
        };
      return {
        ok: true,
        content: r.pairs.map((x) => `${x.a.code} "${x.a.title}" ≈ ${x.b.code} "${x.b.title}" (${Math.round(x.score * 100)}%)`).join("\n"),
        sources: r.pairs.slice(0, 5).flatMap((x) => [taskSource(x.a), taskSource(x.b)]),
      };
    },
  },
  {
    name: "task_history",
    description: "A task's history: who changed what and when (status, assignee, due date, priority, title, blocked), and how long it has been blocked in total.",
    permission: "task.read",
    input: z.object({ task: z.string().min(2).max(80) }),
    jsonSchema: { type: "object", properties: { task: str("task code or id") }, required: ["task"] },
    async run(ctx, input) {
      const r = await work<{
        task: TaskDto & { createdAt: string };
        activity: { actor: string | null; action: string; changes: Record<string, { from: unknown; to: unknown }> | null; at: string }[];
      }>(ctx, "GET", `/tasks/${enc(input.task.trim())}`);
      const names = new Map((await directory(ctx)).map((e) => [e.userId, e.displayName]));
      const nameOf = (v: unknown) => (typeof v === "string" ? (names.get(v) ?? v) : v == null ? "—" : String(v));
      const show = (k: string, v: unknown) =>
        k === "assignee_id" ? nameOf(v) : k.endsWith("_at") && typeof v === "string" ? day(ctx, v) : v == null || v === "" ? "—" : String(v);
      const lines = [...r.activity].reverse().map((a) => {
        const who = a.actor ? nameOf(a.actor.replace(/^user:/, "")) : "system";
        return `${when(ctx, a.at)} ${who}: ${historyWhat(a.action, a.changes, show)}`;
      });
      const b = blockedTime(r.activity, { blockedReason: r.task.blockedReason, createdAt: r.task.createdAt });
      const blockedDays = Math.round((b.totalMs / DAY) * 10) / 10;
      const summary = en(ctx)
        ? `[${r.task.code}] ${r.task.title}: created ${day(ctx, r.task.createdAt)}, now ${r.task.status}. Blocked ${b.spans.length} time(s), ${blockedDays} days in total${r.task.blockedReason ? ` (blocked now: ${r.task.blockedReason})` : ""}.`
        : `[${r.task.code}] ${r.task.title}: tạo ${day(ctx, r.task.createdAt)}, hiện ${r.task.status}. Bị chặn ${b.spans.length} lần, tổng ${blockedDays} ngày${r.task.blockedReason ? ` (đang bị chặn: ${r.task.blockedReason})` : ""}.`;
      return { ok: true, content: [summary, ...lines.slice(-60)].join("\n"), sources: [taskSource(r.task)] };
    },
  },
  {
    name: "estimate_due_date",
    description:
      "Suggest a realistic due date for a piece of work from how long similar finished tasks took (median and 75th percentile days from start to done), optionally in one project or for one assignee. Use before setting a due date when the user asks how long something will take.",
    permission: "task.read",
    input: z.object({ title: z.string().min(2).max(300), project: z.string().max(80).optional(), person: z.string().max(120).optional(), from: isoDate.optional() }),
    jsonSchema: {
      type: "object",
      properties: {
        title: str("what the work is (a task title or code)"),
        project: str("a project code (optional)"),
        person: str("who would do it (optional)"),
        from: str("when work starts, ISO (default now)"),
      },
      required: ["title"],
    },
    async run(ctx, input) {
      // A task code: estimate from its title, in its project.
      let title = input.title;
      let project = input.project;
      if (/^[A-Za-z]+-\d+$/.test(title.trim())) {
        const t = await work<{ task: TaskDto }>(ctx, "GET", `/tasks/${enc(title.trim())}`);
        title = t.task.title;
        project ??= t.task.projectId ?? undefined;
      }
      const assignee = input.person ? (await person(ctx, input.person)).userId : null;
      const q = [`title=${enc(title)}`, project ? `project=${enc(project)}` : "", assignee ? `assignee=${enc(assignee)}` : "", input.from ? `from=${enc(input.from)}` : ""];
      const r = await work<{
        basis: "similar" | "all";
        sample: number;
        medianDays: number | null;
        p75Days: number | null;
        suggestedDueAt: string | null;
        examples: { code: string; title: string; days: number }[];
      }>(ctx, "GET", `/task-tools/estimate?${q.filter(Boolean).join("&")}`);
      if (!r.sample || r.medianDays === null)
        return { ok: true, content: en(ctx) ? "No finished tasks to estimate from yet." : "Chưa có việc đã xong nào để ước lượng.", sources: [] };
      const ex = r.examples.map((e) => `${e.code} ${e.title} (${e.days}d)`).join("; ");
      return {
        ok: true,
        content: en(ctx)
          ? `Based on ${r.sample} ${r.basis === "similar" ? "similar" : "finished (no close match, so all recent)"} tasks: median ${r.medianDays} days, 75% within ${r.p75Days} days. Suggested due date: ${day(ctx, r.suggestedDueAt)}.${ex ? `\nClosest: ${ex}` : ""}`
          : `Dựa trên ${r.sample} việc ${r.basis === "similar" ? "tương tự" : "đã xong (không có việc giống, lấy tất cả gần đây)"}: trung vị ${r.medianDays} ngày, 75% xong trong ${r.p75Days} ngày. Hạn gợi ý: ${day(ctx, r.suggestedDueAt)}.${ex ? `\nGần nhất: ${ex}` : ""}`,
        sources: [],
      };
    },
  },
];

const subtaskShape = z.object({
  title: z.string().min(1).max(300),
  assignee: z.string().max(120).optional(),
  dueAt: isoDate.optional(),
  description: z.string().max(4000).optional(),
});
const subtaskLines = (v: unknown, loc: Loc) =>
  (Array.isArray(v) ? v : []).map((s: Record<string, unknown>) =>
    [String(s.title ?? ""), s.assignee ? `→ ${String(s.assignee)}` : "", s.dueAt ? `(${String(niceTime(s.dueAt, loc))})` : ""].filter(Boolean).join(" "),
  );

/** The default onboarding steps: whose step it is and how many days from the first day it is due. */
const ONBOARDING: { title: Say; who: "hire" | "manager"; day: number }[] = [
  { title: { en: "Prepare laptop, accounts and access", vi: "Chuẩn bị máy, tài khoản và quyền truy cập" }, who: "manager", day: -1 },
  { title: { en: "Welcome message and team introduction", vi: "Gửi lời chào và giới thiệu với đội" }, who: "manager", day: 0 },
  { title: { en: "Sign in and set up the tools", vi: "Đăng nhập và cài đặt công cụ" }, who: "hire", day: 0 },
  { title: { en: "Read the company handbook and policies", vi: "Đọc sổ tay và quy định công ty" }, who: "hire", day: 2 },
  { title: { en: "Meet each teammate one-to-one", vi: "Gặp riêng từng đồng nghiệp trong đội" }, who: "hire", day: 5 },
  { title: { en: "First-week check-in", vi: "Trao đổi cuối tuần đầu tiên" }, who: "manager", day: 5 },
  { title: { en: "Deliver a first small task", vi: "Hoàn thành việc nhỏ đầu tiên" }, who: "hire", day: 10 },
  { title: { en: "30-day review", vi: "Đánh giá sau 30 ngày" }, who: "manager", day: 30 },
];

const WRITE: Write[] = [
  {
    title: { en: "Assign a task", vi: "Giao việc" },
    preview: (i, loc) => ({
      title: L(loc, { en: `Assign ${String(i.task ?? "")}`, vi: `Giao ${String(i.task ?? "")}` }),
      fields: [...field(loc, F.task, i.task), ...field(loc, F.assignee, i.assignee), ...field(loc, F.due, niceTime(i.dueAt, loc))],
      note: L(loc, { en: "Their current open and overdue work is reported after the change.", vi: "Số việc đang mở và trễ hạn của người nhận sẽ được báo sau khi giao." }),
    }),
    tool: {
      name: "assign_task",
      description:
        "Assign or reassign a task to a colleague (optionally with a new due date). The result reports the new assignee's open and overdue load. Check workload first with team_status or overdue_tasks when the user asks who should take it.",
      permission: "task.read",
      input: z.object({ task: z.string().min(2).max(80), assignee: z.string().min(1).max(120), dueAt: isoDate.optional() }),
      jsonSchema: {
        type: "object",
        properties: { task: str("task code or id"), assignee: str("a colleague's name ('me' for the user)"), dueAt: str("new ISO due date-time (optional)") },
        required: ["task", "assignee"],
      },
      async run(ctx, input) {
        const t = await taskOf(ctx, input.task);
        const p = await person(ctx, input.assignee);
        await work(ctx, "PATCH", `/tasks/${t.id}`, {
          expectedVersion: t.version,
          assigneeId: p.userId,
          ...(input.dueAt ? { dueAt: new Date(input.dueAt).toISOString() } : {}),
        });
        const l = await work<{ open: number; overdue: number; dueThisWeek: number; blocked: number }>(ctx, "GET", `/task-tools/load/${enc(p.userId)}`).catch(() => null);
        const load = l
          ? en(ctx)
            ? ` ${p.displayName} now has ${l.open} open tasks (${l.overdue} overdue, ${l.dueThisWeek} due this week, ${l.blocked} blocked).`
            : ` ${p.displayName} hiện có ${l.open} việc mở (${l.overdue} trễ hạn, ${l.dueThisWeek} đến hạn tuần này, ${l.blocked} bị chặn).`
          : "";
        return { ok: true, content: `${en(ctx) ? `Assigned ${t.code} to` : `Đã giao ${t.code} cho`} ${p.displayName}.${load}`, sources: [taskSource(t)] };
      },
    },
  },
  {
    title: { en: "Split into subtasks", vi: "Tách việc con" },
    preview: (i, loc) => ({
      title: L(loc, { en: `Split ${String(i.task ?? "")} into subtasks`, vi: `Tách ${String(i.task ?? "")} thành việc con` }),
      fields: [...field(loc, T.parent, i.task), ...field(loc, T.subtasks, subtaskLines(i.subtasks, loc).join("\n"))],
    }),
    tool: {
      name: "split_task",
      description: "Break a task into subtasks in one go: each with a title and optionally an assignee, a due date and details. Up to 20.",
      permission: "task.create",
      input: z.object({ task: z.string().min(2).max(80), subtasks: z.array(subtaskShape).min(1).max(20) }),
      jsonSchema: {
        type: "object",
        properties: {
          task: str("the parent task code"),
          subtasks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: str("imperative title"),
                assignee: str("a colleague's name (optional)"),
                dueAt: str("ISO date-time (optional)"),
                description: str("details (optional)"),
              },
              required: ["title"],
            },
          },
        },
        required: ["task", "subtasks"],
      },
      async run(ctx, input) {
        const parent = await taskOf(ctx, input.task);
        // Resolve every name first: one unknown name stops the whole split before anything is created.
        const who = await Promise.all(
          input.subtasks.map((s: z.infer<typeof subtaskShape>) => (s.assignee ? person(ctx, s.assignee).then((p) => p.userId) : Promise.resolve(null))),
        );
        const made: { id: string; code: string; title: string }[] = [];
        // One by one, so the subtasks keep the order given.
        for (const [i, s] of (input.subtasks as z.infer<typeof subtaskShape>[]).entries())
          made.push(
            await work<{ id: string; code: string; title: string }>(ctx, "POST", "/tasks", {
              title: s.title,
              description: s.description ?? "",
              assigneeId: who[i],
              dueAt: s.dueAt ? new Date(s.dueAt).toISOString() : null,
              parentId: parent.id,
            }),
          );
        return {
          ok: true,
          content: `Created ${made.length} subtasks under ${parent.code}: ${made.map((t) => t.code).join(", ")}.`,
          sources: [taskSource(parent), ...made.map(taskSource)],
        };
      },
    },
  },
  {
    title: { en: "Change many tasks", vi: "Sửa nhiều việc" },
    preview: (i, loc) => ({
      title: L(loc, { en: `Change ${list(i.tasks).length} tasks`, vi: `Sửa ${list(i.tasks).length} việc` }),
      fields: [
        ...field(loc, T.tasks, list(i.tasks)),
        ...field(loc, F.status, i.status),
        ...field(loc, F.due, niceTime(i.dueAt, loc)),
        ...field(loc, F.priority, i.priority),
        ...field(loc, T.addLabels, i.addLabels),
        ...field(loc, T.removeLabels, i.removeLabels),
      ],
    }),
    tool: {
      name: "move_tasks_bulk",
      description:
        "Change status, due date, priority or labels on several tasks at once (up to 50, by code). Find the codes first (search_tasks, overdue_tasks, list_my_tasks); the user sees every code before anything changes.",
      permission: "task.read",
      input: z.object({
        tasks: z.array(z.string().min(2).max(80)).min(1).max(50),
        status: z.enum(STATUS).optional(),
        dueAt: isoDate.nullable().optional(),
        priority: z.enum(PRIORITY).optional(),
        addLabels: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
        removeLabels: z.array(z.string().max(40)).max(20).optional(),
      }),
      jsonSchema: {
        type: "object",
        properties: {
          tasks: { type: "array", items: { type: "string" }, description: "task codes, e.g. T-041" },
          status: { type: "string", enum: [...STATUS] },
          dueAt: str("ISO date-time, or null to clear"),
          priority: { type: "string", enum: [...PRIORITY] },
          addLabels: { type: "array", items: { type: "string" } },
          removeLabels: { type: "array", items: { type: "string" } },
        },
        required: ["tasks"],
      },
      async run(ctx, input) {
        const { tasks, ...change } = input;
        if (!Object.values(change).some((v) => v !== undefined)) throw new ToolProblem("Nothing to change was given.");
        const heads = await Promise.all([...new Set<string>(tasks)].map((x) => taskOf(ctx, x)));
        const r = await work<{ ok: string[]; failed: { id: string; error: string }[] }>(ctx, "POST", "/tasks/bulk", {
          ids: heads.map((t) => t.id),
          ...change,
          ...(change.dueAt ? { dueAt: new Date(change.dueAt).toISOString() } : {}),
        });
        const code = new Map(heads.map((t) => [t.id, t.code]));
        const failed = (r.failed ?? []).map((f) => `${code.get(f.id) ?? f.id} (${f.error})`);
        return {
          ok: true,
          content: `Changed ${r.ok?.length ?? heads.length - failed.length} of ${heads.length} tasks.${failed.length ? ` Not changed: ${failed.join(", ")}.` : ""}`,
          sources: heads.slice(0, 10).map(taskSource),
        };
      },
    },
  },
  {
    title: { en: "Link tasks", vi: "Liên kết việc" },
    preview: (i, loc) => ({
      title: L(loc, { en: "Add a dependency", vi: "Thêm phụ thuộc" }),
      fields: field(
        loc,
        T.link,
        i.task && i.other
          ? i.relation === "blocked_by"
            ? L(loc, { en: `${String(i.task)} waits on ${String(i.other)}`, vi: `${String(i.task)} chờ ${String(i.other)}` })
            : L(loc, { en: `${String(i.task)} blocks ${String(i.other)}`, vi: `${String(i.task)} chặn ${String(i.other)}` })
          : undefined,
      ),
    }),
    tool: {
      name: "link_tasks",
      description: "Add a dependency between two tasks: `blocks` (task must finish before other) or `blocked_by` (task waits on other).",
      permission: "task.read",
      input: z.object({ task: z.string().min(2).max(80), relation: z.enum(["blocks", "blocked_by"]), other: z.string().min(2).max(80) }),
      jsonSchema: {
        type: "object",
        properties: { task: str("task code"), relation: { type: "string", enum: ["blocks", "blocked_by"] }, other: str("the other task's code") },
        required: ["task", "relation", "other"],
      },
      async run(ctx, input) {
        const [a, b] = await Promise.all([taskOf(ctx, input.task), taskOf(ctx, input.other)]);
        if (a.id === b.id) throw new ToolProblem("A task cannot depend on itself.");
        const [before, after] = input.relation === "blocks" ? [a, b] : [b, a];
        await work(ctx, "POST", `/tasks/${after.id}/dependencies`, { predecessorId: before.id });
        return { ok: true, content: `${after.code} now waits on ${before.code}.`, sources: [taskSource(a), taskSource(b)] };
      },
    },
  },
  {
    title: { en: "Onboarding checklist", vi: "Danh sách onboarding" },
    preview: (i, loc) => ({
      title: L(loc, { en: `Onboarding for ${String(i.newHire ?? "")}`, vi: `Onboarding cho ${String(i.newHire ?? "")}` }),
      fields: [
        ...field(loc, T.newHire, i.newHire),
        ...field(loc, T.starts, niceTime(i.startDate, loc)),
        ...field(loc, T.manager, i.manager),
        ...field(loc, T.steps, Array.isArray(i.steps) && i.steps.length ? list(i.steps).join("\n") : ONBOARDING.map((s) => L(loc, s.title)).join("\n")),
      ],
    }),
    tool: {
      name: "onboarding_checklist",
      description:
        "Create an onboarding checklist for a new hire: a parent task owned by their manager with dated subtasks (accounts, introductions, handbook, one-to-ones, first task, 30-day review). Give `steps` to use your own list instead of the default.",
      permission: "task.create",
      input: z.object({
        newHire: z.string().min(1).max(120),
        startDate: isoDate,
        manager: z.string().max(120).optional(),
        steps: z.array(z.string().min(1).max(300)).max(30).optional(),
      }),
      jsonSchema: {
        type: "object",
        properties: {
          newHire: str("the new hire's name (a colleague if they already have an account)"),
          startDate: str("their first day, ISO date-time"),
          manager: str("their manager's name (default: the user)"),
          steps: { type: "array", items: { type: "string" }, description: "custom steps (optional)" },
        },
        required: ["newHire", "startDate"],
      },
      async run(ctx, input) {
        // Someone not in the directory yet (no account): their steps stay unassigned until they join.
        const hire = await person(ctx, input.newHire).catch((e: unknown) => {
          // Two colleagues with that name: ask, never treat it as someone without an account.
          if (e instanceof ToolProblem && e.message.startsWith("Several")) throw e;
          return null;
        });
        const manager = await person(ctx, input.manager ?? "me");
        const start = new Date(input.startDate).getTime();
        const loc: Loc = ctx.loc ?? (en(ctx) ? "en" : "vi");
        const name = hire?.displayName ?? input.newHire;
        const parent = await work<{ id: string; code: string; title: string }>(ctx, "POST", "/tasks", {
          title: L(loc, { en: `Onboarding: ${name}`, vi: `Onboarding: ${name}` }),
          assigneeId: manager.userId,
          dueAt: new Date(start + 30 * DAY).toISOString(),
        });
        const steps = input.steps?.length
          ? (input.steps as string[]).map((title, i) => ({
              title,
              who: hire ? ("hire" as const) : ("manager" as const),
              day: Math.round((i * 14) / Math.max(1, input.steps!.length - 1)),
            }))
          : ONBOARDING.map((s) => ({ title: L(loc, s.title), who: s.who, day: s.day }));
        const made: { id: string; code: string; title: string }[] = [];
        for (const s of steps)
          made.push(
            await work<{ id: string; code: string; title: string }>(ctx, "POST", "/tasks", {
              title: s.title,
              assigneeId: s.who === "hire" ? (hire?.userId ?? null) : manager.userId,
              dueAt: new Date(start + s.day * DAY).toISOString(),
              parentId: parent.id,
            }),
          );
        return {
          ok: true,
          content: `Created onboarding ${parent.code} for ${name} with ${made.length} steps${hire ? "" : ` (${name} has no account yet: their steps are unassigned)`}.`,
          sources: [taskSource(parent)],
        };
      },
    },
  },
];

const TITLES: Record<string, Say> = {
  overdue_tasks: { en: "Find late tasks", vi: "Tìm việc trễ" },
  find_duplicate_tasks: { en: "Find duplicate tasks", vi: "Tìm việc trùng" },
  task_history: { en: "Read a task's history", vi: "Xem lịch sử việc" },
  estimate_due_date: { en: "Estimate a due date", vi: "Ước lượng hạn" },
};

export { READ, TITLES, WRITE };
