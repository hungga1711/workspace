import { z } from "zod";
import { attendanceTable } from "./tool-blocks.js";
import { dayKey, DEFAULT_TIME_ZONE } from "@workspace/shared";
import { ServiceCallError } from "@workspace/service-kit";
import { ToolProblem, type Source, type Tool, type ToolContext } from "./tools.js";
import { destination, en, enc, F, field, fold, isoDate, L, niceTime, person, str, type Person, type Say, type Write } from "./workspace-kit.js";
import { dayIn, directReports, freeSlots, managerChain, tops, treeLines, zonedInstant, type OrgPerson } from "./people-plan.js";

/**
 * People tools: when a group can meet, asking for leave, attendance over a period, the reporting tree,
 * and reminders. Calendar tools belong to the `calendar` feature and leave/attendance to `time`, so an installation
 * without them never offers them (DISABLED_FEATURES).
 *
 * Privacy as the screens: a meeting slot is computed from the group's merged busy time and away days, never showing
 * whose calendar or leave blocks it; attendance is scoped by the employee module (self, reporting line, or company).
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const day = z.string().regex(DAY, "YYYY-MM-DD");
const zone = (ctx: ToolContext) => ctx.timeZone ?? DEFAULT_TIME_ZONE;
const ddmm = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const employee = <T>(ctx: ToolContext, method: string, path: string, body?: unknown) => ctx.services.employee.request<T>(method, path, body, ctx.principal);
const personSource = (p: { userId: string; displayName: string }): Source => ({ type: "employee", id: p.userId, title: p.displayName, url: `/app/me/people?u=${p.userId}` });

/** A day ("2026-11-18") as the start or end of that day in the workspace zone; a date-time as written. */
function instant(v: string, ctx: ToolContext, end: boolean): number {
  return DAY.test(v) ? zonedInstant(v, end ? "23:59" : "00:00", zone(ctx)) : Date.parse(v);
}

function clock(ms: number, ctx: ToolContext, withDay: boolean): string {
  return new Date(ms).toLocaleString(en(ctx) ? "en-GB" : "vi-VN", {
    ...(withDay ? { weekday: "short", day: "2-digit", month: "2-digit" } : {}),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: zone(ctx),
  });
}

const directory = async (ctx: ToolContext) => (await employee<{ employees: (OrgPerson & { email?: string | null })[] }>(ctx, "GET", "/employees?all=1")).employees;

const READ: Tool[] = [
  {
    name: "find_meeting_slot",
    feature: "calendar",
    description:
      "Find times when the user and the given colleagues are all free for a meeting: working days and hours of the company, skipping everyone's meetings, holidays and days anyone is on leave. Default range: now to 7 days ahead. Then schedule_event can book the chosen time.",
    permission: "calendar.read",
    input: z.object({
      people: z.array(z.string().min(1).max(120)).min(1).max(20),
      durationMinutes: z.number().int().min(15).max(480).default(30),
      from: z.string().max(40).optional(),
      to: z.string().max(40).optional(),
      earliest: z.string().regex(HM).optional(),
      latest: z.string().regex(HM).optional(),
    }),
    jsonSchema: {
      type: "object",
      properties: {
        people: { type: "array", items: { type: "string" }, description: "colleagues' names (the user is always included)" },
        durationMinutes: { type: "number", description: "length of the meeting in minutes (default 30)" },
        from: str("start of the range: YYYY-MM-DD or ISO date-time (default now)"),
        to: str("end of the range: YYYY-MM-DD or ISO date-time (default 7 days after the start)"),
        earliest: str("no earlier than this local time each day, HH:MM (default the company's shift start)"),
        latest: str("no later than this local time each day, HH:MM (default the company's shift end)"),
      },
      required: ["people"],
    },
    async run(ctx, input) {
      const found: Person[] = [];
      for (const who of input.people) {
        const p = await person(ctx, who);
        if (!found.some((x) => x.userId === p.userId)) found.push(p);
      }
      const ids = [...new Set([ctx.principal.id, ...found.map((p) => p.userId)])];
      const tz = zone(ctx);
      const now = Date.now();
      const from = input.from ? instant(input.from, ctx, false) : now;
      const to = input.to ? instant(input.to, ctx, true) : from + 7 * 86400_000;
      if (Number.isNaN(from) || Number.isNaN(to) || to <= from) throw new ToolProblem("The range is not valid: give from before to, as YYYY-MM-DD or an ISO date-time.");
      if (to - from > 62 * 86400_000) throw new ToolProblem("Look at most 62 days ahead at a time.");
      if (to <= now) throw new ToolProblem("That range is already over. Ask for a time from now on.");
      const users = ids.map(enc).join(",");
      const [cal, busy] = await Promise.all([
        employee<{ workWeek: number[]; shift: { start: string; end: string | null } | null; holidays: string[]; awayDays: string[] }>(
          ctx,
          "GET",
          `/availability?users=${users}&from=${dayIn(from, tz)}&to=${dayIn(to, tz)}`,
        ),
        ctx.services.work.request<{ busy: { start: string; end: string }[] }>(
          "GET",
          `/calendar/busy?users=${users}&from=${enc(new Date(from).toISOString())}&to=${enc(new Date(to).toISOString())}`,
          undefined,
          ctx.principal,
        ),
      ]);
      const dayStart = input.earliest ?? cal.shift?.start ?? "09:00";
      const dayEnd = input.latest ?? cal.shift?.end ?? "17:30";
      if (dayEnd <= dayStart) throw new ToolProblem("The latest time must be after the earliest.");
      const slots = freeSlots({
        from,
        to,
        tz,
        now,
        durationMin: input.durationMinutes,
        workWeek: cal.workWeek,
        dayStart,
        dayEnd,
        closedDays: new Set([...cal.holidays, ...cal.awayDays]),
        busy: busy.busy.map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) })),
      });
      const who = found.filter((p) => p.userId !== ctx.principal.id).map((p) => p.displayName);
      const away = cal.awayDays.length;
      const E = en(ctx);
      const head = E
        ? `Free for you${who.length ? ` and ${who.join(", ")}` : ""}, ${input.durationMinutes} min, working hours ${dayStart}–${dayEnd}:`
        : `Giờ trống chung của bạn${who.length ? ` và ${who.join(", ")}` : ""}, ${input.durationMinutes} phút, trong giờ làm ${dayStart}–${dayEnd}:`;
      const lines = slots.map((s) => {
        const start = clock(s.start, ctx, true);
        const end = clock(s.start + input.durationMinutes * 60_000, ctx, false);
        const until = s.end - s.start > input.durationMinutes * 60_000 ? (E ? ` (free until ${clock(s.end, ctx, false)})` : ` (trống tới ${clock(s.end, ctx, false)})`) : "";
        return `- ${start}–${end}${until} [${new Date(s.start).toISOString()}]`;
      });
      const note = away ? (E ? `\n${away} day(s) in the range are left out because someone is on leave.` : `\n${away} ngày trong khoảng này bị bỏ qua vì có người nghỉ phép.`) : "";
      return {
        ok: true,
        content: slots.length
          ? `${head}\n${lines.join("\n")}${note}\n(The ISO time in brackets is for schedule_event.)`
          : `${E ? "No common free time in that range. Try a longer range, a shorter meeting, or fewer people." : "Không có giờ trống chung trong khoảng này. Thử khoảng dài hơn, họp ngắn hơn hoặc ít người hơn."}${note}`,
        sources: [],
      };
    },
  },
  {
    name: "attendance_summary",
    feature: "time",
    description:
      "Attendance over a period: per person days in, late days and minutes, hours worked, missed check-outs, leave days and absences (working days with no check-in and no leave). The user sees themselves; a manager their reporting line; HR the whole company. Filter by department or person. Default: this month so far.",
    permission: "attendance.read",
    input: z.object({ from: day.optional(), to: day.optional(), department: z.string().max(120).optional(), person: z.string().max(120).optional() }),
    jsonSchema: {
      type: "object",
      properties: {
        from: str("first day, YYYY-MM-DD (default the 1st of this month)"),
        to: str("last day, YYYY-MM-DD (default today)"),
        department: str("department name (optional)"),
        person: str("one colleague's name, or 'me' (optional)"),
      },
    },
    async run(ctx, input) {
      const today = dayKey(new Date(), zone(ctx));
      const from = input.from ?? `${today.slice(0, 8)}01`;
      const to = input.to ?? today;
      const who = input.person ? await person(ctx, input.person) : null;
      const q = `from=${from}&to=${to}${input.department ? `&department=${enc(input.department)}` : ""}${who ? `&userId=${enc(who.userId)}` : ""}`;
      const r = await employee<{
        scope: "company" | "team" | "self";
        workingDays: number;
        people: {
          userId: string;
          displayName: string;
          department: string | null;
          presentDays: number;
          lateDays: number;
          lateMinutes: number;
          hours: number;
          missedCheckouts: number;
          leaveDays: number;
          absentDays: number;
          absentOn: string[];
        }[];
      }>(ctx, "GET", `/attendance/summary?${q}`);
      const E = en(ctx);
      if (!r.people.length) return { ok: true, content: E ? "No attendance you may see matches." : "Không có dữ liệu chấm công bạn được xem khớp với yêu cầu.", sources: [] };
      // Nobody checked in at all: the company does not keep attendance here (or not yet), so "absent every day" for
      // everyone would be false. Say that instead of a list of absences.
      if (r.people.every((p) => p.presentDays === 0 && p.leaveDays === 0 && p.hours === 0))
        return {
          ok: true,
          content: E
            ? `No check-ins recorded ${ddmm(from)}–${ddmm(to)} for the ${r.people.length} people you may see: attendance does not seem to be kept in the app for this period, so absences cannot be told.`
            : `Không có lượt chấm công nào từ ${ddmm(from)}–${ddmm(to)} cho ${r.people.length} người bạn được xem: có vẻ công ty chưa chấm công trên ứng dụng trong khoảng này, nên không xác định được ngày vắng.`,
          sources: [],
        };
      // Most attention first: absences, then late days.
      const rows = [...r.people].sort((a, b) => b.absentDays - a.absentDays || b.lateDays - a.lateDays || a.displayName.localeCompare(b.displayName));
      const shown = rows.slice(0, 40);
      const line = (p: (typeof rows)[number]) =>
        E
          ? `- ${p.displayName}${p.department ? ` (${p.department})` : ""}: in ${p.presentDays} day(s), ${p.hours} h, late ${p.lateDays}× (${p.lateMinutes} min), leave ${p.leaveDays}, absent ${p.absentDays}${p.absentDays ? ` (${p.absentOn.slice(0, 5).map(ddmm).join(", ")})` : ""}${p.missedCheckouts ? `, ${p.missedCheckouts} missed check-out(s)` : ""}`
          : `- ${p.displayName}${p.department ? ` (${p.department})` : ""}: đi làm ${p.presentDays} ngày, ${p.hours} giờ, đi muộn ${p.lateDays} lần (${p.lateMinutes} phút), nghỉ phép ${p.leaveDays}, vắng ${p.absentDays}${p.absentDays ? ` (${p.absentOn.slice(0, 5).map(ddmm).join(", ")})` : ""}${p.missedCheckouts ? `, quên chấm ra ${p.missedCheckouts} lần` : ""}`;
      const sum = (k: "lateDays" | "absentDays") => rows.reduce((n, p) => n + p[k], 0);
      const head = E
        ? `Attendance ${ddmm(from)}–${ddmm(to)} (${r.workingDays} working days, ${r.scope === "company" ? "whole company" : r.scope === "team" ? "your team" : "you"}): ${rows.length} people, ${sum("lateDays")} late days, ${sum("absentDays")} absences.`
        : `Chấm công ${ddmm(from)}–${ddmm(to)} (${r.workingDays} ngày làm việc, ${r.scope === "company" ? "toàn công ty" : r.scope === "team" ? "nhóm của bạn" : "của bạn"}): ${rows.length} người, ${sum("lateDays")} lượt đi muộn, ${sum("absentDays")} ngày vắng.`;
      return {
        ok: true,
        content: [
          head,
          ...shown.map(line),
          ...(rows.length > shown.length ? [E ? `… and ${rows.length - shown.length} more` : `… và ${rows.length - shown.length} người nữa`] : []),
        ].join("\n"),
        sources: shown.slice(0, 6).map(personSource),
        blocks: [attendanceTable({ vi: !E, period: `${ddmm(from)}–${ddmm(to)}` }, shown)].filter((x) => x !== null),
      };
    },
  },
  {
    name: "org_chart",
    description: "The reporting tree: under one person, or of a department, or the whole company from the top. Shows names, titles and departments, a few levels deep.",
    permission: "employee.profile.read",
    input: z.object({ person: z.string().max(120).optional(), department: z.string().max(120).optional(), depth: z.number().int().min(1).max(8).default(4) }),
    jsonSchema: {
      type: "object",
      properties: {
        person: str("show the tree under this colleague (optional)"),
        department: str("show this department (optional)"),
        depth: { type: "number", description: "levels to show (default 4)" },
      },
    },
    async run(ctx, input) {
      const people = await directory(ctx);
      const E = en(ctx);
      let roots: OrgPerson[];
      let title: string;
      if (input.person) {
        const p = await person(ctx, input.person);
        const me = people.find((x) => x.userId === p.userId);
        if (!me) throw new ToolProblem(`${p.displayName} is not in the active directory.`);
        roots = [me];
        title = E ? `Reporting tree under ${me.displayName}:` : `Sơ đồ dưới ${me.displayName}:`;
      } else if (input.department) {
        const q = fold(input.department);
        const names = [...new Set(people.map((p) => p.department).filter((d): d is string => !!d))];
        const exact = names.filter((d) => fold(d) === q);
        const hits = exact.length ? exact : names.filter((d) => fold(d).includes(q));
        if (hits.length !== 1)
          throw new ToolProblem(
            hits.length
              ? `Several departments match "${input.department}": ${hits.join(", ")}. Ask which one.`
              : `No department matches "${input.department}". Departments: ${names.join(", ")}.`,
          );
        const inDept = people.filter((p) => p.department === hits[0]);
        const ids = new Set(inDept.map((p) => p.userId));
        // Inside the department, the tree starts at whoever has no manager in it.
        roots = inDept.filter((p) => !p.managerId || !ids.has(p.managerId)).sort((a, b) => a.displayName.localeCompare(b.displayName));
        const depts = await employee<{ departments: { name: string; headId: string | null }[] }>(ctx, "GET", "/departments").catch(() => ({ departments: [] }));
        const head = people.find((p) => p.userId === depts.departments.find((d) => d.name === hits[0])?.headId);
        title = E
          ? `${hits[0]} (${inDept.length} people${head ? `, head: ${head.displayName}` : ""}):`
          : `${hits[0]} (${inDept.length} người${head ? `, trưởng phòng: ${head.displayName}` : ""}):`;
        return { ok: true, content: [title, ...treeLines(inDept, roots, input.depth)].join("\n"), sources: head ? [personSource(head)] : [] };
      } else {
        roots = tops(people);
        title = E ? `Company reporting tree (${people.length} people):` : `Sơ đồ tổ chức công ty (${people.length} người):`;
      }
      return { ok: true, content: [title, ...treeLines(people, roots, input.depth)].join("\n"), sources: roots.slice(0, 3).map(personSource) };
    },
  },
  {
    name: "who_reports_to",
    description: "A person's manager chain up to the top of the company and their direct reports. Default: the user.",
    permission: "employee.profile.read",
    input: z.object({ person: z.string().max(120).optional() }),
    jsonSchema: { type: "object", properties: { person: str("a colleague's name (default the user)") } },
    async run(ctx, input) {
      const people = await directory(ctx);
      const p = await person(ctx, input.person ?? "me");
      const me = people.find((x) => x.userId === p.userId);
      if (!me) throw new ToolProblem(`${p.displayName} is not in the active directory.`);
      const chain = managerChain(people, me.userId);
      const reports = directReports(people, me.userId);
      const E = en(ctx);
      const name = (x: OrgPerson) => `${x.displayName}${x.title ? ` (${x.title})` : ""}`;
      const lines = [
        `${name(me)}${me.department ? (E ? `, ${me.department}` : `, ${me.department}`) : ""}`,
        chain.length
          ? `${E ? "Reports to" : "Báo cáo cho"}: ${chain.map(name).join(" → ")}`
          : E
            ? "Reports to nobody (top of the company)."
            : "Không báo cáo cho ai (cấp cao nhất).",
        reports.length
          ? `${E ? `Direct reports (${reports.length})` : `Cấp dưới trực tiếp (${reports.length})`}: ${reports.map(name).join(", ")}`
          : E
            ? "No direct reports."
            : "Không có cấp dưới trực tiếp.",
      ];
      return { ok: true, content: lines.join("\n"), sources: [personSource(me), ...chain.slice(0, 1).map(personSource)] };
    },
  },
];

const P = {
  from: { en: "From", vi: "Từ ngày" },
  to: { en: "To", vi: "Đến ngày" },
  halfDay: { en: "Half day", vi: "Nửa ngày" },
  left: { en: "Left after (estimate)", vi: "Còn lại sau đơn (ước tính)" },
  when: { en: "When", vi: "Lúc" },
  link: { en: "Opens", vi: "Mở" },
} satisfies Record<string, Say>;

const WRITE: Write[] = [
  {
    title: { en: "Request leave", vi: "Xin nghỉ phép" },
    preview: (i, loc) => ({
      title: L(loc, { en: "Request leave", vi: "Gửi đơn xin nghỉ" }),
      fields: [
        ...field(loc, F.kind, i.type ?? "annual"),
        ...field(loc, P.from, i.startDate),
        ...field(loc, P.to, i.endDate),
        ...field(loc, P.halfDay, i.halfDay ? L(loc, { en: "yes", vi: "có" }) : undefined),
        ...field(loc, F.details, i.reason),
        ...field(loc, P.left, i.balanceAfter !== undefined ? `${String(i.balanceAfter)} ${L(loc, { en: "days", vi: "ngày" })}` : undefined),
      ],
      note: L(loc, {
        en: "Goes to your manager for approval. Weekends and holidays are not counted.",
        vi: "Đơn được gửi tới quản lý của bạn để duyệt. Cuối tuần và ngày lễ không bị tính.",
      }),
    }),
    tool: {
      name: "request_leave",
      feature: "time",
      description:
        "Send a leave request for the user to their manager (the normal approval flow). `type` is a leave type code or name (annual, sick, unpaid…; default annual). Call my_leave_balance first and pass `balanceAfter` (days of that type left after this request) so the user sees it on the card.",
      permission: "leave.request",
      input: z.object({
        type: z.string().max(60).default("annual"),
        startDate: day,
        endDate: day,
        reason: z.string().max(1000).default(""),
        halfDay: z.boolean().default(false),
        balanceAfter: z.number().min(-365).max(365).optional(),
      }),
      jsonSchema: {
        type: "object",
        properties: {
          type: str("leave type code or name (default annual)"),
          startDate: str("first day off, YYYY-MM-DD"),
          endDate: str("last day off, YYYY-MM-DD"),
          reason: str("why (optional)"),
          halfDay: { type: "boolean", description: "half a day (start and end the same day)" },
          balanceAfter: { type: "number", description: "days of this type left after the request, from my_leave_balance" },
        },
        required: ["startDate", "endDate"],
      },
      async run(ctx, input) {
        const types = (await employee<{ types: { code: string; nameVi: string; nameEn: string; active: boolean }[] }>(ctx, "GET", "/leave/types")).types.filter((t) => t.active);
        const q = fold(input.type);
        const type = types.find((t) => [t.code, t.nameEn, t.nameVi].some((n) => fold(n) === q)) ?? types.find((t) => [t.nameEn, t.nameVi].some((n) => fold(n).includes(q)));
        if (!type) throw new ToolProblem(`No leave type "${input.type}". Types: ${types.map((t) => `${t.code} (${t.nameEn})`).join(", ")}.`);
        let r: { id: string; days: number };
        try {
          r = await employee<{ id: string; days: number }>(ctx, "POST", "/leave", {
            type: type.code,
            startDate: input.startDate,
            endDate: input.endDate,
            reason: input.reason,
            halfDay: input.halfDay,
          });
        } catch (e) {
          if (e instanceof ServiceCallError && (e.status === 409 || e.status === 400)) {
            const b = (e.body ?? {}) as { error?: string; available?: number; requested?: number; message?: string };
            if (b.error === "insufficient_balance") throw new ToolProblem(`Not enough ${type.nameEn} left: ${b.available ?? 0} day(s) available, ${b.requested} requested.`);
            if (b.error === "overlapping_request") throw new ToolProblem("The user already has a leave request for some of those days.");
            if (b.error === "no_working_days") throw new ToolProblem("Those dates are all weekends or holidays: nothing to request.");
            if (b.error === "no_approver") throw new ToolProblem("Nobody is set to approve the user's leave. An admin must set their manager first.");
          }
          throw e;
        }
        const me = await employee<{ leaveBalances: { type: string; entitled: number; used: number; pending: number }[] }>(ctx, "GET", "/me").catch(() => null);
        const bal = me?.leaveBalances.find((b) => b.type === type.code);
        const E = en(ctx);
        const left = bal ? bal.entitled - bal.used - bal.pending : null;
        return {
          ok: true,
          content: E
            ? `Leave request sent: ${type.nameEn}, ${ddmm(input.startDate)}–${ddmm(input.endDate)}, ${r.days} working day(s), waiting for approval.${left !== null ? ` ${left} day(s) of ${type.nameEn} left once it is approved.` : ""}`
            : `Đã gửi đơn: ${type.nameVi}, ${ddmm(input.startDate)}–${ddmm(input.endDate)}, ${r.days} ngày công, đang chờ duyệt.${left !== null ? ` Còn ${left} ngày ${type.nameVi.toLowerCase()} khi đơn được duyệt.` : ""}`,
          sources: [{ type: "employee", id: ctx.principal.id, title: E ? "My leave" : "Nghỉ phép của tôi", url: "/app/me?tab=leave" }],
        };
      },
    },
  },
  {
    title: { en: "Set a reminder", vi: "Đặt lời nhắc" },
    preview: (i, loc) => {
      const self = !i.person || ["me", "myself", "i", "tôi", "mình"].includes(String(i.person).trim().toLowerCase());
      return {
        title: L(loc, self ? { en: "Remind me", vi: "Nhắc tôi" } : { en: `Remind ${String(i.person)}`, vi: `Nhắc ${String(i.person)}` }),
        fields: [...field(loc, P.when, niceTime(i.at, loc)), ...field(loc, F.message, i.message), ...(self ? field(loc, P.link, i.link) : [])],
        ...(self ? {} : { note: L(loc, { en: "Sent as a direct message from you at that time.", vi: "Được gửi thành tin nhắn riêng từ bạn vào lúc đó." }) }),
      };
    },
    tool: {
      name: "schedule_reminder",
      description:
        "Remind the user (a notice in their inbox and a push) or a colleague (a direct message from the user, sent at that time) at a date-time within the next year. `link` (only for the user's own reminder) is a page in the app such as /app/work/tasks/T-041.",
      permission: "home.read",
      input: z.object({
        at: isoDate,
        message: z.string().trim().min(1).max(300),
        person: z.string().max(120).optional(),
        link: z
          .string()
          .max(500)
          .regex(/^\/app\/\S*$/)
          .optional(),
      }),
      jsonSchema: {
        type: "object",
        properties: {
          at: str("when, ISO date-time with offset"),
          message: str("what to remind about, short"),
          person: str("a colleague's name to remind instead of the user (optional)"),
          link: str("a page in the app to open, starting /app/ (optional)"),
        },
        required: ["at", "message"],
      },
      async run(ctx, input) {
        const at = Date.parse(input.at);
        if (at < Date.now() + 30_000 || at > Date.now() + 366 * 86400_000) throw new ToolProblem("Pick a time from now to a year ahead.");
        const E = en(ctx);
        const self = !input.person || (await person(ctx, input.person)).userId === ctx.principal.id;
        if (self) {
          if (!ctx.services.home) throw new ToolProblem("Reminders are not available here.");
          await ctx.services.home.request("POST", "/reminders", { at: input.at, title: input.message, url: input.link ?? "/app/" }, ctx.principal);
          return { ok: true, content: E ? `Reminder set for ${clock(at, ctx, true)}: ${input.message}` : `Đã đặt nhắc lúc ${clock(at, ctx, true)}: ${input.message}`, sources: [] };
        }
        const to = await destination(ctx, input.person!);
        await ctx.services.chat.request("POST", `/channels/${enc(to.id)}/scheduled`, { body: input.message, at: input.at }, ctx.principal);
        return {
          ok: true,
          content: E
            ? `${to.label} will get this message at ${clock(at, ctx, true)}: ${input.message}`
            : `${to.label} sẽ nhận tin nhắn này lúc ${clock(at, ctx, true)}: ${input.message}`,
          sources: [],
        };
      },
    },
  },
];

const TITLES: Record<string, Say> = {
  find_meeting_slot: { en: "Find a meeting time", vi: "Tìm giờ họp" },
  attendance_summary: { en: "Read attendance", vi: "Xem chấm công" },
  org_chart: { en: "Read the org chart", vi: "Xem sơ đồ tổ chức" },
  who_reports_to: { en: "Read the reporting line", vi: "Xem cấp quản lý" },
};

export { READ, TITLES, WRITE };
