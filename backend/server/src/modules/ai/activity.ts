import { createHash, randomBytes } from "node:crypto";
import type { AnswerBlock } from "./answer-blocks.js";
import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UnprocessableEntityException,
} from "@nestjs/common";
import type { Request, Response } from "express";
import {
  AttachmentInput,
  historyFor,
  imagesRefused,
  questionMessage,
  readAttachments,
  RefInput,
  refsBlock,
  saveExtras,
  storedExtras,
  type ReadFile,
  type Ref,
} from "./assistant-input.js";
import type { PoolClient } from "pg";
import { z } from "zod";
import {
  appendToOutbox,
  authorize,
  featureDisabled,
  newId,
  recordAudit,
  settingsChanges,
  withTransaction,
  WORKSPACE_TZ_SQL,
  workspaceTimeZone,
  type Principal,
} from "@workspace/shared";
import { bumpHourlyStats, HOURLY_COST, HOURLY_COST_JOIN, HOURLY_UNPRICED } from "./hourly-stats.js";
import { assertAllowed, logger, parse, requirePrincipal } from "@workspace/service-kit";
import { DEPS } from "./ai.controller.js";
import { DEFAULTS } from "./gateway.js";
import { detectSensitive, maskForReader, titleFrom, TOPICS, type Source } from "./insight.js";
import type { Source as ToolSource } from "./tools.js";
import { myInsights } from "./me-insights.js";
import { dataAsAnswer, GROUNDING_RULES, groundWorkspace, guardAnswer, meteredGenerate, noData, parseJson, READ_TOOLS, runAgent, untrusted, type Deps } from "./runtime.js";
import { dataLang, LANGUAGE_NAME, replyIn, replyLocale, workspaceLocale } from "./locale.js";
import { aboutWorkspace, answerBlocked, answerLate } from "./ground.js";
import { taskCodesIn, type BriefTaskDetail } from "./task-brief.js";
import { taskBrief } from "./task-chat.js";
import { aiSinceSql, aiWindow, AUTOMATIC_FEATURES, usesAi } from "./metrics.js";
import { resolveFollowUp } from "./local-model.js";
import { BudgetExceeded, aiDown, budgetHttpError } from "./budgets.js";
import { companyTopics, topicFor } from "./topics.js";
import { answerWithTools, cardsOf, chips, savePending, type ChatAnswer, type ToolChip } from "./mcp/chat.js";
import { toolMode } from "./mcp/loop.js";
import { promptTaskCodes } from "./task-codes.js";
import type { ModelStream } from "./providers.js";
import { followUps, Trace, type Step } from "./progress.js";
import { toolTitle, workspaceTool } from "./workspace-tools.js";
import { stopStream, streamAnswer, untilStopped, type Written } from "./stream.js";

/**
 * AI at work, seen from both sides:
 *
 *  - Trợ lý AI (assistant/*): the company's own chat with GPT, Claude or Gemini on the company's keys.
 *    Every conversation is kept with a topic, a one-line summary and sensitive-data flags.
 *  - The browser extension (internal/monitor/events via the gateway): prompts typed on chatgpt.com,
 *    claude.ai, gemini.google.com and Copilot, recorded the same way, with a notice on those pages.
 *  - Oversight (oversight/*): per person and per department, which tools, how much, for what, and what
 *    looked sensitive. Admins see everyone; managers see their reporting line. Nobody but the person reads
 *    their prompts: the company policy picks topic only, or topic plus the one-line summary the AI wrote
 *    (oversight/me shows the person the very same rows).
 */

type Detail = "topic" | "summary";
export type SensitiveMode = "warn" | "redact" | "block";
export interface Policy {
  detail: Detail;
  captureResponses: boolean;
  retentionDays: number;
  sensitiveMode: SensitiveMode;
  /** People may answer their own questions with the AI on their own computer (personal-ai.ts). */
  allowPersonalAi: boolean;
}
const DEFAULT_POLICY: Policy = { detail: "summary", captureResponses: false, retentionDays: 180, sensitiveMode: "warn", allowPersonalAi: true };
const LABELS: Record<string, string> = { openai: "GPT", anthropic: "Claude", gemini: "Gemini" };

/** Company-AI calls nobody asked for (Home brief, summaries of AI activity): not counted as someone using AI. */
const AUTOMATIC: readonly string[] = AUTOMATIC_FEATURES;
/** Weeks in the AI-use trend (Công việc › AI), the same as the work module's outcomes. */
const TREND_WEEKS = 8;

/**
 * A one-line summary of what the conversation is for (written for a manager, no personal data): the only words
 * about a conversation a manager ever reads. For the company assistant and for what the extension records alike.
 * Best effort and only with a hosted model; without one the conversation has a topic and no summary.
 */
export async function summarizeConversation(d: Deps, p: Principal, id: string) {
  if (d.provider.name === "local") return;
  try {
    // Written once, in the workspace's language (what managers read it in).
    const loc = await workspaceLocale(d);
    const prompts = await withTransaction(d.pool, async (c) =>
      (await c.query<{ content: string }>("SELECT content FROM ai_messages WHERE conversation_id = $1 AND role = 'user' ORDER BY at LIMIT 6", [id])).rows.map((r) =>
        maskForReader(r.content),
      ),
    );
    const r = await meteredGenerate(
      d,
      { principal: p, agentId: null, feature: "ai_activity_summary" },
      {
        tier: "fast",
        system: `Summarise what an employee used an AI assistant for, in one ${LANGUAGE_NAME[loc]} sentence of at most 20 words, as a work activity that starts with a verb and says what the prompts were actually about (do not copy any example). Never repeat names, numbers, IDs or secrets. Also pick one topic from: ${TOPICS.join(", ")}. Reply as JSON {"summary": "...", "topic": "..."}.`,
        messages: [{ role: "user", content: prompts.map((x) => `- ${x.slice(0, 800)}`).join("\n") }],
        maxTokens: 120,
      },
    );
    // A fallback to the offline model echoes the prompt instead of summarising it: no summary then.
    if (r.model.startsWith("local")) return;
    const j = parseJson<{ summary?: string; topic?: string }>(r.text);
    if (!j?.summary) return;
    j.summary = maskForReader(j.summary.replace(/^[-•*\s]+/, ""));
    await withTransaction(d.pool, (c) =>
      c.query("UPDATE ai_conversations SET summary = $2, summary_locale = $5, topic = CASE WHEN $3 = ANY($4::text[]) THEN $3 ELSE topic END WHERE id = $1", [
        id,
        j.summary!.slice(0, 200),
        j.topic ?? "",
        TOPICS,
        loc,
      ]),
    );
  } catch (e) {
    logger.warn({ err: e, conversationId: id }, "ai activity summary failed");
  }
}

export const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export async function policyOf(c: PoolClient): Promise<Policy> {
  const r = (
    await c.query<{ detail: string; capture_responses: boolean; retention_days: number; sensitive_mode: SensitiveMode; allow_personal_ai: boolean }>(
      "SELECT detail, capture_responses, retention_days, sensitive_mode, allow_personal_ai FROM ai_policy LIMIT 1",
    )
  ).rows[0];
  // "full" (admins reading prompts) is not offered: a stored "full" reads as "summary".
  return r
    ? {
        detail: r.detail === "topic" ? "topic" : "summary",
        captureResponses: r.capture_responses,
        retentionDays: r.retention_days,
        sensitiveMode: r.sensitive_mode,
        allowPersonalAi: r.allow_personal_ai,
      }
    : DEFAULT_POLICY;
}

interface Turn {
  userId: string;
  source: Source;
  externalKey: string | null;
  conversationId?: string;
  model: string;
  prompt: string;
  response: string | null;
  at?: Date;
  /** Kinds found before the text reached us (the extension redacted them), so the conversation still says so. */
  extraFlags?: string[];
  /** Outside (MCP) tools the answer used, shown as chips under it. */
  toolCalls?: ToolChip[] | null;
  /** What the workspace tools read or changed for the answer (its citations). */
  sources?: unknown[] | null;
  /** Charts and tables drawn under the answer (answer-blocks.ts). */
  blocks?: AnswerBlock[] | null;
  /** Its steps, notes and next questions (extrasOf), shown again when the conversation is reopened. */
  extras?: Record<string, unknown> | null;
}

/**
 * Sensitive data just went into an AI (first time for this conversation and kind): the workspace's
 * AI admins get a Home notification (the home module), never the text, only who, where and what kind.
 */
export async function alertFlagged(d: Deps, c: PoolClient, userId: string, conversationId: string, source: string, kinds: string[]) {
  if (!kinds.length) return;
  const admins = await d.identity
    .request<{ userIds: string[] }>("GET", "/internal/holders/ai.policy.manage")
    .then((r) => r.userIds.filter((u) => u !== userId))
    .catch(() => [] as string[]);
  if (!admins.length) return;
  await appendToOutbox(c, {
    eventId: newId(),
    eventType: "ai.activity.flagged.v1",
    version: 1,
    aggregateType: "ai.activity",
    aggregateId: conversationId,
    actorId: `user:${userId}`,
    occurredAt: new Date().toISOString(),
    payload: { conversationId, userId, source, kinds, recipients: admins },
  });
}

/** Who the caller may see: everyone (ai.policy.manage) or their reporting line; with names and departments. */
export async function audienceOf(d: Deps, p: Principal) {
  const admin = authorize(p, "ai.policy.manage").allowed;
  const employee = d.services.employee;
  const [dir, r] = await Promise.all([
    employee
      .request<{ employees: { userId: string; displayName: string; title?: string | null; department?: string | null }[] }>("GET", "/employees?all=1", undefined, p)
      .catch(() => ({ employees: [] })),
    admin ? null : employee.request<{ reports: { userId: string }[] }>("GET", "/me/reports", undefined, p).catch(() => ({ reports: [] })),
  ]);
  if (admin || !r) return { admin, people: dir.employees };
  const mine = new Set(r.reports.map((x) => x.userId));
  if (!mine.size) throw new ForbiddenException("only admins and managers see AI activity");
  return { admin, people: dir.employees.filter((x) => mine.has(x.userId)) };
}

/** Adds one prompt (and maybe its answer) to a conversation, creating it on first use; returns its id. */
export async function recordTurn(c: PoolClient, t: Turn): Promise<{ id: string; created: boolean; newFlags: string[]; messageId: string }> {
  const at = t.at ?? new Date();
  let id = t.conversationId ?? null;
  if (!id && t.externalKey) {
    id =
      (await c.query<{ id: string }>("SELECT id FROM ai_conversations WHERE user_id = $1 AND source = $2 AND external_key = $3", [t.userId, t.source, t.externalKey])).rows[0]
        ?.id ?? null;
  }
  const flags = [...new Set([...detectSensitive(t.prompt), ...(t.extraFlags ?? [])])];
  const before = id ? ((await c.query<{ sensitive: string[] }>("SELECT sensitive FROM ai_conversations WHERE id = $1", [id])).rows[0]?.sensitive ?? []) : [];
  let created = false;
  if (!id) {
    id = newId();
    created = true;
    await c.query(
      `INSERT INTO ai_conversations (id, user_id, source, external_key, title, model, topic, summary, sensitive, messages, started_at, last_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, '', $8, 1, $9, $9)`,
      [id, t.userId, t.source, t.externalKey, titleFrom(t.prompt), t.model, await topicFor(c, t.prompt), flags, at],
    );
  } else {
    // A conversation about nothing in particular takes the topic of its first telling prompt.
    await c.query(
      `UPDATE ai_conversations SET messages = messages + 1, last_at = greatest(last_at, $2), model = CASE WHEN $3 = '' THEN model ELSE $3 END,
              topic = CASE WHEN topic = 'other' THEN $4 ELSE topic END,
              sensitive = (SELECT coalesce(array_agg(DISTINCT x), '{}') FROM unnest(sensitive || $5::text[]) x)
        WHERE id = $1`,
      [id, at, t.model, await topicFor(c, t.prompt), flags],
    );
  }
  // A task code in the prompt (T-157) becomes a link suggestion once work confirms the person can see that task.
  const codes = promptTaskCodes(t.prompt);
  if (codes.length)
    await c.query("UPDATE ai_conversations SET hint_task_code = $2 WHERE id = $1 AND task_id IS NULL AND hint_task_id IS NULL AND hint_task_code IS NULL", [id, codes.join(",")]);
  const messageId = newId();
  await c.query("INSERT INTO ai_messages (id, conversation_id, role, content, at) VALUES ($1, $2, 'user', $3, $4)", [messageId, id, t.prompt.slice(0, 20_000), at]);
  await bumpHourlyStats(c, { prompt: { userId: t.userId, source: t.source, at } });
  if (t.response)
    await c.query("INSERT INTO ai_messages (id, conversation_id, role, content, at, tool_calls, sources, blocks, extras) VALUES ($1, $2, 'assistant', $3, $4, $5, $6, $7, $8)", [
      newId(),
      id,
      t.response.slice(0, 20_000),
      new Date(at.getTime() + 1),
      t.toolCalls?.length ? JSON.stringify(t.toolCalls) : null,
      t.sources?.length ? JSON.stringify(t.sources) : null,
      t.blocks?.length ? JSON.stringify(t.blocks) : null,
      t.extras && Object.keys(t.extras).length ? JSON.stringify(t.extras) : null,
    ]);
  return { id, created, newFlags: flags.filter((f) => !before.includes(f)), messageId };
}

/** Where the ask panel was opened, as the tool selection knows places: a channel or a task screen. */
export function pageSurface(refs: Ref[]): "channel" | "task" | null {
  const page = refs.find((r) => r.page);
  return page?.kind === "channel" || page?.kind === "message" ? "channel" : page?.kind === "task" ? "task" : null;
}

/** Hỏi đáp's answer to one question; `stopped` when the person stopped it part-way (streamed only). */
export interface Answer {
  text: string;
  model: string;
  uses?: ChatAnswer["uses"];
  /** What the workspace tools read or changed for this answer (its citations). */
  sources?: ChatAnswer["sources"];
  blocks?: AnswerBlock[];
  pending?: ChatAnswer["pending"];
  /** The tools it ran and with what, kept with the question for follow-ups (never shown). */
  trace?: ChatAnswer["trace"];
  stopped?: boolean;
}
/** A streamed turn: where the text goes, and what of it the person has seen. */
export interface Streamed {
  live: ModelStream;
  written: Written;
}

/** What an answer did, what limits it and what to ask next (progress.ts), sent with it, never stored. */
interface Extras {
  steps: Step[];
  notes: string[];
  followUps: string[];
}
export const extrasOf = (a: Partial<Extras>) => ({
  ...(a.steps?.length ? { steps: a.steps.map(({ id, tool, text, state }) => ({ id, tool, text, state })) } : {}),
  ...(a.notes?.length ? { notes: a.notes } : {}),
  ...(a.followUps?.length ? { followUps: a.followUps } : {}),
});

/**
 * An answer's steps, notes and next questions from its trace (what the stream shows and what is kept with it). Shared by
 * Hỏi đáp and the answer saved after a confirm card (mcp/controller.ts), so a reopened conversation shows both alike.
 */
export function extrasFor(p: Principal, progress: Trace, question: string, sources: ToolSource[] | undefined, surface: "ask" | "channel" | "task" = "ask"): Extras {
  const used = progress.used();
  return {
    steps: progress.steps(),
    notes: progress.notes(),
    followUps: followUps(question, used, sources ?? used.flatMap((u) => u.result.sources), progress.loc, (tool) => offeredTool(tool, p), surface),
  };
}

/** Whether this person is offered a tool (it exists, its feature is on, they have its permission): a next question must work. */
function offeredTool(tool: string, p: Principal): boolean {
  const t = workspaceTool(tool);
  return !!t && !(t.feature && featureDisabled(t.feature)) && authorize(p, t.permission, { ownerId: p.id }).allowed;
}

@Controller()
export class ActivityController {
  constructor(@Inject(DEPS) private readonly d: Deps) {}

  private alert(c: PoolClient, userId: string, conversationId: string, source: string, kinds: string[]) {
    return alertFlagged(this.d, c, userId, conversationId, source, kinds);
  }

  // ---------------------------------------------------------------- Trợ lý AI (the company's assistant)

  /** The models people may pick: one per vendor the company has a key for (OPENAI/ANTHROPIC/GEMINI_API_KEY). */
  @Get("assistant/models")
  models(@Req() req: Request) {
    requirePrincipal(req);
    const gw = this.d.provider as { providers?: () => string[]; menu?: () => { route: string; vendor: string; label: string; model: string }[] };
    // The workspace gateway lists each connection from Admin › AI and each env vendor; a bare gateway (tests) its vendors.
    const models =
      gw.menu?.() ?? (gw.providers?.() ?? []).map((v) => ({ route: `${v}:${DEFAULTS[v]?.smart ?? ""}`, vendor: v, label: LABELS[v] ?? v, model: DEFAULTS[v]?.smart ?? "" }));
    // AI_LOCAL_MODEL=1 (demos, air-gapped trials) makes the built-in model the company's AI: name it, so the composer
    // shows a model rather than "no API key". Its route stays empty, which sends to the default provider.
    if (models.length === 0 && process.env.AI_LOCAL_MODEL === "1") {
      const label = req.headers["x-locale"] === "vi" ? "Mô hình tích hợp" : "Built-in model";
      return { models: [{ route: "", vendor: "local", label, model: "local-extractive" }], offline: false };
    }
    // Without any key the assistant still answers, from the offline extractive model.
    return { models, offline: models.length === 0 };
  }

  @Get("assistant/conversations")
  async myConversations(@Req() req: Request) {
    const p = requirePrincipal(req);
    assertAllowed(p, "ai.use");
    return withTransaction(this.d.pool, async (c) => ({
      conversations: (
        await c.query(
          `SELECT id, title, model, topic, last_at AS "lastAt", messages FROM ai_conversations WHERE user_id = $1 AND source = 'company' ORDER BY last_at DESC LIMIT 100`,
          [p.id],
        )
      ).rows,
      policy: await policyOf(c),
      monitored: (await c.query("SELECT 1 FROM ai_monitor_tokens WHERE user_id = $1", [p.id])).rowCount === 1,
    }));
  }

  @Get("assistant/conversations/:id")
  async myConversation(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "ai.use");
    return withTransaction(this.d.pool, async (c) => {
      const conv = (
        await c.query(`SELECT id, title, model, topic, last_at AS "lastAt", helpful FROM ai_conversations WHERE id = $1 AND user_id = $2 AND source = 'company'`, [id, p.id])
      ).rows[0];
      if (!conv) throw new NotFoundException("conversation not found");
      const cards = await cardsOf(c, p.id, id);
      const messages = (
        await c.query(`SELECT id, role, content, at, tool_calls AS "toolCalls", refs, sources, blocks, extras FROM ai_messages WHERE conversation_id = $1 ORDER BY at`, [id])
      ).rows;
      const files = (
        await c.query<{ messageId: string; id: string; name: string; contentType: string; size: number; kind: string }>(
          `SELECT f.message_id AS "messageId", f.id, f.name, f.content_type AS "contentType", f.size, f.kind
             FROM ai_message_files f JOIN ai_messages m ON m.id = f.message_id WHERE m.conversation_id = $1 ORDER BY f.at`,
          [id],
        )
      ).rows;
      const shown = messages.map(({ extras, ...m }) => {
        const own = files.filter((f) => f.messageId === m.id).map(({ messageId: _, ...f }) => f);
        return { ...m, ...(extras ?? {}), refs: m.refs ?? undefined, ...(own.length ? { files: own } : {}) };
      });
      // A card still waiting for the person's answer is shown where it was, as the answer's bubble.
      const withCards = [...shown, ...cards.map(({ at, ...card }) => ({ id: card.id, role: "assistant", content: "", at, confirm: card }))].sort(
        (x, y) => new Date(x.at as string | Date).getTime() - new Date(y.at as string | Date).getTime(),
      );
      return { conversation: conv, messages: withCards };
    });
  }

  /** Renaming my conversation. The title is masked like a generated one, since managers may see it (policy "summary"). */
  @Patch("assistant/conversations/:id")
  async rename(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "ai.use");
    const b = parse(z.object({ title: z.string().trim().min(1).max(200) }), body);
    const title = titleFrom(b.title);
    return withTransaction(this.d.pool, async (c) => {
      const r = await c.query("UPDATE ai_conversations SET title = $3 WHERE id = $1 AND user_id = $2 AND source = 'company'", [id, p.id, title]);
      if (!r.rowCount) throw new NotFoundException("conversation not found");
      return { title };
    });
  }

  /**
   * Deleting my conversation: its messages and their images go with it (cascade), as do who viewed it and a paused
   * answer waiting on its confirm card. A prompt shared to the library from it stays, without the link back.
   */
  @Delete("assistant/conversations/:id")
  async remove(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "ai.use");
    return withTransaction(this.d.pool, async (c) => {
      const own = await c.query("SELECT 1 FROM ai_conversations WHERE id = $1 AND user_id = $2 AND source = 'company' FOR UPDATE", [id, p.id]);
      if (!own.rowCount) throw new NotFoundException("conversation not found");
      await c.query("DELETE FROM mcp_pending WHERE conversation_id = $1", [id]);
      await c.query("DELETE FROM ai_content_views WHERE conversation_id = $1", [id]);
      await c.query("UPDATE ai_prompt_library SET conversation_id = NULL WHERE conversation_id = $1", [id]);
      await c.query("DELETE FROM ai_conversations WHERE id = $1", [id]);
      return { ok: true };
    });
  }

  /** An image attached to one of my questions (the conversation page shows it again). Only its owner reads it. */
  @Get("assistant/files/:id")
  async myFile(@Req() req: Request, @Res() res: Response, @Param("id") id: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "ai.use");
    const f = await withTransaction(
      this.d.pool,
      async (c) =>
        (await c.query<{ content_type: string; data: Buffer | null }>("SELECT content_type, data FROM ai_message_files WHERE id = $1 AND user_id = $2", [id, p.id])).rows[0],
    );
    if (!f?.data) throw new NotFoundException("file not found");
    res.setHeader("content-type", f.content_type);
    res.setHeader("cache-control", "private, max-age=86400, immutable");
    res.setHeader("x-content-type-options", "nosniff");
    res.end(f.data);
  }

  /** The model's answer to `content` after `history` (the conversation's latest turns). */
  /**
   * The answer, with what it did (steps), what limits it (notes) and what to ask next (followUps), all from its tool
   * calls (progress.ts), no model call. The steps are also streamed as they happen.
   */
  private async answered(
    req: Request,
    p: Principal,
    content: string,
    history: { role: "user" | "assistant"; content: string }[],
    route: string | undefined,
    withConfirm: boolean,
    extras: { files: ReadFile[]; refs: Ref[] },
    streamed: Streamed | undefined,
  ): Promise<Answer & Extras> {
    const loc = replyLocale(content, req);
    const progress = new Trace(loc, toolTitle, streamed?.live.step ? (s) => streamed.live.step!(s) : undefined);
    const answer = await untilStopped(this.answer(req, p, content, history, route, withConfirm, extras, streamed?.live, progress), streamed);
    if (answer.pending || answer.stopped) return { ...answer, steps: progress.steps(), notes: [], followUps: [] };
    return { ...answer, ...extrasFor(p, progress, content, answer.sources, pageSurface(extras.refs) ?? "ask") };
  }

  private async answer(
    req: Request,
    p: Principal,
    content: string,
    history: { role: "user" | "assistant"; content: string }[],
    route: string | undefined,
    withConfirm = true,
    extras: { files: ReadFile[]; refs: Ref[] } = { files: [], refs: [] },
    live?: ModelStream,
    /** Every tool call of this answer, shown as it happens and turned into its notes and next questions. */
    progress?: Trace,
  ): Promise<Answer> {
    try {
      if (this.d.provider.name === "local") {
        // The built-in model cannot write; it answers from the workspace data this person may read (their tasks, the
        // team, leave, documents, messages, people), found with the same read-only tools @AI uses.
        // READ_TOOLS: the first read tools and the area ones a question is routed to ("who is overloaded").
        const readOnly = READ_TOOLS;
        // It reads one question at a time: a follow-up ("what is he working on?", "and the design lead?") is first
        // rewritten to stand alone from the earlier turns of this conversation.
        const question = resolveFollowUp(content, history);
        const run = await runAgent(this.d, p, null, question, "assistant", readOnly, { language: replyLocale(content, req), ...(progress ? { progress } : {}) });
        return { text: run.answer || "…", model: "local-extractive", ...(run.blocks?.length ? { blocks: run.blocks } : {}) };
      } else {
        // Questions about the workspace itself (who is late, how is X doing, project Y, my leave) are answered from
        // its data, read as the asker. The plain chat below sees no workspace data and would make a team up.
        // The screen the panel was opened on (a `page` ref) does not stop these: "who is late?" asked on a task is still
        // about the company. Something the person pointed at or dragged in does.
        const onPage = extras.refs.some((r) => r.page);
        if (!extras.files.length && !extras.refs.some((r) => !r.page)) {
          const asked = resolveFollowUp(content, history);
          const lang = replyLocale(content, req);
          const timeZone = await withTransaction(this.d.pool, workspaceTimeZone).catch(() => undefined);
          const gctx = { services: this.d.services, lang: dataLang(lang), loc: lang, ...(timeZone ? { timeZone } : {}) };
          const late = (await answerLate(gctx, p, asked).catch(() => null)) ?? (await answerBlocked(gctx, p, asked).catch(() => null));
          if (late) {
            progress?.noteRead("team_status", { ok: true, content: late.text, sources: late.sources });
            return { text: late.text, model: "workspace-data" };
          }
          // One intent-routed read for a model that takes no tools. A model that does searches for itself below, and
          // must: "change the refund window in the policy page" is a request to act, not a question to look up.
          const ground = toolMode(this.d, route) !== "none" ? null : await groundWorkspace(this.d, p, asked, lang, timeZone, undefined, progress).catch(() => null);
          if (ground) {
            const r = await meteredGenerate(
              this.d,
              { principal: p, agentId: null, feature: "assistant" },
              {
                tier: "smart",
                system: `You are the company's AI assistant at work. ${replyIn(lang)} Be brief, use Markdown.\n${GROUNDING_RULES}`,
                messages: [...history, { role: "user", content: `${content}\n\n${untrusted(ground.content)}` }],
                maxTokens: 1500,
                ...(route ? { route } : {}),
              },
            ).catch(() => null);
            const text = r?.text.trim() ? guardAnswer(r.text, ground.content, asked, lang) : dataAsAnswer(ground.content, lang);
            return { text, model: r?.text.trim() && text === r.text ? r.model : "workspace-data", ...(ground.blocks.length ? { blocks: ground.blocks } : {}) };
          }
          // Any other question about the workspace's own people, teams, projects or numbers: the read-only agent
          // searches first and answers only from what it finds, or says it has no data. The plain chat below would
          // otherwise invent a team, a figure or a city.
          // (A model that takes tools searches for itself, below, with the workspace's own tools.)
          if (toolMode(this.d, route) === "none" && !onPage && aboutWorkspace(asked)) {
            // READ_TOOLS: the first read tools and the area ones a question is routed to ("who is overloaded").
            const readOnly = READ_TOOLS;
            const run = await runAgent(this.d, p, null, asked, "assistant", readOnly, { language: lang, strict: true, ...(progress ? { progress } : {}) });
            return {
              text: run.answer || noData(asked, lang),
              model: run.toolCalls.length ? "workspace-data" : "assistant",
              ...(run.blocks?.length ? { blocks: run.blocks } : {}),
            };
          }
        }
        const lang = replyLocale(content, req);
        const system = `You are the company's AI assistant at work. Answer clearly and practically. Use Markdown for lists, tables and code. Never invent company data (people, numbers, prices, places); use a clear placeholder only when the person asks for a template. ${replyIn(lang)}`;
        // A task code in the question (@WEB-42, T-041) brings that task's brief along, read as the asker; the usage then
        // counts on the task. Only the model sees it: the conversation keeps the question as typed.
        // Tasks pointed at with @ are read below with the other references, not twice.
        const pointed = new Set(extras.refs.filter((r) => r.kind === "task").map((r) => r.label.split(/\s/)[0]?.toUpperCase()));
        // Both read as the asker from other modules and do not depend on each other: together, before the model.
        const [attached, refsText] = await Promise.all([
          this.taskContext(req, p, content, pointed),
          extras.refs.length ? refsBlock(this.d, p, extras.refs, dataLang(lang)) : Promise.resolve(""),
        ]);
        const question = questionMessage(attached ? `${content}\n\n${attached.text}` : content, refsText, extras.files);
        const task = attached?.taskId ?? extras.refs.find((r) => r.kind === "task")?.id;
        // Office files and tables keep their bytes for the Office tools (read, analyse, fill, edit).
        const files = extras.files.flatMap((f) => (f.kind === "file" && f.data ? [{ name: f.name, contentType: f.contentType, data: f.data }] : []));
        const who = { principal: p, agentId: null, feature: "assistant", subject: task ? { type: "task" as const, id: task } : null, progress, files };
        // With a model that takes tools the answer is a tool loop: the workspace's own tools (search what the asker may
        // read, open an item, and, after their yes on a card, change tasks, the calendar and pages) and the company's
        // outside tools (MCP). A regenerated answer gets no card, so nothing that changes is offered there.
        const withTools = await answerWithTools(this.d, who, system, [...history, question], route, withConfirm, {
          workspace: true,
          loc: lang,
          live,
          question: resolveFollowUp(content, history),
          // Asked from the panel on a channel or a task: that place's tools are shown, as for @AI there.
          ...(pageSurface(extras.refs) ? { surface: pageSurface(extras.refs)! } : {}),
        });
        if (withTools) return withTools;
        // Only this plain answer is streamed: the paths above check or rework the model's text before it is shown.
        const r = await meteredGenerate(this.d, who, {
          tier: "smart",
          system,
          messages: [...history, question],
          maxTokens: 2048,
          ...(route ? { route } : {}),
          ...(live ? { stream: live } : {}),
        });
        return r.stopped ? { text: r.text, model: r.model, stopped: true } : { text: r.text || "…", model: r.model };
      }
    } catch (e) {
      if (e instanceof BudgetExceeded) throw budgetHttpError(e);
      if (extras.files.some((f) => f.kind === "image") && imagesRefused(e))
        throw new UnprocessableEntityException({ error: "images_unsupported", message: "this model does not read images" });
      throw aiDown(e);
    }
  }

  /** The briefs of the tasks a question names by code (two at most), or null when it names none the asker can open. */
  private async taskContext(req: Request, p: Principal, content: string, skip: Set<string | undefined> = new Set()): Promise<{ text: string; taskId: string } | null> {
    const codes = taskCodesIn(content).filter((code) => !skip.has(code.toUpperCase()));
    if (!codes.length) return null;
    const lang = dataLang(replyLocale(content, req));
    const parts: { code: string; id: string; text: string }[] = [];
    for (const code of codes) {
      const detail = await this.d.services.work.request<BriefTaskDetail>("GET", `/tasks/${encodeURIComponent(code)}`, undefined, p).catch(() => null);
      if (!detail) continue;
      const b = await taskBrief(this.d, p, detail, lang).catch(() => null);
      if (b) parts.push({ code: detail.task.code, id: detail.task.id, text: b.brief.text.slice(0, codes.length > 1 ? 5000 : 9000) });
    }
    if (!parts.length) return null;
    return { taskId: parts[0]!.id, text: parts.map((x) => `Workspace data about task ${x.code} (read with the asker's access):\n${untrusted(x.text)}`).join("\n\n") };
  }

  /**
   * "Trả lời lại": a new answer to the conversation's last question, in place of the last answer (same message, so
   * the conversation keeps one answer per question). Metered like any call; it is not a new prompt in AI Insights.
   */
  @Post("assistant/conversations/:id/regenerate")
  async regenerate(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    return this.redo(req, requirePrincipal(req), id, body);
  }

  /** The same, written as it comes (stream.ts). */
  @Post("assistant/conversations/:id/regenerate/stream")
  async regenerateStream(@Req() req: Request, @Res() res: Response, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    await streamAnswer(res, p.id, (live, written) => this.redo(req, p, id, body, { live, written }));
  }

  /** The person's stop button on a streamed answer: it ends with what was written, and that is what is kept. */
  @Post("assistant/streams/:id/stop")
  @HttpCode(204)
  stop(@Req() req: Request, @Param("id") id: string) {
    stopStream(id, requirePrincipal(req).id);
  }

  private async redo(req: Request, p: Principal, id: string, body: unknown, streamed?: Streamed) {
    assertAllowed(p, "ai.use");
    const b = parse(z.object({ route: z.string().max(260).optional() }), body ?? {});
    const { turns, question, extras } = await withTransaction(this.d.pool, async (c) => {
      const own = (await c.query("SELECT 1 FROM ai_conversations WHERE id = $1 AND user_id = $2 AND source = 'company'", [id, p.id])).rowCount;
      if (!own) throw new NotFoundException("conversation not found");
      const turns = await historyFor(c, id, 22);
      const q = turns.at(-2);
      // The question itself goes again as it was asked: its own text, files, images and @ references in full.
      const raw = q ? (await c.query<{ content: string }>("SELECT content FROM ai_messages WHERE id = $1", [q.id])).rows[0]?.content : undefined;
      return { turns, question: raw, extras: q ? await storedExtras(c, q.id) : { files: [], refs: [] } };
    });
    const last = turns.at(-1);
    if (last?.role !== "assistant" || turns.at(-2)?.role !== "user" || question === undefined) throw new NotFoundException("no answer to redo");
    const history = turns.slice(0, -2).map(({ role, content }) => ({ role, content }));
    // No confirm card here: tools that ask first are left out of a redo.
    const answer = await this.answered(req, p, question, history, b.route, false, extras, streamed);
    // Stopped before a word was written: the earlier answer stays.
    if (answer.stopped && !answer.text.trim()) return { answer: "", model: answer.model, toolCalls: [], stopped: true };
    await withTransaction(this.d.pool, async (c) => {
      const extras = extrasOf(answer);
      await c.query("UPDATE ai_messages SET content = $2, tool_calls = $3, sources = $4, blocks = $5, extras = $6 WHERE id = $1", [
        last.id,
        answer.text.slice(0, 20_000),
        answer.uses?.length ? JSON.stringify(chips(answer.uses)) : null,
        answer.sources?.length ? JSON.stringify(answer.sources) : null,
        answer.blocks?.length ? JSON.stringify(answer.blocks) : null,
        Object.keys(extras).length ? JSON.stringify(extras) : null,
      ]);
      await c.query("UPDATE ai_conversations SET last_at = now(), model = $2 WHERE id = $1", [id, answer.model]);
      // The new answer's lookups replace the old one's: a follow-up refines what is shown now.
      await c.query("UPDATE ai_messages SET tool_trace = $2 WHERE id = $1", [turns.at(-2)!.id, answer.trace?.length ? JSON.stringify(answer.trace) : null]);
    });
    return {
      answer: answer.text,
      model: answer.model,
      toolCalls: chips(answer.uses ?? []),
      sources: answer.sources ?? [],
      blocks: answer.blocks ?? [],
      ...extrasOf(answer),
      ...(answer.stopped ? { stopped: true } : {}),
    };
  }

  /** One turn: the person's message, the model's answer (with the conversation so far), both kept. */
  @Post("assistant/messages")
  async send(@Req() req: Request, @Body() body: unknown) {
    return this.turn(req, requirePrincipal(req), body);
  }

  /** The same, the answer written as it comes (stream.ts). What is stored is what was streamed, or where it was stopped. */
  @Post("assistant/messages/stream")
  async sendStream(@Req() req: Request, @Res() res: Response, @Body() body: unknown) {
    const p = requirePrincipal(req);
    await streamAnswer(res, p.id, (live, written) => this.turn(req, p, body, { live, written }));
  }

  private async turn(req: Request, p: Principal, body: unknown, streamed?: Streamed) {
    assertAllowed(p, "ai.use");
    const b = parse(
      z.object({
        conversationId: z.string().min(10).max(40).optional(),
        content: z.string().trim().min(1).max(12_000),
        route: z.string().max(260).optional(),
        attachments: z.array(AttachmentInput).max(6).default([]),
        refs: z.array(RefInput).max(8).default([]),
      }),
      body,
    );
    const history = b.conversationId
      ? await withTransaction(this.d.pool, async (c) => {
          const own = (await c.query("SELECT 1 FROM ai_conversations WHERE id = $1 AND user_id = $2 AND source = 'company'", [b.conversationId, p.id])).rowCount;
          if (!own) throw new NotFoundException("conversation not found");
          // A card left unanswered will never go on: it becomes a "not done" line, which the model reads too.
          await cardsOf(c, p.id, b.conversationId!, true);
          return (await historyFor(c, b.conversationId!, 20)).map(({ role, content }) => ({ role, content }));
        })
      : [];
    const files = await readAttachments(b.attachments);
    const answer = await this.answered(req, p, b.content, history, b.route, true, { files, refs: b.refs }, streamed);
    // Stopped before a word was written: nothing to keep, the question goes back to the composer.
    if (answer.stopped && !answer.text.trim()) return { conversationId: b.conversationId ?? null, answer: "", model: answer.model, toolCalls: [], stopped: true };
    const saved = await withTransaction(this.d.pool, async (c) => {
      const r = await recordTurn(c, {
        userId: p.id,
        source: "company",
        externalKey: null,
        ...(b.conversationId ? { conversationId: b.conversationId } : {}),
        model: answer.model,
        prompt: b.content,
        // A tool waiting for the person's yes: the answer joins the conversation when they decide (mcp/controller).
        response: answer.pending ? null : answer.text,
        toolCalls: answer.uses?.length ? chips(answer.uses) : null,
        sources: answer.sources?.length ? answer.sources : null,
        blocks: answer.blocks?.length ? answer.blocks : null,
        extras: extrasOf(answer),
      });
      await this.alert(c, p.id, r.id, "company", r.newFlags);
      await saveExtras(c, p.id, r.messageId, files, b.refs);
      if (answer.trace?.length) await c.query("UPDATE ai_messages SET tool_trace = $2 WHERE id = $1", [r.messageId, JSON.stringify(answer.trace)]);
      const pending = answer.pending ? await savePending(c, p.id, r.id, answer.pending) : null;
      return { ...r, pending };
    });
    if (saved.created || history.length % 10 === 8) void summarizeConversation(this.d, p, saved.id);
    return {
      conversationId: saved.id,
      answer: answer.text,
      model: answer.model,
      toolCalls: chips(answer.uses ?? []),
      sources: answer.sources ?? [],
      blocks: answer.blocks ?? [],
      ...extrasOf(answer),
      ...(saved.pending ? { pending: saved.pending } : {}),
      ...(answer.stopped ? { stopped: true } : {}),
    };
  }

  // ---------------------------------------------------------------- the browser extension

  /** Whether my browser extension is connected. */
  @Get("monitor/connection")
  async connection(@Req() req: Request) {
    const p = requirePrincipal(req);
    return withTransaction(this.d.pool, async (c) => ({
      connection: (await c.query(`SELECT created_at AS "createdAt", last_seen_at AS "lastSeenAt" FROM ai_monitor_tokens WHERE user_id = $1`, [p.id])).rows[0] ?? null,
    }));
  }

  /** A new connection code for the extension (replaces the old one, which stops working). Shown once. */
  @Post("monitor/connection")
  async connect(@Req() req: Request) {
    const p = requirePrincipal(req);
    if (p.type !== "user") throw new ForbiddenException("people only");
    const token = `aim_${randomBytes(24).toString("base64url")}`;
    await withTransaction(this.d.pool, (c) =>
      c.query(
        `INSERT INTO ai_monitor_tokens (user_id, token_hash) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, created_at = now(), last_seen_at = NULL`,
        [p.id, hash(token)],
      ),
    );
    return { token };
  }

  @Delete("monitor/connection")
  @HttpCode(204)
  async disconnect(@Req() req: Request) {
    const p = requirePrincipal(req);
    await withTransaction(this.d.pool, (c) => c.query("DELETE FROM ai_monitor_tokens WHERE user_id = $1", [p.id]));
  }

  // The extension batches themselves (internal/monitor/events) are taken in monitor-intake.ts.

  // ---------------------------------------------------------------- oversight (managers and admins)

  private audience(p: Principal) {
    return audienceOf(this.d, p);
  }

  @Get("oversight")
  async oversight(@Req() req: Request, @Query("days") daysQ?: string) {
    const p = requirePrincipal(req);
    const days = aiWindow(daysQ);
    const { admin, people } = await this.audience(p);
    const ids = people.map((x) => x.userId);
    return withTransaction(this.d.pool, async (c) => {
      const policy = await policyOf(c);
      // Retention is the hourly `ai-retention` job (ai_prune_expired); a read never deletes.
      const since = aiSinceSql(days);
      const rows = (
        await c.query<{ user_id: string; source: string; topic: string; conversations: number; prompts: number; flagged: number; last: Date }>(
          `SELECT user_id, source, topic, count(*)::int AS conversations, sum(messages)::int AS prompts,
                  count(*) FILTER (WHERE cardinality(sensitive) > 0)::int AS flagged, max(last_at) AS last
             FROM ai_conversations WHERE last_at > ${since} AND user_id = ANY($1::text[]) GROUP BY user_id, source, topic`,
          [ids],
        )
      ).rows;
      const byPerson = new Map<
        string,
        { sources: Record<string, number>; topics: Record<string, number>; conversations: number; prompts: number; flagged: number; lastAt: Date | null }
      >();
      for (const r of rows) {
        const x = byPerson.get(r.user_id) ?? { sources: {}, topics: {}, conversations: 0, prompts: 0, flagged: 0, lastAt: null };
        x.sources[r.source] = (x.sources[r.source] ?? 0) + r.prompts;
        x.topics[r.topic] = (x.topics[r.topic] ?? 0) + r.prompts;
        x.conversations += r.conversations;
        x.prompts += r.prompts;
        x.flagged += r.flagged;
        x.lastAt = !x.lastAt || r.last > x.lastAt ? r.last : x.lastAt;
        byPerson.set(r.user_id, x);
      }
      const connected = new Set(
        (await c.query<{ user_id: string }>("SELECT user_id FROM ai_monitor_tokens WHERE user_id = ANY($1::text[]) AND last_seen_at > now() - interval '14 days'", [ids])).rows.map(
          (r) => r.user_id,
        ),
      );
      // The company AI inside the app (summaries, translation, task and doc helpers, agents): calls and tokens
      // per person and feature. The assistant's own chats are counted above as conversations; its tokens are here.
      // From the hourly rollup (ai_hourly_stats), not the usage rows: the window is hours, so `since` is rounded
      // down to the hour it falls in.
      const sinceHour = `date_trunc('hour', ${since})`;
      const usage = (
        await c.query<{ user_id: string; feature: string; calls: number; tokens: number; cost: number; unpriced: number }>(
          `SELECT s.user_id, s.feature, sum(s.calls)::int AS calls, sum(s.input_tokens + s.output_tokens)::bigint::float AS tokens,
                  coalesce(sum(${HOURLY_COST}), 0)::float AS cost, coalesce(sum(${HOURLY_UNPRICED}), 0)::bigint::float AS unpriced
             FROM ai_hourly_stats s ${HOURLY_COST_JOIN}
            WHERE s.feature <> '' AND s.hour >= ${sinceHour} AND s.user_id = ANY($1::text[]) AND s.feature NOT IN (${AUTOMATIC.map((f) => `'${f}'`).join(",")})
            GROUP BY s.user_id, s.feature`,
          [ids],
        )
      ).rows;
      // Cost counts every call made for these people, automatic ones included (the company pays for those too).
      const automatic = (
        await c.query<{ user_id: string; cost: number; unpriced: number }>(
          `SELECT s.user_id, coalesce(sum(${HOURLY_COST}), 0)::float AS cost, coalesce(sum(${HOURLY_UNPRICED}), 0)::bigint::float AS unpriced
             FROM ai_hourly_stats s ${HOURLY_COST_JOIN}
            WHERE s.hour >= ${sinceHour} AND s.user_id = ANY($1::text[]) AND s.feature IN (${AUTOMATIC.map((f) => `'${f}'`).join(",")})
            GROUP BY s.user_id`,
          [ids],
        )
      ).rows;
      const inApp = new Map<string, { calls: number; tokens: number; cost: number; unpriced: number; features: Record<string, number> }>();
      const features = new Map<string, { feature: string; calls: number; tokens: number; cost: number; people: number }>();
      for (const r of usage) {
        const x = inApp.get(r.user_id) ?? { calls: 0, tokens: 0, cost: 0, unpriced: 0, features: {} };
        if (r.feature !== "assistant") {
          x.calls += r.calls;
          x.features[r.feature] = (x.features[r.feature] ?? 0) + r.calls;
        }
        x.tokens += r.tokens;
        x.cost += r.cost;
        x.unpriced += r.unpriced;
        inApp.set(r.user_id, x);
        const f = features.get(r.feature) ?? { feature: r.feature, calls: 0, tokens: 0, cost: 0, people: 0 };
        f.calls += r.calls;
        f.tokens += r.tokens;
        f.cost += r.cost;
        f.people++;
        features.set(r.feature, f);
      }
      for (const r of automatic) {
        const x = inApp.get(r.user_id) ?? { calls: 0, tokens: 0, cost: 0, unpriced: 0, features: {} };
        x.cost += r.cost;
        x.unpriced += r.unpriced;
        inApp.set(r.user_id, x);
      }
      // What the company AI worked on: calls tied to a task, a document, a meeting… (the rest had no subject).
      const subjects = (
        await c.query<{ type: string; calls: number; items: number }>(
          `SELECT subject_type AS type, count(*)::int AS calls, count(DISTINCT subject_id)::int AS items
             FROM ai_usage WHERE at > ${since} AND user_id = ANY($1::text[]) AND subject_type IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`,
          [ids],
        )
      ).rows;
      const out = people
        .map((x) => ({
          userId: x.userId,
          displayName: x.displayName,
          title: x.title ?? null,
          department: x.department ?? null,
          extension: connected.has(x.userId),
          ...(byPerson.get(x.userId) ?? { sources: {}, topics: {}, conversations: 0, prompts: 0, flagged: 0, lastAt: null }),
          inApp: inApp.get(x.userId) ?? { calls: 0, tokens: 0, cost: 0, unpriced: 0, features: {} },
        }))
        .sort((a, b) => b.prompts + b.inApp.calls - (a.prompts + a.inApp.calls) || a.displayName.localeCompare(b.displayName));
      const departments = new Map<
        string,
        {
          name: string | null;
          people: number;
          active: number;
          prompts: number;
          inApp: number;
          tokens: number;
          cost: number;
          flagged: number;
          sources: Record<string, number>;
          topics: Record<string, number>;
        }
      >();
      for (const x of out) {
        const k = x.department ?? "";
        const d = departments.get(k) ?? { name: x.department, people: 0, active: 0, prompts: 0, inApp: 0, tokens: 0, cost: 0, flagged: 0, sources: {}, topics: {} };
        d.people++;
        if (usesAi({ prompts: x.prompts, inAppCalls: x.inApp.calls })) d.active++;
        d.prompts += x.prompts;
        d.inApp += x.inApp.calls;
        d.tokens += x.inApp.tokens;
        d.cost += x.inApp.cost;
        d.flagged += x.flagged;
        for (const [s, n] of Object.entries(x.sources)) d.sources[s] = (d.sources[s] ?? 0) + n;
        for (const [s, n] of Object.entries(x.topics)) d.topics[s] = (d.topics[s] ?? 0) + n;
        departments.set(k, d);
      }
      const daily = (
        await c.query<{ day: string; source: string; prompts: number }>(
          `SELECT to_char(hour AT TIME ZONE ${WORKSPACE_TZ_SQL}, 'YYYY-MM-DD') AS day, source, sum(prompts)::int AS prompts
             FROM ai_hourly_stats WHERE feature = '' AND hour >= ${sinceHour} AND user_id = ANY($1::text[]) GROUP BY 1, 2 ORDER BY 1`,
          [ids],
        )
      ).rows;
      // Eight weeks (from Monday, in the workspace's zone) of AI use by these people, for the trend next to work done.
      const weekly = (
        await c.query<{ week: string; prompts: number; inApp: number; people: number }>(
          `WITH w AS (
             SELECT generate_series(date_trunc('week', now() AT TIME ZONE ${WORKSPACE_TZ_SQL}) - interval '${TREND_WEEKS - 1} weeks',
                                    date_trunc('week', now() AT TIME ZONE ${WORKSPACE_TZ_SQL}), interval '1 week') AS week),
           e AS (
             SELECT user_id, date_trunc('week', hour AT TIME ZONE ${WORKSPACE_TZ_SQL}) AS week,
                    CASE WHEN feature = '' THEN prompts ELSE 0 END AS prompt, CASE WHEN feature = '' THEN 0 ELSE calls END AS app
               FROM ai_hourly_stats WHERE user_id = ANY($1::text[]) AND hour >= date_trunc('hour', now() - interval '${TREND_WEEKS} weeks')
                AND feature NOT IN ('assistant', ${AUTOMATIC.map((f) => `'${f}'`).join(",")}))
           SELECT to_char(w.week, 'YYYY-MM-DD') AS week, coalesce(sum(e.prompt), 0)::int AS prompts, coalesce(sum(e.app), 0)::int AS "inApp",
                  count(DISTINCT e.user_id)::int AS people
             FROM w LEFT JOIN e ON e.week = w.week GROUP BY w.week ORDER BY w.week`,
          [ids],
        )
      ).rows;
      // What these people's company AI cost each of those weeks (every call, automatic ones included).
      const weeklyCost = new Map(
        (
          await c.query<{ week: string; cost: number }>(
            `SELECT to_char(date_trunc('week', s.hour AT TIME ZONE ${WORKSPACE_TZ_SQL}), 'YYYY-MM-DD') AS week, coalesce(sum(${HOURLY_COST}), 0)::float AS cost
               FROM ai_hourly_stats s ${HOURLY_COST_JOIN}
              WHERE s.feature <> '' AND s.user_id = ANY($1::text[]) AND s.hour >= date_trunc('hour', now() - interval '${TREND_WEEKS} weeks') GROUP BY 1`,
            [ids],
          )
        ).rows.map((r) => [r.week, r.cost]),
      );
      for (const w of weekly) (w as typeof w & { cost: number }).cost = weeklyCost.get(w.week) ?? 0;
      // "AI có giúp không?": the people's own one-tap answers, by tool, topic and department (only answered ones).
      const answers = (
        await c.query<{ user_id: string; source: string; topic: string; yes: number; no: number; partly: number }>(
          `SELECT user_id, source, topic, count(*) FILTER (WHERE helpful = 'yes')::int AS yes, count(*) FILTER (WHERE helpful = 'no')::int AS no,
                  count(*) FILTER (WHERE helpful = 'partly')::int AS partly
             FROM ai_conversations WHERE last_at > ${since} AND user_id = ANY($1::text[]) AND helpful IS NOT NULL GROUP BY user_id, source, topic`,
          [ids],
        )
      ).rows;
      const deptOf = new Map(people.map((x) => [x.userId, x.department ?? null]));
      const tally = (key: (r: (typeof answers)[number]) => string | null) => {
        const m = new Map<string | null, { key: string | null; yes: number; no: number; partly: number }>();
        for (const r of answers) {
          const k = key(r);
          const x = m.get(k) ?? { key: k, yes: 0, no: 0, partly: 0 };
          x.yes += r.yes;
          x.no += r.no;
          x.partly += r.partly;
          m.set(k, x);
        }
        return [...m.values()].sort((a, b) => b.yes + b.no + b.partly - (a.yes + a.no + a.partly));
      };
      const helpful = { sources: tally((r) => r.source), topics: tally((r) => r.topic), departments: tally((r) => deptOf.get(r.user_id) ?? null) };
      const recent = await this.conversations(c, policy, "v.user_id = ANY($1::text[])", [ids], 40, since);
      const flagged = await this.conversations(c, policy, "v.user_id = ANY($1::text[]) AND cardinality(v.sensitive) > 0", [ids], 20, since);
      return {
        days,
        /** The workspace's zone: days and weeks above are counted in it. */
        timeZone: await workspaceTimeZone(c),
        policy,
        canEditPolicy: admin,
        /** The company's own topic names (Admin › AI), so its topics don't show as "other". */
        topicLabels: (await companyTopics(c)).topics.filter((x) => x.labelVi || x.labelEn).map((x) => ({ key: x.key, labelVi: x.labelVi, labelEn: x.labelEn })),
        totals: {
          people: out.length,
          active: out.filter((x) => usesAi({ prompts: x.prompts, inAppCalls: x.inApp.calls })).length,
          inApp: out.reduce((n, x) => n + x.inApp.calls, 0),
          tokens: out.reduce((n, x) => n + x.inApp.tokens, 0),
          cost: out.reduce((n, x) => n + x.inApp.cost, 0),
          unpricedTokens: out.reduce((n, x) => n + x.inApp.unpriced, 0),
          prompts: out.reduce((n, x) => n + x.prompts, 0),
          outside: out.reduce((n, x) => n + Object.entries(x.sources).reduce((m, [s, k]) => m + (s === "company" ? 0 : k), 0), 0),
          flagged: out.reduce((n, x) => n + x.flagged, 0),
          extension: out.filter((x) => x.extension).length,
        },
        people: out,
        departments: [...departments.values()].sort((a, b) => Number(a.name === null) - Number(b.name === null) || b.prompts - a.prompts),
        daily,
        weekly,
        features: [...features.values()].sort((a, b) => b.calls - a.calls),
        subjects,
        helpful,
        recent,
        flagged,
      };
    });
  }

  /** "Nhắc cài tiện ích": everyone in my audience whose extension has not sent anything in 14 days gets a Home notice. */
  @Post("oversight/remind-extension")
  @HttpCode(200)
  async remindExtension(@Req() req: Request) {
    const p = requirePrincipal(req);
    const { people } = await this.audience(p);
    return withTransaction(this.d.pool, async (c) => {
      const on = new Set((await c.query<{ user_id: string }>("SELECT user_id FROM ai_monitor_tokens WHERE last_seen_at > now() - interval '14 days'")).rows.map((r) => r.user_id));
      const missing = people.map((x) => x.userId).filter((u) => !on.has(u) && u !== p.id);
      if (missing.length)
        await appendToOutbox(c, {
          eventId: newId(),
          eventType: "ai.extension.reminded.v1",
          version: 1,
          aggregateType: "ai.activity",
          aggregateId: "workspace",
          actorId: `user:${p.id}`,
          occurredAt: new Date().toISOString(),
          payload: { recipients: missing },
        });
      return { reminded: missing.length };
    });
  }

  /** One person's AI conversations in the window (what a manager opens from the people table). */
  @Get("oversight/people/:userId")
  async person(@Req() req: Request, @Param("userId") userId: string, @Query("days") daysQ?: string) {
    const p = requirePrincipal(req);
    const days = [7, 30, 90].includes(Number(daysQ)) ? Number(daysQ) : 30;
    const { people } = await this.audience(p);
    const who = people.find((x) => x.userId === userId);
    if (!who) throw new NotFoundException("not in your team");
    return withTransaction(this.d.pool, async (c) => {
      const policy = await policyOf(c);
      return {
        person: who,
        policy,
        conversations: await this.conversations(c, policy, "v.user_id = $1", [userId], 200, `now() - make_interval(days => ${days})`),
      };
    });
  }

  /** Transparency: the policy and exactly what my managers can see about me. */
  @Get("oversight/me")
  async me(@Req() req: Request) {
    const p = requirePrincipal(req);
    return withTransaction(this.d.pool, async (c) => {
      const policy = await policyOf(c);
      return {
        policy,
        stats: (
          await c.query(
            `SELECT source, count(*)::int AS conversations, sum(messages)::int AS prompts FROM ai_conversations WHERE user_id = $1 AND last_at > now() - interval '30 days' GROUP BY source`,
            [p.id],
          )
        ).rows,
        extension: (await c.query(`SELECT created_at AS "createdAt", last_seen_at AS "lastSeenAt" FROM ai_monitor_tokens WHERE user_id = $1`, [p.id])).rows[0] ?? null,
        // Exactly what AI › Áp dụng AI › Mức sử dụng shows a manager about me over 30 days: the same conversation rows (masked by the
        // same policy) and the company-AI features I used, so "Dữ liệu AI của tôi" is never a guess.
        managerSees: {
          days: 30,
          conversations: await this.conversations(c, policy, "v.user_id = $1", [p.id], 50, "now() - interval '30 days'"),
          features: (
            await c.query<{ feature: string; calls: number }>(
              `SELECT feature, count(*)::int AS calls FROM ai_usage WHERE user_id = $1 AND at > now() - interval '30 days'
                 AND feature NOT IN ('assistant', ${AUTOMATIC.map((f) => `'${f}'`).join(",")}) GROUP BY feature ORDER BY 2 DESC`,
              [p.id],
            )
          ).rows,
        },
        // AI Insights for the person (me-insights.ts): this week, "có giúp", task links, warnings, erasure.
        insights: await myInsights(this.d, c, p),
      };
    });
  }

  /**
   * "Xóa toàn bộ dữ liệu giám sát AI": everything the extension ever recorded for this workspace (conversations
   * and messages from ChatGPT/Claude/Gemini/Copilot, who viewed them, the connection codes). Company-AI
   * conversations stay. For companies that switch monitoring off and want nothing left behind; logged in ai_audit.
   */
  @Delete("monitor/data")
  async purgeMonitoring(@Req() req: Request) {
    const p = requirePrincipal(req);
    assertAllowed(p, "ai.policy.manage");
    return withTransaction(this.d.pool, async (c) => {
      // 5,000 conversations at a time (a workspace can hold hundreds of thousands), never the whole id list in memory.
      let conversations = 0;
      let messages = 0;
      for (;;) {
        const ids = (await c.query<{ id: string }>("SELECT id FROM ai_conversations WHERE source <> 'company' LIMIT 5000")).rows.map((r) => r.id);
        if (!ids.length) break;
        messages += (await c.query("DELETE FROM ai_messages WHERE conversation_id = ANY($1::text[])", [ids])).rowCount ?? 0;
        await c.query("DELETE FROM ai_content_views WHERE conversation_id = ANY($1::text[])", [ids]);
        conversations += (await c.query("DELETE FROM ai_conversations WHERE id = ANY($1::text[])", [ids])).rowCount ?? 0;
      }
      await c.query("DELETE FROM ai_hourly_stats WHERE feature = '' AND source <> 'company'");
      const tokens = (await c.query("DELETE FROM ai_monitor_tokens")).rowCount ?? 0;
      await c.query("INSERT INTO ai_audit (id, actor_id, agent_id, tool, allowed, reason, input) VALUES ($1,$2,NULL,'monitor.purge',true,NULL,$3)", [
        newId(),
        p.id,
        JSON.stringify({ conversations, messages, tokens }),
      ]);
      await recordAudit(c, { action: "ai.monitor.data_deleted", targetType: "ai_policy", targetId: "workspace", meta: { conversations, messages, tokens } });
      return { conversations, messages, tokens };
    });
  }

  @Get("policy")
  async getPolicy(@Req() req: Request) {
    const p = requirePrincipal(req);
    return withTransaction(this.d.pool, async (c) => ({ policy: await policyOf(c), canEdit: authorize(p, "ai.policy.manage").allowed }));
  }

  @Put("policy")
  async setPolicy(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "ai.policy.manage");
    const b = parse(
      z.object({
        detail: z.enum(["topic", "summary"]),
        captureResponses: z.boolean(),
        retentionDays: z.number().int().min(7).max(730),
        // Optional: a client that leaves it out keeps the current mode.
        sensitiveMode: z.enum(["warn", "redact", "block"]).optional(),
      }),
      body,
    );
    return withTransaction(this.d.pool, async (c) => {
      const prev = await policyOf(c);
      await c.query(
        `INSERT INTO ai_policy (detail, capture_responses, retention_days, sensitive_mode, updated_by) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (singleton) DO UPDATE SET detail = EXCLUDED.detail, capture_responses = EXCLUDED.capture_responses, retention_days = EXCLUDED.retention_days,
           sensitive_mode = EXCLUDED.sensitive_mode, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [b.detail, b.captureResponses, b.retentionDays, b.sensitiveMode ?? prev.sensitiveMode, p.id],
      );
      // The audit trail (ADR 0025): what is recorded about AI use, before and after.
      const shown = (x: { detail: string; captureResponses: boolean; retentionDays: number; sensitiveMode: string }) => ({
        recording: x.detail,
        captureResponses: x.captureResponses,
        retentionDays: x.retentionDays,
        sensitiveMode: x.sensitiveMode,
      });
      const changes = settingsChanges(shown(prev), shown({ ...b, sensitiveMode: b.sensitiveMode ?? prev.sensitiveMode }));
      if (Object.keys(changes).length) await recordAudit(c, { action: "ai.policy.changed", targetType: "ai_policy", targetId: "workspace", changes });
      // Decree 13/2023: people are told when what is recorded about them changes.
      const before = prev;
      if (before.detail !== b.detail || before.captureResponses !== b.captureResponses || before.retentionDays !== b.retentionDays) {
        const everyone = await this.d.identity
          .request<{ userIds: string[] }>("GET", "/internal/holders/ai.use")
          .then((r) => r.userIds.filter((u) => u !== p.id))
          .catch(() => [] as string[]);
        if (everyone.length)
          await appendToOutbox(c, {
            eventId: newId(),
            eventType: "ai.policy.changed.v1",
            version: 1,
            aggregateType: "ai.activity",
            aggregateId: "workspace",
            actorId: `user:${p.id}`,
            occurredAt: new Date().toISOString(),
            payload: { detail: b.detail, captureResponses: b.captureResponses, retentionDays: b.retentionDays, recipients: everyone },
          });
      }
      return { policy: await policyOf(c) };
    });
  }

  /**
   * Conversation rows trimmed to what a manager may see: the topic, and under "summary" the one line the AI wrote.
   * Never the title (it is cut from the person's first prompt) and never the prompts themselves; a conversation
   * the AI has not summarised (no hosted model) shows its topic only.
   */
  private async conversations(c: PoolClient, policy: Policy, where: string, args: unknown[], limit: number, since: string) {
    const rows = (
      await c.query<{
        id: string;
        user_id: string;
        source: string;
        title: string;
        summary: string;
        topic: string;
        sensitive: string[];
        messages: number;
        model: string;
        started_at: Date;
        last_at: Date;
      }>(
        `SELECT v.id, v.user_id, v.source, v.title, v.summary, v.topic, v.sensitive, v.messages, v.model, v.started_at, v.last_at
           FROM ai_conversations v WHERE ${where} AND v.last_at > ${since} ORDER BY v.last_at DESC LIMIT ${limit}`,
        args,
      )
    ).rows;
    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      source: r.source,
      topic: r.topic,
      sensitive: r.sensitive,
      prompts: r.messages,
      model: r.model,
      startedAt: r.started_at,
      lastAt: r.last_at,
      // Masked again on the way out, so rows stored before a rule existed never show a secret.
      // Rows from before summaries were the AI's alone may hold the title as their summary: those show nothing.
      ...(policy.detail === "topic" || r.summary === r.title ? {} : { summary: maskForReader(r.summary).replace(/^[-•*\s]+/, "") }),
    }));
  }
}
