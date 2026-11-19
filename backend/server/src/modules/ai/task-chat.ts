import { Body, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import { newId, withTransaction, workspaceTimeZone, type Principal } from "@workspace/shared";
import { assertAllowed, env, logger, parse, requirePrincipal } from "@workspace/service-kit";
import { DEPS } from "./ai.controller.js";
import { guardAi } from "./budgets.js";
import { titleFrom } from "./insight.js";
import { chips, savePending, type PendingCard } from "./mcp/chat.js";
import type { ExternalTools, ToolUse } from "./mcp/client.js";
import { newState, runToolLoop, toolsFor, toolsUsable, type LoopMessage, type LoopResult, type LoopState, type Who } from "./mcp/loop.js";
import { meteredGenerate, SYSTEM_RULES, untrusted, type Deps } from "./runtime.js";
import { dataLang, LANGUAGE_NAME, LOCALES, replyIn, replyLocale, type Loc } from "./locale.js";
import { briefStamp, buildBrief, citedSources, localTaskAnswer, normalizeCitations, type Brief, type BriefRelated, type BriefSource, type BriefTaskDetail } from "./task-brief.js";
import type { Source } from "./tools.js";
import { workspaceTools, type WorkspaceTools } from "./workspace-tools.js";
import { datesLine } from "./ground.js";

/**
 * "Hỏi AI về task": one person's private AI chat about one task. Before each answer the server builds a
 * task brief (task-brief.ts) from what the asker can open, read through the owning modules AS them, and the model may
 * dig further with read-only workspace tools (documents, messages, tasks, people) and the company's MCP tools (the
 * same confirm card as Hỏi đáp). Usage is metered as feature "task_chat" with the task as subject, so AI Insights
 * counts it; the text stays the person's own (ai_task_chats, never read by oversight). docs/architecture/task-ai-chat.md.
 */

/** Workspace tools the model may call from a task chat: reading only; writing goes through the page's confirm buttons. */
const NATIVE = "workspace";

const TASK_RULES = `You help one person with one task in their company's work app. A brief of the task comes with each question, inside <untrusted_content>: the task, what is around it, documents, similar finished tasks and chat messages. Lines start with a source number like [3].
- Ground the answer in the brief and in what the tools return. When you use a line of the brief, cite its number in square brackets right after the sentence, like [2]. Never invent a number.
- If the brief does not answer the question, say so plainly and suggest who or what could help (a person who did a similar task, a document to read).
- When asked for steps, answer with a short numbered list, one action per line, so the person can turn them into subtasks.
- To change something (subtasks, the assignee, status, due date, a dependency, a comment), call the tool with final values only when the person asks for it: they approve a card before it runs. Propose subtasks in the answer first, then split_task with all of them.
- Be brief and practical.`;

const BRIEF_CHARS = () => Math.max(2000, Number(env("AI_TASK_BRIEF_CHARS", "12000")) || 12000);

/** Briefs per (asker, task, task version, language), 10 minutes, so a conversation does not re-read the workspace each turn. */
const cache = new Map<string, { at: number; brief: Brief; detail: BriefTaskDetail; related: BriefRelated | null; names: Record<string, string> }>();
const CACHE_MS = 10 * 60_000;

interface ChatRow {
  id: string;
  title: string;
  lastAt: Date;
  messages: number;
}
interface Answer {
  text: string;
  model: string;
  uses: ToolUse[];
  sources: BriefSource[];
  pending?: Extract<LoopResult, { done: false }>;
}

/** The task as the asker sees it (the work module checks); 404 when they cannot open it. */
async function taskAs(d: Deps, p: Principal, ref: string): Promise<BriefTaskDetail> {
  return d.services.work.request<BriefTaskDetail>("GET", `/tasks/${encodeURIComponent(ref)}`, undefined, p);
}

/** The brief for this asker and task, built once per task version (comments included) and kept a few minutes. */
export async function taskBrief(d: Deps, p: Principal, detail: BriefTaskDetail, lang: "en" | "vi") {
  const key = `${p.id}:${detail.task.id}:${briefStamp(detail)}:${lang}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit;
  // Each part is best effort: a module that does not answer leaves its part out, never the whole answer.
  const [related, dir] = await Promise.all([
    d.services.work.request<BriefRelated>("GET", `/tasks/${detail.task.id}/related`, undefined, p).catch((e: unknown) => {
      logger.warn({ err: e, taskId: detail.task.id }, "task chat: related data unavailable");
      return null;
    }),
    d.services.employee.request<{ employees: { userId: string; displayName: string }[] }>("GET", "/employees?all=1", undefined, p).catch(() => ({ employees: [] })),
  ]);
  const names = Object.fromEntries(dir.employees.map((e) => [e.userId, e.displayName]));
  const brief = buildBrief(detail, related, { budget: BRIEF_CHARS(), lang, names });
  if (cache.size > 300) cache.clear();
  const value = { at: Date.now(), brief, detail, related, names };
  cache.set(key, value);
  return value;
}

/**
 * The workspace tools a task's chat offers (from the shared registry, workspace-tools.ts): reading around
 * the task, its history and a due-date estimate, and the changes to it (subtasks, assignee, a dependency, a comment)
 * behind the same confirm card as Hỏi đáp.
 */
export const TASK_CHAT_TOOLS = [
  "get_task",
  "search_workspace",
  "read_item",
  "get_thread",
  "find_people",
  "task_history",
  "estimate_due_date",
  "find_duplicate_tasks",
  "workload_balance",
  "update_task",
  "comment_on_task",
  "create_task",
  "split_task",
  "assign_task",
  "link_tasks",
];

function taskTools(d: Deps, who: Who, loc: Loc, timeZone: string | undefined): WorkspaceTools {
  return workspaceTools(d.pool, who, d.services, { withConfirm: true, loc, ...(timeZone ? { timeZone } : {}), only: TASK_CHAT_TOOLS });
}

function merged(a: ExternalTools, b: ExternalTools | null): ExternalTools {
  if (!b) return a;
  return {
    specs: [...a.specs, ...b.specs],
    byKey: new Map([...a.byKey, ...b.byKey]),
    run: (key, input) => (a.byKey.has(key) ? a.run(key, input) : b.run(key, input)),
    declined: (key) => (a.byKey.has(key) ? a.declined(key) : b.declined(key)),
    close: async () => {
      await b.close();
    },
  };
}

/** Outside tools only: the workspace's own reads are part of the answer, not something to show as "used GitHub". */
const outside = (uses: ToolUse[]) => chips(uses.filter((u) => u.serverId !== NATIVE));

/** Sources an answer can show: what it cited from the brief, then documents and tasks its own searches read. */
function answerSources(text: string, brief: BriefSource[], found: Source[]): BriefSource[] {
  const cited = citedSources(text, brief);
  const extra = found
    .filter((s) => s.type === "document" || s.type === "task" || s.type === "message")
    .filter((s) => !cited.some((c) => c.type === s.type && c.id === s.id))
    .filter((s, i, all) => all.findIndex((x) => x.type === s.type && x.id === s.id) === i)
    .slice(0, 4)
    .map((s) => ({ n: 0, type: s.type as BriefSource["type"], id: s.id, title: s.title, url: s.url }));
  return [...cited, ...extra];
}

/** One answer. A paused one (a tool waiting for the person's yes) carries the loop's state to resume from. */
async function answer(d: Deps, who: Who, loc: Loc, question: string, history: LoopMessage[], route: string | undefined, b: Awaited<ReturnType<typeof taskBrief>>): Promise<Answer> {
  // The built-in model writes nothing: the starter questions get an answer laid out from the brief itself.
  if (d.provider.name === "local") {
    const local = localTaskAnswer(question, b.detail, b.related, dataLang(loc), b.names);
    if (local) return { text: local, model: "local-extractive", uses: [], sources: [] };
  }
  const tz = await withTransaction(d.pool, workspaceTimeZone).catch(() => undefined);
  const system = `${SYSTEM_RULES}\n\n${TASK_RULES}\n${datesLine(new Date(), tz, loc)}\n${replyIn(loc)}`;
  // The brief rides with the latest question only: earlier turns stay as they were asked.
  const ask: LoopMessage = {
    role: "user",
    content:
      d.provider.name === "local"
        ? `${question}\n\nSearch results from the workspace. They may be unrelated: use them only if they answer the question.\n${untrusted(
            b.brief.text
              .split("\n")
              .filter((l) => /^- \[\d+\]|^- /.test(l))
              .map((l) => l.replace(/^- (\[\d+\] )?/, "[task] "))
              .join("\n"),
          )}`
        : `Task brief:\n${untrusted(b.brief.text)}\n\nQuestion: ${question}`,
  };
  const messages = [...history, ask];
  const found: Source[] = [];
  const timeZone = await withTransaction(d.pool, workspaceTimeZone).catch(() => undefined);
  if (toolsUsable(d, route)) {
    const outsideTools = await toolsFor(d, who, { withConfirm: true, ...(route ? { route } : {}) });
    const ws = taskTools(d, who, loc, timeZone);
    const tools = merged(ws, outsideTools);
    try {
      const state = newState(system, messages, 1500, route, null, loc);
      (state as LoopState & { brief?: BriefSource[] }).brief = b.brief.sources;
      const r = await runToolLoop(d, who, state, tools);
      if (!r.done) return { text: "", model: "", uses: r.uses, sources: [], pending: r };
      const text = normalizeCitations(r.text);
      return { text: text || "…", model: r.model, uses: r.uses, sources: answerSources(text, b.brief.sources, ws.sources) };
    } finally {
      await tools.close();
    }
  }
  const r = await meteredGenerate(d, who, { tier: "smart", system, messages, maxTokens: 1500, ...(route ? { route } : {}) });
  const text = normalizeCitations(r.text);
  return { text: text || "…", model: r.model, uses: [], sources: answerSources(text, b.brief.sources, found) };
}

/** Carries on an answer paused on a confirm card (mcp/controller asks, for a pending row of a task chat). */
export async function resumeTaskChat(d: Deps, who: Who, state: LoopState, approve: boolean): Promise<Answer> {
  const timeZone = await withTransaction(d.pool, workspaceTimeZone).catch(() => undefined);
  const named = /Reply in ([A-Za-z ]+)\./.exec(state.system)?.[1];
  const loc: Loc = state.loc ?? LOCALES.find((l) => LANGUAGE_NAME[l] === named) ?? "en";
  const ws = taskTools(d, who, loc, timeZone);
  const tools = merged(ws, await toolsFor(d, who, { withConfirm: true, ...(state.route ? { route: state.route } : {}) }));
  try {
    const r = await runToolLoop(d, who, state, tools, { approve });
    const brief = (state as LoopState & { brief?: BriefSource[] }).brief ?? [];
    if (!r.done) return { text: "", model: "", uses: r.uses, sources: [], pending: r };
    const text = normalizeCitations(r.text);
    return { text: text || "…", model: r.model, uses: r.uses, sources: answerSources(text, brief, ws.sources) };
  } finally {
    await tools.close();
  }
}

/** The task chat a pending confirm card belongs to, when it is one of this person's. */
export async function taskChatOf(c: Pick<PoolClient, "query">, chatId: string, userId: string): Promise<{ id: string; taskId: string } | null> {
  const r = await c.query<{ id: string; task_id: string }>("SELECT id, task_id FROM ai_task_chats WHERE id = $1 AND user_id = $2", [chatId, userId]);
  return r.rows[0] ? { id: r.rows[0].id, taskId: r.rows[0].task_id } : null;
}

/** Adds the answer to the chat (after a confirm card, or in the same turn). */
export async function saveTaskAnswer(c: PoolClient, chatId: string, a: { text: string; model: string; uses: ToolUse[]; sources: BriefSource[] }) {
  await c.query("INSERT INTO ai_task_chat_messages (id, chat_id, role, content, at, sources, tool_calls) VALUES ($1, $2, 'assistant', $3, clock_timestamp(), $4, $5)", [
    newId(),
    chatId,
    a.text.slice(0, 20_000),
    a.sources.length ? JSON.stringify(a.sources) : null,
    a.uses.length && outside(a.uses).length ? JSON.stringify(outside(a.uses)) : null,
  ]);
  await c.query("UPDATE ai_task_chats SET last_at = now(), model = CASE WHEN $2 = '' THEN model ELSE $2 END WHERE id = $1", [chatId, a.model]);
}

export const taskChatWho = (p: Principal, taskId: string): Who => ({ principal: p, agentId: null, feature: "task_chat", subject: { type: "task", id: taskId } });
export const outsideChips = outside;

@Controller()
export class TaskChatController {
  constructor(@Inject(DEPS) private readonly d: Deps) {}

  /** My chats about this task (newest first) and one of them opened: the newest, or `c`. Nobody else's, ever. */
  @Get("tasks/:id/chat")
  async open(@Req() req: Request, @Param("id") id: string, @Query("c") chatId?: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "ai.use");
    const detail = await guardAi(() => taskAs(this.d, p, id));
    return withTransaction(this.d.pool, async (c) => {
      const chats = (
        await c.query<ChatRow>(`SELECT id, title, last_at AS "lastAt", messages FROM ai_task_chats WHERE user_id = $1 AND task_id = $2 ORDER BY last_at DESC LIMIT 30`, [
          p.id,
          detail.task.id,
        ])
      ).rows;
      const current = chatId ? chats.find((x) => x.id === chatId) : chats[0];
      if (chatId && !current) throw new NotFoundException("chat not found");
      const messages = current
        ? (await c.query(`SELECT id, role, content, at, sources, tool_calls AS "toolCalls" FROM ai_task_chat_messages WHERE chat_id = $1 ORDER BY at`, [current.id])).rows
        : [];
      return { task: { id: detail.task.id, code: detail.task.code, title: detail.task.title }, chats, current: current?.id ?? null, messages };
    });
  }

  /** One turn: my question, the answer grounded in the task brief, both kept in my chat (a new one without `chatId`). */
  @Post("tasks/:id/chat")
  @HttpCode(200)
  async send(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "ai.use");
    const b = parse(z.object({ content: z.string().trim().min(1).max(8000), chatId: z.string().min(10).max(40).nullish(), route: z.string().max(260).optional() }), body);
    const detail = await guardAi(() => taskAs(this.d, p, id));
    const taskId = detail.task.id;
    const history = b.chatId
      ? await withTransaction(this.d.pool, async (c) => {
          const own = await taskChatOf(c, b.chatId!, p.id);
          if (!own || own.taskId !== taskId) throw new NotFoundException("chat not found");
          return (
            await c.query<LoopMessage>(
              "SELECT role, content FROM (SELECT role, content, at FROM ai_task_chat_messages WHERE chat_id = $1 ORDER BY at DESC LIMIT 12) x ORDER BY at",
              [b.chatId],
            )
          ).rows;
        })
      : [];
    const loc = replyLocale(b.content, req);
    const who = taskChatWho(p, taskId);
    const a = await guardAi(async () => answer(this.d, who, loc, b.content, history, b.route, await taskBrief(this.d, p, detail, dataLang(loc))));
    return withTransaction(this.d.pool, async (c) => {
      let chatId = b.chatId ?? null;
      if (!chatId) {
        chatId = newId();
        await c.query("INSERT INTO ai_task_chats (id, user_id, task_id, title, model) VALUES ($1, $2, $3, $4, $5)", [chatId, p.id, taskId, titleFrom(b.content), a.model]);
      }
      await c.query("INSERT INTO ai_task_chat_messages (id, chat_id, role, content, at) VALUES ($1, $2, 'user', $3, clock_timestamp())", [newId(), chatId, b.content]);
      await c.query("UPDATE ai_task_chats SET messages = messages + 1, last_at = now() WHERE id = $1", [chatId]);
      let pending: PendingCard | null = null;
      // A tool waiting for the person's yes: the answer joins the chat when they decide (mcp/controller).
      if (a.pending) pending = await savePending(c, p.id, chatId, { state: a.pending.state, call: a.pending.call });
      else await saveTaskAnswer(c, chatId, a);
      return { chatId, answer: a.text, model: a.model, sources: a.sources, toolCalls: outside(a.uses), ...(pending ? { pending } : {}) };
    });
  }

  /** Deletes one of my chats about this task. */
  @Delete("tasks/:id/chat/:chatId")
  @HttpCode(204)
  async remove(@Req() req: Request, @Param("chatId") chatId: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "ai.use");
    // Mine only; the task may be named by its code in the path, so the chat is matched on its owner.
    const r = await this.d.pool.query("DELETE FROM ai_task_chats WHERE id = $1 AND user_id = $2", [chatId, p.id]);
    if (!r.rowCount) throw new NotFoundException("chat not found");
  }
}
