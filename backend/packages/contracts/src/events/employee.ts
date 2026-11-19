import { z } from "zod";
import { day, defineEvent, id, ids, timestamp } from "./define.js";

export const employeeEvents = {
  "employee.leave.requested.v1": defineEvent({
    aggregateType: "employee.leave",
    summary: "A leave request awaits its approver (new, or re-routed on handover)",
    intent: "projection",
    payload: z.object({
      requestId: id,
      userId: id,
      displayName: z.string(),
      approverId: z.string().nullable(),
      type: z.string(),
      days: z.number(),
      startDate: day,
      endDate: day,
      onBehalfOf: id.optional(),
    }),
  }),
  "employee.leave.reminded.v1": defineEvent({
    aggregateType: "employee.leave",
    summary: "HR reminded the approver of a leave request that is still waiting",
    intent: "projection",
    payload: z.object({ requestId: id, approverId: id, displayName: z.string(), days: z.number(), remindedBy: id }),
  }),
  "employee.leave.decided.v1": defineEvent({
    aggregateType: "employee.leave",
    summary: "A leave request was approved, rejected or cancelled",
    intent: "projection",
    payload: z.object({
      requestId: id,
      userId: id,
      approverId: z.string().nullable(),
      decision: z.enum(["approved", "rejected", "cancelled"]),
      decidedBy: id,
    }),
  }),
  "employee.leave.balances_granted.v1": defineEvent({
    aggregateType: "employee.leave",
    summary: "Leave balances were granted in bulk for a type and year",
    intent: "audit",
    payload: z.object({ type: z.string(), year: z.number().int(), updated: z.number().int(), skipped: z.number().int(), by: id }).passthrough(),
  }),
  "employee.profile.updated.v1": defineEvent({
    aggregateType: "employee.profile",
    summary: "Org data changed: department or manager (also when a manager's reports are handed over)",
    intent: "audit",
    payload: z.object({ userId: id, code: z.string(), departmentId: z.string().nullable(), managerId: z.string().nullable() }),
  }),
  "employee.compensation.changed.v1": defineEvent({
    aggregateType: "employee.profile",
    summary: "Someone's compensation changed (no amounts, by design)",
    intent: "audit",
    payload: z.object({ userId: id }),
  }),
  "employee.holiday.set.v1": defineEvent({
    aggregateType: "employee.holiday",
    summary: "A company holiday was added or renamed",
    intent: "audit",
    payload: z.object({ day, name: z.string(), by: id }),
  }),
  "employee.holiday.removed.v1": defineEvent({
    aggregateType: "employee.holiday",
    summary: "A company holiday was removed",
    intent: "audit",
    payload: z.object({ day, by: id }),
  }),
  "employee.attendance.corrected.v1": defineEvent({
    aggregateType: "employee.attendance",
    summary: "An admin corrected someone's attendance for a day (before and after kept)",
    intent: "audit",
    payload: z.object({
      userId: id,
      day,
      before: z.object({ check_in: timestamp, check_out: timestamp.nullable() }).nullable(),
      after: z.object({ checkIn: timestamp, checkOut: timestamp.nullable() }),
      correctedBy: id,
      note: z.string(),
    }),
  }),
  "employee.announcement.published.v1": defineEvent({
    aggregateType: "employee.announcement",
    summary: "A company announcement was published",
    intent: "projection",
    payload: z.object({
      announcementId: id,
      title: z.string(),
      category: z.string(),
      authorId: id,
      departmentIds: ids,
      publishAt: timestamp,
      eventAt: timestamp.nullish(),
      // Who to notify (the targeted, active employees minus the author), only for an announcement published now;
      // a scheduled one is not announced early. Absent on events from before notifications existed.
      recipients: ids.optional(),
    }),
  }),
  "employee.announcement.deleted.v1": defineEvent({
    aggregateType: "employee.announcement",
    summary: "An announcement was removed",
    intent: "audit",
    payload: z.object({ announcementId: id }),
  }),
};
