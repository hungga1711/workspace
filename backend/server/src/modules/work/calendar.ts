import type { PoolClient } from "pg";
import { workspaceTimeZone } from "./settings.js";
import { newId, type Principal } from "@workspace/shared";
import { emit, requireAny } from "./common.js";
import { nextCode } from "./codes.js";
import { Forbidden, Invalid, NotFound } from "./errors.js";

export type Recurrence = "daily" | "weekdays" | "weekly" | "biweekly" | "monthly";
/** A series stops at its end date, after a year, or after this many meetings, whichever comes first. */
export const MAX_OCCURRENCES = 100;

/**
 * Start times of a series. Steps are whole days on the UTC instant, so the local wall-clock time stays
 * the same in zones without daylight saving (Vietnam and the region). Monthly keeps the day of month and
 * skips months that do not have it (31st). "weekdays" skips Saturday and Sunday in the organizer's time zone.
 */
export function occurrences(start: Date, rule: Recurrence, until: Date, timeZone: string): Date[] {
  const out: Date[] = [];
  const end = Math.min(until.getTime(), start.getTime() + 366 * 86400_000);
  const day = 86400_000;
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" });
  for (let i = 0; out.length < MAX_OCCURRENCES; i++) {
    let d: Date;
    if (rule === "monthly") {
      d = new Date(start);
      d.setUTCMonth(start.getUTCMonth() + i);
      if (d.getUTCDate() !== start.getUTCDate()) {
        if (d.getTime() > end) break;
        continue;
      }
    } else {
      const step = rule === "weekly" ? 7 : rule === "biweekly" ? 14 : 1;
      d = new Date(start.getTime() + i * step * day);
    }
    if (d.getTime() > end) break;
    if (rule === "weekdays" && ["Sat", "Sun"].includes(weekday.format(d))) continue;
    out.push(d);
  }
  return out;
}

export async function createEvent(
  c: PoolClient,
  p: Principal,
  input: {
    title: string;
    kind: "meeting" | "deadline" | "event";
    startsAt: string;
    endsAt: string;
    attendeeIds: string[];
    location: string;
    projectId: string | null;
    recurrence?: { rule: Recurrence; until: string; timeZone?: string | undefined } | null | undefined;
  },
) {
  requireAny(p, "calendar.edit", [{ ownerId: p.id }]);
  if (Date.parse(input.endsAt) < Date.parse(input.startsAt)) throw new Invalid("event ends before it starts");
  if (input.recurrence && Date.parse(input.recurrence.until) < Date.parse(input.startsAt)) throw new Invalid("the series ends before it starts");
  const duration = Date.parse(input.endsAt) - Date.parse(input.startsAt);
  const starts = input.recurrence
    ? occurrences(new Date(input.startsAt), input.recurrence.rule, new Date(input.recurrence.until), input.recurrence.timeZone ?? (await workspaceTimeZone(c)))
    : [new Date(input.startsAt)];
  if (!starts.length) throw new Invalid("the series has no meetings (check the days and end date)");
  const seriesId = input.recurrence ? newId() : null;
  const attendees = [...new Set([p.id, ...input.attendeeIds])];
  const ids: string[] = [];
  // Meetings get a code (H-012); a series shares one number and numbers its occurrences (H-012-1, H-012-2…).
  // Deadlines and other entries have none.
  const firstId = newId();
  const base = input.kind === "meeting" ? await nextCode(c, "meeting", firstId) : null;
  for (const [i, start] of starts.entries()) {
    const id = i === 0 ? firstId : newId();
    const code = base && seriesId ? `${base}-${i + 1}` : base;
    ids.push(id);
    const startsAt = start.toISOString();
    const endsAt = new Date(start.getTime() + duration).toISOString();
    await c.query(
      "INSERT INTO calendar_events (id, title, kind, starts_at, ends_at, organizer_id, location, project_id, series_id, recurrence, code) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [id, input.title, input.kind, startsAt, endsAt, p.id, input.location, input.projectId, seriesId, input.recurrence?.rule ?? null, code],
    );
    for (const u of attendees) {
      await c.query("INSERT INTO event_attendees (event_id, user_id, response) VALUES ($1,$2,$3)", [id, u, u === p.id ? "accepted" : "pending"]);
    }
    // Every occurrence reaches calendars and Today; only the first one is announced as an invitation.
    await emit(c, input.kind === "meeting" ? "work.meeting.scheduled.v1" : "work.event.scheduled.v1", "work.calendar", id, {
      eventId: id,
      ...(code ? { code } : {}),
      title: input.title,
      kind: input.kind,
      startsAt,
      endsAt,
      organizerId: p.id,
      attendeeIds: attendees,
      location: input.location,
      ...(seriesId ? { seriesId, seriesIndex: i, recurrence: input.recurrence!.rule, occurrences: starts.length } : {}),
    });
  }
  return { id: ids[0]!, code: base && seriesId ? `${base}-1` : base, seriesId, occurrences: ids.length };
}

export async function listEvents(c: PoolClient, p: Principal, from: string, to: string) {
  requireAny(p, "calendar.read", [{ ownerId: p.id }]);
  const r = await c.query(
    `SELECT e.id, e.code, e.title, e.kind, e.starts_at AS "startsAt", e.ends_at AS "endsAt", e.organizer_id AS "organizerId", e.location, a.response,
            e.series_id AS "seriesId", e.recurrence
       FROM calendar_events e JOIN event_attendees a ON a.event_id = e.id
      WHERE a.user_id = $1 AND e.starts_at < $3 AND e.ends_at >= $2 ORDER BY e.starts_at LIMIT 500`,
    [p.id, from, to],
  );
  return r.rows;
}

export async function respond(c: PoolClient, p: Principal, eventId: string, response: "accepted" | "declined") {
  const e = (await c.query<{ ends_at: Date }>("SELECT ends_at FROM calendar_events WHERE id = $1", [eventId])).rows[0];
  if (!e) throw new NotFound("event not found");
  // Once the event is over the answers are a record (who came, who never replied): they no longer change.
  if (e.ends_at.getTime() < Date.now()) throw new Invalid("the event has ended");
  const r = await c.query("UPDATE event_attendees SET response = $3 WHERE event_id = $1 AND user_id = $2", [eventId, p.id, response]);
  if (!r.rowCount) throw new NotFound("invitation not found");
}

/**
 * Moves or edits one event (dragging it on the calendar). Organizer only; the
 * attendees are told the new time.
 */
export async function updateEvent(
  c: PoolClient,
  p: Principal,
  eventId: string,
  input: { title?: string | undefined; startsAt?: string | undefined; endsAt?: string | undefined; location?: string | undefined },
) {
  const e = (
    await c.query<{ organizer_id: string; title: string; kind: string; starts_at: Date; ends_at: Date; location: string }>(
      "SELECT organizer_id, title, kind, starts_at, ends_at, location FROM calendar_events WHERE id = $1",
      [eventId],
    )
  ).rows[0];
  if (!e) throw new NotFound("event not found");
  if (e.organizer_id !== p.id) throw new Forbidden("only the organizer can change this event");
  const startsAt = input.startsAt ?? e.starts_at.toISOString();
  const endsAt = input.endsAt ?? e.ends_at.toISOString();
  if (Date.parse(endsAt) < Date.parse(startsAt)) throw new Invalid("event ends before it starts");
  await c.query("UPDATE calendar_events SET title = $2, starts_at = $3, ends_at = $4, location = $5 WHERE id = $1", [
    eventId,
    input.title ?? e.title,
    startsAt,
    endsAt,
    input.location ?? e.location,
  ]);
  const attendees = (await c.query<{ user_id: string }>("SELECT user_id FROM event_attendees WHERE event_id = $1", [eventId])).rows.map((r) => r.user_id);
  const moved = startsAt !== e.starts_at.toISOString() || endsAt !== e.ends_at.toISOString();
  // Same event as scheduling (marked as a reschedule), so Home and attendees' calendars move it too.
  await emit(c, e.kind === "meeting" ? "work.meeting.scheduled.v1" : "work.event.scheduled.v1", "work.calendar", eventId, {
    eventId,
    title: input.title ?? e.title,
    kind: e.kind,
    startsAt,
    endsAt,
    organizerId: p.id,
    attendeeIds: attendees,
    location: input.location ?? e.location,
    rescheduled: moved,
    previousStartsAt: e.starts_at.toISOString(),
  });
  return { id: eventId, startsAt, endsAt };
}

/** Cancels one meeting, or this and every later meeting of its series ("following"). Organizer only. */
export async function deleteEvent(c: PoolClient, p: Principal, eventId: string, scope: "one" | "following" = "one") {
  const r = await c.query<{ organizer_id: string; series_id: string | null; starts_at: Date }>("SELECT organizer_id, series_id, starts_at FROM calendar_events WHERE id = $1", [
    eventId,
  ]);
  const e = r.rows[0];
  if (!e) throw new NotFound("event not found");
  if (e.organizer_id !== p.id) throw new Forbidden("only the organizer can cancel");
  const gone =
    scope === "following" && e.series_id
      ? (await c.query<{ id: string }>("DELETE FROM calendar_events WHERE series_id = $1 AND starts_at >= $2 RETURNING id", [e.series_id, e.starts_at])).rows.map((x) => x.id)
      : (await c.query<{ id: string }>("DELETE FROM calendar_events WHERE id = $1 RETURNING id", [eventId])).rows.map((x) => x.id);
  for (const id of gone) await emit(c, "work.event.cancelled.v1", "work.calendar", id, { eventId: id });
  return { cancelled: gone.length };
}
