import { Body, Controller, ForbiddenException, Get, HttpException, Inject, NotFoundException, Param, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { agentOnBehalfOf, appendToOutbox, authorize, newId, withTransaction, type Principal } from "@workspace/shared";
import { assertAllowed, logger, parse, requirePrincipal, ServiceCallError } from "@workspace/service-kit";
import { meteredGenerate, parseJson, replyLanguage, runAgent, SYSTEM_RULES, untrusted, type Deps } from "./runtime.js";
import { requestLocale } from "./locale.js";
import { briefSystem, briefUser, EXTRACT_SYSTEM, extractUser, threadUser } from "./prompts.js";
import { BudgetExceeded, budgetHttpError, listBudgets } from "./budgets.js";
import { AGENT_TOOLS, executeTool, type Source } from "./tools.js";
import { aiFlags, aiStatus, type AiStatus } from "./status.js";

export const DEPS = Symbol("DEPS");

async function budgetGuard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof BudgetExceeded) throw budgetHttpError(e);
    throw e;
  }
}

interface Extraction {
  summary: string;
  actions: { title: string; assigneeId: string | null; due: string | null }[];
  decisions: { title: string }[];
}

@Controller()
export class AiController {
  constructor(@Inject(DEPS) private readonly d: Deps) {}

  @Get("health")
  health() {
    return { ok: true, provider: this.d.provider.name, model: this.d.provider.status?.() ?? { degraded: false } };
  }

  /**
   * Whether the company has an AI provider configured (`configured`) and which vendors (`providers`).
   * Cheap (no model call); the web reads it once per request to show or hide company-AI features.
   */
  @Get("status")
  async status(@Req() req: Request): Promise<AiStatus> {
    requirePrincipal(req);
    return aiStatus(this.d.provider, await aiFlags(this.d));
  }

  /** @AI questions: the AI acts strictly as the asking user. */
  @Post("ask")
  async ask(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "ai.use");
    // channelId: the conversation @AI was asked in, so "summarise this channel" knows which one (read access is still checked).
    const b = parse(z.object({ question: z.string().trim().min(1).max(4000), channelId: z.string().min(10).max(40).optional() }), body);
    return budgetGuard(() =>
      runAgent(
        this.d,
        p,
        null,
        b.question,
        "ask",
        [
          "search_messages",
          "recent_channel_messages",
          "get_thread",
          "list_my_tasks",
          "search_documents",
          "get_document",
          "project_status",
          "team_status",
          "team_ai_usage",
          "goals_status",
          "delegated_status",
          "who_is_out",
          "my_leave_balance",
          "find_people",
          "get_employee_compensation",
        ],
        { ...(b.channelId ? { channelId: b.channelId } : {}), language: requestLocale(req) },
      ),
    );
  }

  /**
   * "Translate" on a chat message: the text the person already sees, into the reader's language (English when a
   * Vietnamese reader translates Vietnamese). Metered like every AI call; the text is untrusted input.
   */
  @Post("translate")
  async translate(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "ai.use");
    const b = parse(z.object({ text: z.string().trim().min(1).max(4000), to: z.enum(["vi", "en", "zh", "es"]) }), body);
    const language = { vi: "Vietnamese", en: "English", zh: "Simplified Chinese", es: "Spanish" }[b.to];
    return budgetGuard(async () => {
      const r = await meteredGenerate(
        this.d,
        { principal: p, agentId: null, feature: "translate" },
        {
          tier: "fast",
          system: `${SYSTEM_RULES}\nYou translate workplace chat messages. Translate the user's message into ${language}. Keep names, @mentions, links, numbers, emoji, line breaks and Markdown formatting (**bold**, lists, \`code\`) exactly as marked up. Reply with the translation only, no quotes or notes.`,
          maxTokens: 1200,
          messages: [{ role: "user", content: untrusted(b.text) }],
        },
      );
      // The offline fallback cannot translate: say so instead of returning its notice as a "translation".
      if (r.model === "local-extractive") throw new HttpException({ error: "ai_unavailable" }, 503);
      return { text: r.text.trim(), to: b.to };
    });
  }

  /**
   * Thread summary + proposed actions/decisions. Proposals only: the user
   * confirms each one in the UI, which then calls the work module with the source.
   */
  @Post("threads/:messageId/summarize")
  async summarize(@Req() req: Request, @Param("messageId") messageId: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "ai.use");
    return budgetGuard(async () => {
      const thread = await executeTool(this.d.pool, { principal: p, agentId: null, services: this.d.services }, "get_thread", { messageId });
      if (!thread.ok) throw new NotFoundException("thread not found");
      const r = await meteredGenerate(
        this.d,
        { principal: p, agentId: null, feature: "summarize", subject: { type: "message", id: messageId } },
        {
          tier: "fast",
          system: EXTRACT_SYSTEM,
          maxTokens: 1200,
          messages: [{ role: "user", content: threadUser(replyLanguage(req), thread.content) }],
        },
      );
      const x = parseJson<Extraction>(r.text);
      if (!x || typeof x.summary !== "string" || !Array.isArray(x.actions) || !Array.isArray(x.decisions)) {
        // Malformed model output is reported, never half-applied.
        throw new HttpException({ error: "ai_malformed_output" }, 502);
      }
      return { summary: x.summary, actions: x.actions.slice(0, 20), decisions: x.decisions.slice(0, 20), source: thread.sources[0] ?? null };
    });
  }

  /**
   * @Agent in a channel. Effective principal = agent ∩ asker. The answer is
   * posted in the channel only if every member can read every source it used;
   * otherwise it is returned privately to the asker with a note.
   */
  @Post("agents/:agentId/invoke")
  async invoke(@Req() req: Request, @Param("agentId") agentId: string, @Body() body: unknown) {
    const asker = requirePrincipal(req);
    assertAllowed(asker, "agent.invoke");
    const b = parse(z.object({ channelId: z.string().length(26), threadRootId: z.string().length(26).nullable().default(null), prompt: z.string().trim().min(1).max(4000) }), body);
    let agent: Principal & { name: string; budget: number; allowedTools?: string[] };
    try {
      agent = await this.d.identity.request("POST", "/internal/agents/resolve", { agentId });
    } catch (e) {
      if (e instanceof ServiceCallError && e.status === 404) throw new NotFoundException("agent not found");
      throw e;
    }
    // Per-agent monthly budget: on top of the workspace quota, a runaway agent stops alone.
    if (agent.budget > 0) {
      const used = await withTransaction(this.d.pool, async (c) =>
        Number(
          (
            await c.query<{ n: string }>(
              "SELECT coalesce(sum(input_tokens + output_tokens), 0)::bigint AS n FROM ai_usage WHERE agent_id = $1 AND at > date_trunc('month', now())",
              [agentId],
            )
          ).rows[0]!.n,
        ),
      );
      if (used >= agent.budget)
        throw new HttpException({ error: "agent_budget_exceeded", message: `${agent.name} has used up this month's budget`, used, budget: agent.budget }, 402);
    }
    const effective = agentOnBehalfOf(agent, asker);
    // The asker must be able to read the channel the agent will answer in.
    let members: string[];
    try {
      members = (await this.d.services.chat.request<{ userIds: string[] }>("GET", `/channels/${b.channelId}/members`, undefined, asker)).userIds;
    } catch (e) {
      if (e instanceof ServiceCallError && (e.status === 403 || e.status === 404)) throw new ForbiddenException("not a member of this channel");
      throw e;
    }
    // Each agent only sees the tools its admin allowed (allowed_tools); grants still apply on top.
    const tools = (agent.allowedTools?.length ? agent.allowedTools : AGENT_TOOLS).filter((t) => AGENT_TOOLS.includes(t));
    const run = await budgetGuard(() => runAgent(this.d, effective, agentId, b.prompt, "agent", tools, { language: requestLocale(req) }));
    const publicOk = await this.audienceCanRead(members, run.sources);
    // Feeds "AI did while you were away" on the asker's Home.
    const ran = (messageId: string | null) =>
      withTransaction(this.d.pool, (c) =>
        appendToOutbox(c, {
          eventId: newId(),
          eventType: "ai.agent.run.completed.v1",
          version: 1,
          aggregateType: "ai.agent",
          aggregateId: agentId,
          actorId: `agent:${agentId}`,
          occurredAt: new Date().toISOString(),
          payload: {
            agentId,
            agentName: agent.name,
            askerId: asker.id,
            channelId: b.channelId,
            messageId,
            prompt: b.prompt.slice(0, 200),
            answer: run.answer.slice(0, 300),
            toolCalls: run.toolCalls,
          },
        }),
      ).catch((err) => logger.warn({ err }, "agent run event failed"));
    if (!publicOk) {
      await ran(null);
      return { visibility: "private", note: "Câu trả lời dùng thông tin mà không phải ai trong kênh cũng xem được, nên chỉ hiển thị cho bạn.", ...run };
    }
    const message = await this.d.services.chat.request<{ id: string }>("POST", "/internal/agent-messages", {
      channelId: b.channelId,
      askerId: asker.id,
      agentId,
      threadRootId: b.threadRootId,
      body: `**${agent.name}:** ${run.answer}`,
    });
    await ran(message.id);
    return { visibility: "channel", messageId: message.id, ...run };
  }

  private async audienceCanRead(members: string[], sources: Source[]): Promise<boolean> {
    if (sources.length === 0) return true;
    if (members.length > 50) return false; // too large to verify cheaply: answer privately
    const messageIds = sources.filter((s) => s.type === "message").map((s) => s.id);
    if (messageIds.length) {
      const r = await this.d.services.chat.request<{ allReadable: boolean }>("POST", "/internal/readable", { messageIds, userIds: members });
      if (!r.allReadable) return false;
    }
    const other = sources.filter((s) => s.type !== "message");
    if (other.length === 0) return true;
    for (const userId of members) {
      let principal: Principal;
      try {
        principal = await this.d.identity.request<Principal>("POST", "/internal/resolve", { userId });
      } catch {
        return false;
      }
      for (const s of other) {
        const path = s.type === "task" ? `/tasks/${s.id}` : s.type === "document" ? `/docs/${s.id}` : null;
        if (!path) return false; // employee data and anything unknown: never broadcast
        try {
          await this.d.services.work.request("GET", path, undefined, principal);
        } catch {
          return false;
        }
      }
    }
    return true;
  }

  /** Lazy Daily Brief AI part, called by the home module with the user's principal. */
  @Post("internal/brief")
  async brief(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "ai.use");
    const { locale = "vi", ...ctx } = parse(
      z.object({ needsYou: z.array(z.record(z.unknown())).max(30), today: z.array(z.record(z.unknown())).max(30), locale: z.enum(["vi", "en"]).optional() }),
      body,
    );
    return budgetGuard(async () => {
      // Grounded in the same items Home shows: with work waiting, the sentence must name the first thing to do,
      // never "nothing urgent" (the Home headline counts the same needsYou list).
      const rec = await meteredGenerate(
        this.d,
        { principal: p, agentId: null, feature: "brief" },
        {
          tier: "fast",
          maxTokens: 400,
          system: briefSystem(locale),
          messages: [{ role: "user", content: briefUser(ctx) }],
        },
      );
      const recommendation = parseJson<{ recommendation?: string }>(rec.text)?.recommendation ?? "";
      // Catch-up digest: up to 3 channels with unread messages, newest first.
      const channels = (
        await this.d.services.chat.request<{ channels: { id: string; name: string | null; kind: string; unread: number; mentions: number; lastReadSeq: number }[] }>(
          "GET",
          "/channels",
          undefined,
          p,
        )
      ).channels
        .filter((c) => c.unread > 0)
        .sort((a, b) => b.mentions - a.mentions || b.unread - a.unread)
        .slice(0, 3);
      // One model call per channel, in parallel: sequential calls made the brief slower than the callers' timeouts.
      const digest = (
        await Promise.all(
          channels.map(async (c): Promise<{ channel: string; lines: string[] } | null> => {
            const msgs = (
              await this.d.services.chat.request<{ messages: { authorId: string; body: string }[] }>(
                "GET",
                `/channels/${c.id}/messages?after=${c.lastReadSeq}&limit=40`,
                undefined,
                p,
              )
            ).messages;
            if (msgs.length === 0) return null;
            const s = await meteredGenerate(
              this.d,
              { principal: p, agentId: null, feature: "catchup" },
              {
                tier: "fast",
                system: EXTRACT_SYSTEM,
                maxTokens: 500,
                messages: [{ role: "user", content: untrusted(msgs.map((m) => `[${m.authorId}] ${m.body}`).join("\n")) }],
              },
            );
            const x = parseJson<Extraction>(s.text);
            const lines = x
              ? [
                  ...x.decisions.map((d) => d.title),
                  ...x.actions.filter((a) => a.assigneeId === p.id).map((a) => `${locale === "en" ? "You need to" : "Bạn cần"}: ${a.title}`),
                ].slice(0, 3)
              : [];
            return {
              channel: c.kind === "dm" ? (locale === "en" ? "Direct message" : "Tin nhắn riêng") : `#${c.name}`,
              lines: lines.length ? lines : [x?.summary ?? (locale === "en" ? `${msgs.length} new messages` : `${msgs.length} tin nhắn mới`)],
            };
          }),
        )
      ).filter((d): d is { channel: string; lines: string[] } => d !== null);
      return { recommendation, digest };
    });
  }

  /**
   * Summary, action items and decisions from text the caller already has open
   * (meeting minutes, a document, a task description). Proposals only: the UI
   * asks the user to confirm each task, and the work module authorizes the create.
   */
  @Post("extract")
  async extract(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "ai.use");
    const b = parse(
      z.object({
        kind: z.enum(["meeting", "document", "task"]),
        /** The meeting, document or task the text comes from, so the use counts for that piece of work. */
        subjectId: z.string().min(10).max(40).optional(),
        title: z.string().max(300).default(""),
        text: z.string().trim().min(1).max(60000),
        people: z
          .array(z.object({ id: z.string().max(80), name: z.string().max(120) }))
          .max(200)
          .default([]),
      }),
      body,
    );
    return budgetGuard(async () => {
      const roster = b.people.map((x) => `${x.id}: ${x.name}`).join("\n");
      const r = await meteredGenerate(
        this.d,
        {
          principal: p,
          agentId: null,
          feature: `extract_${b.kind}`,
          subject: b.subjectId ? { type: b.kind === "document" ? "document" : b.kind, id: b.subjectId } : null,
        },
        {
          tier: "fast",
          system: `${EXTRACT_SYSTEM}\nPeople (id: name) you may use for assigneeId:\n${roster || "(none)"}`,
          maxTokens: 1500,
          messages: [{ role: "user", content: extractUser(b.kind, b.title, replyLanguage(req), b.text) }],
        },
      );
      const x = parseJson<Extraction>(r.text);
      if (!x || typeof x.summary !== "string" || !Array.isArray(x.actions) || !Array.isArray(x.decisions)) throw new HttpException({ error: "ai_malformed_output" }, 502);
      const known = new Set(b.people.map((q) => q.id));
      return {
        summary: x.summary.slice(0, 2000),
        // Only people the caller passed in can be suggested as assignees.
        actions: x.actions
          .slice(0, 20)
          .map((a) => ({ title: String(a.title).slice(0, 300), assigneeId: a.assigneeId && known.has(a.assigneeId) ? a.assigneeId : null, due: a.due ?? null })),
        decisions: x.decisions.slice(0, 20).map((d) => ({ title: String(d.title).slice(0, 300) })),
      };
    });
  }

  /** One agent's month: tokens against budget, runs, and every tool call it made (allowed or refused). */
  @Get("agents/:agentId/activity")
  async agentActivity(@Req() req: Request, @Param("agentId") agentId: string) {
    const p = requirePrincipal(req);
    if (!authorize(p, "ai.agent.manage").allowed && !authorize(p, "audit.read").allowed) throw new ForbiddenException("admin only");
    return withTransaction(this.d.pool, async (c) => ({
      month: (
        await c.query(
          `SELECT coalesce(sum(input_tokens + output_tokens), 0)::bigint AS tokens, count(*)::int AS calls, count(DISTINCT user_id)::int AS users
          FROM ai_usage WHERE agent_id = $1 AND at > date_trunc('month', now())`,
          [agentId],
        )
      ).rows[0],
      toolCalls: (await c.query(`SELECT tool, actor_id AS "actorId", allowed, reason, input, at FROM ai_audit WHERE agent_id = $1 ORDER BY at DESC LIMIT 100`, [agentId])).rows,
    }));
  }

  @Get("usage")
  async usage(@Req() req: Request) {
    const p = requirePrincipal(req);
    if (!authorize(p, "ai.policy.manage").allowed) throw new ForbiddenException("admin only");
    return withTransaction(this.d.pool, async (c) => ({
      model: { provider: this.d.provider.name, ...(this.d.provider.status?.() ?? { degraded: false }) },
      budgets: await listBudgets(c),
      byFeature: (
        await c.query(
          `SELECT feature, sum(input_tokens + output_tokens)::bigint AS tokens, count(*)::int AS calls FROM ai_usage WHERE at > date_trunc('month', now()) GROUP BY feature ORDER BY tokens DESC`,
        )
      ).rows,
      byAgent: (
        await c.query(
          `SELECT agent_id AS "agentId", sum(input_tokens + output_tokens)::bigint AS tokens, count(*)::int AS calls FROM ai_usage WHERE agent_id IS NOT NULL AND at > date_trunc('month', now()) GROUP BY agent_id`,
        )
      ).rows,
      deniedToolCalls: (await c.query(`SELECT tool, actor_id AS "actorId", agent_id AS "agentId", reason, at FROM ai_audit WHERE NOT allowed ORDER BY at DESC LIMIT 50`)).rows,
    }));
  }
}
