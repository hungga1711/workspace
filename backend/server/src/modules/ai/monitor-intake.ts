import { Body, Controller, ForbiddenException, Inject, NotFoundException, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import { authorize, newId, runWithContext, withTransaction } from "@workspace/shared";
import { parse, requirePrincipal } from "@workspace/service-kit";
import type { Principal } from "@workspace/shared";
import { DEPS } from "./ai.controller.js";
import { linkConversation, tasksByCode } from "./me-insights.js";
import { alertFlagged, hash, policyOf, recordTurn, summarizeConversation } from "./activity.js";
import { SENSITIVE, sourceFromHost } from "./insight.js";
import { aiFlags } from "./status.js";
import type { Deps } from "./runtime.js";

/**
 * What the browser extension sends (POST /api/ai-monitor/events, through the gateway with the person's
 * connection code). Three kinds of event, none of them carrying text the person did not send:
 *
 *  - a turn: the prompt as it was actually sent (already redacted when the policy says so), maybe the answer,
 *    maybe a hint (the task the person had open in workspace) and how many parts were redacted;
 *  - safety: a send that was warned about, redacted or blocked, with the kinds and a count, never the text;
 *  - feedback: the one-tap "did AI help?" after an answer.
 *
 * The answer tells the extension the policy it must apply: whether answers are kept, what to do with
 * sensitive data, and the company's own keywords.
 */

const kind = z.enum(SENSITIVE);
const at = z.string().datetime({ offset: true }).optional();
const url = z.string().url().max(2000);
const conversation = z.string().max(200).nullable().default(null);
const Turn = z.object({
  kind: z.literal("turn").default("turn"),
  url,
  conversation,
  // Empty prompt + a response: the answer to the last prompt of that conversation, sent later.
  prompt: z.string().trim().max(20_000).default(""),
  response: z.string().max(40_000).nullable().default(null),
  model: z.string().max(80).default(""),
  at,
  hint: z.object({ taskId: z.string().regex(/^[A-Za-z0-9_-]{10,40}$/), seenAt: z.string().datetime({ offset: true }) }).nullish(),
  redactions: z.record(kind, z.number().int().min(0).max(1000)).nullish(),
});
const Safety = z.object({
  kind: z.literal("safety"),
  url,
  action: z.enum(["warn", "redact", "block"]),
  kinds: z.array(kind).max(10),
  count: z.number().int().min(1).max(1000).default(1),
  at,
});
const Feedback = z.object({ kind: z.literal("feedback"), url, conversation, helpful: z.enum(["yes", "no", "partly"]), at });
// "Link this chat to T-157?" answered on the AI site: link it (only to a task the person can read) or drop the hint.
// The code is whatever the extension offered: a workspace or synced key (T-157, AB2-7) or a ClickUp id (#86B1X2Y3Z);
// one this pattern refused would fail the whole batch, and the prompts sent with it.
const Link = z.object({
  kind: z.literal("link"),
  url,
  conversation,
  code: z.string().regex(/^(?:[A-Za-z][A-Za-z0-9]{0,9}-\d{1,7}|#[0-9A-Za-z]{7,12})$/),
  decline: z.boolean().default(false),
  at,
});
// Old extensions send turns without `kind`; z.union tries the tagged kinds first.
const Event = z.union([Safety, Feedback, Link, Turn]);

/** A hint older than this is about another piece of work. */
const HINT_FRESH_MS = 2 * 3600_000;
/** The extension downloads the keyword list on every batch; companies with more terms keep the first ones. */
const MAX_KEYWORDS = 500;

export async function keywordsOf(c: PoolClient): Promise<string[]> {
  return (await c.query<{ term: string }>(`SELECT term FROM ai_keywords ORDER BY created_at, id LIMIT ${MAX_KEYWORDS}`)).rows.map((r) => r.term);
}

@Controller()
export class MonitorIntakeController {
  constructor(@Inject(DEPS) private readonly d: Deps) {}

  /** The gateway forwards extension batches here (the token is the only credential the extension has). */
  @Post("internal/monitor/events")
  async events(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    if (p.type !== "service" || !authorize(p, "principal.resolve").allowed) throw new ForbiddenException("gateway only");
    const b = parse(
      z.object({
        token: z.string().regex(/^aim_[A-Za-z0-9_-]{20,64}$/),
        // Empty is a ping: the extension checks its code and learns the policy when it connects.
        events: z.array(Event).max(50),
      }),
      body,
    );
    // The connection code names the person it was made for.
    const owner = (await this.d.pool.query<{ user_id: string }>("SELECT user_id FROM ai_monitor_tokens WHERE token_hash = $1", [hash(b.token)])).rows[0];
    if (!owner) throw new NotFoundException("unknown connection");
    // AI Insights switched off (Admin › AI): the extension learns it from the 403 and shows "not connected".
    if (!(await aiFlags(this.d)).monitoring) throw new ForbiddenException({ error: "monitoring_off" });
    const userId = owner.user_id;
    // Conversations this batch started: the AI writes their one-line summary once the batch is stored.
    const fresh: string[] = [];
    // Under "topic" nobody reads a summary, so the prompts are not sent to the model for one.
    let summaries = false;
    return runWithContext({ actorId: `user:${userId}`, requestId: String(req.requestId ?? newId()) }, async () => {
      const out = await withTransaction(this.d.pool, async (c) => {
        const policy = await policyOf(c);
        summaries = policy.detail === "summary";
        const conversationOf = async (source: string, key: string) =>
          (await c.query<{ id: string }>("SELECT id FROM ai_conversations WHERE user_id = $1 AND source = $2 AND external_key = $3", [userId, source, key])).rows[0]?.id ?? null;
        const safety = (source: string, action: string, kinds: string[], count: number, when: Date) =>
          c.query("INSERT INTO ai_safety_events (id, user_id, source, action, kinds, count, at) VALUES ($1, $2, $3, $4, $5, $6, $7)", [
            newId(),
            userId,
            source,
            action,
            kinds,
            count,
            when,
          ]);
        let n = 0;
        for (const e of b.events) {
          const u = new URL(e.url);
          const source = sourceFromHost(u.hostname);
          // The extension reports only AI sites; anything else is dropped rather than stored.
          if (source === "other") continue;
          const when = e.at ? new Date(e.at) : new Date();
          if (Math.abs(Date.now() - when.getTime()) > 7 * 86400_000) continue;

          if (e.kind === "safety") {
            await safety(source, e.action, e.kinds, e.count, when);
            n++;
            continue;
          }
          const key = (e.conversation ?? u.pathname).slice(0, 200);
          if (e.kind === "link") {
            const id = await conversationOf(source, key);
            if (!id) continue;
            if (e.decline) {
              await c.query("UPDATE ai_conversations SET hint_task_id = NULL, hint_task_code = NULL WHERE id = $1", [id]);
              n++;
              continue;
            }
            // Work answers as the person, so a code for a task they cannot read links nothing.
            const as = await this.d.identity.request<Principal>("POST", "/internal/resolve", { userId }).catch(() => null);
            const task = as ? (await tasksByCode(this.d, as, [e.code])).get(e.code.toUpperCase()) : undefined;
            if (task && (await linkConversation(c, userId, id, task.id, "hint"))) n++;
            continue;
          }
          if (e.kind === "feedback") {
            const id = await conversationOf(source, key);
            if (!id) continue;
            await c.query("UPDATE ai_conversations SET helpful = $2, helpful_at = $3 WHERE id = $1", [id, e.helpful, when]);
            n++;
            continue;
          }
          if (!e.prompt) {
            if (!policy.captureResponses || !e.response) continue;
            const id = await conversationOf(source, key);
            if (!id) continue;
            await c.query("INSERT INTO ai_messages (id, conversation_id, role, content, at) VALUES ($1, $2, 'assistant', $3, $4)", [
              newId(),
              id,
              e.response.slice(0, 20_000),
              when,
            ]);
            n++;
            continue;
          }
          const redacted = Object.entries(e.redactions ?? {}).filter(([, v]) => v > 0);
          const r = await recordTurn(c, {
            userId,
            source,
            // ChatGPT /c/<id>, Claude /chat/<id>, Gemini /app/<id>: one conversation per page id.
            externalKey: key,
            model: e.model,
            prompt: e.prompt,
            response: policy.captureResponses ? e.response : null,
            at: when,
            // What was redacted still marks the conversation, so its owner and the counts know it happened.
            extraFlags: redacted.map(([k]) => k),
          });
          if (redacted.length)
            await safety(
              source,
              "redact",
              redacted.map(([k]) => k),
              redacted.reduce((s, [, v]) => s + v, 0),
              when,
            );
          // Only a hint: the person confirms it in Của tôi › AI before the conversation counts for that task.
          if (e.hint && Math.abs(when.getTime() - new Date(e.hint.seenAt).getTime()) <= HINT_FRESH_MS)
            await c.query("UPDATE ai_conversations SET hint_task_id = $2 WHERE id = $1 AND task_id IS NULL", [r.id, e.hint.taskId]);
          if (r.created) fresh.push(r.id);
          await alertFlagged(this.d, c, userId, r.id, source, r.newFlags);
          n++;
        }
        await c.query("UPDATE ai_monitor_tokens SET last_seen_at = now() WHERE user_id = $1", [userId]);
        return { accepted: n, captureResponses: policy.captureResponses, sensitiveMode: policy.sensitiveMode, keywords: await keywordsOf(c) };
      });
      if (summaries && fresh.length) void this.summarize(userId, fresh);
      return out;
    });
  }

  /** Managers read the AI's summary, never the prompt: without this a conversation from the extension shows its topic only. */
  private async summarize(userId: string, ids: string[]) {
    const as = await this.d.identity.request<Principal>("POST", "/internal/resolve", { userId }).catch(() => null);
    if (!as) return;
    for (const id of ids) await summarizeConversation(this.d, as, id);
  }
}
