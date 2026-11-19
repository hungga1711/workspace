import type { KnownEvent } from "@workspace/contracts";
import { channelLabel, fingerprint, scrubRecord } from "./privacy.js";

/**
 * Domain events → audit trail rows (ADR 0025). One case per event type an admin may need to trace, each with its
 * privacy rule in a comment; a type without a case is not audited (the doc lists which and why).
 *
 * `updated` events carry only the new state, so the last audited state of a task, project, page, board, channel or
 * profile is kept (`audit_subjects`) and diffed: "status todo → doing". Private fields are kept as a fingerprint
 * only, which says "description changed" without it.
 */

export type Outcome = "success" | "failure" | "denied";

export interface AuditDraft {
  action: string;
  targetType: string;
  targetId: string;
  targetLabel?: string | null;
  outcome?: Outcome;
  /** field → { from, to }, or { changed: true } for a private field. */
  changes?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  /**
   * Skip this row when the same actor wrote the same action on the same target less than this many minutes ago
   * (autosaved page edits are one entry per sitting, not one per keystroke burst).
   */
  coalesceMinutes?: number;
}

export interface Subject {
  type: string;
  id: string;
}

export interface SubjectState {
  version: number | null;
  state: Record<string, unknown>;
}

export interface Mapped {
  rows: AuditDraft[];
  /** The new audited state of the subject (saved), or `drop` once it is gone. */
  save?: { version: number | null; state: Record<string, unknown> } | "drop";
}

/** The subject whose previous state an event's mapping needs, if any. */
export function subjectOf(e: KnownEvent): Subject | null {
  switch (e.eventType) {
    case "work.task.created.v1":
    case "work.task.updated.v1":
    case "work.task.deleted.v1":
    case "work.task.commented.v1":
    case "work.task.comment_deleted.v1":
      return { type: "task", id: e.payload.taskId };
    case "work.project.created.v1":
    case "work.project.updated.v1":
      return { type: "project", id: e.payload.projectId };
    case "work.document.created.v1":
    case "work.document.updated.v1":
    case "work.document.deleted.v1":
      return { type: "document", id: e.payload.documentId };
    case "work.whiteboard.created.v1":
    case "work.whiteboard.updated.v1":
    case "work.whiteboard.deleted.v1":
      return { type: "whiteboard", id: e.payload.whiteboardId };
    case "chat.channel.created.v1":
    case "chat.channel.updated.v1":
    case "chat.channel.member_added.v1":
    case "chat.channel.member_removed.v1":
      return { type: "channel", id: e.payload.channelId };
    case "employee.profile.updated.v1":
      return { type: "profile", id: e.payload.userId };
    case "work.meeting.scheduled.v1":
    case "work.event.scheduled.v1":
    case "work.event.cancelled.v1":
      return { type: "calendar", id: e.payload.eventId };
    default:
      return null;
  }
}

const label = (code: string | null | undefined, title: string | null | undefined) => [code, title].filter(Boolean).join(" · ") || null;

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** { field: { from, to } } for changed public fields, { field: { changed: true } } for changed fingerprints. */
export function diff(prev: Record<string, unknown>, next: Record<string, unknown>, fields: string[], hashed: string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) if (!same(prev[f], next[f])) out[f] = { from: prev[f] ?? null, to: next[f] ?? null };
  for (const f of hashed) if (!same(prev[f], next[f])) out[f] = { changed: true };
  return out;
}

const sorted = (xs: readonly string[] | undefined) => [...(xs ?? [])].sort();

/** One specific action when a single well-known field changed, else the generic `updated`. */
function pick(changes: Record<string, unknown>, specific: Record<string, string>, fallback: string): string {
  const keys = Object.keys(changes);
  return keys.length === 1 && specific[keys[0]!] ? specific[keys[0]!]! : fallback;
}

/** Whether a stored state is newer than (or as new as) this event's version: an older event arriving late. */
const stale = (prev: SubjectState | null, version: number | undefined) => prev?.version != null && version != null && version <= prev.version;

/** Maps one event. `actor` is the envelope's actor ("user:…"), for "joined" vs "added". */
export function mapEvent(e: KnownEvent, prev: SubjectState | null, actor: string): Mapped | null {
  const p0 = prev?.state ?? {};
  switch (e.eventType) {
    // ── audit.entry: written by modules where no domain event says it; meta/changes are scrubbed in the consumer.
    case "audit.entry.recorded.v1": {
      const x = e.payload;
      return {
        rows: [
          {
            action: x.action,
            targetType: x.targetType,
            targetId: x.targetId,
            targetLabel: x.targetLabel ?? null,
            outcome: x.outcome,
            ...(x.changes ? { changes: scrubRecord(x.changes) } : {}),
            ...(x.meta ? { meta: scrubRecord(x.meta) } : {}),
            ...(x.coalesceMinutes ? { coalesceMinutes: x.coalesceMinutes } : {}),
          },
        ],
      };
    }

    // ── identity: invitations, roles, renames, offboarding are direct entries from identity (richer); only the join
    // itself has no direct entry.
    case "identity.member.joined.v1":
      return { rows: [{ action: "identity.member.joined", targetType: "member", targetId: e.payload.userId, targetLabel: e.payload.email, meta: { owner: !!e.payload.owner } }] };

    // ── chat: structure only. DMs and group conversations are not audited at all (who talks to whom is private);
    // a private channel never shows its name, a public one does. Topic text is never stored.
    case "chat.channel.created.v1": {
      const x = e.payload;
      const state = { kind: x.kind, name: x.kind === "public" ? x.name : null, archived: false, topic: fingerprint(x.topic) };
      if (x.kind === "dm" || x.kind === "group") return { rows: [], save: { version: null, state } };
      return {
        rows: [
          {
            action: "chat.channel.created",
            targetType: "channel",
            targetId: x.channelId,
            targetLabel: channelLabel(x.kind, x.name),
            meta: { kind: x.kind, members: x.memberIds.length },
          },
        ],
        save: { version: null, state },
      };
    }
    case "chat.channel.updated.v1": {
      const x = e.payload;
      const next = { kind: x.kind, name: x.kind === "public" ? x.name : null, archived: x.archived, topic: fingerprint(x.topic) };
      if (x.kind === "dm" || x.kind === "group") return { rows: [], save: { version: null, state: next } };
      const lbl = channelLabel(x.kind, x.name);
      const rows: AuditDraft[] = [];
      const base = { targetType: "channel", targetId: x.channelId, targetLabel: lbl, meta: { kind: x.kind } };
      const prevName = prev ? p0.name : x.kind === "public" ? x.previousName : null;
      const renamed = x.previousName !== null && x.previousName !== x.name;
      if (renamed)
        rows.push({
          ...base,
          action: "chat.channel.renamed",
          changes: x.kind === "public" ? { name: { from: prevName ?? x.previousName, to: x.name } } : { name: { changed: true } },
        });
      if (prev ? p0.archived !== x.archived : x.archived) rows.push({ ...base, action: x.archived ? "chat.channel.archived" : "chat.channel.unarchived" });
      if (prev && p0.topic !== next.topic) rows.push({ ...base, action: "chat.channel.updated", changes: { topic: { changed: true } } });
      return { rows, save: { version: null, state: next } };
    }
    case "chat.channel.member_added.v1":
    case "chat.channel.member_removed.v1": {
      const kind = typeof p0.kind === "string" ? p0.kind : null;
      // Unknown (created before the trail): treated as private, so no name is shown.
      if (kind === "dm" || kind === "group") return { rows: [] };
      const lbl = channelLabel(kind, typeof p0.name === "string" ? p0.name : null);
      const meta = { kind: kind ?? "private" };
      if (e.eventType === "chat.channel.member_added.v1") {
        const self = e.payload.userIds.length === 1 && actor === `user:${e.payload.userIds[0]}`;
        return {
          rows: [
            {
              action: self ? "chat.channel.joined" : "chat.channel.member_added",
              targetType: "channel",
              targetId: e.payload.channelId,
              targetLabel: lbl,
              meta: { ...meta, userIds: e.payload.userIds },
            },
          ],
        };
      }
      const self = actor === `user:${e.payload.userId}`;
      return {
        rows: [
          {
            action: self ? "chat.channel.left" : "chat.channel.member_removed",
            targetType: "channel",
            targetId: e.payload.channelId,
            targetLabel: lbl,
            meta: { ...meta, userIds: [e.payload.userId] },
          },
        ],
      };
    }

    // ── work: tasks. The description and blocked reason are fingerprints; comments are recorded as "commented"
    // without their text.
    case "work.task.created.v1":
    case "work.task.updated.v1": {
      const x = e.payload;
      const state = {
        code: x.code,
        title: x.title,
        status: x.status,
        assigneeId: x.assigneeId,
        priority: x.priority,
        dueAt: x.dueAt,
        projectId: x.projectId,
        labels: sorted(x.labels),
        description: fingerprint(x.description),
        blockedReason: fingerprint(x.blockedReason),
      };
      const save = { version: x.version, state };
      const target = { targetType: "task", targetId: x.taskId, targetLabel: label(x.code, x.title) };
      if (e.eventType === "work.task.created.v1") {
        const source = x.source && typeof x.source === "object" ? (x.source as { type?: unknown }).type : null;
        return {
          rows: [
            {
              ...target,
              action: "work.task.created",
              meta: { status: x.status, assigneeId: x.assigneeId, priority: x.priority, dueAt: x.dueAt, projectId: x.projectId, ...(typeof source === "string" ? { source } : {}) },
            },
          ],
          save,
        };
      }
      if (stale(prev, x.version)) return { rows: [] };
      if (!prev) return { rows: [{ ...target, action: "work.task.updated", meta: { status: x.status, assigneeId: x.assigneeId, dueAt: x.dueAt } }], save };
      const changes = diff(p0, state, ["title", "status", "assigneeId", "priority", "dueAt", "projectId", "labels"], ["description", "blockedReason"]);
      if (!Object.keys(changes).length) return { rows: [], save };
      const action = pick(
        changes,
        { status: "work.task.status_changed", assigneeId: "work.task.assigned", dueAt: "work.task.rescheduled", title: "work.task.renamed", projectId: "work.task.moved" },
        "work.task.updated",
      );
      return { rows: [{ ...target, action, changes }], save };
    }
    case "work.task.deleted.v1":
      return {
        rows: [{ action: "work.task.deleted", targetType: "task", targetId: e.payload.taskId, targetLabel: label(e.payload.code, typeof p0.title === "string" ? p0.title : null) }],
        save: "drop",
      };
    case "work.task.commented.v1":
      return {
        rows: [
          {
            action: "work.task.commented",
            targetType: "task",
            targetId: e.payload.taskId,
            targetLabel: label(e.payload.code, e.payload.title),
            meta: { commentId: e.payload.commentId },
          },
        ],
      };
    case "work.task.comment_deleted.v1":
      return {
        rows: [
          {
            action: "work.task.comment_deleted",
            targetType: "task",
            targetId: e.payload.taskId,
            targetLabel: label(p0.code as string, p0.title as string),
            meta: { commentId: e.payload.commentId },
          },
        ],
      };
    // Agent workflows asking the people on a task (the questions and answers themselves are not stored).
    case "work.run.asked.v1":
      return {
        rows: [
          {
            action: "work.workflow.asked",
            targetType: "task",
            targetId: e.payload.taskId,
            targetLabel: label(e.payload.code, e.payload.title),
            meta: { runId: e.payload.runId, workflow: e.payload.workflowName, count: e.payload.count },
          },
        ],
      };
    case "work.run.answered.v1":
      return {
        rows: [
          {
            action: "work.workflow.answered",
            targetType: "task",
            targetId: e.payload.taskId,
            targetLabel: label(e.payload.code, typeof p0.title === "string" ? p0.title : null),
            outcome: e.payload.outcome === "cancelled" ? "failure" : "success",
            meta: { runId: e.payload.runId, result: e.payload.outcome },
          },
        ],
      };

    // ── work: projects (the description is a fingerprint).
    case "work.project.created.v1":
    case "work.project.updated.v1": {
      const x = e.payload;
      const state = { code: x.code, name: x.name, ownerId: x.ownerId, dueAt: x.dueAt, status: "status" in x ? x.status : "active", description: fingerprint(x.description) };
      const target = { targetType: "project", targetId: x.projectId, targetLabel: label(x.code, x.name) };
      if (e.eventType === "work.project.created.v1")
        return { rows: [{ ...target, action: "work.project.created", meta: { ownerId: x.ownerId, dueAt: x.dueAt } }], save: { version: null, state } };
      if (!prev) return { rows: [{ ...target, action: "work.project.updated", meta: { status: state.status } }], save: { version: null, state } };
      const changes = diff(p0, state, ["name", "status", "ownerId", "dueAt"], ["description"]);
      if (!Object.keys(changes).length) return { rows: [], save: { version: null, state } };
      return {
        rows: [{ ...target, action: pick(changes, { status: "work.project.status_changed", ownerId: "work.project.handed_over" }, "work.project.updated"), changes }],
        save: { version: null, state },
      };
    }

    // ── work: pages and whiteboards. Their text is a fingerprint; a content edit is "edited" once per sitting.
    case "work.document.created.v1":
    case "work.document.updated.v1": {
      const x = e.payload;
      const state = { code: x.code, title: x.title, projectId: x.projectId, spaceId: x.spaceId, sharedWith: sorted(x.sharedWith), text: fingerprint(x.text) };
      const target = { targetType: "document", targetId: x.documentId, targetLabel: label(x.code, x.title) };
      // A page's version counts content saves only (a rename keeps it), so it cannot order these events.
      const save = { version: null, state };
      if (e.eventType === "work.document.created.v1") return { rows: [{ ...target, action: "work.document.created", meta: { projectId: x.projectId, spaceId: x.spaceId } }], save };
      const edited: AuditDraft = { ...target, action: "work.document.edited", coalesceMinutes: 30 };
      if (!prev) return { rows: [edited], save };
      const structural = diff(p0, state, ["title", "projectId", "spaceId"]);
      if (!same(p0.sharedWith, state.sharedWith)) {
        const before = new Set((p0.sharedWith as string[] | undefined) ?? []);
        const after = new Set(state.sharedWith);
        structural.sharedWith = { added: state.sharedWith.filter((u) => !before.has(u)), removed: [...before].filter((u) => !after.has(u)) };
      }
      const rows: AuditDraft[] = [];
      if (Object.keys(structural).length)
        rows.push({
          ...target,
          action: pick(
            structural,
            { title: "work.document.renamed", sharedWith: "work.document.shared", projectId: "work.document.moved", spaceId: "work.document.moved" },
            "work.document.updated",
          ),
          changes: structural,
        });
      if (p0.text !== state.text) rows.push(edited);
      return { rows, save };
    }
    case "work.document.deleted.v1":
      return {
        rows: [{ action: "work.document.deleted", targetType: "document", targetId: e.payload.documentId, targetLabel: label(p0.code as string, p0.title as string) }],
        save: "drop",
      };
    case "work.document.commented.v1":
      // The quote and the comment are content: only that a comment was made.
      return {
        rows: [
          {
            action: "work.document.commented",
            targetType: "document",
            targetId: e.payload.documentId,
            targetLabel: label(e.payload.code, e.payload.title),
            meta: { commentId: e.payload.commentId },
          },
        ],
      };
    case "work.whiteboard.created.v1":
    case "work.whiteboard.updated.v1": {
      const x = e.payload;
      const state = { code: x.code, title: x.title, projectId: x.projectId, text: fingerprint(x.text) };
      const target = { targetType: "whiteboard", targetId: x.whiteboardId, targetLabel: label(x.code, x.title) };
      if (e.eventType === "work.whiteboard.created.v1") return { rows: [{ ...target, action: "work.whiteboard.created" }], save: { version: null, state } };
      const edited: AuditDraft = { ...target, action: "work.whiteboard.edited", coalesceMinutes: 30 };
      if (!prev) return { rows: [edited], save: { version: null, state } };
      const changes = diff(p0, state, ["title", "projectId"]);
      const rows: AuditDraft[] = [];
      if (Object.keys(changes).length) rows.push({ ...target, action: pick(changes, { title: "work.whiteboard.renamed" }, "work.whiteboard.updated"), changes });
      if (p0.text !== state.text) rows.push(edited);
      return { rows, save: { version: null, state } };
    }
    case "work.whiteboard.deleted.v1":
      return {
        rows: [{ action: "work.whiteboard.deleted", targetType: "whiteboard", targetId: e.payload.whiteboardId, targetLabel: label(p0.code as string, p0.title as string) }],
        save: "drop",
      };

    // ── work: approvals and decisions (the question/answer text and a decision's details are content).
    case "work.approval.requested.v1": {
      const x = e.payload;
      return {
        rows: [
          {
            action: "work.approval.requested",
            targetType: "approval",
            targetId: x.approvalId,
            targetLabel: label(x.code, x.title),
            meta: {
              approverId: x.approverId,
              requesterId: x.requesterId,
              kind: x.kind ?? null,
              amount: x.amount ?? null,
              currency: x.currency ?? null,
              ...(x.onBehalfOf ? { onBehalfOf: x.onBehalfOf } : {}),
            },
          },
        ],
      };
    }
    case "work.approval.decided.v1":
      return {
        rows: [
          {
            action: `work.approval.${e.payload.decision}`,
            targetType: "approval",
            targetId: e.payload.approvalId,
            targetLabel: e.payload.title,
            meta: { requesterId: e.payload.requesterId, approverId: e.payload.approverId },
          },
        ],
      };
    case "work.approval.commented.v1":
      return { rows: [{ action: "work.approval.commented", targetType: "approval", targetId: e.payload.approvalId, targetLabel: e.payload.title }] };
    case "work.decision.proposed.v1":
      return {
        rows: [
          {
            action: "work.decision.proposed",
            targetType: "decision",
            targetId: e.payload.decisionId,
            targetLabel: e.payload.title,
            meta: { deciderId: e.payload.deciderId ?? null, projectId: e.payload.projectId },
          },
        ],
      };
    case "work.decision.created.v1":
      return {
        rows: [
          { action: "work.decision.recorded", targetType: "decision", targetId: e.payload.decisionId, targetLabel: e.payload.title, meta: { projectId: e.payload.projectId } },
        ],
      };
    case "work.decision.withdrawn.v1":
      return { rows: [{ action: "work.decision.withdrawn", targetType: "decision", targetId: e.payload.decisionId, targetLabel: e.payload.title }] };
    case "work.delegation.set.v1":
      return { rows: [{ action: "work.delegation.set", targetType: "member", targetId: e.payload.userId, meta: { delegateId: e.payload.delegateId, until: e.payload.until } }] };
    case "work.delegation.cleared.v1":
      return { rows: [{ action: "work.delegation.cleared", targetType: "member", targetId: e.payload.userId }] };

    // ── work: calendar. A series is one entry (its first occurrence), not one per meeting.
    case "work.meeting.scheduled.v1":
    case "work.event.scheduled.v1": {
      const x = e.payload;
      const state = { code: x.code ?? null, title: x.title, startsAt: x.startsAt };
      const target = { targetType: x.kind === "meeting" ? "meeting" : "calendar_event", targetId: x.eventId, targetLabel: label(x.code, x.title) };
      if (x.rescheduled || (prev && !same(p0.startsAt, x.startsAt)))
        return {
          rows: [{ ...target, action: "work.meeting.rescheduled", changes: { startsAt: { from: p0.startsAt ?? x.previousStartsAt ?? null, to: x.startsAt } } }],
          save: { version: null, state },
        };
      if (prev || (x.seriesIndex ?? 0) > 0) return { rows: [], save: { version: null, state } };
      return {
        rows: [
          {
            ...target,
            action: "work.meeting.scheduled",
            meta: { kind: x.kind, startsAt: x.startsAt, attendees: x.attendeeIds.length, ...(x.occurrences ? { occurrences: x.occurrences } : {}) },
          },
        ],
        save: { version: null, state },
      };
    }
    case "work.event.cancelled.v1":
      return {
        rows: [{ action: "work.meeting.cancelled", targetType: "meeting", targetId: e.payload.eventId, targetLabel: label(p0.code as string, p0.title as string) }],
        save: "drop",
      };

    // ── employee: leave (type and days, never the reason), org changes, compensation (never amounts), holidays,
    // attendance corrections (before/after times, never the note), announcements (title only).
    case "employee.leave.requested.v1": {
      const x = e.payload;
      return {
        rows: [
          {
            action: "employee.leave.requested",
            targetType: "leave_request",
            targetId: x.requestId,
            targetLabel: x.displayName,
            meta: {
              userId: x.userId,
              type: x.type,
              days: x.days,
              startDate: x.startDate,
              endDate: x.endDate,
              approverId: x.approverId,
              ...(x.onBehalfOf ? { onBehalfOf: x.onBehalfOf } : {}),
            },
          },
        ],
      };
    }
    case "employee.leave.decided.v1":
      return { rows: [{ action: `employee.leave.${e.payload.decision}`, targetType: "leave_request", targetId: e.payload.requestId, meta: { userId: e.payload.userId } }] };
    case "employee.leave.balances_granted.v1":
      return {
        rows: [
          {
            action: "employee.leave.balances_granted",
            targetType: "leave_type",
            targetId: e.payload.type,
            targetLabel: `${e.payload.type} ${e.payload.year}`,
            meta: { year: e.payload.year, updated: e.payload.updated, skipped: e.payload.skipped },
          },
        ],
      };
    case "employee.profile.updated.v1": {
      const x = e.payload;
      const state = { departmentId: x.departmentId, managerId: x.managerId };
      const target = { targetType: "member", targetId: x.userId, targetLabel: x.code || null };
      if (!prev) return { rows: [{ ...target, action: "employee.profile.updated", meta: state }], save: { version: null, state } };
      const changes = diff(p0, state, ["departmentId", "managerId"]);
      if (!Object.keys(changes).length) return { rows: [], save: { version: null, state } };
      return {
        rows: [
          {
            ...target,
            action: pick(changes, { departmentId: "employee.profile.department_changed", managerId: "employee.profile.manager_changed" }, "employee.profile.updated"),
            changes,
          },
        ],
        save: { version: null, state },
      };
    }
    case "employee.compensation.changed.v1":
      return { rows: [{ action: "employee.compensation.changed", targetType: "member", targetId: e.payload.userId }] };
    case "employee.holiday.set.v1":
      return { rows: [{ action: "employee.holiday.set", targetType: "holiday", targetId: e.payload.day, targetLabel: e.payload.name }] };
    case "employee.holiday.removed.v1":
      return { rows: [{ action: "employee.holiday.removed", targetType: "holiday", targetId: e.payload.day }] };
    case "employee.attendance.corrected.v1": {
      const x = e.payload;
      return {
        rows: [
          {
            action: "employee.attendance.corrected",
            targetType: "member",
            targetId: x.userId,
            meta: { day: x.day },
            changes: {
              checkIn: { from: x.before?.check_in ?? null, to: x.after.checkIn },
              checkOut: { from: x.before?.check_out ?? null, to: x.after.checkOut },
            },
          },
        ],
      };
    }
    case "employee.announcement.published.v1":
      return {
        rows: [
          {
            action: "employee.announcement.published",
            targetType: "announcement",
            targetId: e.payload.announcementId,
            targetLabel: e.payload.title,
            meta: { category: e.payload.category, departments: e.payload.departmentIds.length },
          },
        ],
      };
    case "employee.announcement.deleted.v1":
      return { rows: [{ action: "employee.announcement.deleted", targetType: "announcement", targetId: e.payload.announcementId }] };

    // ── ai: connections (never secrets), sensitive-data flags (the kinds of data, never the prompt). Policy changes are
    // a direct entry from the ai module (with before and after).
    case "ai.connection.created.v1":
    case "ai.connection.updated.v1":
    case "ai.connection.deleted.v1":
    case "ai.connection.default.v1": {
      const verb = e.eventType.split(".")[2]!;
      return {
        rows: [
          {
            action: `ai.connection.${verb === "default" ? "made_default" : verb}`,
            targetType: "ai_connection",
            targetId: e.payload.id,
            targetLabel: e.payload.name,
            meta: { mode: e.payload.mode, vendor: e.payload.vendor },
          },
        ],
      };
    }
    case "ai.activity.flagged.v1":
      return {
        rows: [
          {
            action: "ai.activity.flagged",
            targetType: "member",
            targetId: e.payload.userId,
            outcome: "denied",
            meta: { source: e.payload.source, kinds: e.payload.kinds, conversationId: e.payload.conversationId },
          },
        ],
      };

    default:
      return null;
  }
}

/** Types the consumer maps (anything else is skipped before touching the database). */
export const MAPPED_TYPES = new Set<string>([
  "audit.entry.recorded.v1",
  "identity.member.joined.v1",
  "chat.channel.created.v1",
  "chat.channel.updated.v1",
  "chat.channel.member_added.v1",
  "chat.channel.member_removed.v1",
  "work.task.created.v1",
  "work.task.updated.v1",
  "work.task.deleted.v1",
  "work.task.commented.v1",
  "work.task.comment_deleted.v1",
  "work.run.asked.v1",
  "work.run.answered.v1",
  "work.project.created.v1",
  "work.project.updated.v1",
  "work.document.created.v1",
  "work.document.updated.v1",
  "work.document.deleted.v1",
  "work.document.commented.v1",
  "work.whiteboard.created.v1",
  "work.whiteboard.updated.v1",
  "work.whiteboard.deleted.v1",
  "work.approval.requested.v1",
  "work.approval.decided.v1",
  "work.approval.commented.v1",
  "work.decision.proposed.v1",
  "work.decision.created.v1",
  "work.decision.withdrawn.v1",
  "work.delegation.set.v1",
  "work.delegation.cleared.v1",
  "work.meeting.scheduled.v1",
  "work.event.scheduled.v1",
  "work.event.cancelled.v1",
  "employee.leave.requested.v1",
  "employee.leave.decided.v1",
  "employee.leave.balances_granted.v1",
  "employee.profile.updated.v1",
  "employee.compensation.changed.v1",
  "employee.holiday.set.v1",
  "employee.holiday.removed.v1",
  "employee.attendance.corrected.v1",
  "employee.announcement.published.v1",
  "employee.announcement.deleted.v1",
  "ai.connection.created.v1",
  "ai.connection.updated.v1",
  "ai.connection.deleted.v1",
  "ai.connection.default.v1",
  "ai.activity.flagged.v1",
]);

/** "user:abc" → { type, id }; API keys are service principals "service:apikey:<id>". */
export function parseActor(actorId: string): { type: string; id: string } {
  const i = actorId.indexOf(":");
  const kind = i < 0 ? actorId : actorId.slice(0, i);
  const rest = i < 0 ? "" : actorId.slice(i + 1);
  if (kind === "user" || kind === "agent") return { type: kind, id: rest };
  if (kind === "service" && rest.startsWith("apikey:")) return { type: "apikey", id: rest.slice("apikey:".length) };
  if (kind === "anonymous") return { type: "anonymous", id: rest };
  return { type: "system", id: kind === "service" ? rest : "" };
}
