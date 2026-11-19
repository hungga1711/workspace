import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, Post, Put, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import { appendToOutbox, newId, recordAudit, withTransaction, type Principal } from "@workspace/shared";
import { assertAllowed, logger, parse, requirePrincipal } from "@workspace/service-kit";
import { DEPS } from "./ai.controller.js";
import { redact } from "./insight.js";
import { companyTopics } from "./topics.js";
import type { Deps } from "./runtime.js";

/**
 * AI Insights, the person's side (ADR 0020): what I used AI for this week and whether it helped, which task each
 * conversation served, my own sensitive-data warnings, all my data as JSON, and a request to delete it. Everything
 * here is about the caller only; managers' views stay in activity.ts and read the same rows.
 *
 * Linking a conversation to a task is the person's act (picked, a confirmed extension hint, or an accepted
 * full-text suggestion). Only then is `ai.usage.recorded.v1` emitted with source "extension", so work counts the
 * task as AI-assisted like a company-AI call (ADR 0011). A hint or a suggestion alone never counts.
 */

type Helpful = "yes" | "no" | "partly";
export interface TaskBrief {
  id: string;
  code: string;
  title: string;
  status: string;
  completedAt: string | null;
  /** A synced task's key in its source tool, when it differs from the code. */
  key?: string | null;
}
export interface WithAi {
  assisted: { done: number; dated: number; onTime: number; cycleDays: number | null };
  other: { done: number; dated: number; onTime: number; cycleDays: number | null };
}

const WEEK = "now() - interval '7 days'";
const MONTH = "now() - interval '30 days'";
/** Conversations listed in Của tôi › AI (newest first); older ones are in the JSON export. */
const LIST = 30;

function person(req: Request): Principal {
  const p = requirePrincipal(req);
  if (p.type !== "user") throw new ForbiddenException("people only");
  return p;
}

/** The same data an admin removes on "done" and the person can ask to have removed: everything AI Insights keeps about them. */
async function eraseInsights(c: PoolClient, userId: string): Promise<{ conversations: number; messages: number }> {
  const ids = (await c.query<{ id: string }>("SELECT id FROM ai_conversations WHERE user_id = $1", [userId])).rows.map((r) => r.id);
  let messages = 0;
  if (ids.length) {
    messages = (await c.query("DELETE FROM ai_messages WHERE conversation_id = ANY($1::text[])", [ids])).rowCount ?? 0;
    await c.query("DELETE FROM ai_conversations WHERE id = ANY($1::text[])", [ids]);
  }
  // Their private task chats (Hỏi AI về task) go too: an erasure leaves nothing they wrote to an AI.
  await c.query("DELETE FROM ai_task_chats WHERE user_id = $1", [userId]);
  await c.query("DELETE FROM ai_content_views WHERE user_id = $1", [userId]);
  await c.query("DELETE FROM ai_safety_events WHERE user_id = $1", [userId]);
  // Their prompt counts in the hourly rollup too; company-AI calls stay with ai_usage (metering, not content).
  await c.query("DELETE FROM ai_hourly_stats WHERE user_id = $1 AND feature = ''", [userId]);
  return { conversations: ids.length, messages };
}

/** Titles of tasks, asked of work as the caller (so only tasks they may read come back). */
async function taskBriefs(d: Deps, p: Principal, ids: string[]): Promise<Map<string, TaskBrief>> {
  const want = [...new Set(ids)].slice(0, 100);
  if (!want.length) return new Map();
  const r = await d.services.work
    .request<{ tasks: TaskBrief[] }>("GET", `/me/tasks/lookup?ids=${want.map(encodeURIComponent).join(",")}`, undefined, p)
    .catch(() => ({ tasks: [] as TaskBrief[] }));
  return new Map(r.tasks.map((t) => [t.id, t]));
}

/** Tasks by code, asked of work as the caller: a code the person typed counts only for a task they may read. */
export async function tasksByCode(d: Deps, p: Principal, codes: string[]): Promise<Map<string, TaskBrief>> {
  const want = [...new Set(codes.map((x) => x.toUpperCase()))].slice(0, 100);
  if (!want.length) return new Map();
  const r = await d.services.work
    .request<{ tasks: TaskBrief[] }>("GET", `/me/tasks/lookup?codes=${want.map(encodeURIComponent).join(",")}`, undefined, p)
    .catch(() => ({ tasks: [] as TaskBrief[] }));
  // Synced tasks may answer to their source key (ENG-123) as well as our code.
  return new Map(r.tasks.flatMap((t) => [[t.code.toUpperCase(), t] as const, ...(t.key ? [[t.key.toUpperCase(), t] as const] : [])]));
}

/** The first typed code (in prompt order) that names a task the person can see. */
export function firstVisible(codes: string | null, byCode: Map<string, TaskBrief>): TaskBrief | null {
  for (const code of (codes ?? "").split(",")) {
    const t = byCode.get(code.trim().toUpperCase());
    if (t) return t;
  }
  return null;
}

/**
 * Links a conversation to a task (the person picked it, confirmed a hint, or accepted a suggestion) and, the first
 * time it points there, tells work so the task counts as AI-assisted. The caller has checked the person may read it.
 */
export async function linkConversation(c: PoolClient, userId: string, id: string, taskId: string, via: "manual" | "hint" | "suggested") {
  const conv = (
    await c.query<{ source: string; task_id: string | null; started_at: Date }>(
      "SELECT source, task_id, started_at FROM ai_conversations WHERE id = $1 AND user_id = $2 FOR UPDATE",
      [id, userId],
    )
  ).rows[0];
  if (!conv) return false;
  await c.query("UPDATE ai_conversations SET task_id = $2, task_link = $3, task_linked_at = now(), hint_task_id = NULL, hint_task_code = NULL WHERE id = $1", [id, taskId, via]);
  if (conv.task_id !== taskId)
    await appendToOutbox(c, {
      eventId: newId(),
      eventType: "ai.usage.recorded.v1",
      version: 1,
      aggregateType: "ai.usage",
      aggregateId: id,
      actorId: `user:${userId}`,
      occurredAt: new Date().toISOString(),
      payload: {
        usageId: id,
        userId,
        feature: conv.source,
        subjectType: "task",
        subjectId: taskId,
        tokens: 0,
        // When the AI was used, not when it was linked: a task counts as assisted only if that came first.
        at: conv.started_at.toISOString(),
        source: conv.source === "company" ? "app" : "extension",
      },
    });
  return true;
}

/**
 * Everything Của tôi › AI shows beyond the transparency block (oversight/me): this week by topic and tool, the
 * "có giúp" answers, my conversations with their task links and hints, my sensitive-data warnings and safety
 * events, how my tasks went with and without AI, and my erasure requests.
 */
export async function myInsights(d: Deps, c: PoolClient, p: Principal) {
  const week = (
    await c.query<{ topic: string; source: string; conversations: number; prompts: number; yes: number; no: number; partly: number }>(
      `SELECT topic, source, count(*)::int AS conversations, sum(messages)::int AS prompts,
              count(*) FILTER (WHERE helpful = 'yes')::int AS yes, count(*) FILTER (WHERE helpful = 'no')::int AS no,
              count(*) FILTER (WHERE helpful = 'partly')::int AS partly
         FROM ai_conversations WHERE user_id = $1 AND last_at > ${WEEK} GROUP BY topic, source`,
      [p.id],
    )
  ).rows;
  const sum = (k: "conversations" | "prompts" | "yes" | "no" | "partly") => week.reduce((n, r) => n + r[k], 0);
  const group = (k: "topic" | "source") => {
    const m = new Map<string, number>();
    for (const r of week) m.set(r[k], (m.get(r[k]) ?? 0) + r.conversations);
    return [...m.entries()].map(([key, conversations]) => ({ [k]: key, conversations })).sort((a, b) => b.conversations - a.conversations);
  };
  const rows = (
    await c.query<{
      id: string;
      source: string;
      title: string;
      topic: string;
      sensitive: string[];
      messages: number;
      last_at: Date;
      helpful: Helpful | null;
      task_id: string | null;
      task_link: string | null;
      hint_task_id: string | null;
      hint_task_code: string | null;
    }>(
      `SELECT id, source, title, topic, sensitive, messages, last_at, helpful, task_id, task_link, hint_task_id, hint_task_code
         FROM ai_conversations WHERE user_id = $1 AND last_at > ${MONTH} ORDER BY last_at DESC LIMIT ${LIST}`,
      [p.id],
    )
  ).rows;
  const flagged = (
    await c.query<{ kind: string; conversations: number }>(
      `SELECT k AS kind, count(*)::int AS conversations FROM ai_conversations, unnest(sensitive) k
        WHERE user_id = $1 AND last_at > ${MONTH} GROUP BY k ORDER BY 2 DESC`,
      [p.id],
    )
  ).rows;
  const safety = (
    await c.query<{ action: string; kind: string; count: number }>(
      `SELECT action, k AS kind, sum(count)::int AS count FROM ai_safety_events, unnest(CASE WHEN cardinality(kinds) = 0 THEN ARRAY['other'] ELSE kinds END) k
        WHERE user_id = $1 AND at > ${MONTH} GROUP BY action, k ORDER BY 3 DESC`,
      [p.id],
    )
  ).rows;
  const erasure = (
    await c.query(
      `SELECT id, status, note, requested_at AS "requestedAt", handled_at AS "handledAt" FROM ai_erasure_requests WHERE user_id = $1 ORDER BY requested_at DESC LIMIT 5`,
      [p.id],
    )
  ).rows;
  // Codes typed in prompts become hints once work confirms this person can see the task; resolved ones are kept.
  const typed = rows.filter((r) => !r.task_id && !r.hint_task_id && r.hint_task_code);
  if (typed.length) {
    const byCode = await tasksByCode(
      d,
      p,
      typed.flatMap((r) => (r.hint_task_code ?? "").split(",")),
    );
    for (const r of typed) {
      const t = firstVisible(r.hint_task_code, byCode);
      if (!t) continue;
      r.hint_task_id = t.id;
      await c.query("UPDATE ai_conversations SET hint_task_id = $2 WHERE id = $1 AND task_id IS NULL", [r.id, t.id]);
    }
  }
  const [titles, outcomes] = await Promise.all([
    taskBriefs(
      d,
      p,
      rows.flatMap((r) => [r.task_id, r.hint_task_id].filter((x): x is string => !!x)),
    ),
    d.services.work.request<{ withAi: WithAi; helped: (TaskBrief & { days: number })[] }>("GET", "/me/ai-outcomes?days=30", undefined, p).catch(() => null),
  ]);
  const labels = (await companyTopics(c)).topics.filter((x) => x.labelVi || x.labelEn);
  return {
    topicLabels: labels.map((x) => ({ key: x.key, labelVi: x.labelVi, labelEn: x.labelEn })),
    week: {
      conversations: sum("conversations"),
      prompts: sum("prompts"),
      topics: group("topic"),
      sources: group("source"),
      helpful: { yes: sum("yes"), no: sum("no"), partly: sum("partly") },
    },
    conversations: rows.map((r) => ({
      id: r.id,
      source: r.source,
      title: redact(r.title),
      topic: r.topic,
      sensitive: r.sensitive,
      prompts: r.messages,
      lastAt: r.last_at,
      helpful: r.helpful,
      task: r.task_id ? (titles.get(r.task_id) ?? null) : null,
      taskLink: r.task_link,
      // A hint is shown only for a task the person can still see and that is not already the linked one.
      hint: r.hint_task_id && r.hint_task_id !== r.task_id ? (titles.get(r.hint_task_id) ?? null) : null,
      // "code": the prompt named the task; "open": the task was open in workspace just before (extension hint).
      hintFrom: r.hint_task_code ? ("code" as const) : ("open" as const),
    })),
    sensitive: { flagged, safety },
    tasks: outcomes,
    erasure,
  };
}

@Controller()
export class MeInsightsController {
  constructor(@Inject(DEPS) private readonly d: Deps) {}

  /** "AI có giúp không?": the person's own answer for one of their conversations (null clears it). */
  @Put("oversight/me/conversations/:id/helpful")
  async helpful(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = person(req);
    const b = parse(z.object({ helpful: z.enum(["yes", "no", "partly"]).nullable() }), body);
    return withTransaction(this.d.pool, async (c) => {
      const r = await c.query("UPDATE ai_conversations SET helpful = $3, helpful_at = CASE WHEN $3::text IS NULL THEN NULL ELSE now() END WHERE id = $1 AND user_id = $2", [
        id,
        p.id,
        b.helpful,
      ]);
      if (!r.rowCount) throw new NotFoundException("conversation not found");
      return { helpful: b.helpful };
    });
  }

  /** Links one of my conversations to a task I can see; announces it to work the first time it points there. */
  @Put("oversight/me/conversations/:id/task")
  async link(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = person(req);
    const b = parse(z.object({ taskId: z.string().min(1).max(40), via: z.enum(["manual", "hint", "suggested"]).default("manual") }), body);
    const task = (await taskBriefs(this.d, p, [b.taskId])).get(b.taskId);
    if (!task) throw new NotFoundException("task not found");
    return withTransaction(this.d.pool, async (c) => {
      if (!(await linkConversation(c, p.id, id, b.taskId, b.via))) throw new NotFoundException("conversation not found");
      return { task, taskLink: b.via };
    });
  }

  /**
   * Unlinks. The task keeps its "AI-assisted" mark in work (the projection only adds); a wrong link is rare and
   * one task's mark is not worth a compensating event stream.
   */
  @Delete("oversight/me/conversations/:id/task")
  @HttpCode(204)
  async unlink(@Req() req: Request, @Param("id") id: string) {
    const p = person(req);
    await withTransaction(this.d.pool, async (c) => {
      const r = await c.query("UPDATE ai_conversations SET task_id = NULL, task_link = NULL, task_linked_at = NULL WHERE id = $1 AND user_id = $2", [id, p.id]);
      if (!r.rowCount) throw new NotFoundException("conversation not found");
    });
  }

  /** "Không phải việc này": drops the extension's hint for this conversation. */
  @Delete("oversight/me/conversations/:id/hint")
  @HttpCode(204)
  async dismissHint(@Req() req: Request, @Param("id") id: string) {
    const p = person(req);
    await withTransaction(this.d.pool, (c) => c.query("UPDATE ai_conversations SET hint_task_id = NULL, hint_task_code = NULL WHERE id = $1 AND user_id = $2", [id, p.id]));
  }

  /** Tasks of mine this conversation was probably for (full-text overlap with its title and first prompt). */
  @Get("oversight/me/conversations/:id/suggestions")
  async suggestions(@Req() req: Request, @Param("id") id: string) {
    const p = person(req);
    const text = await withTransaction(this.d.pool, async (c) => {
      const conv = (await c.query<{ title: string; task_id: string | null }>("SELECT title, task_id FROM ai_conversations WHERE id = $1 AND user_id = $2", [id, p.id])).rows[0];
      if (!conv) throw new NotFoundException("conversation not found");
      const first = (await c.query<{ content: string }>("SELECT content FROM ai_messages WHERE conversation_id = $1 AND role = 'user' ORDER BY at LIMIT 1", [id])).rows[0];
      return { text: `${conv.title} ${first?.content.slice(0, 400) ?? ""}`, linked: conv.task_id };
    });
    const r = await this.d.services.work
      .request<{ tasks: TaskBrief[] }>("GET", `/me/tasks/match?mode=suggest&q=${encodeURIComponent(redact(text.text))}`, undefined, p)
      .catch(() => ({ tasks: [] as TaskBrief[] }));
    return { tasks: r.tasks.filter((t) => t.id !== text.linked) };
  }

  /** The task picker: my open or recent tasks by title or code. */
  @Get("oversight/me/tasks")
  async searchTasks(@Req() req: Request, @Query("q") q?: string) {
    const p = person(req);
    return this.d.services.work
      .request<{ tasks: TaskBrief[] }>("GET", `/me/tasks/match?mode=search&q=${encodeURIComponent((q ?? "").slice(0, 120))}`, undefined, p)
      .catch(() => ({ tasks: [] as TaskBrief[] }));
  }

  /** "Xuất dữ liệu của tôi": every AI Insights row about me, with the messages, as one JSON document. */
  @Get("oversight/me/export")
  async export(@Req() req: Request) {
    const p = person(req);
    return withTransaction(this.d.pool, async (c) => {
      const conversations = (
        await c.query(
          `SELECT id, source, external_key AS "externalKey", title, model, topic, summary, sensitive, messages, started_at AS "startedAt", last_at AS "lastAt",
                  helpful, helpful_at AS "helpfulAt", task_id AS "taskId", task_link AS "taskLink", task_linked_at AS "taskLinkedAt", hint_task_id AS "hintTaskId"
             FROM ai_conversations WHERE user_id = $1 ORDER BY started_at`,
          [p.id],
        )
      ).rows as { id: string }[];
      const messages = (
        await c.query<{ conversationId: string; role: string; content: string; at: Date }>(
          `SELECT m.conversation_id AS "conversationId", m.role, m.content, m.at FROM ai_messages m JOIN ai_conversations v ON v.id = m.conversation_id
            WHERE v.user_id = $1 ORDER BY m.at`,
          [p.id],
        )
      ).rows;
      const byConv = new Map<string, { role: string; content: string; at: Date }[]>();
      for (const m of messages) byConv.set(m.conversationId, [...(byConv.get(m.conversationId) ?? []), { role: m.role, content: m.content, at: m.at }]);
      // The audit trail (ADR 0025) notes the export, never what it holds.
      await recordAudit(c, { action: "ai.oversight.exported", targetType: "member", targetId: p.id, meta: { conversations: conversations.length } });
      return {
        exportedAt: new Date().toISOString(),
        userId: p.id,
        policy: (await c.query('SELECT detail, capture_responses AS "captureResponses", retention_days AS "retentionDays" FROM ai_policy LIMIT 1')).rows[0] ?? null,
        conversations: conversations.map((v) => ({ ...v, messages: byConv.get(v.id) ?? [] })),
        safetyEvents: (await c.query(`SELECT source, action, kinds, count, at FROM ai_safety_events WHERE user_id = $1 ORDER BY at`, [p.id])).rows,
        contentViews: (await c.query(`SELECT viewer_id AS "viewerId", conversation_id AS "conversationId", at FROM ai_content_views WHERE user_id = $1 ORDER BY at`, [p.id])).rows,
        extension: (await c.query(`SELECT created_at AS "createdAt", last_seen_at AS "lastSeenAt" FROM ai_monitor_tokens WHERE user_id = $1`, [p.id])).rows[0] ?? null,
        companyAiUse: (
          await c.query(
            `SELECT feature, model, subject_type AS "subjectType", subject_id AS "subjectId", input_tokens AS "inputTokens", output_tokens AS "outputTokens", at
                           FROM ai_usage WHERE user_id = $1 ORDER BY at`,
            [p.id],
          )
        ).rows,
        erasureRequests: (await c.query(`SELECT status, note, requested_at AS "requestedAt", handled_at AS "handledAt" FROM ai_erasure_requests WHERE user_id = $1`, [p.id])).rows,
      };
    });
  }

  /** "Yêu cầu xoá": one open request at a time; AI admins see it in Admin › AI. */
  @Post("oversight/me/erasure")
  async requestErasure(@Req() req: Request, @Body() body: unknown) {
    const p = person(req);
    const b = parse(z.object({ note: z.string().trim().max(500).default("") }), body ?? {});
    return withTransaction(this.d.pool, async (c) => {
      const open = (await c.query<{ id: string }>("SELECT id FROM ai_erasure_requests WHERE user_id = $1 AND status = 'open'", [p.id])).rows[0];
      if (open) return { id: open.id, status: "open" };
      const id = newId();
      await c.query("INSERT INTO ai_erasure_requests (id, user_id, note) VALUES ($1, $2, $3)", [id, p.id, b.note]);
      await recordAudit(c, { action: "ai.erasure.requested", targetType: "member", targetId: p.id, meta: { requestId: id } });
      return { id, status: "open" };
    });
  }

  /** Admin › AI: open erasure requests (and the last few handled ones). */
  @Get("oversight/erasure-requests")
  async erasureRequests(@Req() req: Request) {
    const p = requirePrincipal(req);
    assertAllowed(p, "ai.policy.manage");
    return withTransaction(this.d.pool, async (c) => ({
      requests: (
        await c.query(
          `SELECT id, user_id AS "userId", note, status, requested_at AS "requestedAt", handled_by AS "handledBy", handled_at AS "handledAt"
             FROM ai_erasure_requests ORDER BY (status = 'open') DESC, requested_at DESC LIMIT 50`,
        )
      ).rows,
    }));
  }

  /**
   * Done deletes the person's AI Insights data (conversations, messages, views of them, safety events). Company-AI
   * usage rows stay: they hold no content and are the company's cost record. Logged in ai_audit either way.
   */
  @Post("oversight/erasure-requests/:id")
  async handleErasure(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "ai.policy.manage");
    const b = parse(z.object({ status: z.enum(["done", "declined"]) }), body);
    return withTransaction(this.d.pool, async (c) => {
      const r = (await c.query<{ user_id: string; status: string }>("SELECT user_id, status FROM ai_erasure_requests WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!r) throw new NotFoundException("request not found");
      if (r.status !== "open") return { status: r.status };
      const erased = b.status === "done" ? await eraseInsights(c, r.user_id) : null;
      await c.query("UPDATE ai_erasure_requests SET status = $2, handled_by = $3, handled_at = now() WHERE id = $1", [id, b.status, p.id]);
      await c.query("INSERT INTO ai_audit (id, actor_id, agent_id, tool, allowed, reason, input) VALUES ($1,$2,NULL,'insights.erasure',true,NULL,$3)", [
        newId(),
        p.id,
        JSON.stringify({ requestId: id, userId: r.user_id, status: b.status, ...(erased ?? {}) }),
      ]);
      await recordAudit(c, { action: "ai.erasure.decided", targetType: "member", targetId: r.user_id, meta: { requestId: id, status: b.status, ...(erased ?? {}) } });
      logger.info({ requestId: id, status: b.status }, "AI Insights erasure request handled");
      return { status: b.status, ...(erased ?? {}) };
    });
  }
}
