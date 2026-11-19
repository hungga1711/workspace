import { z } from "zod";
import { defineEvent, id, ids, timestamp } from "./define.js";

const connection = z.object({ id, mode: z.string(), vendor: z.string().nullable(), name: z.string() });

export const aiEvents = {
  "ai.activity.flagged.v1": defineEvent({
    aggregateType: "ai.activity",
    summary: "Sensitive data was sent to an AI; AI admins (`recipients`) are told",
    intent: "projection",
    payload: z.object({ conversationId: id, userId: id, source: z.string(), kinds: z.array(z.string()), recipients: ids }),
  }),
  "ai.extension.reminded.v1": defineEvent({
    aggregateType: "ai.activity",
    summary: "People without the AI monitor extension were reminded to install it",
    intent: "projection",
    payload: z.object({ recipients: ids }),
  }),
  "ai.policy.changed.v1": defineEvent({
    aggregateType: "ai.activity",
    summary: "What is recorded about AI use changed; everyone who uses AI is told",
    intent: "projection",
    payload: z.object({ detail: z.string(), captureResponses: z.boolean(), retentionDays: z.number().int(), recipients: ids }),
  }),
  "ai.quota.threshold_reached.v1": defineEvent({
    aggregateType: "ai.quota",
    summary: "An AI budget (workspace, department or person) reached 80% or 100% this month (once per budget, month and threshold)",
    intent: "projection",
    payload: z.object({
      threshold: z.number(),
      period: z.string(),
      recipients: ids,
      scope: z.enum(["workspace", "department", "person"]).optional(),
      scopeId: z.string().optional(),
      url: z.string().optional(),
    }),
  }),
  "ai.usage.recorded.v1": defineEvent({
    aggregateType: "ai.usage",
    summary:
      "AI was used on a piece of work (a task, a document, a meeting…): a company-AI call, or an outside AI conversation the person linked to a task; the work module marks AI-assisted tasks",
    intent: "projection",
    payload: z.object({
      usageId: id,
      userId: id,
      feature: z.string(),
      subjectType: z.string(),
      subjectId: id,
      tokens: z.number().int(),
      at: timestamp,
      // "extension": a conversation from the browser extension (or an import) linked to the task in Của tôi › AI;
      // usageId is then the conversation id. Older producers sent no source: they were all company AI.
      // "local": a coding-agent session on the person's computer (workspace-usage.mjs) that named the task.
      source: z.enum(["app", "extension", "local"]).default("app"),
    }),
  }),
  "ai.agent.run.completed.v1": defineEvent({
    aggregateType: "ai.agent",
    summary: "An agent answered someone in chat",
    intent: "projection",
    payload: z.object({
      agentId: id,
      agentName: z.string(),
      askerId: id,
      channelId: id,
      messageId: z.string().nullable(),
      prompt: z.string(),
      answer: z.string(),
      toolCalls: z.unknown(),
    }),
  }),
  "ai.connection.created.v1": defineEvent({ aggregateType: "ai.connection", summary: "An AI connection was added (never carries secrets)", intent: "audit", payload: connection }),
  "ai.connection.updated.v1": defineEvent({ aggregateType: "ai.connection", summary: "An AI connection was edited", intent: "audit", payload: connection }),
  "ai.connection.deleted.v1": defineEvent({ aggregateType: "ai.connection", summary: "An AI connection was removed", intent: "audit", payload: connection }),
  "ai.connection.default.v1": defineEvent({ aggregateType: "ai.connection", summary: "An AI connection became the default", intent: "audit", payload: connection }),
};
