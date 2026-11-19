import type { PoolClient } from "pg";
import type { Principal } from "@workspace/shared";
import { activity, emit } from "./common.js";
import { knowledgeChanged } from "./knowledge.js";
import { Conflict, Forbidden, Invalid, NotFound } from "./errors.js";
import { TASK_COLS, taskDto, type TaskRow } from "./tasks.js";

interface EventRow {
  id: string;
  title: string;
  kind: string;
  starts_at: Date;
  ends_at: Date;
  organizer_id: string;
  location: string;
  project_id: string | null;
  agenda: string;
  notes: string;
  version: number;
  updated_at: Date;
  series_id: string | null;
  recurrence: string | null;
  code: string | null;
}

async function loadEvent(c: PoolClient, p: Principal, id: string) {
  const e = (
    await c.query<EventRow>(
      "SELECT id, title, kind, starts_at, ends_at, organizer_id, location, project_id, agenda, notes, version, updated_at, series_id, recurrence, code FROM calendar_events WHERE id = $1",
      [id],
    )
  ).rows[0];
  if (!e) throw new NotFound("event not found");
  const attendees = (await c.query<{ user_id: string; response: string }>("SELECT user_id, response FROM event_attendees WHERE event_id = $1 ORDER BY user_id", [id])).rows;
  // Only people on the invite (and the organizer) see a meeting, its agenda and minutes.
  if (e.organizer_id !== p.id && !attendees.some((a) => a.user_id === p.id)) throw new NotFound("event not found");
  return { e, attendees };
}

/** Meeting page: details, RSVPs, agenda, minutes and the action items created from it. */
export async function getMeeting(c: PoolClient, p: Principal, id: string) {
  const { e, attendees } = await loadEvent(c, p, id);
  const tasks = (await c.query<TaskRow>(`SELECT ${TASK_COLS} FROM tasks WHERE source->>'type' = 'meeting' AND source->>'eventId' = $1 ORDER BY created_at`, [id])).rows;
  // In a series: the neighbouring meetings this person is on, so last week's minutes are one click away.
  let series: {
    id: string;
    recurrence: string | null;
    previous: { id: string; code: string | null; startsAt: Date } | null;
    next: { id: string; code: string | null; startsAt: Date } | null;
  } | null = null;
  if (e.series_id) {
    const near = async (cmp: "<" | ">") =>
      (
        await c.query<{ id: string; code: string | null; startsAt: Date }>(
          `SELECT x.id, x.code, x.starts_at AS "startsAt" FROM calendar_events x
        WHERE x.series_id = $1 AND x.starts_at ${cmp} $2 AND (x.organizer_id = $3 OR EXISTS (SELECT 1 FROM event_attendees a WHERE a.event_id = x.id AND a.user_id = $3))
        ORDER BY x.starts_at ${cmp === "<" ? "DESC" : "ASC"} LIMIT 1`,
          [e.series_id, e.starts_at, p.id],
        )
      ).rows[0] ?? null;
    series = { id: e.series_id, recurrence: e.recurrence, previous: await near("<"), next: await near(">") };
  }
  return {
    event: {
      id: e.id,
      code: e.code,
      title: e.title,
      kind: e.kind,
      startsAt: e.starts_at,
      endsAt: e.ends_at,
      organizerId: e.organizer_id,
      location: e.location,
      projectId: e.project_id,
      agenda: e.agenda,
      notes: e.notes,
      version: e.version,
      updatedAt: e.updated_at,
    },
    attendees: attendees.map((a) => ({ userId: a.user_id, response: a.response })),
    actionItems: tasks.map(taskDto),
    series,
  };
}

/** Upcoming or past meetings the caller is invited to, with counts for the list view. */
export async function listMeetings(c: PoolClient, p: Principal, when: "upcoming" | "past") {
  const r = await c.query(
    `SELECT e.id, e.code, e.title, e.starts_at AS "startsAt", e.ends_at AS "endsAt", e.organizer_id AS "organizerId", e.location, e.project_id AS "projectId", a.response,
            e.series_id AS "seriesId", e.recurrence,
            (e.agenda <> '') AS "hasAgenda", (e.notes <> '') AS "hasNotes",
            (SELECT count(*)::int FROM event_attendees x WHERE x.event_id = e.id) AS "attendeeCount",
            ARRAY(SELECT x.user_id FROM event_attendees x WHERE x.event_id = e.id ORDER BY x.user_id = e.organizer_id DESC LIMIT 8) AS "attendeeIds",
            (SELECT count(*)::int FROM tasks t WHERE t.source->>'type' = 'meeting' AND t.source->>'eventId' = e.id) AS "actionItems",
            (SELECT count(*)::int FROM tasks t WHERE t.source->>'type' = 'meeting' AND t.source->>'eventId' = e.id AND t.status NOT IN ('done','cancelled')) AS "openActionItems"
       FROM calendar_events e JOIN event_attendees a ON a.event_id = e.id AND a.user_id = $1
      WHERE e.kind = 'meeting' AND ${when === "upcoming" ? "e.ends_at >= now() ORDER BY e.starts_at" : "e.ends_at < now() ORDER BY e.starts_at DESC"} LIMIT 100`,
    [p.id],
  );
  return r.rows;
}

/**
 * What meetings left behind for me: open action items from meetings I attended (mine first), and my
 * meetings of the last two weeks that still have no minutes.
 */
export async function meetingFollowups(c: PoolClient, p: Principal) {
  const items = (
    await c.query(
      `SELECT t.id, t.code, t.title, t.status, t.assignee_id AS "assigneeId", t.due_at AS "dueAt", e.id AS "meetingId", e.code AS "meetingCode", e.title AS "meetingTitle"
         FROM tasks t JOIN calendar_events e ON e.id = t.source->>'eventId'
         JOIN event_attendees a ON a.event_id = e.id AND a.user_id = $1
        WHERE t.source->>'type' = 'meeting' AND t.status NOT IN ('done','cancelled')
        ORDER BY (t.assignee_id = $1) DESC, coalesce(t.due_at, 'infinity'), t.created_at DESC LIMIT 20`,
      [p.id],
    )
  ).rows;
  const missingNotes = (
    await c.query(
      `SELECT e.id, e.code, e.title, e.starts_at AS "startsAt" FROM calendar_events e
        WHERE e.kind = 'meeting' AND e.organizer_id = $1 AND e.notes = '' AND e.ends_at < now() AND e.starts_at > now() - interval '14 days'
        ORDER BY e.starts_at DESC LIMIT 10`,
      [p.id],
    )
  ).rows;
  return { actionItems: items, missingNotes };
}

/**
 * Organizer edits everything; attendees co-write the agenda and minutes.
 * Optimistic concurrency on version so two note-takers never overwrite each other silently.
 */
export async function updateMeeting(
  c: PoolClient,
  p: Principal,
  id: string,
  input: {
    expectedVersion: number;
    title?: string | undefined;
    startsAt?: string | undefined;
    endsAt?: string | undefined;
    location?: string | undefined;
    attendeeIds?: string[] | undefined;
    agenda?: string | undefined;
    notes?: string | undefined;
  },
) {
  const { e, attendees } = await loadEvent(c, p, id);
  const organizer = e.organizer_id === p.id;
  const organizerOnly = input.title !== undefined || input.startsAt !== undefined || input.endsAt !== undefined || input.location !== undefined || input.attendeeIds !== undefined;
  if (organizerOnly && !organizer) throw new Forbidden("only the organizer can change time, place or invitees");
  const startsAt = input.startsAt ?? e.starts_at.toISOString();
  const endsAt = input.endsAt ?? e.ends_at.toISOString();
  if (Date.parse(endsAt) < Date.parse(startsAt)) throw new Invalid("event ends before it starts");
  const r = await c.query(
    `UPDATE calendar_events SET title = $3, starts_at = $4, ends_at = $5, location = $6, agenda = $7, notes = $8, version = version + 1, updated_at = now()
      WHERE id = $1 AND version = $2`,
    [id, input.expectedVersion, input.title ?? e.title, startsAt, endsAt, input.location ?? e.location, input.agenda ?? e.agenda, input.notes ?? e.notes],
  );
  if (!r.rowCount) throw new Conflict("meeting changed since you opened it", { currentVersion: e.version });
  let ids = attendees.map((a) => a.user_id);
  if (input.attendeeIds) {
    const next = [...new Set([e.organizer_id, ...input.attendeeIds])];
    await c.query("DELETE FROM event_attendees WHERE event_id = $1 AND NOT (user_id = ANY($2))", [id, next]);
    for (const u of next) await c.query("INSERT INTO event_attendees (event_id, user_id, response) VALUES ($1,$2,'pending') ON CONFLICT DO NOTHING", [id, u]);
    ids = next;
  }
  const rescheduled =
    organizerOnly &&
    (startsAt !== e.starts_at.toISOString() ||
      endsAt !== e.ends_at.toISOString() ||
      input.attendeeIds !== undefined ||
      (input.title !== undefined && input.title !== e.title) ||
      (input.location !== undefined && input.location !== e.location));
  await activity(c, "event", id, input.notes !== undefined ? "notes_updated" : "updated", {});
  // The agenda and minutes are what people later ask about: search and AI retrieval read them again (knowledge.ts).
  await knowledgeChanged(c, e.kind === "meeting" ? "meeting" : "event", id);
  if (rescheduled && e.kind === "meeting") {
    await emit(c, "work.meeting.scheduled.v1", "work.calendar", id, {
      eventId: id,
      title: input.title ?? e.title,
      kind: e.kind,
      startsAt,
      endsAt,
      organizerId: e.organizer_id,
      attendeeIds: ids,
      location: input.location ?? e.location,
      rescheduled: true,
    });
  }
  return getMeeting(c, p, id);
}
