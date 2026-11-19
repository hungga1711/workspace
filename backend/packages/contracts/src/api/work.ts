import { z } from "zod";

/**
 * Request bodies of the public work API, shared by the work module's controllers (which parse them), the gateway's
 * MCP tools and the OpenAPI document, so the three cannot drift apart.
 */

export const taskStatus = z.enum(["todo", "in_progress", "review", "done", "cancelled"]);
export const taskPriority = z.enum(["low", "medium", "high", "urgent"]);
export const taskRecurrence = z.enum(["daily", "weekdays", "weekly", "biweekly", "monthly"]);
export const isoDateTime = z.string().datetime({ offset: true });

export const taskCreateBody = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().max(20000).default(""),
  assigneeId: z.string().nullable().default(null),
  projectId: z.string().nullable().default(null),
  priority: taskPriority.default("medium"),
  dueAt: isoDateTime.nullable().default(null),
  labels: z.array(z.string().max(40)).max(20).default([]),
  customFields: z.record(z.unknown()).default({}),
  parentId: z.string().nullable().default(null),
  source: z
    .union([
      z.object({ type: z.literal("chat.message"), messageId: z.string(), channelId: z.string() }),
      z.object({ type: z.literal("meeting"), eventId: z.string() }),
      z.object({ type: z.literal("document"), documentId: z.string() }),
    ])
    .nullable()
    .default(null),
  recurrence: taskRecurrence.nullable().default(null),
  /** The board column the task starts in (the project's first column if absent). Never sets the status. */
  columnId: z.string().min(1).nullable().default(null),
  /** The starting status (to do if absent). */
  status: taskStatus.exclude(["cancelled"]).optional(),
  startAt: isoDateTime.nullable().default(null),
});

/** `expectedVersion` is the task's `version` as last read: a concurrent edit answers 409 instead of being lost. */
export const taskUpdateBody = z.object({
  expectedVersion: z.number().int().positive(),
  title: z.string().trim().min(1).max(300).optional(),
  description: z.string().max(20000).optional(),
  assigneeId: z.string().nullable().optional(),
  priority: taskPriority.optional(),
  dueAt: isoDateTime.nullable().optional(),
  labels: z.array(z.string().max(40)).max(20).optional(),
  customFields: z.record(z.unknown()).optional(),
  status: taskStatus.optional(),
  blockedReason: z.string().max(500).nullable().optional(),
  recurrence: taskRecurrence.nullable().optional(),
  startAt: isoDateTime.nullable().optional(),
});

export const taskCommentBody = z.object({ body: z.string().trim().min(1).max(10000) });
/** A link to a pull or merge request, an issue or a design in a tool the company connected (the integrations hub). */
export const taskLinkBody = z.object({ url: z.string().trim().url().max(2000) });

// ── Agent workflows and their runs (work/workflows.ts) ────────────────────────────────────────────────

/** Starting a task's workflow: what the workflow asks for at Run, by input key. */
export const runStartBody = z.object({
  inputs: z
    .record(z.string().max(40), z.union([z.string().max(8000), z.number()]))
    .optional()
    .describe("The workflow's inputs by key (config.inputs of the workflow); required ones must be given"),
});
/** Letting a run past the approval it waits on; the note goes to the next step. */
export const runApproveBody = z.object({ note: z.string().max(4000).default("") });
/** Sending the result back instead of approving: the AI step under review runs again with this note. */
export const runReworkBody = z.object({ note: z.string().trim().min(1).max(4000).describe("What should change") });
/** Answering a round of an AI step's questions (by question id), or leaving them to the AI. */
export const runAnswerBody = z.object({
  answers: z.record(z.string().max(40), z.string().max(4000)).optional().describe("Answer text by question id"),
  skip: z.boolean().optional().describe("true: let the AI decide instead of answering"),
});
/** One step's activity: `after` is the id of the last line already read. */
export const runActivityQuery = z.object({
  step: z.coerce.number().int().min(0).max(200).describe("The step's index in the run, from 0"),
  after: z.coerce.number().int().min(0).optional().describe("Only lines after this line id"),
});

// ── Requests for approval (work/approvals.ts) ─────────────────────────────────────────────────────────

export const approvalRequestBody = z.object({
  title: z.string().trim().min(1).max(200),
  details: z.string().max(5000).default(""),
  approverId: z.string().min(1),
  kind: z.enum(["purchase", "payment", "advance", "trip", "other"]).default("other"),
  // A company template (Vận hành › Mẫu yêu cầu); its requests are kind "other".
  templateId: z.string().max(40).nullable().default(null),
  // Money in `currency` (ISO 4217, default VND).
  amount: z.number().min(0).max(1e13).nullable().default(null).describe("Required for purchase, payment and advance"),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable()
    .default(null),
  // The template's own fields (vendor, purpose, dates…): short strings only.
  fields: z
    .record(z.string().max(40), z.string().max(500))
    .refine((f) => Object.keys(f).length <= 12, "too many fields")
    .default({}),
});
export const approvalDecisionBody = z.object({ decision: z.enum(["approved", "rejected"]), comment: z.string().max(2000).nullable().default(null) });

// ── Calendar (work/calendar.ts) ───────────────────────────────────────────────────────────────────────

export const calendarEventCreateBody = z.object({
  title: z.string().trim().min(1).max(200),
  kind: z.enum(["meeting", "deadline", "event"]).default("meeting"),
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  attendeeIds: z.array(z.string()).max(200).default([]),
  location: z.string().max(200).default(""),
  projectId: z.string().nullable().default(null),
  recurrence: z
    .object({
      rule: z.enum(["daily", "weekdays", "weekly", "biweekly", "monthly"]),
      until: isoDateTime,
      timeZone: z
        .string()
        .max(64)
        .refine((tz) => {
          try {
            new Intl.DateTimeFormat("en-US", { timeZone: tz });
            return true;
          } catch {
            return false;
          }
        }, "unknown time zone")
        .optional(),
    })
    .nullable()
    .optional(),
});
export const calendarEventUpdateBody = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  startsAt: isoDateTime.optional(),
  endsAt: isoDateTime.optional(),
  location: z.string().max(200).optional(),
});
export const calendarRespondBody = z.object({ response: z.enum(["accepted", "declined"]) });
