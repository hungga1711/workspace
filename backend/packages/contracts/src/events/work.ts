import { z } from "zod";
import { day, defineEvent, id, ids, timestamp } from "./define.js";

/** Every task event but deletion carries the whole task (`eventPayload` in the work module's tasks.ts). */
const task = z.object({
  taskId: id,
  code: z.string(),
  title: z.string(),
  description: z.string(),
  ownerId: id,
  assigneeId: z.string().nullable(),
  projectId: z.string().nullable(),
  status: z.string(),
  priority: z.string().nullable(),
  dueAt: timestamp.nullable(),
  labels: z.array(z.string()),
  /** Monotonic per task: projections drop an older version arriving late. */
  version: z.number().int(),
  blockedReason: z.string().nullable(),
  /** Where the task came from: null, or { type: "chat.message" | "ai" | "meeting" | "document" | "whiteboard" | "recurring" | "import", ... }. */
  source: z.unknown(),
});

/** An agent workflow run on a task (work/workflows.ts). */
const run = z.object({ runId: id, taskId: id, code: z.string(), workflowName: z.string(), runner: z.enum(["server", "local"]) });

const project = z.object({ projectId: id, code: z.string(), name: z.string(), description: z.string().nullable(), ownerId: id, dueAt: timestamp.nullable() });

/** A page as search and Home see it; `projectId` is "workspace" when everyone may read it, null when private. */
const document = z.object({
  documentId: id,
  code: z.string(),
  title: z.string(),
  ownerId: id,
  spaceId: z.string().nullable(),
  projectId: z.string().nullable(),
  sharedWith: ids,
  /** Plain text of the page, at most 20,000 characters. */
  text: z.string(),
  version: z.number().int(),
});

/**
 * A whiteboard as search sees it (ADR 0024); `projectId` is "workspace" when every member may read it, else null: the
 * board is its own container (`wb:<id>`), which the work module's search scope lists for each person who may open it.
 */
const whiteboard = z.object({
  whiteboardId: id,
  code: z.string(),
  title: z.string(),
  ownerId: id,
  projectId: z.string().nullable(),
  /** The text on the board in reading order, at most 20,000 characters. */
  text: z.string(),
});

const calendarEvent = z.object({
  eventId: id,
  /** A meeting's readable code (H-012, or H-012-3 in a series); deadlines and other entries have none. */
  code: z.string().optional(),
  title: z.string(),
  /** "meeting", "deadline" or "event". */
  kind: z.string(),
  startsAt: timestamp,
  endsAt: timestamp,
  organizerId: id,
  attendeeIds: ids,
  location: z.string().nullish(),
  seriesId: z.string().optional(),
  seriesIndex: z.number().int().optional(),
  recurrence: z.string().optional(),
  occurrences: z.number().int().optional(),
  rescheduled: z.boolean().optional(),
  previousStartsAt: timestamp.optional(),
});

const decisionSource = z.unknown();

export const workEvents = {
  "work.task.created.v1": defineEvent({ aggregateType: "work.task", summary: "A task was created", intent: "projection", payload: task }),
  "work.task.updated.v1": defineEvent({ aggregateType: "work.task", summary: "Any change to a task (fields, column, schedule)", intent: "projection", payload: task }),
  "work.task.completed.v1": defineEvent({
    aggregateType: "work.task",
    summary: "A task moved to done (emitted next to the matching `updated`); `watchers` are the people following it",
    intent: "projection",
    payload: task.extend({ watchers: ids.optional() }),
  }),
  "work.task.deleted.v1": defineEvent({
    aggregateType: "work.task",
    summary: "A task was deleted",
    intent: "projection",
    payload: z.object({ taskId: id, code: z.string() }),
  }),
  "work.task.commented.v1": defineEvent({
    aggregateType: "work.task",
    summary: "Someone commented on a task",
    intent: "projection",
    payload: z.object({
      taskId: id,
      commentId: id,
      authorId: id,
      ownerId: id,
      assigneeId: z.string().nullable(),
      code: z.string(),
      title: z.string(),
      /** People following the task (task_watchers), told like the owner and assignee. */
      watchers: ids.optional(),
      mentions: ids,
    }),
  }),
  "work.task.comment_edited.v1": defineEvent({
    aggregateType: "work.task",
    summary: "The author edited a task comment; `mentions` lists only people newly mentioned",
    intent: "projection",
    payload: z.object({ taskId: id, commentId: id, authorId: id, code: z.string(), title: z.string(), mentions: ids }),
  }),
  "work.task.comment_deleted.v1": defineEvent({
    aggregateType: "work.task",
    summary: "A task comment was deleted (by its author, or by someone who may delete the task)",
    intent: "projection",
    payload: z.object({ taskId: id, commentId: id }),
  }),
  // Agent workflow runs (work/workflows.ts): the run is the aggregate. Questions are read by home (notices); the
  // lifecycle events are for the audit trail and for webhooks (platform/webhooks.ts offers the ones worth acting on).
  "work.run.started.v1": defineEvent({ aggregateType: "work.run", summary: "Someone started a task's agent workflow", intent: "audit", payload: run }),
  "work.run.paused.v1": defineEvent({
    aggregateType: "work.run",
    summary: "A run was paused: it holds after the step in progress",
    intent: "audit",
    payload: run,
  }),
  "work.run.resumed.v1": defineEvent({ aggregateType: "work.run", summary: "A paused run was continued", intent: "audit", payload: run }),
  "work.run.cancelled.v1": defineEvent({ aggregateType: "work.run", summary: "A run was stopped before it finished", intent: "audit", payload: run }),
  "work.run.waiting.v1": defineEvent({
    aggregateType: "work.run",
    summary: "A run reached an approval step and waits for a person to approve or send the work back",
    intent: "audit",
    payload: run.extend({
      reason: z.enum(["approval"]),
      step: z.string(),
      /** This wait (a step waits again after its work was sent back); notices about it are settled when it closes. */
      waitId: z.string().optional(),
      title: z.string().optional(),
      /** Who can give the approval, among the people the step names (home tells exactly these). */
      recipientIds: ids.optional(),
    }),
  }),
  "work.run.decided.v1": defineEvent({
    aggregateType: "work.run",
    summary: "A run's wait for approval closed: approved, the work sent back, or the run was stopped",
    intent: "projection",
    payload: run.extend({ waitId: z.string(), outcome: z.enum(["approved", "sent_back", "cancelled"]) }),
  }),
  "work.run.finished.v1": defineEvent({
    aggregateType: "work.run",
    summary: "A run ended: its result was delivered, or it failed (a failed run can be run again from the step that failed)",
    intent: "audit",
    payload: run.extend({ status: z.enum(["done", "failed"]), error: z.string().nullable() }),
  }),
  "work.run.asked.v1": defineEvent({
    aggregateType: "work.run",
    summary: "A run's AI step stopped to ask the people on the task something before it goes on",
    intent: "projection",
    payload: run.extend({
      /** The round of questions (task_agent_run_questions); notices about it are settled when it closes. */
      questionId: id,
      title: z.string(),
      /** Who should answer: the person who started the run and the assignee. */
      recipientIds: ids,
      count: z.number().int(),
    }),
  }),
  "work.run.answered.v1": defineEvent({
    aggregateType: "work.run",
    summary: "A round of a run's questions closed: answered, left to the AI, or the run was stopped",
    intent: "projection",
    payload: run.extend({ questionId: id, outcome: z.enum(["answered", "skipped", "cancelled"]) }),
  }),

  "work.project.created.v1": defineEvent({ aggregateType: "work.project", summary: "A project was created", intent: "projection", payload: project }),
  "work.project.updated.v1": defineEvent({
    aggregateType: "work.project",
    summary: "A project changed or was handed over",
    intent: "projection",
    payload: project.extend({ status: z.string(), changes: z.record(z.unknown()) }),
  }),

  "work.document.created.v1": defineEvent({ aggregateType: "work.document", summary: "A page was created", intent: "projection", payload: document }),
  "work.document.updated.v1": defineEvent({
    aggregateType: "work.document",
    summary: "A page was saved, renamed, or its readers changed (`editorId` and `watchers` only on a save)",
    intent: "projection",
    payload: document.extend({ editorId: id.optional(), watchers: ids.optional() }),
  }),
  "work.document.deleted.v1": defineEvent({
    aggregateType: "work.document",
    summary: "A page was deleted",
    intent: "projection",
    payload: z.object({ documentId: id }),
  }),
  "work.whiteboard.created.v1": defineEvent({ aggregateType: "work.whiteboard", summary: "A whiteboard was created", intent: "projection", payload: whiteboard }),
  "work.whiteboard.updated.v1": defineEvent({
    aggregateType: "work.whiteboard",
    summary: "A whiteboard's title, readers or text changed (saves that only move shapes emit nothing)",
    intent: "projection",
    payload: whiteboard,
  }),
  "work.whiteboard.deleted.v1": defineEvent({
    aggregateType: "work.whiteboard",
    summary: "A whiteboard was deleted (archived)",
    intent: "projection",
    payload: z.object({ whiteboardId: id }),
  }),
  "work.document.commented.v1": defineEvent({
    aggregateType: "work.document",
    summary: "Someone commented on a page; `notify` lists owner, last editor and mentions",
    intent: "projection",
    payload: z.object({ documentId: id, commentId: id, code: z.string(), title: z.string(), authorId: id, notify: ids, quote: z.string().nullable() }),
  }),

  "work.approval.requested.v1": defineEvent({
    aggregateType: "work.approval",
    summary: "Someone must approve a request (new, delegated, reassigned or handed over)",
    intent: "projection",
    payload: z.object({
      approvalId: id,
      /** Readable code (YC-001); absent on events from before codes, and on re-announcements that do not read it. */
      code: z.string().optional(),
      title: z.string(),
      requesterId: id,
      approverId: id,
      kind: z.string().optional(),
      amount: z.number().nullable().optional(),
      /** ISO 4217; null when the request is not about money. */
      currency: z.string().length(3).nullable().optional(),
      onBehalfOf: id.optional(),
    }),
  }),
  "work.approval.decided.v1": defineEvent({
    aggregateType: "work.approval",
    summary: "An approval was approved, rejected, or cancelled by its requester",
    intent: "projection",
    payload: z.object({
      approvalId: id,
      title: z.string(),
      requesterId: id,
      approverId: id,
      decision: z.enum(["approved", "rejected", "cancelled"]),
      decidedBy: id,
    }),
  }),
  "work.approval.commented.v1": defineEvent({
    aggregateType: "work.approval",
    summary: "A question or answer on an approval",
    intent: "projection",
    payload: z.object({ approvalId: id, title: z.string(), authorId: id, recipientId: id, body: z.string() }),
  }),

  "work.decision.proposed.v1": defineEvent({
    aggregateType: "work.decision",
    summary: "A decision awaits its named decider",
    intent: "projection",
    payload: z.object({
      decisionId: id,
      title: z.string(),
      details: z.string(),
      projectId: z.string().nullable(),
      deciderId: z.string().nullish(),
      proposedBy: z.string().nullable(),
      source: decisionSource,
    }),
  }),
  "work.decision.created.v1": defineEvent({
    aggregateType: "work.decision",
    summary: "A decision was recorded",
    intent: "projection",
    payload: z.object({ decisionId: id, title: z.string(), projectId: z.string().nullable(), decidedBy: id, proposedBy: z.string().nullable(), source: decisionSource }),
  }),
  "work.decision.withdrawn.v1": defineEvent({
    aggregateType: "work.decision",
    summary: "A proposed decision was withdrawn",
    intent: "projection",
    payload: z.object({ decisionId: id, title: z.string(), deciderId: z.string().nullable(), proposedBy: z.string().nullable() }),
  }),

  "work.delegation.set.v1": defineEvent({
    aggregateType: "work.delegation",
    summary: "Someone named an out-of-office delegate until a day",
    intent: "projection",
    payload: z.object({ userId: id, delegateId: id, until: day }),
  }),
  "work.delegation.cleared.v1": defineEvent({
    aggregateType: "work.delegation",
    summary: "An out-of-office delegate was removed",
    intent: "projection",
    payload: z.object({ userId: id }),
  }),

  "work.meeting.scheduled.v1": defineEvent({
    aggregateType: "work.calendar",
    summary: "A meeting reached calendars: created (per occurrence), edited or rescheduled",
    intent: "projection",
    payload: calendarEvent,
  }),
  "work.event.scheduled.v1": defineEvent({
    aggregateType: "work.calendar",
    summary: "A deadline or other non-meeting calendar entry was created or moved",
    intent: "audit",
    payload: calendarEvent,
  }),
  "work.event.cancelled.v1": defineEvent({
    aggregateType: "work.calendar",
    summary: "A calendar entry (meeting or not) was cancelled",
    intent: "projection",
    payload: z.object({ eventId: id }),
  }),
  /**
   * Something the workspace knows changed in a way search and AI retrieval should see: a task's comments, a
   * meeting's agenda or minutes, a calendar entry, a file whose text was read, a request. Live events carry only what
   * changed (`type`, `id`): the indexer reads the current text from the work module, so the order events arrive in
   * never matters and a long page is not copied into the outbox. The re-index feed sends `doc` along (null: gone).
   */
  "work.knowledge.changed.v1": defineEvent({
    aggregateType: "work.knowledge",
    summary: "Text that search and AI retrieval index changed (task, page, meeting, calendar entry, file, request)",
    intent: "projection",
    payload: z.object({
      type: z.enum(["task", "document", "meeting", "event", "file", "approval"]),
      id,
      doc: z
        .object({
          containerId: z.string(),
          aclUsers: ids,
          title: z.string(),
          text: z.string(),
          url: z.string(),
          updatedAt: timestamp,
        })
        .nullable()
        .optional(),
    }),
  }),
};
