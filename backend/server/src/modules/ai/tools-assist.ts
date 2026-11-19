import { z } from "zod";
import { DEFAULT_TIME_ZONE, featureDisabled } from "@workspace/shared";
import { ToolProblem, type Source, type Tool, type ToolContext } from "./tools.js";
import { en, enc, str, taskSource, work, type Say, type Write } from "./workspace-kit.js";
import { freeToday, rankTasks, slotTasks, type PlanTask, type Ranked, type Why } from "./assist-plan.js";

/**
 * Help with one's own day, for everyone rather than for managers: what to do first today, and the words
 * of an end-of-day report, a task update or a request for help. Both only read: a draft is shown in the answer and
 * sent, if the person wants, through send_message or comment_on_task, which ask first like every change.
 */

const DAY = 86_400_000;
const zone = (ctx: ToolContext) => ctx.timeZone ?? DEFAULT_TIME_ZONE;
const hm = (at: number, ctx: ToolContext) => new Date(at).toLocaleTimeString(en(ctx) ? "en-GB" : "vi-VN", { hour: "2-digit", minute: "2-digit", timeZone: zone(ctx) });
const dayKey = (at: number, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
const t = (ctx: ToolContext, e: string, v: string) => (en(ctx) ? e : v);

interface SummaryTask extends PlanTask {
  updatedAt?: string;
  completedAt?: string | null;
}
interface Summary {
  open: SummaryTask[];
  recentlyDone: SummaryTask[];
  stats: { doneToday: number; doneThisWeek: number; inProgress: number; overdue: number };
}
interface CalEvent {
  id: string;
  code?: string | null;
  title: string;
  kind: string;
  startsAt: string;
  endsAt: string;
}

const WHY: Record<Why, Say> = {
  overdue: { en: "overdue", vi: "đã trễ hạn" },
  today: { en: "due today", vi: "hạn hôm nay" },
  risk: { en: "at risk of being late", vi: "có nguy cơ trễ" },
  tomorrow: { en: "due tomorrow", vi: "hạn ngày mai" },
  urgent: { en: "urgent", vi: "khẩn" },
  high: { en: "high priority", vi: "ưu tiên cao" },
  started: { en: "already started", vi: "đang làm dở" },
  soon: { en: "due this week", vi: "hạn trong tuần" },
  open: { en: "open", vi: "đang mở" },
};
const why = (r: Ranked, ctx: ToolContext) => {
  const w = WHY[r.why][en(ctx) ? "en" : "vi"];
  return r.why === "overdue" && r.late ? `${w} ${r.late} ${t(ctx, r.late === 1 ? "day" : "days", "ngày")}` : w;
};
const taskSrc = (x: PlanTask): Source => taskSource({ id: x.id, code: x.code, title: x.title });

/** Today's meetings and events, the person's own calendar (empty when the calendar is left out of this installation). */
async function todaysEvents(ctx: ToolContext, now: number): Promise<CalEvent[] | null> {
  if (featureDisabled("calendar")) return [];
  const tz = zone(ctx);
  const day = dayKey(now, tz);
  const from = new Date(Date.parse(`${day}T00:00:00Z`) - 14 * 3600_000).toISOString();
  const to = new Date(Date.parse(`${day}T23:59:59Z`) + 14 * 3600_000).toISOString();
  const r = await work<{ events: CalEvent[] }>(ctx, "GET", `/calendar/events?from=${enc(from)}&to=${enc(to)}`).catch(() => null);
  // A wide window around the day in UTC, then only what falls on today in the workspace's zone.
  return r ? r.events.filter((e) => dayKey(Date.parse(e.startsAt), tz) === day || dayKey(Date.parse(e.endsAt), tz) === day) : null;
}

/** The person's working hours today ("09:00"–"17:30"), or null on a day off. Falls back to the usual office day. */
async function shiftToday(ctx: ToolContext, now: number): Promise<{ start: string; end: string } | null> {
  const day = dayKey(now, zone(ctx));
  const r = await ctx.services.employee
    .request<{
      workWeek: number[];
      shift: { start: string; end: string | null } | null;
      holidays: string[];
      awayDays: string[];
    }>("GET", `/availability?users=${enc(ctx.principal.id)}&from=${day}&to=${day}`, undefined, ctx.principal)
    .catch(() => null);
  if (!r) return { start: "09:00", end: "17:30" };
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  if (r.holidays.includes(day) || r.awayDays.includes(day) || (r.workWeek.length && !r.workWeek.includes(weekday))) return null;
  return { start: r.shift?.start ?? "09:00", end: r.shift?.end ?? "17:30" };
}

const PLAN: Tool<{ max?: number | undefined }> = {
  name: "plan_my_day",
  description:
    "The user's day in order: approvals waiting for them, their open tasks ranked (overdue, due today, at risk, urgent, already started), blocked tasks set apart, today's meetings and the free time between them, each top task placed in a free stretch. For 'what should I do first', 'plan my day', 'hôm nay tôi nên làm gì trước'. Present it as a short ordered plan; never change anything.",
  permission: "task.read",
  input: z.object({ max: z.number().int().min(3).max(15).optional() }),
  jsonSchema: { type: "object", properties: { max: { type: "number", description: "how many tasks to rank (default 8)" } } },
  async run(ctx, input) {
    const now = Date.now();
    const [summary, events, shift, approvals] = await Promise.all([
      work<Summary>(ctx, "GET", "/me/summary"),
      todaysEvents(ctx, now),
      shiftToday(ctx, now),
      work<{ approvals: { id: string; code: string; title: string; status: string }[] }>(ctx, "GET", "/approvals").catch(() => null),
    ]);
    const { order, blocked } = rankTasks(summary.open, now, zone(ctx));
    const top = order.slice(0, input.max ?? 8);
    const meetings = (events ?? []).map((e) => ({ start: Date.parse(e.startsAt), end: Date.parse(e.endsAt) }));
    const free = freeToday(now, zone(ctx), shift, meetings);
    const placed = slotTasks(top, free);
    const pending = (approvals?.approvals ?? []).filter((a) => a.status === "pending");
    const sources: Source[] = [];
    const parts: string[] = [];

    if (pending.length) {
      parts.push(
        `## ${t(ctx, "First: approvals waiting for you", "Trước tiên: yêu cầu chờ bạn duyệt")} (${pending.length})\n${pending
          .slice(0, 5)
          .map((a) => `- [approval ${a.code}] ${a.title}`)
          .join("\n")}`,
      );
      sources.push(...pending.slice(0, 3).map((a) => ({ type: "approval" as const, id: a.id, title: `${a.code} ${a.title}`, url: `/app/work/approvals/${a.id}` })));
    }
    if (top.length) {
      parts.push(
        `## ${t(ctx, "Tasks in order", "Thứ tự làm việc")}\n${top
          .map((r, i) => {
            const at = placed.get(r.task.id);
            const slot = at ? ` · ${t(ctx, "in the free time", "vào khoảng trống")} ${hm(at.start, ctx)}–${hm(at.end, ctx)}` : "";
            const pct = r.task.progress != null ? ` · ${r.task.progress}%` : "";
            return `${i + 1}. [task ${r.task.code}] ${r.task.title} · ${why(r, ctx)}${pct}${slot}`;
          })
          .join("\n")}`,
      );
      sources.push(...top.slice(0, 6).map((r) => taskSrc(r.task)));
    }
    if (blocked.length)
      parts.push(
        `## ${t(ctx, "Blocked: unblock or ask for help", "Đang bị chặn: gỡ vướng hoặc nhờ hỗ trợ")}\n${blocked
          .slice(0, 6)
          .map((b) => `- [task ${b.code}] ${b.title}${b.blockedReason ? ` · ${b.blockedReason.slice(0, 160)}` : ""}`)
          .join("\n")}`,
      );
    if (events === null) parts.push(t(ctx, "(The calendar could not be read just now.)", "(Chưa đọc được lịch lúc này.)"));
    else if (events.length)
      parts.push(
        `## ${t(ctx, "Today's calendar", "Lịch hôm nay")}\n${events
          .slice(0, 12)
          .map((e) => `- [${e.kind === "meeting" ? "meeting" : "event"} ${e.id}] ${hm(Date.parse(e.startsAt), ctx)}–${hm(Date.parse(e.endsAt), ctx)} ${e.title}`)
          .join("\n")}`,
      );
    parts.push(
      shift === null
        ? t(ctx, "Today is not a working day for the user.", "Hôm nay không phải ngày làm việc của người dùng.")
        : free.length
          ? `## ${t(ctx, "Free time left today", "Thời gian trống còn lại hôm nay")}\n${free.map((f) => `- ${hm(f.start, ctx)}–${hm(f.end, ctx)} (${Math.round((f.end - f.start) / 60_000)} ${t(ctx, "min", "phút")})`).join("\n")}`
          : t(ctx, "No free stretch of 30 minutes or more is left today.", "Hôm nay không còn khoảng trống nào từ 30 phút trở lên."),
    );
    parts.push(
      t(
        ctx,
        `Done today: ${summary.stats.doneToday}. Done this week: ${summary.stats.doneThisWeek}. Overdue in total: ${summary.stats.overdue}.`,
        `Đã xong hôm nay: ${summary.stats.doneToday}. Xong trong tuần: ${summary.stats.doneThisWeek}. Tổng số việc trễ hạn: ${summary.stats.overdue}.`,
      ),
    );
    if (!top.length && !blocked.length && !pending.length)
      return {
        ok: true,
        content: t(ctx, "Nothing is open for the user today: no tasks, no approvals waiting.", "Hôm nay người dùng không có việc mở nào, không có yêu cầu chờ duyệt."),
        sources,
      };
    return { ok: true, content: parts.join("\n\n"), sources };
  },
};

const KINDS = ["end_of_day", "task_update", "help_request"] as const;

interface TaskDetail {
  task: {
    id: string;
    code: string;
    title: string;
    status: string;
    dueAt: string | null;
    blockedReason?: string | null;
    progress?: number | null;
    etaAt?: string | null;
    assigneeId: string | null;
    ownerId?: string;
  };
  comments: { authorId: string; body: string; createdAt?: string }[];
  subtasks: { code: string; title: string; status: string }[];
}

const STATUS: Record<string, Say> = {
  todo: { en: "to do", vi: "chưa bắt đầu" },
  in_progress: { en: "in progress", vi: "đang làm" },
  review: { en: "in review", vi: "chờ duyệt" },
  blocked: { en: "blocked", vi: "bị chặn" },
  done: { en: "done", vi: "xong" },
  cancelled: { en: "cancelled", vi: "đã huỷ" },
};
const status = (s: string, ctx: ToolContext) => STATUS[s]?.[en(ctx) ? "en" : "vi"] ?? s;
const date = (iso: string, ctx: ToolContext) => new Date(iso).toLocaleDateString(en(ctx) ? "en-GB" : "vi-VN", { day: "2-digit", month: "2-digit", timeZone: zone(ctx) });

const DRAFT: Tool<{ kind: (typeof KINDS)[number]; task?: string | undefined; note?: string | undefined }> = {
  name: "draft_update",
  description:
    "Drafts written from the user's own work, to send themselves: `end_of_day` (what they finished and worked on today, what is next, what blocks them), `task_update` (a progress update on one task: status, % done, expected finish, what changed), `help_request` (a message asking for help on a blocked or late task). Returns the facts and a draft. Show the draft in the answer, polished but with the same facts; send it only if the user asks (send_message or comment_on_task, which ask first).",
  permission: "task.read",
  input: z.object({ kind: z.enum(KINDS), task: z.string().min(2).max(64).optional(), note: z.string().max(500).optional() }),
  jsonSchema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: [...KINDS] },
      task: str("task code for task_update or help_request, e.g. T-041"),
      note: str("what the user added in their own words (optional)"),
    },
    required: ["kind"],
  },
  async run(ctx, input) {
    if (input.kind === "end_of_day") return endOfDay(ctx, input.note);
    if (!input.task) throw new ToolProblem("Which task? Give its code (e.g. T-041), or ask the user.");
    const d = await work<TaskDetail>(ctx, "GET", `/tasks/${enc(input.task.trim())}`);
    const x = d.task;
    // A reason marks a task blocked whatever its status says.
    const st = status(x.blockedReason && x.status !== "done" && x.status !== "cancelled" ? "blocked" : x.status, ctx);
    const src = [taskSource(x)];
    const open = d.subtasks.filter((s) => s.status !== "done" && s.status !== "cancelled");
    const lastWords = d.comments.slice(-3).map((c) => `> ${c.body.replace(/\s+/g, " ").slice(0, 240)}`);
    const facts = [
      `[task ${x.code}] ${x.title} · ${st}${x.dueAt ? ` · ${t(ctx, "due", "hạn")} ${date(x.dueAt, ctx)}` : ""}${x.progress != null ? ` · ${x.progress}%` : ""}${x.etaAt ? ` · ${t(ctx, "expected", "dự kiến xong")} ${date(x.etaAt, ctx)}` : ""}`,
      x.blockedReason ? `${t(ctx, "Blocked", "Bị chặn")}: ${x.blockedReason}` : "",
      d.subtasks.length ? `${t(ctx, "Subtasks", "Việc con")}: ${d.subtasks.length - open.length}/${d.subtasks.length} ${t(ctx, "done", "xong")}` : "",
      ...lastWords,
    ].filter(Boolean);
    const draft =
      input.kind === "task_update"
        ? [
            `**${x.code} ${x.title}** · ${st}${x.progress != null ? ` · ${x.progress}%` : ""}`,
            `- ${t(ctx, "Done so far", "Đã làm")}: ${input.note ?? (d.subtasks.length ? `${d.subtasks.length - open.length}/${d.subtasks.length} ${t(ctx, "subtasks", "việc con")}` : "…")}`,
            `- ${t(ctx, "Next", "Tiếp theo")}: ${open[0] ? `${open[0].code} ${open[0].title}` : "…"}`,
            `- ${t(ctx, "Expected finish", "Dự kiến xong")}: ${x.etaAt ? date(x.etaAt, ctx) : x.dueAt ? date(x.dueAt, ctx) : "…"}`,
            ...(x.blockedReason ? [`- ${t(ctx, "Blocked by", "Đang vướng")}: ${x.blockedReason}`] : []),
          ].join("\n")
        : [
            t(ctx, `I need help with ${x.code} ${x.title}.`, `Mình cần hỗ trợ với ${x.code} ${x.title}.`),
            x.blockedReason
              ? t(ctx, `It is blocked: ${x.blockedReason}.`, `Việc đang bị chặn: ${x.blockedReason}.`)
              : input.note
                ? input.note
                : t(ctx, "Where I am stuck: …", "Chỗ mình đang vướng: …"),
            x.dueAt ? t(ctx, `It is due ${date(x.dueAt, ctx)}.`, `Hạn là ${date(x.dueAt, ctx)}.`) : "",
            t(ctx, "Could you take a look, or tell me who can?", "Bạn xem giúp mình, hoặc chỉ mình nên hỏi ai được không?"),
          ]
            .filter(Boolean)
            .join(" ");
    return { ok: true, content: `${t(ctx, "Facts", "Dữ liệu")}:\n${facts.join("\n")}\n\n${t(ctx, "Draft", "Bản nháp")}:\n${draft}`, sources: src };
  },
};

async function endOfDay(ctx: ToolContext, note?: string) {
  const now = Date.now();
  const tz = zone(ctx);
  const today = dayKey(now, tz);
  const tomorrow = dayKey(now + DAY, tz);
  const s = await work<Summary>(ctx, "GET", "/me/summary");
  const on = (iso: string | null | undefined, day: string) => !!iso && dayKey(Date.parse(iso), tz) === day;
  const done = s.recentlyDone.filter((x) => on(x.completedAt, today));
  const touched = s.open.filter((x) => on(x.updatedAt, today));
  const blocked = s.open.filter((x) => x.status === "blocked" || x.blockedReason);
  // Tomorrow's first three, ranked as tomorrow morning will see them.
  const next = rankTasks(s.open, now + DAY, tz).order.slice(0, 3);
  const dueTomorrow = s.open.filter((x) => on(x.dueAt, tomorrow));
  const line = (x: PlanTask, extra = "") => `- ${x.code} ${x.title}${extra}`;
  const draft = [
    `**${t(ctx, "End of day", "Báo cáo cuối ngày")} ${new Date(now).toLocaleDateString(en(ctx) ? "en-GB" : "vi-VN", { day: "2-digit", month: "2-digit", timeZone: tz })}**`,
    `${t(ctx, "Done", "Đã xong")} (${done.length}):`,
    ...(done.length ? done.map((x) => line(x)) : [`- ${t(ctx, "nothing finished today", "hôm nay chưa xong việc nào")}`]),
    `${t(ctx, "Worked on", "Đang làm")}:`,
    ...(touched.length ? touched.slice(0, 6).map((x) => line(x, x.progress != null ? ` · ${x.progress}%` : "")) : [`- …`]),
    `${t(ctx, "Tomorrow", "Ngày mai")}:`,
    ...(next.length ? next.map((r) => line(r.task)) : [`- …`]),
    ...(blocked.length ? [`${t(ctx, "Blocked", "Vướng mắc")}:`, ...blocked.slice(0, 4).map((x) => line(x, x.blockedReason ? ` · ${x.blockedReason.slice(0, 120)}` : ""))] : []),
    ...(note ? [note] : []),
  ].join("\n");
  const facts = t(
    ctx,
    `Finished today: ${done.length}. Changed today: ${touched.length}. Due tomorrow: ${dueTomorrow.length}. Blocked: ${blocked.length}. Overdue: ${s.stats.overdue}.`,
    `Xong hôm nay: ${done.length}. Cập nhật hôm nay: ${touched.length}. Hạn ngày mai: ${dueTomorrow.length}. Bị chặn: ${blocked.length}. Trễ hạn: ${s.stats.overdue}.`,
  );
  return {
    ok: true,
    content: `${facts}\n\n${t(ctx, "Draft", "Bản nháp")}:\n${draft}`,
    sources: [...done, ...touched].slice(0, 6).map(taskSrc),
  };
}

export const READ: Tool[] = [PLAN, DRAFT];
export const WRITE: Write[] = [];
export const TITLES: Record<string, Say> = {
  plan_my_day: { en: "Plan my day", vi: "Lên kế hoạch ngày" },
  draft_update: { en: "Draft an update", vi: "Soạn bản cập nhật" },
};
