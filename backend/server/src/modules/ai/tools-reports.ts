import { z } from "zod";
import { aiOutputTable, departmentTable, flowChart, overdueChart, spendCharts, workloadChart } from "./tool-blocks.js";
import { deptMatches } from "./ground.js";
import {
  aiVsOutput,
  compareDepartments,
  topicBreakdown,
  weeklyMarkdown,
  workloadBalance,
  type AiProfile,
  type DepartmentRow,
  type OutputRow,
  type OversightPerson,
  type ReportPerson,
} from "./report-math.js";
import type { ModelSpend } from "./spend-models.js";
import { ToolProblem, type Source, type Tool, type ToolContext } from "./tools.js";
import { en, enc, field, fold, L, matchNames, person, str, work, type Say, type Write } from "./workspace-kit.js";

/**
 * The owner's report tools: one person's week, departments side by side, a weekly report written as a
 * page, who carries too much, what is blocked and on what, a trend over weeks, and AI use beside output, what staff
 * ask AI about, what AI costs and where AI could help more. Every read goes through the owning module as the asker,
 * which applies its own rule (a manager sees their reporting line, a company-wide viewer everyone), so a tool here
 * never shows more than the matching page in the app.
 */

const T = (ctx: ToolContext, english: string, vietnamese: string) => (en(ctx) ? english : vietnamese);
const dm = (iso: string | null | undefined) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : "");
const signed = (n: number | null) => (n === null ? "–" : `${n > 0 ? "+" : ""}${n}%`);
const personSource = (userId: string, name: string): Source => ({ type: "employee", id: userId, title: name, url: `/app/work/people/${userId}` });

interface TeamTask {
  id: string;
  code: string;
  title: string;
  status: string;
  dueAt: string | null;
  overdue?: boolean;
  atRisk?: boolean;
  stale?: boolean;
  progress?: number | null;
  etaAt?: string | null;
  blockedReason?: string | null;
}
interface TeamRow {
  userId: string;
  displayName: string;
  title?: string | null;
  department?: string | null;
  open: number;
  inProgress: number;
  overdue: number;
  atRisk: number;
  stale: number;
  blocked: number;
  done7: number;
  done28: number;
  doneWeeks: number[];
  onTimeRate: number | null;
  avgProgress: number | null;
  lastActivityAt: string | null;
  now: TeamTask[];
  late: TeamTask[];
  doneRecently: { id: string; code: string; title: string }[];
  tasks: TeamTask[];
}
interface Team {
  scope: "reports" | "everyone" | "none";
  people: TeamRow[];
  departments: DepartmentRow[];
}
const team = (ctx: ToolContext) => work<Team>(ctx, "GET", "/followup/team");

/** The people a report is about: one person, one department, or everyone the asker follows. */
async function subject(ctx: ToolContext, who: string | undefined): Promise<{ label: string; people: TeamRow[]; scope: Team["scope"] }> {
  const r = await team(ctx);
  if (!who || ["team", "company", "everyone", "all", "đội", "công ty", "tất cả"].includes(who.trim().toLowerCase()))
    return { label: r.scope === "everyone" ? T(ctx, "the company", "toàn công ty") : T(ctx, "my team", "đội của tôi"), people: r.people, scope: r.scope };
  const q = fold(who);
  // A department by its whole name, then a person, then looser department words ("sales"): loose matching first
  // would read "An" as "Ban giám đốc".
  const exactDept = r.people.filter((x) => x.department && fold(x.department) === q);
  if (exactDept.length) return { label: exactDept[0]!.department!, people: exactDept, scope: r.scope };
  const named = matchNames(r.people, who);
  if (named.length === 1) return { label: named[0]!.displayName, people: named, scope: r.scope };
  const dept = q.length >= 3 ? r.people.filter((x) => x.department && deptMatches(x.department, who)) : [];
  if (dept.length) return { label: dept[0]!.department!, people: dept, scope: r.scope };
  if (named.length > 1) throw new ToolProblem(`Several people match "${who}": ${named.map((x) => x.displayName).join(", ")}. Ask the user which one.`);
  throw new ToolProblem(`"${who}" is neither a person nor a department among the people the user follows.`);
}

/**
 * The /velocity and /reports/overdue-trend scope for what the user named, most exact first: a department by its
 * whole name, a person by their whole name, then looser department words ("sales" for "Kinh doanh"), a project code,
 * and last a person by part of their name. Loose department matching alone would read "An" as "Ban giám đốc".
 */
async function flowScope(ctx: ToolContext, of: string | undefined): Promise<{ scope: string; label: string }> {
  const v = (of ?? "").trim();
  if (!v || ["company", "workspace", "công ty", "toàn công ty"].includes(v.toLowerCase())) return { scope: "workspace", label: T(ctx, "the company", "toàn công ty") };
  if (/^project:/i.test(v)) {
    const code = v.replace(/^project:/i, "");
    return { scope: `project:${code}`, label: code };
  }
  const [depts, people] = await Promise.all([
    ctx.services.employee.request<{ departments: { id: string; name: string }[] }>("GET", "/departments", undefined, ctx.principal).catch(() => ({ departments: [] })),
    ctx.services.employee
      .request<{ employees: { userId: string; displayName: string }[] }>("GET", "/employees?all=1", undefined, ctx.principal)
      .catch(() => ({ employees: [] as { userId: string; displayName: string }[] })),
  ]);
  const q = fold(v);
  const dept = (d: { id: string; name: string }) => ({ scope: `department:${d.id}`, label: d.name });
  const exactDept = depts.departments.find((x) => fold(x.name) === q);
  if (exactDept) return dept(exactDept);
  const exactPeople = people.employees.filter((x) => fold(x.displayName) === q);
  if (exactPeople.length === 1) return { scope: `person:${exactPeople[0]!.userId}`, label: exactPeople[0]!.displayName };
  if (!["me", "myself", "i", "tôi", "mình"].includes(v.toLowerCase()) && v.length >= 3) {
    const loose = depts.departments.find((x) => deptMatches(x.name, v));
    if (loose) return dept(loose);
  }
  if (/^[A-Z][A-Z0-9]{0,9}$/.test(v)) return { scope: `project:${v}`, label: v };
  const p = await person(ctx, v);
  return { scope: `person:${p.userId}`, label: p.displayName };
}

interface Profiles {
  totals: { people: number; using: number; uses: number; prevUses: number; outsidePrompts: number; costUsd: number; companyTokens: number; unpricedTokens: number };
  departments: { name: string | null; people: number; using: number; uses: number; tokens: number; costUsd: number }[];
  features: { feature: string; calls: number; tokens: number; costUsd: number; people: number }[];
  people: (AiProfile & { costUsd: number; tokens: number; topics: { key: string; count: number }[] })[];
}
const AI_DAYS = z.union([z.literal(7), z.literal(30), z.literal(90)]).default(30);
const aiDaysSchema = { type: "integer", enum: [7, 30, 90], description: "window in days (default 30)" };
function aiClient(ctx: ToolContext) {
  if (!ctx.services.ai) throw new ToolProblem("AI usage data is not available on this server.");
  return ctx.services.ai;
}
/** A refused AI read (not a manager or admin) as plain words for the model. */
const aiRead = <R>(ctx: ToolContext, path: string) =>
  aiClient(ctx)
    .request<R>("GET", path, undefined, ctx.principal)
    .catch((e: { status?: number }) => {
      if (e?.status === 403) throw new ToolProblem("Only managers (for their reporting line) and AI admins can see this.");
      throw e;
    });

const usd = (n: number) => `$${n < 10 ? n.toFixed(2) : Math.round(n).toLocaleString("en-US")}`;

async function weeklyReportText(ctx: ToolContext, of: string | undefined) {
  const s = await subject(ctx, of);
  const day = new Date().toLocaleDateString("en-CA", { timeZone: ctx.timeZone ?? "UTC" });
  const r = weeklyMarkdown(s.label, s.people as ReportPerson[], en(ctx) ? "en" : "vi", day);
  return { ...r, people: s.people };
}

export const READ: Tool[] = [
  {
    name: "person_progress",
    description:
      "One person's progress: done in the last 7 and 28 days (per week), what they are on now with % and expected finish, what is overdue or blocked, on-time rate, last activity, and the flow over recent weeks. Only people the user may follow (their reporting line, their own department as numbers, everyone for company-wide viewers). Use for 'how is Lan doing this week', 'what did Minh get done'.",
    permission: "task.read",
    input: z.object({ person: z.string().min(1).max(120) }),
    jsonSchema: { type: "object", properties: { person: str("the person's name ('me' for the user)") }, required: ["person"] },
    async run(ctx, input) {
      const who = await person(ctx, input.person);
      const [r, v] = await Promise.all([
        work<{ access: string; profile: { displayName: string; title: string | null; department: string | null }; person: TeamRow | null }>(
          ctx,
          "GET",
          `/people/${enc(who.userId)}`,
        ),
        work<{ weeks: { week: string; done: number; added: number; cycleDays: number | null }[] }>(ctx, "GET", `/velocity?scope=${enc(`person:${who.userId}`)}&weeks=4`).catch(
          () => null,
        ),
      ]);
      const x = r.person;
      const head = `[${T(ctx, "person", "người")} ${r.profile.displayName}${r.profile.title ? `, ${r.profile.title}` : ""}${r.profile.department ? `, ${r.profile.department}` : ""}]`;
      if (!x) return { ok: true, content: `${head} ${T(ctx, "No tasks assigned.", "Chưa được giao việc nào.")}`, sources: [personSource(who.userId, r.profile.displayName)] };
      const lines = [
        `${head} ${T(
          ctx,
          `${x.done7} done in 7 days, ${x.done28} in 28 (per week, oldest first: ${(x.doneWeeks ?? []).join(", ")}); ${x.open} open (${x.inProgress} in progress), ${x.overdue} overdue, ${x.atRisk ?? 0} at risk, ${x.blocked} blocked, ${x.stale} without an update for 3+ days; on time ${x.onTimeRate ?? "–"}%; average progress ${x.avgProgress ?? "–"}%; last active ${dm(x.lastActivityAt) || "never"}.`,
          `xong ${x.done7} việc trong 7 ngày, ${x.done28} trong 28 ngày (theo tuần, cũ trước: ${(x.doneWeeks ?? []).join(", ")}); ${x.open} việc mở (${x.inProgress} đang làm), ${x.overdue} trễ hạn, ${x.atRisk ?? 0} có nguy cơ trễ, ${x.blocked} bị chặn, ${x.stale} lâu chưa cập nhật; đúng hạn ${x.onTimeRate ?? "–"}%; tiến độ trung bình ${x.avgProgress ?? "–"}%; hoạt động gần nhất ${dm(x.lastActivityAt) || "chưa có"}.`,
        )}`,
      ];
      if (r.access === "colleague")
        lines.push(
          T(
            ctx,
            "(Numbers only: this person is a department colleague, not in the user's reporting line.)",
            "(Chỉ có số liệu: người này cùng phòng, không thuộc tuyến quản lý của người hỏi.)",
          ),
        );
      const task = (t: TeamTask) =>
        `${t.code} ${t.title}${t.dueAt ? ` (${T(ctx, "due", "hạn")} ${dm(t.dueAt)})` : ""}${t.progress != null ? ` ${t.progress}%` : ""}${t.etaAt ? `, ${T(ctx, "expected", "dự kiến")} ${dm(t.etaAt)}` : ""}${t.blockedReason ? `, ${T(ctx, "blocked", "bị chặn")}: ${t.blockedReason}` : ""}`;
      if (x.now?.length) lines.push(`[${T(ctx, "in progress", "đang làm")}] ${x.now.map(task).join("; ")}`);
      if (x.late?.length) lines.push(`[${T(ctx, "overdue", "trễ hạn")}] ${x.late.map(task).join("; ")}`);
      const blocked = (x.tasks ?? []).filter((t) => t.blockedReason && t.status !== "done");
      if (blocked.length) lines.push(`[${T(ctx, "blocked", "bị chặn")}] ${blocked.slice(0, 5).map(task).join("; ")}`);
      if (x.doneRecently?.length) lines.push(`[${T(ctx, "done recently", "vừa xong")}] ${x.doneRecently.map((t) => `${t.code} ${t.title}`).join("; ")}`);
      if (v?.weeks.length)
        lines.push(
          `[${T(ctx, "flow by week", "theo tuần")}] ${v.weeks.map((w) => `${w.week.slice(5)}: ${T(ctx, "done", "xong")} ${w.done}, ${T(ctx, "added", "thêm")} ${w.added}${w.cycleDays != null ? `, ${w.cycleDays}d` : ""}`).join(" · ")}`,
        );
      const flow = v ? flowChart({ vi: !en(ctx), id: `flow-${who.userId}`, of: r.profile.displayName }, v.weeks) : null;
      return { ok: true, content: lines.join("\n"), sources: [personSource(who.userId, r.profile.displayName)], ...(flow ? { blocks: [flow] } : {}) };
    },
  },
  {
    name: "department_compare",
    description:
      "Departments side by side over the last 1–4 weeks: people, tasks done and done per person, open, overdue and the late share, blocked, on-time rate (28 days) and health. Over the departments of the people the user follows (everyone for company-wide viewers). Use for 'which department is behind', 'compare Sales and Marketing'.",
    permission: "task.read",
    input: z.object({ weeks: z.number().int().min(1).max(4).default(1), departments: z.array(z.string().max(80)).max(10).optional() }),
    jsonSchema: {
      type: "object",
      properties: {
        weeks: { type: "integer", minimum: 1, maximum: 4, description: "period in weeks (default 1)" },
        departments: { type: "array", items: { type: "string" }, description: "only these departments (optional)" },
      },
    },
    async run(ctx, input) {
      const r = await team(ctx);
      if (r.scope === "none") return { ok: true, content: T(ctx, "[departments] Nobody reports to the user.", "[phòng ban] Không có ai báo cáo cho người hỏi."), sources: [] };
      let rows = compareDepartments(r.departments, input.weeks);
      if (input.departments?.length) rows = rows.filter((d) => d.name && input.departments!.some((a: string) => deptMatches(d.name!, a)));
      if (!rows.length)
        return {
          ok: true,
          content: T(ctx, "[departments] No such departments among the people the user follows.", "[phòng ban] Không có phòng ban này trong những người bạn theo dõi."),
          sources: [],
        };
      const none = T(ctx, "(no department)", "(chưa có phòng ban)");
      return {
        ok: true,
        content: [
          T(
            ctx,
            `[departments, last ${input.weeks} week(s)] name | people | done | done/person | open | overdue (share) | blocked | on time | health`,
            `[phòng ban, ${input.weeks} tuần qua] tên | người | xong | xong/người | mở | trễ (tỷ lệ) | bị chặn | đúng hạn | tình trạng`,
          ),
          ...rows.map(
            (d) =>
              `${d.name ?? none} | ${d.people} | ${d.done} | ${d.donePerPerson} | ${d.open} | ${d.overdue} (${d.overdueShare}%) | ${d.blocked} | ${d.onTimeRate ?? "–"}% | ${d.health}`,
          ),
        ].join("\n"),
        sources: [],
        blocks: [departmentTable({ vi: !en(ctx), weeks: input.weeks }, rows)].filter((b) => b !== null),
      };
    },
  },
  {
    name: "weekly_report_text",
    description:
      "Write the weekly progress report as text (totals, who needs attention, per person what got done, what is in hand, what is late) for a person, a department or the whole team/company. Use when the user wants the report in the answer, or when Docs is not available.",
    permission: "task.read",
    input: z.object({ of: z.string().max(120).optional() }),
    jsonSchema: { type: "object", properties: { of: str("a person, a department, or 'team'/'company' (default: everyone the user follows)") } },
    async run(ctx, input) {
      const r = await weeklyReportText(ctx, input.of);
      return { ok: true, content: `# ${r.title}\n\n${r.markdown}`, sources: r.people.slice(0, 10).map((x) => personSource(x.userId, x.displayName)) };
    },
  },
  {
    name: "workload_balance",
    description:
      "Who carries too much and who has room: per person open tasks, due in the next 7 days, overdue and blocked, rated overloaded / busy / normal / has room against the team's median. Use before assigning work, or for 'who is overloaded', 'who can take this'.",
    permission: "task.read",
    input: z.object({ department: z.string().max(80).optional() }),
    jsonSchema: { type: "object", properties: { department: str("only this department (optional)") } },
    async run(ctx, input) {
      const r = await team(ctx);
      if (r.scope === "none") return { ok: true, content: T(ctx, "[workload] Nobody reports to the user.", "[khối lượng] Không có ai báo cáo cho người hỏi."), sources: [] };
      const people = input.department ? r.people.filter((x) => x.department && deptMatches(x.department, input.department!)) : r.people;
      const b = workloadBalance(people, Date.now());
      const word: Record<string, string> = en(ctx)
        ? { overloaded: "OVERLOADED", busy: "busy", normal: "normal", room: "has room" }
        : { overloaded: "QUÁ TẢI", busy: "bận", normal: "bình thường", room: "còn trống" };
      return {
        ok: true,
        content: [
          T(
            ctx,
            `[workload] ${b.people.length} people, median ${b.median} open tasks each. name | open | due in 7 days | overdue | blocked | load`,
            `[khối lượng] ${b.people.length} người, trung vị ${b.median} việc mở mỗi người. tên | mở | hạn trong 7 ngày | trễ | bị chặn | mức tải`,
          ),
          ...b.people
            .slice(0, 50)
            .map((x) => `${x.displayName}${x.department ? ` (${x.department})` : ""} | ${x.open} | ${x.dueSoon} | ${x.overdue} | ${x.blocked} | ${word[x.load]}`),
        ].join("\n"),
        sources: b.people
          .filter((x) => x.load === "overloaded")
          .slice(0, 8)
          .map((x) => personSource(x.userId, x.displayName)),
        blocks: [workloadChart({ vi: !en(ctx) }, b.people)].filter((x) => x !== null),
      };
    },
  },
  {
    name: "blockers_report",
    description:
      "What is blocked and on what: open tasks with a blocked reason or waiting on an unfinished task, longest blocked first, each with how long, who has it, the chain of tasks it waits on and how many tasks wait on it in turn. Optional person or department narrows to their tasks. Use for 'what is stuck', 'what blocks the launch'.",
    permission: "task.read",
    input: z.object({ person: z.string().max(120).optional(), department: z.string().max(80).optional() }),
    jsonSchema: { type: "object", properties: { person: str("only this person's tasks (optional)"), department: str("only this department's tasks (optional)") } },
    async run(ctx, input) {
      type Head = { id: string; code: string; title: string; status: string; assigneeId: string | null };
      const [r, dir] = await Promise.all([
        work<{ tasks: (Head & { dueAt: string | null; reason: string | null; since: string; waitingOn: Head[]; holdsUp: number })[]; total: number }>(
          ctx,
          "GET",
          "/reports/blockers",
        ),
        ctx.services.employee
          .request<{ employees: { userId: string; displayName: string; department?: string | null }[] }>("GET", "/employees?all=1", undefined, ctx.principal)
          .catch(() => ({ employees: [] })),
      ]);
      const by = new Map(dir.employees.map((e) => [e.userId, e]));
      let tasks = r.tasks;
      if (input.person) {
        const p = await person(ctx, input.person);
        tasks = tasks.filter((t) => t.assigneeId === p.userId);
      }
      if (input.department) tasks = tasks.filter((t) => t.assigneeId && by.get(t.assigneeId)?.department && deptMatches(by.get(t.assigneeId)!.department!, input.department!));
      if (!tasks.length) return { ok: true, content: T(ctx, "[blockers] Nothing is blocked.", "[bị chặn] Không có việc nào bị chặn."), sources: [] };
      const days = (iso: string) => Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 86400_000));
      const who = (id: string | null) => (id ? (by.get(id)?.displayName ?? "?") : T(ctx, "unassigned", "chưa giao"));
      return {
        ok: true,
        content: [
          T(ctx, `[blockers] ${tasks.length} blocked task(s), longest first.`, `[bị chặn] ${tasks.length} việc bị chặn, lâu nhất trước.`),
          ...tasks
            .slice(0, 30)
            .map(
              (t) =>
                `${t.code} ${t.title} → ${who(t.assigneeId)}: ${T(ctx, `blocked ${days(t.since)} days`, `bị chặn ${days(t.since)} ngày`)}${t.reason ? ` (${t.reason})` : ""}${t.dueAt ? `, ${T(ctx, "due", "hạn")} ${dm(t.dueAt)}` : ""}${t.waitingOn.length ? `; ${T(ctx, "waits on", "chờ")} ${t.waitingOn.map((w) => `${w.code} (${who(w.assigneeId)}, ${w.status})`).join(" ← ")}` : ""}${t.holdsUp ? `; ${T(ctx, `holds up ${t.holdsUp} task(s)`, `đang giữ chân ${t.holdsUp} việc`)}` : ""}`,
            ),
        ].join("\n"),
        sources: tasks.slice(0, 10).map((t) => ({ type: "task" as const, id: t.id, title: `${t.code} ${t.title}`, url: `/app/work/tasks/${t.code || t.id}` })),
      };
    },
  },
  {
    name: "trend_metric",
    description:
      "A weekly series for N weeks (default 8): tasks done, tasks added, median cycle time (days from start to done) and tasks overdue at the end of each week, for a person, a department, a project (by code) or the whole company. Use for 'are we getting faster', 'trend of overdue work in Sales'. The answer can be drawn as a chart.",
    permission: "task.read",
    input: z.object({ of: z.string().max(120).optional(), weeks: z.number().int().min(2).max(26).default(8) }),
    jsonSchema: {
      type: "object",
      properties: {
        of: str("a person, a department, a project code, or 'company' (default)"),
        weeks: { type: "integer", minimum: 2, maximum: 26, description: "how many weeks (default 8)" },
      },
    },
    async run(ctx, input) {
      const s = await flowScope(ctx, input.of);
      const [v, o] = await Promise.all([
        work<{ weeks: { week: string; done: number; added: number; cycleDays: number | null }[] }>(ctx, "GET", `/velocity?scope=${enc(s.scope)}&weeks=${input.weeks}`).catch(
          (e: { status?: number }) => {
            // Company-wide figures are for company-wide viewers; anyone else asks about themselves, a department or a project.
            if (e?.status === 403 || e?.status === 404)
              throw new ToolProblem(`The user may not see the trend of ${s.label}. Ask about a person ('me'), their department, or a project instead.`);
            throw e;
          },
        ),
        work<{ weeks: { week: string; overdue: number }[] }>(ctx, "GET", `/reports/overdue-trend?scope=${enc(s.scope)}&weeks=${input.weeks}`).catch(() => null),
      ]);
      const late = new Map((o?.weeks ?? []).map((w) => [w.week, w.overdue]));
      return {
        ok: true,
        content: [
          T(
            ctx,
            `[trend ${s.label}, ${input.weeks} weeks] week (Monday) | done | added | median cycle days | overdue at week end`,
            `[xu hướng ${s.label}, ${input.weeks} tuần] tuần (thứ Hai) | xong | thêm | số ngày làm (trung vị) | trễ hạn cuối tuần`,
          ),
          ...v.weeks.map((w) => `${w.week} | ${w.done} | ${w.added} | ${w.cycleDays ?? "–"} | ${late.get(w.week) ?? "–"}`),
        ].join("\n"),
        sources: [],
        blocks: [
          flowChart({ vi: !en(ctx), id: `flow-${s.scope}`, of: s.label }, v.weeks),
          o ? overdueChart({ vi: !en(ctx), id: `overdue-${s.scope}`, of: s.label }, o.weeks) : null,
        ].filter((x) => x !== null),
      };
    },
  },
  {
    name: "ai_usage_vs_output",
    description:
      "AI use beside getting work done, per person: uses of AI (the company AI and ChatGPT/Claude/Gemini/Copilot through the extension) and tasks done in the window, each with the change against the window before, on-time rate, and regular AI users compared with the others as groups. A comparison, not proof that AI caused it. Managers see their reporting line, AI admins everyone.",
    permission: "task.read",
    feature: "ai",
    input: z.object({ days: AI_DAYS }),
    jsonSchema: { type: "object", properties: { days: aiDaysSchema } },
    async run(ctx, input) {
      const [p, o] = await Promise.all([
        aiRead<Profiles>(ctx, `/adoption/people?days=${input.days}`),
        work<{ people: OutputRow[] }>(ctx, "GET", `/reports/output?days=${input.days}`),
      ]);
      const r = aiVsOutput(p.people, o.people);
      const g = (x: typeof r.regular) =>
        T(
          ctx,
          `${x.people} people, ${x.done} tasks done (${signed(x.change)} vs the ${input.days} days before)`,
          `${x.people} người, xong ${x.done} việc (${signed(x.change)} so với ${input.days} ngày trước)`,
        );
      return {
        ok: true,
        content: [
          T(
            ctx,
            `[AI and output, ${input.days} days] Regular AI users: ${g(r.regular)}. Others: ${g(r.others)}.`,
            `[AI và kết quả, ${input.days} ngày] Người dùng AI thường xuyên: ${g(r.regular)}. Những người khác: ${g(r.others)}.`,
          ),
          T(ctx, "name | AI uses (change) | tasks done (change) | on time", "tên | lượt dùng AI (thay đổi) | việc xong (thay đổi) | đúng hạn"),
          ...r.people
            .slice(0, 40)
            .map(
              (x) =>
                `${x.displayName}${x.department ? ` (${x.department})` : ""} | ${x.uses} (${signed(x.usesChange)}) | ${x.done} (${signed(x.doneChange)}) | ${x.onTimeRate ?? "–"}%`,
            ),
        ].join("\n"),
        sources: [],
        blocks: [aiOutputTable({ vi: !en(ctx), days: input.days }, r.people)].filter((x) => x !== null),
      };
    },
  },
  {
    name: "prompt_topics",
    description:
      "What staff ask AI about, by topic (code, writing, analysis, translation, the company's own topics…): prompts per topic, how many people, how many went to outside assistants (ChatGPT, Claude, Gemini, Copilot), and the departments asking most. Never the prompts' text. Managers see their reporting line, AI admins everyone. Optional department narrows it.",
    permission: "task.read",
    feature: "ai",
    input: z.object({ days: AI_DAYS, department: z.string().max(80).optional() }),
    jsonSchema: { type: "object", properties: { days: aiDaysSchema, department: str("only this department (optional)") } },
    async run(ctx, input) {
      const [o, labels] = await Promise.all([
        aiRead<{ people: OversightPerson[] }>(ctx, `/oversight?days=${input.days}`),
        aiRead<{ topics: { key: string; labelVi: string; labelEn: string }[] }>(ctx, "/insights/topics").catch(() => ({ topics: [] })),
      ]);
      const people = input.department ? o.people.filter((x) => x.department && deptMatches(x.department, input.department!)) : o.people;
      const name = new Map(labels.topics.map((t) => [t.key, en(ctx) ? t.labelEn || t.labelVi : t.labelVi || t.labelEn]));
      const rows = topicBreakdown(people);
      if (!rows.length)
        return { ok: true, content: T(ctx, `[AI topics, ${input.days} days] No AI use recorded.`, `[chủ đề AI, ${input.days} ngày] Chưa ghi nhận lượt dùng AI nào.`), sources: [] };
      return {
        ok: true,
        content: [
          T(
            ctx,
            `[AI topics, ${input.days} days] topic | prompts | people | to outside assistants | departments asking most`,
            `[chủ đề AI, ${input.days} ngày] chủ đề | câu hỏi | người | gửi công cụ bên ngoài | phòng ban hỏi nhiều nhất`,
          ),
          ...rows
            .slice(0, 20)
            .map((t) => `${name.get(t.topic) ?? t.topic} | ${t.prompts} | ${t.people} | ${t.outside} | ${t.departments.map((d) => `${d.name} ${d.prompts}`).join(", ") || "–"}`),
        ].join("\n"),
        sources: [],
      };
    },
  },
  {
    name: "ai_spend",
    description:
      "What the company's own AI cost in the window: total, by department, by person (top spenders) and by model, with tokens; plus what the app's AI features used. Prices are the company's (Admin › AI) or public list prices; tokens of an unpriced model are counted, never shown as free. Managers see their reporting line, AI admins everyone.",
    permission: "task.read",
    feature: "ai",
    input: z.object({ days: AI_DAYS }),
    jsonSchema: { type: "object", properties: { days: aiDaysSchema } },
    async run(ctx, input) {
      const [p, m] = await Promise.all([
        aiRead<Profiles>(ctx, `/adoption/people?days=${input.days}`),
        aiRead<{ models: ModelSpend[] }>(ctx, `/spend/models?days=${input.days}`).catch(() => ({ models: [] as ModelSpend[] })),
      ]);
      const t = p.totals;
      const none = T(ctx, "(no department)", "(chưa có phòng ban)");
      const spenders = p.people.filter((x) => x.costUsd > 0 || x.tokens > 0).sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens);
      return {
        ok: true,
        content: [
          T(
            ctx,
            `[AI spend, ${input.days} days] ${usd(t.costUsd)} for ${t.companyTokens.toLocaleString("en-US")} tokens of the company AI${t.unpricedTokens ? ` (${t.unpricedTokens.toLocaleString("en-US")} tokens of models with no price)` : ""}; ${t.outsidePrompts} prompts on outside assistants are not billed here.`,
            `[chi phí AI, ${input.days} ngày] ${usd(t.costUsd)} cho ${t.companyTokens.toLocaleString("en-US")} token AI của công ty${t.unpricedTokens ? ` (${t.unpricedTokens.toLocaleString("en-US")} token của model chưa có giá)` : ""}; ${t.outsidePrompts} câu hỏi trên công cụ bên ngoài không tính ở đây.`,
          ),
          `[${T(ctx, "by department", "theo phòng ban")}] ${p.departments.map((d) => `${d.name ?? none} ${usd(d.costUsd)} (${d.tokens.toLocaleString("en-US")} tok)`).join("; ") || "–"}`,
          `[${T(ctx, "by person", "theo người")}] ${
            spenders
              .slice(0, 10)
              .map((x) => `${x.displayName} ${usd(x.costUsd)}`)
              .join("; ") || "–"
          }`,
          `[${T(ctx, "by model", "theo model")}] ${
            m.models
              .slice(0, 10)
              .map(
                (x) =>
                  `${x.model} ${x.costUsd === null ? T(ctx, "no price", "chưa có giá") : usd(x.costUsd)} (${x.tokens.toLocaleString("en-US")} tok, ${x.people} ${T(ctx, "people", "người")})`,
              )
              .join("; ") || "–"
          }`,
          `[${T(ctx, "by app feature", "theo tính năng")}] ${
            p.features
              .slice(0, 8)
              .map((f) => `${f.feature} ${usd(f.costUsd)} (${f.calls})`)
              .join("; ") || "–"
          }`,
        ].join("\n"),
        sources: [],
        blocks: spendCharts({ vi: !en(ctx) }, p.departments, m.models),
      };
    },
  },
  {
    name: "suggest_ai_adoption",
    description:
      "Where AI could help more: kinds of work the team does a lot (from task titles) where few of the people doing it use AI, with example tasks, who does that work, colleagues who use AI for it and say it helps (mentors), and the people who stopped or never started using AI. Managers see their reporting line, AI admins everyone; anyone else gets their own.",
    permission: "task.read",
    feature: "ai",
    input: z.object({ days: AI_DAYS }),
    jsonSchema: { type: "object", properties: { days: aiDaysSchema } },
    async run(ctx, input) {
      type S = {
        scope: string;
        suggestions: {
          topic: string;
          tasks: number;
          examples: string[];
          people: { displayName: string; tasks: number; usesAi: boolean }[];
          departments: string[];
          coverage: number;
          helpful: number | null;
          mentors: { displayName: string }[];
        }[];
      };
      const [s, p] = await Promise.all([
        aiRead<S>(ctx, `/adoption/suggestions?days=${input.days}`),
        aiRead<Profiles>(ctx, `/adoption/people?days=${input.days}`).catch(() => null),
      ]);
      const lines = s.suggestions.map(
        (x) =>
          `[${x.topic}] ${T(ctx, `${x.tasks} tasks, ${Math.round(x.coverage * 100)}% of the people doing them use AI`, `${x.tasks} việc, ${Math.round(x.coverage * 100)}% người làm có dùng AI`)}${x.helpful != null ? T(ctx, `, rated helpful ${Math.round(x.helpful * 100)}%`, `, đánh giá hữu ích ${Math.round(x.helpful * 100)}%`) : ""}; ${T(ctx, "e.g.", "ví dụ")} ${x.examples.join("; ") || "–"}; ${T(ctx, "who", "ai làm")}: ${
            x.people
              .filter((y) => !y.usesAi)
              .slice(0, 5)
              .map((y) => y.displayName)
              .join(", ") || "–"
          }${x.departments.length ? ` (${x.departments.join(", ")})` : ""}${x.mentors.length ? `; ${T(ctx, "mentors", "người hướng dẫn")}: ${x.mentors.map((m) => m.displayName).join(", ")}` : ""}`,
      );
      const lapsed = p?.people.filter((x) => x.pattern === "lapsed").map((x) => x.displayName) ?? [];
      const never = p?.people.filter((x) => x.pattern === "none").map((x) => x.displayName) ?? [];
      return {
        ok: true,
        content:
          [
            ...lines,
            lapsed.length ? `[${T(ctx, "stopped using AI", "đã ngừng dùng AI")}] ${lapsed.slice(0, 20).join(", ")}` : "",
            never.length ? `[${T(ctx, "not using AI", "chưa dùng AI")}] ${never.slice(0, 20).join(", ")}` : "",
          ]
            .filter(Boolean)
            .join("\n") ||
          T(ctx, "[AI adoption] Nothing stands out: AI is used for most kinds of work here.", "[áp dụng AI] Chưa thấy chỗ nào nổi bật: AI đã được dùng cho phần lớn công việc."),
        sources: [],
      };
    },
  },
];

const REPORT_ON: Say = { en: "Report on", vi: "Báo cáo về" };
const PAGE_TITLE: Say = { en: "Page", vi: "Trang" };

export const WRITE: Write[] = [
  {
    title: { en: "Write the weekly report", vi: "Viết báo cáo tuần" },
    preview: (i, loc) => ({
      title: L(loc, { en: "Create the weekly report as a page", vi: "Tạo báo cáo tuần thành một trang" }),
      fields: [...field(loc, REPORT_ON, i.of || L(loc, { en: "everyone you follow", vi: "mọi người bạn theo dõi" })), ...field(loc, PAGE_TITLE, i.title)],
      note: L(loc, { en: "The page starts private to you.", vi: "Trang chỉ mình bạn xem cho đến khi bạn chia sẻ." }),
    }),
    tool: {
      name: "weekly_report",
      description:
        "Create this week's progress report as a page in Docs (private to the user): totals, who needs attention, per person done, in hand and late, for a person, a department or everyone the user follows. Only when the user asks for the report as a page; otherwise weekly_report_text.",
      permission: "document.create",
      feature: "docs",
      input: z.object({ of: z.string().max(120).optional(), title: z.string().max(200).optional() }),
      jsonSchema: {
        type: "object",
        properties: { of: str("a person, a department, or 'team'/'company' (default: everyone the user follows)"), title: str("the page title (optional)") },
      },
      async run(ctx, input) {
        const r = await weeklyReportText(ctx, input.of);
        const title = input.title?.trim() || r.title;
        const d = await work<{ id: string }>(ctx, "POST", "/docs", { title, content: r.markdown, projectId: null, format: "markdown" });
        return {
          ok: true,
          content: T(ctx, `Created the page "${title}".`, `Đã tạo trang "${title}".`),
          sources: [{ type: "document", id: d.id, title, url: `/app/work/docs/${d.id}` }],
        };
      },
    },
  },
];

export const TITLES: Record<string, Say> = {
  person_progress: { en: "Read a person's progress", vi: "Xem tiến độ một người" },
  department_compare: { en: "Compare departments", vi: "So sánh phòng ban" },
  weekly_report_text: { en: "Write the weekly report", vi: "Viết báo cáo tuần" },
  workload_balance: { en: "Check workload", vi: "Xem khối lượng việc" },
  blockers_report: { en: "Find what is blocked", vi: "Tìm việc bị chặn" },
  trend_metric: { en: "Read the trend", vi: "Xem xu hướng" },
  ai_usage_vs_output: { en: "Compare AI use and output", vi: "So sánh dùng AI và kết quả" },
  prompt_topics: { en: "Read AI topics", vi: "Xem chủ đề hỏi AI" },
  ai_spend: { en: "Read AI spend", vi: "Xem chi phí AI" },
  suggest_ai_adoption: { en: "Suggest where AI helps", vi: "Gợi ý áp dụng AI" },
};
