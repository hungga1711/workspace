import type { Loc } from "./locale.js";
import type { AnswerBlock } from "./answer-blocks.js";
import type { Coverage, Trace } from "./progress.js";
import { afterCall, cachedRead } from "./tool-cache.js";
import { deptMatches } from "./ground.js";
import type { Pool } from "pg";
import { z } from "zod";
import { authorize, dayKey, featureDisabled, type DeployFeature, DEFAULT_TIME_ZONE, newId, withTransaction, recordAudit, type Principal } from "@workspace/shared";
import { logger, ServiceCallError, type ServiceClient } from "@workspace/service-kit";

/**
 * Tool execution:
 *   User → Identity → Authorization → AI → Tool → Authorization AGAIN → Data
 * 1. The executor checks the tool's permission against the EFFECTIVE principal
 *    (asker, or agent ∩ asker) before running anything.
 * 2. The tool calls the owning module AS that principal, and the module
 *    authorizes again with its own rules (scope, membership).
 * Model output can only choose among registered tools with schema-validated
 * input; it can never widen the principal. Every call is audited.
 */
export interface ToolContext {
  principal: Principal; // effective principal
  agentId: string | null;
  services: { chat: ServiceClient; work: ServiceClient; employee: ServiceClient; ai?: ServiceClient; home?: ServiceClient; identity?: ServiceClient };
  /** The workspace's IANA zone, for dates written into tool results. */
  timeZone?: string;
  /**
   * The language of the answer. Results are written in it because the offline model shows them as they are; a hosted
   * model reads either. Vietnamese when unset.
   */
  lang?: "en" | "vi";
  /** The answer's own language (Chinese and Spanish answers read English tool results). */
  loc?: Loc;
  /** The answer this call belongs to: each call is shown as it happens and counted for its notes (progress.ts). */
  progress?: Trace;
  /** Files attached to the question (Office files and tables keep their bytes), for the Office tools. */
  files?: AttachedFile[];
  /** A file the asker attached earlier in Hỏi đáp, newest first, by name (the Office tools after a confirm card). */
  storedFile?: (name: string) => Promise<AttachedFile[]>;
}

export interface AttachedFile {
  name: string;
  contentType: string;
  data: Buffer;
}

export interface Source {
  /** "web": a page outside the workspace (the AI's web tools read or cited it); its id and url are the address. */
  type: "message" | "task" | "document" | "project" | "employee" | "meeting" | "event" | "file" | "approval" | "workflow" | "channel" | "web";
  id: string;
  title: string;
  url: string;
}

export interface ToolResult {
  ok: boolean;
  content: string;
  sources: Source[];
  /** A chart or table of the same rows, drawn under the answer (answer-blocks.ts); the model never sees it. */
  blocks?: AnswerBlock[];
  /** What the result leaves out, said under the answer (progress.ts): a short period, a partial view, a cut list. */
  coverage?: Coverage[];
}

export interface Tool<I = any> {
  name: string;
  description: string;
  permission: string;
  input: z.ZodType<I>;
  jsonSchema: Record<string, unknown>;
  /** The deploy-time feature it belongs to (DISABLED_FEATURES): left out of the tool list when that is off. */
  feature?: DeployFeature;
  run(ctx: ToolContext, input: I): Promise<ToolResult>;
}

const str = (d: string) => ({ type: "string", description: d });
/** Case- and accent-insensitive, for matching a name the user typed ("lan" finds "Nguyễn Thị Lan"). */
const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .trim();

interface TaskLine {
  id: string;
  code: string;
  title: string;
  status: string;
  dueAt: string | null;
  overdue?: boolean;
  stale?: boolean;
  /** The assignee's own check-in: % done and expected finish; atRisk when that misses the due date. */
  progress?: number | null;
  etaAt?: string | null;
  atRisk?: boolean;
}
/** "60%, dự kiến xong 15/10, CÓ NGUY CƠ TRỄ" for the model and the local fallback. */
const progressVi = (t: TaskLine, d: (iso: string) => string) =>
  `${t.progress != null ? `, đã xong ${t.progress}%` : ", chưa báo tiến độ"}${t.etaAt ? `, dự kiến xong ${d(t.etaAt)}` : ""}${t.atRisk && !t.overdue ? ", CÓ NGUY CƠ TRỄ" : ""}`;
const progressEn = (t: TaskLine, d: (iso: string) => string) =>
  `${t.progress != null ? `, ${t.progress}% done` : ", no progress update"}${t.etaAt ? `, expected ${d(t.etaAt)}` : ""}${t.atRisk && !t.overdue ? ", AT RISK of being late" : ""}`;
interface TeamStatus {
  scope: "reports" | "everyone" | "none";
  totals: { open: number; overdue: number; stale: number; blocked: number; done7: number };
  people: {
    userId: string;
    displayName: string;
    title?: string | null;
    department?: string | null;
    open: number;
    inProgress: number;
    overdue: number;
    stale: number;
    blocked: number;
    done7: number;
    lastActivityAt: string | null;
    now: TaskLine[];
    late: TaskLine[];
    doneRecently: { id: string; code: string; title: string }[];
  }[];
}
interface Delegated {
  summary: { open: number; overdue: number; stale: number; blocked: number; done14: number };
  tasks: (TaskLine & { assigneeId: string | null; updatedAt: string; blockedReason: string | null })[];
}

// Read by people when no hosted model rewrites the answer (local fallback), so in plain Vietnamese.
const STATUS_VI: Record<string, string> = { todo: "chưa bắt đầu", in_progress: "đang làm", review: "chờ duyệt", blocked: "bị chặn", done: "xong" };
const STATUS_EN: Record<string, string> = { todo: "to do", in_progress: "in progress", review: "in review", blocked: "blocked", done: "done" };
const isEn = (ctx: ToolContext) => ctx.lang === "en";
const dayVi = (iso: string, timeZone = DEFAULT_TIME_ZONE) => new Date(iso).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", timeZone });

export const TOOLS: Tool[] = [
  {
    name: "search_messages",
    description: "Search chat messages the user can read.",
    permission: "message.read",
    input: z.object({ query: z.string().min(2).max(200) }),
    jsonSchema: { type: "object", properties: { query: str("search text") }, required: ["query"] },
    async run(ctx, input) {
      const r = await ctx.services.chat.request<{ hits: { entity_id: string; container_id: string; body: string; title: string; url: string }[] }>(
        "GET",
        `/search?q=${encodeURIComponent(input.query)}&types=message`,
        undefined,
        ctx.principal,
      );
      return {
        ok: true,
        content: r.hits.map((h) => `[message ${h.entity_id}] ${h.body}`).join("\n"),
        sources: r.hits.map((h) => ({ type: "message", id: h.entity_id, title: h.title ? `#${h.title}` : "message", url: h.url })),
      };
    },
  },
  {
    name: "recent_channel_messages",
    description: "Read the latest messages of a chat channel the user can read (for 'summarise this channel', 'what did I miss').",
    permission: "message.read",
    input: z.object({ channelId: z.string().min(10).max(40) }),
    jsonSchema: { type: "object", properties: { channelId: str("channel id") }, required: ["channelId"] },
    async run(ctx, input) {
      const r = await ctx.services.chat.request<{ messages: { id: string; body: string; deletedAt: string | null }[] }>(
        "GET",
        `/channels/${encodeURIComponent(input.channelId)}/messages?limit=40`,
        undefined,
        ctx.principal,
      );
      const rows = r.messages
        .filter((m) => !m.deletedAt && m.body?.trim())
        .slice(0, 40)
        .reverse();
      return {
        ok: true,
        content: rows.map((m) => `[message ${m.id}] ${m.body.replace(/\s+/g, " ").slice(0, 300)}`).join("\n"),
        sources: rows.slice(-5).map((m) => ({ type: "message", id: m.id, title: "message", url: `/app/chat/m/${m.id}` })),
      };
    },
  },
  {
    name: "get_thread",
    description: "Read a chat thread (root message and replies).",
    permission: "message.read",
    input: z.object({ messageId: z.string().length(26) }),
    jsonSchema: { type: "object", properties: { messageId: str("root message id") }, required: ["messageId"] },
    async run(ctx, input) {
      const r = await ctx.services.chat.request<{
        root: { id: string; authorId: string; body: string; channelId: string };
        replies: { id: string; authorId: string; body: string }[];
      }>("GET", `/messages/${input.messageId}/thread`, undefined, ctx.principal);
      const all = [r.root, ...r.replies];
      return {
        ok: true,
        content: all.map((m) => `[${m.authorId}] ${m.body}`).join("\n"),
        sources: [{ type: "message", id: r.root.id, title: "thread", url: `/app/chat/${r.root.channelId}?m=${r.root.id}` }],
      };
    },
  },
  {
    name: "list_my_tasks",
    description: "List open tasks assigned to the user.",
    permission: "task.read",
    input: z.object({}),
    jsonSchema: { type: "object", properties: {} },
    async run(ctx) {
      const r = await ctx.services.work.request<{ tasks: { id: string; code: string; title: string; status: string; dueAt: string | null }[] }>(
        "GET",
        "/tasks",
        undefined,
        ctx.principal,
      );
      const open = r.tasks.filter((t) => !["done", "cancelled"].includes(t.status));
      return {
        ok: true,
        content: isEn(ctx)
          ? open
              .map((t) => {
                // By the day in the workspace's zone: a task due at 17:00 today is due today, not overdue at 17:01.
                const today = dayKey(new Date(), ctx.timeZone ?? DEFAULT_TIME_ZONE);
                const due = t.dueAt ? dayKey(new Date(t.dueAt), ctx.timeZone ?? DEFAULT_TIME_ZONE) : null;
                const mark = !due ? "" : due < today ? " (OVERDUE)" : due === today ? " (today)" : "";
                return `[task ${t.code}] ${t.title} · ${STATUS_EN[t.status] ?? t.status}${t.dueAt ? ` · due ${dayVi(t.dueAt, ctx.timeZone).replace("-", "/")}${mark}` : ""}`;
              })
              .join("\n") || "[task] You have no open tasks."
          : open.map((t) => `[task ${t.code}] ${t.title} · ${STATUS_VI[t.status] ?? t.status}${t.dueAt ? ` · hạn ${dayVi(t.dueAt, ctx.timeZone)}` : ""}`).join("\n"),
        sources: open.map((t) => ({ type: "task", id: t.id, title: t.code, url: `/app/work/tasks/${t.id}` })),
      };
    },
  },
  {
    name: "create_task",
    description: "Create a task. Only when the user explicitly asks to create tasks.",
    permission: "task.create",
    input: z.object({
      title: z.string().min(1).max(300),
      description: z.string().max(5000).default(""),
      assigneeId: z.string().nullable().default(null),
      dueAt: z.string().datetime({ offset: true }).nullable().default(null),
      source: z
        .object({ type: z.literal("chat.message"), messageId: z.string(), channelId: z.string() })
        .nullable()
        .default(null),
    }),
    jsonSchema: { type: "object", properties: { title: str("task title"), description: str("details"), assigneeId: str("user id"), dueAt: str("ISO date") }, required: ["title"] },
    async run(ctx, input) {
      const t = await ctx.services.work.request<{ id: string; code: string; title: string }>("POST", "/tasks", input, ctx.principal);
      return { ok: true, content: `Created task ${t.code}: ${t.title}`, sources: [{ type: "task", id: t.id, title: t.code, url: `/app/work/tasks/${t.id}` }] };
    },
  },
  {
    name: "search_documents",
    description: "Find documents, tasks and projects the user can open, by keywords. Returns ids to read with get_document.",
    permission: "document.read",
    input: z.object({ query: z.string().min(2).max(200) }),
    jsonSchema: { type: "object", properties: { query: str("search text") }, required: ["query"] },
    async run(ctx, input) {
      const r = await ctx.services.chat.request<{ hits: { entity_type: string; entity_id: string; title: string; body: string; url: string }[] }>(
        "GET",
        `/search?q=${encodeURIComponent(input.query)}&types=document,task,project`,
        undefined,
        ctx.principal,
      );
      return {
        ok: true,
        content: r.hits.map((h) => `[${h.entity_type} ${h.entity_id}] ${h.title}${h.body ? `: ${h.body.slice(0, 200)}` : ""}`).join("\n") || "No matching documents.",
        sources: r.hits.map((h) => ({ type: h.entity_type as Source["type"], id: h.entity_id, title: h.title, url: h.url })),
      };
    },
  },
  {
    name: "get_document",
    description: "Read a document's full text (for summarizing, answering questions or comparing documents).",
    permission: "document.read",
    input: z.object({ documentId: z.string().length(26) }),
    jsonSchema: { type: "object", properties: { documentId: str("document id from search_documents") }, required: ["documentId"] },
    async run(ctx, input) {
      const r = await ctx.services.work.request<{
        document: { id: string; code: string; title: string; version: number; ownerId?: string };
        content: string;
        text?: string;
      }>("GET", `/docs/${input.documentId}?track=0`, undefined, ctx.principal);
      // Who owns the page, for "who wrote it?" (the directory may be out of reach: then the line is left out).
      const owner = r.document.ownerId
        ? await ctx.services.employee
            .request<{ displayName?: string }>("GET", `/employees/${encodeURIComponent(r.document.ownerId)}`, undefined, ctx.principal)
            .then((e) => e.displayName ?? null)
            .catch(() => null)
        : null;
      return {
        ok: true,
        content: `# ${r.document.title} (${r.document.code}, v${r.document.version})\n${owner ? `${isEn(ctx) ? "Owner" : "Người tạo"}: ${owner}\n` : ""}${(r.text ?? r.content).slice(0, 20000)}`,
        sources: [{ type: "document", id: r.document.id, title: r.document.title, url: `/app/work/docs/${r.document.id}` }],
      };
    },
  },
  {
    name: "find_people",
    description: "Find colleagues by name, job title or department (who is the frontend lead, who works in Finance). Returns title, department and manager.",
    permission: "employee.profile.read",
    input: z.object({ query: z.string().min(2).max(200) }),
    jsonSchema: { type: "object", properties: { query: str("a name, job title or department") }, required: ["query"] },
    async run(ctx, input) {
      const r = await ctx.services.employee.request<{
        employees: { userId: string; displayName: string; title: string | null; department: string | null; managerId: string | null }[];
      }>("GET", "/employees?all=1", undefined, ctx.principal);
      const words = fold(input.query)
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 1);
      const name = new Map(r.employees.map((e) => [e.userId, e.displayName]));
      // Every word must appear in the name, title or department ("frontend lead" finds the Frontend Lead only).
      const hits = r.employees
        .filter((e) => {
          const hay = fold(`${e.displayName} ${e.title ?? ""} ${e.department ?? ""}`);
          return words.length > 0 && words.every((w) => hay.includes(w.replace(/s$/, "")));
        })
        .slice(0, 10);
      const en = isEn(ctx);
      return {
        ok: true,
        content:
          hits
            .map(
              (e) =>
                `[${en ? "person" : "người"} ${e.displayName}] ${[e.title, e.department].filter(Boolean).join(", ")}${e.managerId && name.get(e.managerId) ? `${en ? ", reports to " : ", báo cáo cho "}${name.get(e.managerId)}` : ""}`,
            )
            .join("\n") || (en ? "[people] No one matches." : "[người] Không có ai khớp."),
        sources: hits.map((e) => ({ type: "employee" as const, id: e.userId, title: e.displayName, url: `/app/me/people?u=${e.userId}` })),
      };
    },
  },
  {
    name: "project_status",
    description: "Status of active projects: open and overdue tasks per project. Optional project narrows to one name or code.",
    permission: "project.read",
    input: z.object({ project: z.string().max(80).optional() }),
    jsonSchema: { type: "object", properties: { project: str("a project's name or code to focus on (optional)") } },
    async run(ctx, input) {
      const r = await ctx.services.work.request<{ projects: { id: string; code: string; name: string; openTasks: number; overdueTasks: number; dueAt: string | null }[] }>(
        "GET",
        "/projects",
        undefined,
        ctx.principal,
      );
      if (input.project) {
        const want = fold(input.project);
        const hit = r.projects.filter((p) => fold(p.name).includes(want) || want.includes(fold(p.name)) || fold(p.code) === want);
        if (!hit.length)
          return {
            ok: true,
            content: isEn(ctx) ? `[project] No active project matches "${input.project}".` : `[dự án] Không có dự án đang chạy nào khớp "${input.project}".`,
            sources: [],
          };
        r.projects = hit;
      }
      return {
        ok: true,
        content:
          r.projects.map((p) => `[project ${p.code}] ${p.name}: ${p.openTasks} open, ${p.overdueTasks} overdue${p.dueAt ? `, due ${p.dueAt.slice(0, 10)}` : ""}`).join("\n") ||
          "No active projects.",
        sources: r.projects.map((p) => ({ type: "project", id: p.id, title: p.name, url: `/app/work/projects/${p.id}` })),
      };
    },
  },
  {
    name: "team_status",
    description:
      "What the people who report to the user (directly or through their managers) are working on, optionally in one department: per person open, in-progress, overdue, quiet (no update for 3+ days) and blocked tasks with each task's reported progress %, expected finish date and whether it is at risk of being late, and what they finished in the last 7 days. Use for 'what is my team doing', 'how is X doing', 'who is behind'. Optional person narrows to one name.",
    permission: "task.read",
    input: z.object({ person: z.string().max(80).optional(), department: z.string().max(80).optional() }),
    jsonSchema: {
      type: "object",
      properties: { person: str("a person's name to focus on (optional)"), department: str("a department name to narrow to, e.g. Engineering (optional)") },
    },
    async run(ctx, input) {
      const r = await ctx.services.work.request<TeamStatus>("GET", "/followup/team", undefined, ctx.principal);
      // A "name" that is no one's but is a department's ("what did Sales finish this week"): read it as that department.
      if (input.person && !input.department) {
        const name = fold(input.person);
        const isPerson = r.people.some((x) => fold(x.displayName).includes(name) || name.includes(fold(x.displayName)));
        if (!isPerson && r.people.some((x) => x.department && deptMatches(x.department, input.person!))) input = { department: input.person };
      }
      if (input.department) {
        r.people = r.people.filter((x) => x.department && deptMatches(x.department, input.department!));
        // No such department among the people the asker follows: say so, never a team of zero.
        if (!r.people.length)
          return {
            ok: true,
            content: isEn(ctx)
              ? `[team] No department called "${input.department}" among the people you follow.`
              : `[đội] Không có phòng ban "${input.department}" trong những người bạn theo dõi.`,
            sources: [],
          };
      }
      const en = isEn(ctx);
      if (r.scope === "none")
        return { ok: true, content: en ? "[team] Nobody reports to you in the org chart." : "[đội] Không có ai báo cáo cho người hỏi trong sơ đồ tổ chức.", sources: [] };
      const want = input.person ? fold(input.person) : null;
      const people = want ? r.people.filter((x) => fold(x.displayName).includes(want) || want.includes(fold(x.displayName))) : r.people;
      if (want && !people.length)
        return {
          ok: true,
          content: en ? `[team] "${input.person}" is not among the people who report to you.` : `[đội] Không tìm thấy "${input.person}" trong những người báo cáo cho người hỏi.`,
          sources: [],
        };
      const d = (iso: string | null) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : "");
      const lines = people.slice(0, 40).map((x) => {
        const head = en
          ? `[person ${x.displayName}${x.title ? `, ${x.title}` : ""}] ${x.open} open task${x.open === 1 ? "" : "s"} (${x.inProgress} in progress, ${x.overdue} overdue, ${x.stale} without an update for 3+ days, ${x.blocked} blocked); ${x.done7} done in the last 7 days; last active ${x.lastActivityAt ? d(x.lastActivityAt) : "never"}.`
          : `[người ${x.displayName}${x.title ? `, ${x.title}` : ""}] ${x.open} việc đang mở (${x.inProgress} đang làm, ${x.overdue} trễ hạn, ${x.stale} lâu chưa cập nhật, ${x.blocked} bị chặn); xong ${x.done7} việc trong 7 ngày; hoạt động gần nhất ${x.lastActivityAt ? d(x.lastActivityAt) : "chưa có"}.`;
        const now = x.now.map((t) =>
          en
            ? `${t.code} ${t.title}${t.dueAt ? ` (due ${d(t.dueAt)}${t.overdue ? ", LATE" : ""})` : ""}${progressEn(t, d)}${t.stale ? " [no recent update]" : ""}`
            : `${t.code} ${t.title}${t.dueAt ? ` (hạn ${d(t.dueAt)}${t.overdue ? ", TRỄ" : ""})` : ""}${progressVi(t, d)}${t.stale ? " [lâu chưa cập nhật]" : ""}`,
        );
        const late = x.late.filter((t) => !x.now.some((n) => n.id === t.id)).map((t) => `${t.code} ${t.title} (${en ? "due" : "hạn"} ${d(t.dueAt)})`);
        const done = x.doneRecently.map((t) => `${t.code} ${t.title}`);
        const [doing, overdue, finished] = en ? ["in progress", "overdue", "done"] : ["đang làm", "trễ hạn", "đã xong"];
        return [
          head,
          now.length ? `[${x.displayName} · ${doing}] ${now.join("; ")}` : "",
          late.length ? `[${x.displayName} · ${overdue}] ${late.join("; ")}` : "",
          done.length ? `[${x.displayName} · ${finished}] ${done.join("; ")}` : "",
        ]
          .filter(Boolean)
          .join("\n");
      });
      // Narrowed to a department, the totals are that department's, not the whole team's.
      const t = input.department
        ? r.people.reduce(
            (n, x) => ({ open: n.open + x.open, overdue: n.overdue + x.overdue, stale: n.stale + x.stale, blocked: n.blocked + x.blocked, done7: n.done7 + x.done7 }),
            { open: 0, overdue: 0, stale: 0, blocked: 0, done7: 0 },
          )
        : r.totals;
      const total = want
        ? ""
        : en
          ? `[total] ${r.people.length} people: ${t.open} open tasks, ${t.overdue} overdue, ${t.stale} without a recent update, ${t.blocked} blocked, ${t.done7} done in 7 days.${r.scope === "everyone" ? " (No reporting lines yet: this is the whole company.)" : ""}`
          : `[tổng] ${r.people.length} người: ${t.open} việc mở, ${t.overdue} trễ hạn, ${t.stale} lâu chưa cập nhật, ${t.blocked} bị chặn, ${t.done7} xong trong 7 ngày.${r.scope === "everyone" ? " (Chưa có sơ đồ quản lý: đang xem cả công ty.)" : ""}`;
      return {
        ok: true,
        content: [total, ...lines].filter(Boolean).join("\n") || (en ? "[team] No tasks are assigned to your team yet." : "[đội] Chưa có việc nào được giao cho đội."),
        sources: people.slice(0, 10).map((x) => ({ type: "employee" as const, id: x.userId, title: x.displayName, url: `/app/work/people/${x.userId}` })),
        // A manager sees the people under them, not the company: the answer says so.
        ...(r.scope === "reports" ? { coverage: [{ kind: "scope" as const, scope: "reports" as const }] } : {}),
      };
    },
  },
  {
    name: "team_ai_usage",
    description:
      "How the user's team (or the whole company, for AI admins) used AI in the last 7 days: per person the number of prompts, which tools (the company AI assistant, ChatGPT, Claude, Gemini, Copilot), what for (topics) and sensitive-data alerts. Use for 'who uses AI', 'what does my team use ChatGPT for', 'is anyone pasting sensitive data'.",
    permission: "task.read",
    input: z.object({}),
    jsonSchema: { type: "object", properties: {} },
    async run(ctx) {
      const en = isEn(ctx);
      if (!ctx.services.ai) return { ok: true, content: en ? "[AI] No AI usage data yet." : "[AI] Chưa có dữ liệu dùng AI.", sources: [] };
      type O = {
        totals: { people: number; active: number; prompts: number; outside: number; flagged: number };
        people: {
          userId: string;
          displayName: string;
          department: string | null;
          prompts: number;
          flagged: number;
          sources: Record<string, number>;
          topics: Record<string, number>;
        }[];
      };
      const r = await ctx.services.ai.request<O>("GET", "/oversight?days=7", undefined, ctx.principal).catch(() => null);
      if (!r)
        return { ok: true, content: en ? "[AI] Only managers and admins can see AI activity." : "[AI] Người hỏi không xem được hoạt động AI (chỉ quản lý và admin).", sources: [] };
      const top = (o: Record<string, number>) =>
        Object.entries(o)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([k, n]) => `${k} ${n}`)
          .join(", ");
      const t = r.totals;
      const lines = r.people
        .filter((x) => x.prompts)
        .slice(0, 40)
        .map((x) =>
          en
            ? `[person ${x.displayName}${x.department ? `, ${x.department}` : ""}] ${x.prompts} prompts; tools: ${top(x.sources)}; topics: ${top(x.topics)}${x.flagged ? `; ${x.flagged} sensitive-data alerts` : ""}.`
            : `[người ${x.displayName}${x.department ? `, ${x.department}` : ""}] ${x.prompts} câu hỏi; công cụ: ${top(x.sources)}; chủ đề: ${top(x.topics)}${x.flagged ? `; ${x.flagged} cảnh báo dữ liệu nhạy cảm` : ""}.`,
        );
      const idle = r.people.filter((x) => !x.prompts).map((x) => x.displayName);
      return {
        ok: true,
        content: [
          en
            ? `[AI, 7 days] ${t.active}/${t.people} people use AI, ${t.prompts} prompts, ${t.outside} on outside tools (ChatGPT, Claude, Gemini, Copilot), ${t.flagged} sensitive-data alerts.`
            : `[AI 7 ngày] ${t.active}/${t.people} người dùng AI, ${t.prompts} câu hỏi, ${t.outside} câu trên công cụ bên ngoài (ChatGPT, Claude, Gemini, Copilot), ${t.flagged} cảnh báo dữ liệu nhạy cảm.`,
          ...lines,
          idle.length ? `[${en ? "not using AI" : "chưa dùng AI"}] ${idle.slice(0, 30).join(", ")}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        sources: r.people
          .filter((x) => x.prompts)
          .slice(0, 10)
          .map((x) => ({ type: "employee" as const, id: x.userId, title: x.displayName, url: `/app/work/people/${x.userId}` })),
      };
    },
  },
  {
    name: "goals_status",
    description:
      "The company's and departments' goals (OKR) for this quarter: each goal's progress against the time already gone (on track, at risk, behind), owner and key results with their values. Use for 'how are our goals', 'are we on track this quarter', 'mục tiêu quý này thế nào'.",
    permission: "project.read",
    input: z.object({}),
    jsonSchema: { type: "object", properties: {} },
    async run(ctx) {
      type G = {
        id: string;
        title: string;
        department: string | null;
        progress: number;
        expected: number;
        health: string;
        keyResults: { title: string; progress: number; current: number; target: number; unit: string; kind: string; done: number; total: number }[];
      };
      const r = await ctx.services.work.request<{ period: string; goals: G[] }>("GET", "/goals", undefined, ctx.principal);
      const en = isEn(ctx);
      if (!r.goals.length) return { ok: true, content: en ? `[goals ${r.period}] No goals yet.` : `[mục tiêu ${r.period}] Chưa có mục tiêu nào.`, sources: [] };
      const H: Record<string, string> = en
        ? { done: "done", on_track: "on track", at_risk: "at risk", behind: "behind", not_started: "not started" }
        : { done: "hoàn thành", on_track: "đúng tiến độ", at_risk: "có nguy cơ", behind: "chậm", not_started: "chưa bắt đầu" };
      return {
        ok: true,
        content: r.goals
          .map(
            (g) =>
              (en
                ? `[goal ${g.department ?? "company"}] ${g.title}: ${g.progress}% (time says ${g.expected}%), ${H[g.health] ?? g.health}. `
                : `[mục tiêu ${g.department ?? "toàn công ty"}] ${g.title}: đạt ${g.progress}% (theo thời gian nên ${g.expected}%), ${H[g.health] ?? g.health}. `) +
              g.keyResults
                .map((k) => `${k.title} ${k.kind === "project" ? `${k.done}/${k.total} ${en ? "tasks" : "việc"}` : `${k.current}/${k.target} ${k.unit}`} (${k.progress}%)`)
                .join("; "),
          )
          .join("\n"),
        sources: r.goals.slice(0, 10).map((g) => ({ type: "project" as const, id: g.id, title: g.title, url: "/app/work/goals" })),
      };
    },
  },
  {
    name: "delegated_status",
    description:
      "Where the tasks the user assigned to other people stand: open, overdue, at risk (expected finish after the due date), quiet (no update for 3+ days), blocked, done in the last 14 days, with who has each, % done and when they expect to finish. Use for 'where is what I asked for', 'what did X do with my task'.",
    permission: "task.read",
    input: z.object({}),
    jsonSchema: { type: "object", properties: {} },
    async run(ctx) {
      const [r, dir] = await Promise.all([
        ctx.services.work.request<Delegated>("GET", "/followup/delegated", undefined, ctx.principal),
        ctx.services.employee
          .request<{ employees: { userId: string; displayName: string }[] }>("GET", "/employees?all=1", undefined, ctx.principal)
          .catch(() => ({ employees: [] })),
      ]);
      const name = new Map(dir.employees.map((e) => [e.userId, e.displayName]));
      const d = (iso: string | null) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : "");
      const st: Record<string, string> = { todo: "chưa bắt đầu", in_progress: "đang làm", review: "chờ duyệt", done: "đã xong" };
      const en = isEn(ctx);
      const quiet = (t: { updatedAt: string }) => Math.floor((Date.now() - Date.parse(t.updatedAt)) / 86400_000);
      const lines = r.tasks
        .slice(0, 40)
        .map((t) =>
          en
            ? `[task ${t.code}] ${t.title} → ${name.get(t.assigneeId ?? "") ?? t.assigneeId}: ${STATUS_EN[t.status] ?? t.status}${t.dueAt ? `, due ${d(t.dueAt)}` : ""}${t.overdue ? ", OVERDUE" : ""}${t.stale ? `, no update for ${quiet(t)} days` : ""}${progressEn(t, d)}${t.blockedReason ? `, blocked: ${t.blockedReason}` : ""}`
            : `[việc ${t.code}] ${t.title} → ${name.get(t.assigneeId ?? "") ?? t.assigneeId}: ${st[t.status] ?? t.status}${t.dueAt ? `, hạn ${d(t.dueAt)}` : ""}${t.overdue ? ", TRỄ HẠN" : ""}${t.stale ? `, ${quiet(t)} ngày chưa cập nhật` : ""}${progressVi(t, d)}${t.blockedReason ? `, bị chặn: ${t.blockedReason}` : ""}`,
        );
      const s = r.summary;
      return {
        ok: true,
        content: [
          en
            ? `[total] You have ${s.open} open tasks with other people: ${s.overdue} overdue, ${s.stale} without a recent update, ${s.blocked} blocked; ${s.done14} done in 14 days.`
            : `[tổng] Đã giao ${s.open} việc đang mở: ${s.overdue} trễ hạn, ${s.stale} lâu chưa cập nhật, ${s.blocked} bị chặn; ${s.done14} việc xong trong 14 ngày.`,
          ...lines,
        ].join("\n"),
        sources: r.tasks.slice(0, 10).map((t) => ({ type: "task" as const, id: t.id, title: t.code, url: `/app/work/tasks/${t.id}` })),
      };
    },
  },
  {
    name: "who_is_out",
    description:
      "Who is on leave (approved or pending) between two dates, among the people the user may see (their team and department), plus company holidays in that range. Dates are YYYY-MM-DD; default is today to 7 days ahead.",
    permission: "employee.profile.read",
    input: z.object({
      from: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      to: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
    }),
    jsonSchema: { type: "object", properties: { from: str("first day, YYYY-MM-DD"), to: str("last day, YYYY-MM-DD") } },
    async run(ctx, input) {
      const today = dayKey(new Date(), ctx.timeZone ?? DEFAULT_TIME_ZONE);
      const from = input.from ?? today;
      const to = input.to ?? new Date(Date.parse(from) + 7 * 86400_000).toISOString().slice(0, 10);
      const [out, hol] = await Promise.all([
        ctx.services.employee.request<{ out: { userId: string; displayName: string; type: string; startDate: string; endDate: string; status: string }[] }>(
          "GET",
          `/leave/out?from=${from}&to=${to}`,
          undefined,
          ctx.principal,
        ),
        ctx.services.employee
          .request<{ holidays: { day: string; name: string }[] }>("GET", `/holidays?year=${from.slice(0, 4)}`, undefined, ctx.principal)
          .catch(() => ({ holidays: [] })),
      ]);
      const vi = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
      const en = isEn(ctx);
      const lines = [
        ...out.out.map((o) =>
          en
            ? `[on leave] ${o.displayName}: ${vi(o.startDate)}–${vi(o.endDate)} (${o.status === "approved" ? "approved" : "pending"})`
            : `[nghỉ phép] ${o.displayName}: ${vi(o.startDate)}–${vi(o.endDate)} (${o.status === "approved" ? "đã duyệt" : "chờ duyệt"})`,
        ),
        ...hol.holidays.filter((h) => h.day >= from && h.day <= to).map((h) => `[${en ? "holiday" : "ngày lễ"}] ${h.name}: ${vi(h.day)}`),
      ];
      return {
        ok: true,
        content: lines.join("\n") || (en ? `[on leave] Nobody is off between ${vi(from)} and ${vi(to)}.` : `[nghỉ phép] Không ai nghỉ từ ${vi(from)} đến ${vi(to)}.`),
        sources: out.out.map((o) => ({ type: "employee", id: o.userId, title: o.displayName, url: `/app/me/people?u=${o.userId}` })),
      };
    },
  },
  {
    name: "my_leave_balance",
    description: "The user's own leave balances this year (entitled, used, pending, remaining) and upcoming company holidays.",
    permission: "leave.request",
    input: z.object({}),
    jsonSchema: { type: "object", properties: {} },
    async run(ctx) {
      const [me, hol] = await Promise.all([
        ctx.services.employee.request<{ leaveBalances: { type: string; entitled: number; used: number; pending: number }[] }>("GET", "/me", undefined, ctx.principal),
        ctx.services.employee.request<{ holidays: { day: string; name: string }[] }>("GET", "/holidays", undefined, ctx.principal).catch(() => ({ holidays: [] })),
      ]);
      const today = dayKey(new Date(), ctx.timeZone ?? DEFAULT_TIME_ZONE);
      const en = isEn(ctx);
      const lines = [
        ...me.leaveBalances.map((b) =>
          en
            ? `[${b.type} leave] ${b.entitled - b.used - b.pending} days left (${b.entitled} a year, ${b.used} used, ${b.pending} pending)`
            : `[phép ${b.type}] còn ${b.entitled - b.used - b.pending} ngày (được cấp ${b.entitled}, đã dùng ${b.used}, chờ duyệt ${b.pending})`,
        ),
        ...hol.holidays
          .filter((h) => h.day >= today)
          .slice(0, 3)
          .map((h) => `[${en ? "next holiday" : "ngày lễ sắp tới"}] ${h.name}: ${h.day.slice(8, 10)}/${h.day.slice(5, 7)}`),
      ];
      return {
        ok: true,
        content: lines.join("\n") || (en ? "[leave] You have no leave allowance this year." : "[phép] Bạn chưa được cấp ngày phép năm nay."),
        sources: [{ type: "employee", id: ctx.principal.id, title: en ? "My leave" : "Nghỉ phép của tôi", url: "/app/me?tab=leave" }],
      };
    },
  },
  {
    name: "search_tasks",
    description: "Find tasks the user can open by keywords or a task code (T-041), including finished ones. Returns codes to read with get_task.",
    permission: "task.read",
    input: z.object({ query: z.string().min(2).max(200) }),
    jsonSchema: { type: "object", properties: { query: str("keywords or a task code") }, required: ["query"] },
    async run(ctx, input) {
      const r = await ctx.services.chat.request<{ hits: { entity_type: string; entity_id: string; title: string; body: string; url: string }[] }>(
        "GET",
        `/search?q=${encodeURIComponent(input.query)}&types=task`,
        undefined,
        ctx.principal,
      );
      const hits = r.hits.filter((h) => h.entity_type === "task").slice(0, 10);
      return {
        ok: true,
        content:
          hits.map((h) => `[task ${h.entity_id}] ${h.title}${h.body ? `: ${h.body.slice(0, 200)}` : ""}`).join("\n") ||
          (isEn(ctx) ? "No matching tasks." : "Không có việc nào khớp."),
        sources: hits.map((h) => ({ type: "task" as const, id: h.entity_id, title: h.title, url: h.url })),
      };
    },
  },
  {
    name: "get_task",
    description: "Read one task the user can open: status, assignee, due date, description, subtasks and recent comments. Takes a task id or code.",
    permission: "task.read",
    input: z.object({ task: z.string().min(2).max(64) }),
    jsonSchema: { type: "object", properties: { task: str("task id or code, e.g. T-041") }, required: ["task"] },
    async run(ctx, input) {
      const r = await ctx.services.work.request<{
        task: { id: string; code: string; title: string; description: string; status: string; assigneeId: string | null; dueAt: string | null; blockedReason?: string | null };
        comments: { authorId: string; body: string }[];
        subtasks: { code: string; title: string; status: string }[];
      }>("GET", `/tasks/${encodeURIComponent(input.task)}`, undefined, ctx.principal);
      const t = r.task;
      const en = isEn(ctx);
      const status = (en ? STATUS_EN : STATUS_VI)[t.status] ?? t.status;
      const lines = [
        `# ${t.code} ${t.title} · ${status}${t.dueAt ? ` · ${en ? "due" : "hạn"} ${dayVi(t.dueAt, ctx.timeZone)}` : ""}`,
        t.blockedReason ? `${en ? "Blocked" : "Bị chặn"}: ${t.blockedReason}` : "",
        t.description.slice(0, 4000),
        ...r.subtasks.map((s) => `- [${s.status === "done" ? "x" : " "}] ${s.code} ${s.title}`),
        ...r.comments.slice(-10).map((c) => `> ${c.body.replace(/\s+/g, " ").slice(0, 400)}`),
      ].filter(Boolean);
      return { ok: true, content: lines.join("\n"), sources: [{ type: "task", id: t.id, title: `${t.code} ${t.title}`, url: `/app/work/tasks/${t.id}` }] };
    },
  },
  {
    name: "get_employee_compensation",
    description: "Read an employee's salary and compensation.",
    permission: "employee.salary.read",
    input: z.object({ employeeId: z.string().min(1) }),
    jsonSchema: { type: "object", properties: { employeeId: str("employee user id") }, required: ["employeeId"] },
    async run(ctx, input) {
      const r = await ctx.services.employee.request<{ baseSalary: number; currency: string }>(
        "GET",
        `/employees/${encodeURIComponent(input.employeeId)}/compensation`,
        undefined,
        ctx.principal,
      );
      return { ok: true, content: `Compensation: ${r.baseSalary} ${r.currency}`, sources: [{ type: "employee", id: input.employeeId, title: "compensation", url: `/app/me` }] };
    },
  },
];

export const toolByName = new Map(TOOLS.map((t) => [t.name, t]));
/** Tools an agent may be given (allowed_tools). Compensation is never an agent tool. */
export const AGENT_TOOLS = [
  "search_messages",
  "get_thread",
  "list_my_tasks",
  "create_task",
  "search_documents",
  "get_document",
  "project_status",
  "team_status",
  "team_ai_usage",
  "goals_status",
  "delegated_status",
  "who_is_out",
];

/**
 * Something a tool wants the model to hear and act on (two people match that name, the passage is not in the page):
 * its message is the tool's result. Any other error stays out of the model's sight.
 */
export class ToolProblem extends Error {}

/**
 * A use of the connected AI's own web or cloud tool (web search, web fetch, its code sandbox) in the audit trail, like
 * any tool call: what it searched or which page, never what the page said. Never throws.
 */
export async function auditProviderTool(pool: Pool, who: { principal: Principal; agentId: string | null }, name: string, input: Record<string, unknown>): Promise<void> {
  const kept = {
    ...(typeof input.query === "string" ? { query: input.query.slice(0, 300) } : {}),
    ...(typeof input.url === "string" ? { url: input.url.slice(0, 500) } : {}),
  };
  await withTransaction(pool, (c) =>
    c.query("INSERT INTO ai_audit (id, actor_id, agent_id, tool, allowed, reason, input) VALUES ($1,$2,$3,$4,true,'provider tool',$5)", [
      newId(),
      who.principal.id,
      who.agentId,
      `provider.${name}`.slice(0, 80),
      JSON.stringify(kept),
    ]),
  ).catch((e) => logger.warn({ err: e, tool: name }, "ai: provider tool not audited"));
}

/** Runs one tool call with both authorization checks and an audit row. Never throws. `lookup`: the set the tool belongs to. */
export async function executeTool(pool: Pool, ctx: ToolContext, name: string, rawInput: unknown, lookup: Map<string, Tool> = toolByName): Promise<ToolResult> {
  const step = ctx.progress?.start(name, rawInput);
  const r = await runTool(pool, ctx, name, rawInput, lookup);
  if (step) ctx.progress!.end(step, r);
  return r;
}

async function runTool(pool: Pool, ctx: ToolContext, name: string, rawInput: unknown, lookup: Map<string, Tool>): Promise<ToolResult> {
  const tool = lookup.get(name);
  const audit = async (allowed: boolean, reason: string | null) => {
    await withTransaction(pool, (c) =>
      c.query("INSERT INTO ai_audit (id, actor_id, agent_id, tool, allowed, reason, input) VALUES ($1,$2,$3,$4,$5,$6,$7)", [
        newId(),
        ctx.principal.id,
        ctx.agentId,
        name,
        allowed,
        reason,
        JSON.stringify(rawInput ?? {}),
      ]),
    );
    // A refused tool call goes to the audit trail too (ADR 0025): which tool and why, never its input.
    if (!allowed)
      await withTransaction(pool, (c) =>
        recordAudit(c, {
          action: "ai.tool.denied",
          outcome: "denied",
          actorId: ctx.agentId ? `agent:${ctx.agentId}` : `user:${ctx.principal.id}`,
          targetType: "ai_tool",
          targetId: name.slice(0, 200),
          meta: { askerId: ctx.principal.id, why: reason?.slice(0, 120) ?? null },
        }),
      ).catch(() => undefined);
  };
  if (!tool) {
    await audit(false, "unknown tool");
    return { ok: false, content: `DENIED: unknown tool ${name}`, sources: [] };
  }
  if (tool.feature && featureDisabled(tool.feature)) {
    await audit(false, "feature disabled");
    return { ok: false, content: `DENIED: ${tool.feature} is not part of this installation`, sources: [] };
  }
  const decision = authorize(ctx.principal, tool.permission, { ownerId: ctx.principal.id });
  if (!decision.allowed) {
    await audit(false, decision.reason);
    return { ok: false, content: `DENIED: you do not have permission ${tool.permission}`, sources: [] };
  }
  const parsed = tool.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    await audit(false, "invalid input");
    // Which value is wrong and why, so the model can correct the call instead of giving up.
    const why = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
      .join("; ");
    return { ok: false, content: `DENIED: invalid tool input (${why.slice(0, 300)})`, sources: [] };
  }
  try {
    // Authorized and audited like any call; a read asked again within a minute or so is answered from its last result.
    const kept = cachedRead(ctx, name, parsed.data);
    const r = kept ?? (await tool.run(ctx, parsed.data));
    await audit(true, kept ? "cached" : null);
    if (!kept) afterCall(ctx, name, parsed.data, r);
    return r;
  } catch (e) {
    // Downstream re-authorization failures surface here (403/404 from the owning module).
    const status = e instanceof ServiceCallError ? e.status : 0;
    await audit(false, status ? `downstream ${status}` : (e as Error).message);
    if (e instanceof ToolProblem) return { ok: false, content: e.message, sources: [] };
    if (status === 403 || status === 404) return { ok: false, content: "DENIED: not found or not permitted", sources: [] };
    // What the owning module refused and why (a start after the end, a page changed meanwhile): the model can fix it or say it.
    if (status === 400 || status === 409 || status === 422) {
      const b = (e as ServiceCallError).body as { message?: unknown } | null;
      return {
        ok: false,
        content: `Refused: ${typeof b?.message === "string" ? b.message.slice(0, 300) : status === 409 ? "it changed meanwhile; read it again" : "the values are not valid"}`,
        sources: [],
      };
    }
    logger.warn({ err: e, tool: name }, "tool failed");
    return { ok: false, content: "Tool failed; try again later.", sources: [] };
  }
}
