import { Body, Controller, HttpCode, Inject, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { assertAllowed, logger, parse, requirePrincipal } from "@workspace/service-kit";
import { withTransaction, type Principal } from "@workspace/shared";
import { DEPS } from "./ai.controller.js";
import { RefInput, questionMessage, refsBlock } from "./assistant-input.js";
import { guardAi } from "./budgets.js";
import { dataLang, replyIn, replyLocale } from "./locale.js";
import { answerWithTools, chips, savePending, type PendingContext } from "./mcp/chat.js";
import { toolMode } from "./mcp/loop.js";
import { READ_TOOLS, runAgent, untrusted, type Deps } from "./runtime.js";
import { followUps, Trace } from "./progress.js";
import { toolTitle, workspaceTool } from "./workspace-tools.js";
import { executeTool, type Source, type ToolContext } from "./tools.js";

/**
 * @AI where the work is: in a chat channel and in a task's comments, the same assistant as Hỏi đáp with
 * the same tools (workspace-tools.ts), told where it was asked.
 *
 *   channel   the answer is the asker's alone (as @AI in chat always was): what it read may be more than the channel's
 *             other members may see. It has read the channel's recent messages; asked in a thread's replies
 *             (`threadId`), it has read that thread instead, and "this thread" means it.
 *   task      the person's comment is on the task already; the answer is posted under it as a comment marked "AI",
 *             for everyone on the task. It has read the task.
 *
 * A change (a task, the calendar, a page, a workflow) waits for the asker's yes on a card, wherever it was asked; in
 * a task the answer is posted once they decide (mcp/controller.ts decide).
 */

export const mentionBody = z.discriminatedUnion("surface", [
  z.object({
    surface: z.literal("channel"),
    channelId: z.string().length(26),
    /** Asked in a thread's replies: the thread's root message. */
    threadId: z.string().length(26).optional(),
    content: z.string().trim().min(1).max(12_000),
    refs: z.array(RefInput).max(8).default([]),
  }),
  z.object({ surface: z.literal("task"), taskId: z.string().min(2).max(60), content: z.string().trim().min(1).max(12_000), refs: z.array(RefInput).max(8).default([]) }),
]);

/** The question without the mention that addressed it. */
export const withoutMention = (text: string) => text.replace(/^\s*@ai\b[\s,:]*/i, "").trim() || text.trim();

/** Posts the assistant's answer on a task as a comment marked "AI", in the asker's name (work checks they may read it). */
export async function postAiComment(d: Pick<Deps, "services">, askerId: string, taskId: string, text: string): Promise<{ commentId: string } | null> {
  try {
    const r = await d.services.work.request<{ id: string }>("POST", `/internal/tasks/${encodeURIComponent(taskId)}/agent-comments`, {
      askerId,
      agent: "AI",
      body: text.slice(0, 9500),
    });
    return { commentId: r.id };
  } catch (err) {
    logger.warn({ err, taskId }, "could not post the assistant's comment");
    return null;
  }
}

@Controller()
export class MentionController {
  constructor(@Inject(DEPS) private readonly d: Deps) {}

  @Post("mention")
  @HttpCode(200)
  async mention(@Req() req: Request, @Body() raw: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "ai.use");
    const b = parse(mentionBody, raw);
    const asked = withoutMention(b.content);
    const loc = replyLocale(asked, req);
    return guardAi(async () => {
      // Where it was asked and what it points at (@task, @page) are read together: both are module reads as the asker.
      const [where, refsText] = await Promise.all([this.where(p, b, dataLang(loc)), b.refs.length ? refsBlock(this.d, p, b.refs, dataLang(loc)) : Promise.resolve("")]);
      const context: PendingContext = b.surface === "task" ? { surface: "task", taskId: where.id } : { surface: "channel", channelId: b.channelId };
      // What the answer read, for the notes and next questions shown under it (progress.ts); nothing is streamed here.
      const progress = new Trace(loc, toolTitle);
      const more = (sources: Source[]) => {
        const used = progress.used();
        const notes = progress.notes();
        const next = followUps(asked, used, sources, loc, (tool) => !!workspaceTool(tool), b.surface);
        return { ...(notes.length ? { notes } : {}), ...(next.length ? { followUps: next } : {}) };
      };
      const who = {
        principal: p,
        agentId: null,
        feature: "assistant",
        subject: b.surface === "task" ? { type: "task" as const, id: where.id } : { type: "channel" as const, id: b.channelId },
        progress,
      };
      // A model that takes no tools (the built-in one, a small self-hosted one) answers from what a search finds.
      if (toolMode(this.d) === "none") {
        const run = await runAgent(this.d, p, null, asked, "assistant", READ_TOOLS, { ...(b.surface === "channel" ? { channelId: b.channelId } : {}), language: loc, progress });
        const posted = b.surface === "task" && run.answer ? await postAiComment(this.d, p.id, where.id, run.answer) : null;
        return {
          answer: run.answer || "…",
          model: "workspace-data",
          toolCalls: [],
          sources: run.sources as Source[],
          ...more(run.sources as Source[]),
          // Charts only where the answer is the asker's alone (a channel); a task comment is posted as text.
          ...(b.surface === "channel" && run.blocks?.length ? { blocks: run.blocks } : {}),
          ...(posted ? { posted } : {}),
        };
      }
      const system = [
        `You are the company's AI assistant at work, asked ${b.surface === "task" ? "in the comments of a task; your answer is posted there for everyone on the task, so write it for them" : "in a chat channel; only the person who asked sees your answer"}.`,
        `Be brief and practical; use Markdown. Never invent company data. ${replyIn(loc)}`,
      ].join(" ");
      const question = questionMessage(`${asked}\n\n${where.text}`, refsText, []);
      const answer = await answerWithTools(this.d, who, system, [question], undefined, true, { workspace: true, loc, question: asked, surface: b.surface });
      if (!answer) return { answer: "…", model: "", toolCalls: [], sources: [] };
      if (answer.pending) {
        const card = await withTransaction(this.d.pool, (c) => savePending(c, p.id, null, answer.pending!, context));
        return { answer: "", model: "", toolCalls: chips(answer.uses), sources: answer.sources ?? [], pending: card };
      }
      const posted = b.surface === "task" ? await postAiComment(this.d, p.id, where.id, answer.text) : null;
      return {
        answer: answer.text,
        model: answer.model,
        toolCalls: chips(answer.uses),
        sources: answer.sources ?? [],
        ...more(answer.sources ?? []),
        ...(b.surface === "channel" && answer.blocks?.length ? { blocks: answer.blocks } : {}),
        ...(posted ? { posted } : {}),
      };
    });
  }

  /** What the assistant is told about the place it was asked in, read as the asker (who must be able to read it). */
  private async where(p: Principal, b: z.infer<typeof mentionBody>, lang: "en" | "vi"): Promise<{ id: string; text: string }> {
    if (b.surface === "task") {
      const t = await this.d.services.work.request<{ task: { id: string; code: string; title: string } }>("GET", `/tasks/${encodeURIComponent(b.taskId)}`, undefined, p);
      const brief = await refsBlock(this.d, p, [{ kind: "task", id: t.task.id, label: t.task.code }], lang);
      return { id: t.task.id, text: `(Asked in the comments of task ${t.task.code}. "This task" means ${t.task.code}.)\n\n${brief}` };
    }
    const ctx: ToolContext = { principal: p, agentId: null, services: this.d.services, lang };
    if (b.threadId) {
      // Read as the asker: a thread they cannot read gives nothing, and the question is answered without it.
      const thread = await executeTool(this.d.pool, ctx, "get_thread", { messageId: b.threadId });
      if (thread.ok)
        return {
          id: b.channelId,
          text: `(Asked in the replies of a thread in chat channel ${b.channelId}. "This thread" means thread ${b.threadId}: for summarize_channel, extract_action_items or draft_reply about it, pass thread ${b.threadId}.)\n\nThe thread so far:\n${untrusted(thread.content.slice(0, 8000))}`,
        };
    }
    const recent = await executeTool(this.d.pool, ctx, "recent_channel_messages", { channelId: b.channelId, limit: 20 });
    return {
      id: b.channelId,
      text: `(Asked in chat channel ${b.channelId}. "This channel", "here" and "what did I miss" mean it: for summarize_channel or extract_action_items, pass channel ${b.channelId}.)${recent.ok ? `\n\nThe channel's latest messages:\n${untrusted(recent.content.slice(0, 6000))}` : ""}`,
    };
  }
}
