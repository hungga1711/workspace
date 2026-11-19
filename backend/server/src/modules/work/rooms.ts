import { type ObjectStorage } from "@workspace/service-kit";
import { newId, type Principal } from "@workspace/shared";
import { AccessToken, EgressClient, EgressStatus, EncodedFileOutput, EncodedFileType, RoomServiceClient, S3Upload, TrackSource } from "livekit-server-sdk";
import { createHash, randomBytes, randomInt } from "node:crypto";
import type { PoolClient } from "pg";
import { Forbidden, Invalid, NotFound } from "./errors.js";

/**
 * Video meetings on LiveKit (an open-source WebRTC SFU). This module only keeps rooms, the guest
 * lobby and recordings, and signs short-lived join tokens: audio, video and screen share flow
 * browser ⇄ SFU, and recordings go SFU (Egress) ⇄ object storage, never through the server.
 */
export interface MeetConfig {
  /** Where browsers connect (wss:// in production). */
  publicUrl: string;
  /** Where the server reaches the LiveKit API (http(s)://). */
  apiUrl: string;
  apiKey: string;
  apiSecret: string;
  /** Recording upload target as the Egress worker reaches it; null disables recording. */
  recording: { endpoint: string; region: string; bucket: string; accessKey: string; secret: string } | null;
}

/**
 * null when `LIVEKIT_URL` is not set: video meetings and calls are off on this server (the web hides them and the
 * controller answers 404 `meet_not_configured`; everything else about a meeting still works). Development falls back
 * to the local LiveKit container and its published dev key; production never falls back, and a URL without a key
 * fails at start-up rather than signing tokens with a secret anyone can read on GitHub.
 */
export function meetConfigFromEnv(env: (k: string, d?: string) => string, production = process.env.NODE_ENV === "production"): MeetConfig | null {
  let publicUrl: string;
  try {
    publicUrl = env("LIVEKIT_URL", production ? undefined : "ws://localhost:7880");
  } catch {
    return null;
  }
  const dev = (value: string) => (production ? undefined : value);
  const recordingOn = env("MEET_RECORDING", "off") === "on";
  return {
    publicUrl,
    apiUrl: env("LIVEKIT_API_URL", publicUrl.replace(/^ws/, "http")),
    apiKey: env("LIVEKIT_API_KEY", dev("workspace_dev")),
    apiSecret: env("LIVEKIT_API_SECRET", dev("workspace-dev-livekit-secret-change-me-32b")),
    // Any S3 API. Locally the Egress container reaches SeaweedFS as http://s3:8333.
    recording: recordingOn
      ? {
          endpoint: env("RECORDING_S3_ENDPOINT", env("S3_ENDPOINT", dev("http://s3:8333"))),
          region: env("S3_REGION", "auto"),
          bucket: env("S3_BUCKET", "workspace-files"),
          accessKey: env("S3_ACCESS_KEY_ID", dev("workspace_dev_key")),
          secret: env("S3_SECRET_ACCESS_KEY", dev("workspace_dev_secret")),
        }
      : null,
  };
}

export type GuestAccess = "open" | "lobby" | "off";

interface RoomRow {
  id: string;
  code: string;
  title: string;
  event_id: string | null;
  created_by: string;
  guest_access: GuestAccess;
  created_at: Date;
  last_used_at: Date;
}
const ROOM_COLS = "id, code, title, event_id, created_by, guest_access, created_at, last_used_at";

const roomDto = (r: RoomRow) => ({
  id: r.id,
  code: r.code,
  title: r.title,
  eventId: r.event_id,
  createdBy: r.created_by,
  guestAccess: r.guest_access,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
});

/** "abc-defg-hij": 10 letters (26^10 ≈ 1.4e14), easy to read aloud, impossible to guess in bulk. */
export function newCode(): string {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const s = Array.from({ length: 10 }, () => letters[randomInt(letters.length)]).join("");
  return `${s.slice(0, 3)}-${s.slice(3, 7)}-${s.slice(7)}`;
}
export const CODE_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

/** LiveKit room name: the room's id, never shown to anyone. */
const lkRoom = (r: { id: string }) => r.id;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

async function roomByCode(c: PoolClient, code: string): Promise<RoomRow> {
  if (!CODE_RE.test(code)) throw new NotFound("meeting not found");
  const r = (await c.query<RoomRow>(`SELECT ${ROOM_COLS} FROM meeting_rooms WHERE code = $1`, [code])).rows[0];
  if (!r) throw new NotFound("meeting not found");
  return r;
}

/** Whether a share link's code names a meeting room. */
export async function roomExists(c: PoolClient, code: string): Promise<boolean> {
  if (!CODE_RE.test(code)) return false;
  return ((await c.query("SELECT 1 FROM meeting_rooms WHERE code = $1", [code])).rowCount ?? 0) > 0;
}

/**
 * Start a meeting. With an event id: the room of that calendar meeting (created on first use), so
 * everyone invited lands in the same room. Only people on the invite may open an event's room.
 */
export async function createRoom(
  c: PoolClient,
  p: Principal,
  b: { title?: string | undefined; eventId?: string | undefined; guestAccess?: GuestAccess | undefined; channelId?: string | undefined },
  locale: "vi" | "en" = "vi",
) {
  let title = b.title?.trim() || "";
  if (b.eventId) {
    const existing = (await c.query<RoomRow>(`SELECT ${ROOM_COLS} FROM meeting_rooms WHERE event_id = $1`, [b.eventId])).rows[0];
    const ev = (
      await c.query<{ title: string; organizer_id: string; invited: boolean }>(
        `SELECT title, organizer_id, EXISTS (SELECT 1 FROM event_attendees a WHERE a.event_id = e.id AND a.user_id = $2) AS invited
         FROM calendar_events e WHERE id = $1`,
        [b.eventId, p.id],
      )
    ).rows[0];
    if (!ev || (ev.organizer_id !== p.id && !ev.invited)) throw new NotFound("event not found");
    if (existing) return roomDto(existing);
    title = title || ev.title;
  }
  const id = newId();
  for (let attempt = 0; ; attempt++) {
    try {
      const r = (
        await c.query<RoomRow>(
          `INSERT INTO meeting_rooms (id, code, title, event_id, created_by, guest_access, channel_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${ROOM_COLS}`,
          [id, newCode(), title || (locale === "en" ? "Meeting" : "Cuộc họp"), b.eventId ?? null, p.id, b.guestAccess ?? "lobby", b.channelId ?? null],
        )
      ).rows[0]!;
      return roomDto(r);
    } catch (e) {
      // A code collision (unique across all workspaces) is astronomically rare: draw again.
      if ((e as { code?: string }).code === "23505" && String((e as { constraint?: string }).constraint).includes("code") && attempt < 3) continue;
      throw e;
    }
  }
}

/** The meetings I started recently, newest first (the "Họp ngay" list). */
export async function listRooms(c: PoolClient, p: Principal) {
  // Rooms I started, joined, or that belong to a calendar meeting I am invited to (recordings live there).
  const rows = (
    await c.query<RoomRow>(
      `SELECT ${ROOM_COLS} FROM meeting_rooms
        WHERE created_by = $1 OR id IN (SELECT room_id FROM meeting_participants WHERE user_id = $1)
           OR event_id IN (SELECT event_id FROM event_attendees WHERE user_id = $1) OR event_id IN (SELECT id FROM calendar_events WHERE organizer_id = $1)
        ORDER BY last_used_at DESC LIMIT 20`,
      [p.id],
    )
  ).rows;
  return rows.map(roomDto);
}

export async function getRoom(c: PoolClient, code: string) {
  return roomDto(await roomByCode(c, code));
}

/** Only whoever started the meeting changes who may join from outside. */
export async function updateRoom(c: PoolClient, p: Principal, code: string, b: { title?: string | undefined; guestAccess?: GuestAccess | undefined }) {
  const r = await roomByCode(c, code);
  if (r.created_by !== p.id) throw new Forbidden("only the person who started the meeting can change it");
  const u = (
    await c.query<RoomRow>(`UPDATE meeting_rooms SET title = COALESCE($2, title), guest_access = COALESCE($3, guest_access) WHERE id = $1 RETURNING ${ROOM_COLS}`, [
      r.id,
      b.title?.trim() || null,
      b.guestAccess ?? null,
    ])
  ).rows[0]!;
  return roomDto(u);
}

async function sign(cfg: MeetConfig, room: RoomRow, who: { identity: string; name: string; metadata: Record<string, unknown> }) {
  const at = new AccessToken(cfg.apiKey, cfg.apiSecret, { identity: who.identity, name: who.name, metadata: JSON.stringify(who.metadata), ttl: "4h" });
  // canUpdateOwnMetadata: people raise and lower their hand through their own attributes.
  at.addGrant({ roomJoin: true, room: lkRoom(room), canPublish: true, canSubscribe: true, canPublishData: true, canUpdateOwnMetadata: true });
  return { url: cfg.publicUrl, token: await at.toJwt(), room: roomDto(room) };
}

/** A workspace member joins any room of their workspace directly. */
export async function memberJoin(c: PoolClient, cfg: MeetConfig, p: Principal, code: string, name: string, locale: "vi" | "en" = "vi") {
  const r = await roomByCode(c, code);
  await c.query("UPDATE meeting_rooms SET last_used_at = now() WHERE id = $1", [r.id]);
  await c.query("INSERT INTO meeting_participants (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [r.id, p.id]);
  return sign(cfg, r, {
    identity: `u:${p.id}`,
    name: name.trim().slice(0, 80) || (locale === "en" ? "Member" : "Thành viên"),
    metadata: { kind: "member", userId: p.id, host: r.created_by === p.id },
  });
}

/** What a guest sees before joining: the title and whether they can get in. */
export async function guestPreview(c: PoolClient, code: string) {
  const r = await roomByCode(c, code);
  return { code: r.code, title: r.title, guestAccess: r.guest_access };
}

const WAIT_MINUTES = 15;

/**
 * A guest asks to join. Open rooms let them straight in; lobby rooms record a request that a member
 * admits from inside the meeting; closed rooms refuse. The guest gets a secret to poll with.
 */
export async function guestJoin(c: PoolClient, cfg: MeetConfig, code: string, rawName: string) {
  const r = await roomByCode(c, code);
  const name = rawName.trim().replace(/\s+/g, " ").slice(0, 60);
  if (!name) throw new Invalid("name is required");
  if (r.guest_access === "off") throw new Forbidden("this meeting only admits workspace members");
  if (r.guest_access === "open") {
    await c.query("UPDATE meeting_rooms SET last_used_at = now() WHERE id = $1", [r.id]);
    return { status: "admitted" as const, ...(await sign(cfg, r, { identity: `g:${newId()}`, name, metadata: { kind: "guest" } })) };
  }
  const id = newId();
  const secret = randomBytes(24).toString("base64url");
  await c.query(`INSERT INTO meeting_guests (id, room_id, name, secret_hash) VALUES ($1, $2, $3, $4)`, [id, r.id, name, sha(secret)]);
  return { status: "waiting" as const, requestId: id, secret };
}

/** The guest polls their request; once admitted it carries the join token. */
export async function guestStatus(c: PoolClient, cfg: MeetConfig, code: string, requestId: string, secret: string) {
  const r = await roomByCode(c, code);
  const g = (
    await c.query<{ id: string; name: string; status: string; secret_hash: string; created_at: Date }>(
      "SELECT id, name, status, secret_hash, created_at FROM meeting_guests WHERE id = $1 AND room_id = $2",
      [requestId, r.id],
    )
  ).rows[0];
  if (!g || g.secret_hash !== sha(secret)) throw new NotFound("request not found");
  if (g.status === "denied") return { status: "denied" as const };
  if (g.status === "waiting") {
    if (Date.now() - g.created_at.getTime() > WAIT_MINUTES * 60_000) return { status: "expired" as const };
    return { status: "waiting" as const };
  }
  return { status: "admitted" as const, ...(await sign(cfg, r, { identity: `g:${g.id}`, name: g.name, metadata: { kind: "guest" } })) };
}

/** Guests waiting in the lobby, for members inside the meeting. */
export async function lobby(c: PoolClient, code: string) {
  const r = await roomByCode(c, code);
  const rows = (
    await c.query<{ id: string; name: string; created_at: Date }>(
      `SELECT id, name, created_at FROM meeting_guests WHERE room_id = $1 AND status = 'waiting' AND created_at > now() - make_interval(mins => $2) ORDER BY created_at`,
      [r.id, WAIT_MINUTES],
    )
  ).rows;
  return rows.map((g) => ({ id: g.id, name: g.name, askedAt: g.created_at }));
}

export async function decideGuest(c: PoolClient, p: Principal, code: string, requestId: string, admit: boolean) {
  const r = await roomByCode(c, code);
  const u = await c.query("UPDATE meeting_guests SET status = $3, decided_by = $4 WHERE id = $1 AND room_id = $2 AND status = 'waiting'", [
    requestId,
    r.id,
    admit ? "admitted" : "denied",
    p.id,
  ]);
  if (!u.rowCount) throw new NotFound("request not found or already decided");
}

/** Who is in the meeting right now (from the SFU), for the "in progress · 3 people" hint. */
async function liveCount(cfg: MeetConfig, r: { id: string }): Promise<number> {
  try {
    return (await new RoomServiceClient(cfg.apiUrl, cfg.apiKey, cfg.apiSecret).listParticipants(lkRoom(r))).length;
  } catch {
    return 0; // the room does not exist on the SFU until someone joins
  }
}

/** Who is in the call right now, for the "already here" line before joining (members only). */
export async function presence(c: PoolClient, cfg: MeetConfig, code: string) {
  const r = await roomByCode(c, code);
  try {
    const people = await new RoomServiceClient(cfg.apiUrl, cfg.apiKey, cfg.apiSecret).listParticipants(lkRoom(r));
    return { participants: people.length, names: people.map((p) => p.name || "?").slice(0, 8) };
  } catch {
    return { participants: 0, names: [] }; // the room does not exist on the SFU until someone joins
  }
}

// ---- recordings ----

interface RecRow {
  id: string;
  egress_id: string;
  object_key: string;
  status: "recording" | "ready" | "failed";
  started_by: string;
  started_at: Date;
  ended_at: Date | null;
}

/**
 * Recordings that ended on their own (everyone left, the egress stopped or failed) without anyone
 * pressing stop: ask the SFU and settle the row, so nothing shows "recording" forever.
 */
async function settleRecordings(c: PoolClient, cfg: MeetConfig, roomId: string) {
  const open = (await c.query<RecRow>("SELECT id, egress_id FROM meeting_recordings WHERE room_id = $1 AND status = 'recording'", [roomId])).rows;
  if (!open.length) return;
  const egress = new EgressClient(cfg.apiUrl, cfg.apiKey, cfg.apiSecret);
  for (const rec of open) {
    const info = (await egress.listEgress({ egressId: rec.egress_id }).catch(() => null))?.[0];
    if (info === undefined) continue; // the SFU could not be asked; try again next time
    const status =
      info === null || info.status === EgressStatus.EGRESS_FAILED || info.status === EgressStatus.EGRESS_ABORTED
        ? "failed"
        : info.status === EgressStatus.EGRESS_COMPLETE || info.status === EgressStatus.EGRESS_LIMIT_REACHED
          ? "ready"
          : null;
    if (status) await c.query("UPDATE meeting_recordings SET status = $2, ended_at = coalesce(ended_at, now()) WHERE id = $1", [rec.id, status]);
  }
}

export async function startRecording(c: PoolClient, cfg: MeetConfig, p: Principal, code: string) {
  if (!cfg.recording) throw new Invalid("recording is not enabled on this server");
  const r = await roomByCode(c, code);
  await settleRecordings(c, cfg, r.id);
  const active = (await c.query<RecRow>("SELECT id FROM meeting_recordings WHERE room_id = $1 AND status = 'recording'", [r.id])).rows[0];
  if (active) throw new Invalid("already recording");
  const id = newId();
  const key = `recordings/${id}.mp4`;
  const s3 = cfg.recording;
  const file = new EncodedFileOutput({
    fileType: EncodedFileType.MP4,
    filepath: key,
    output: { case: "s3", value: new S3Upload({ endpoint: s3.endpoint, region: s3.region, bucket: s3.bucket, accessKey: s3.accessKey, secret: s3.secret, forcePathStyle: true }) },
  });
  const info = await new EgressClient(cfg.apiUrl, cfg.apiKey, cfg.apiSecret).startRoomCompositeEgress(lkRoom(r), file, { layout: "grid" });
  await c.query(`INSERT INTO meeting_recordings (id, room_id, egress_id, object_key, started_by) VALUES ($1, $2, $3, $4, $5)`, [id, r.id, info.egressId, key, p.id]);
  return { id, status: "recording" as const };
}

export async function stopRecording(c: PoolClient, cfg: MeetConfig, code: string) {
  const r = await roomByCode(c, code);
  const rec = (await c.query<RecRow>("SELECT id, egress_id FROM meeting_recordings WHERE room_id = $1 AND status = 'recording'", [r.id])).rows[0];
  if (!rec) throw new NotFound("not recording");
  let failed = false;
  try {
    await new EgressClient(cfg.apiUrl, cfg.apiKey, cfg.apiSecret).stopEgress(rec.egress_id);
  } catch {
    failed = true; // the egress already ended (e.g. everyone left); the file is final or missing
  }
  await c.query("UPDATE meeting_recordings SET status = $2, ended_at = now() WHERE id = $1", [rec.id, failed ? "failed" : "ready"]);
  return { id: rec.id, status: failed ? "failed" : "ready" };
}

/**
 * Recordings of a room. Downloads are presigned object-storage URLs: the video streams from storage to
 * the browser. A file still being finalised by Egress shows as processing.
 */
/** Recordings are for whoever started the room, joined it, or was invited to its calendar meeting. */
async function mayWatch(c: PoolClient, p: Principal, r: RoomRow): Promise<boolean> {
  if (r.created_by === p.id) return true;
  const q = await c.query(
    `SELECT 1 FROM meeting_participants WHERE room_id = $1 AND user_id = $2
     UNION ALL SELECT 1 FROM calendar_events e WHERE e.id = $3 AND (e.organizer_id = $2 OR EXISTS (SELECT 1 FROM event_attendees a WHERE a.event_id = e.id AND a.user_id = $2))
     LIMIT 1`,
    [r.id, p.id, r.event_id],
  );
  return (q.rowCount ?? 0) > 0;
}

export async function listRecordings(c: PoolClient, storage: ObjectStorage, code: string, cfg?: MeetConfig, p?: Principal) {
  const r = await roomByCode(c, code);
  if (p && !(await mayWatch(c, p, r))) throw new Forbidden("recordings are for the people in this meeting");
  if (cfg?.recording) await settleRecordings(c, cfg, r.id);
  const rows = (
    await c.query<RecRow>("SELECT id, egress_id, object_key, status, started_by, started_at, ended_at FROM meeting_recordings WHERE room_id = $1 ORDER BY started_at DESC", [r.id])
  ).rows;
  return Promise.all(
    rows.map(async (x) => {
      const head = x.status === "ready" ? await storage.head(x.object_key).catch(() => null) : null;
      const name = `${r.title} ${x.started_at.toISOString().slice(0, 16).replace("T", " ")}.mp4`;
      return {
        id: x.id,
        status: x.status === "ready" && !head ? ("processing" as const) : x.status,
        startedBy: x.started_by,
        startedAt: x.started_at,
        endedAt: x.ended_at,
        size: head?.size ?? null,
        url: head ? await storage.presignGet(x.object_key, 3600, name, true) : null,
      };
    }),
  );
}

// ---- host controls ----

export type HostAction = "mute" | "remove" | "end";

/**
 * The person who started the meeting can mute someone's microphone, ask someone to leave, or end
 * the call for everyone (which also stops a recording). Removing a guest also closes their lobby
 * request, so the same request cannot be used to get back in.
 */
export async function hostAction(c: PoolClient, cfg: MeetConfig, p: Principal, code: string, action: HostAction, identity?: string) {
  const r = await roomByCode(c, code);
  if (r.created_by !== p.id) throw new Forbidden("only the person who started the meeting can do this");
  const svc = new RoomServiceClient(cfg.apiUrl, cfg.apiKey, cfg.apiSecret);
  const room = lkRoom(r);
  if (action === "end") {
    await stopRecording(c, cfg, code).catch(() => undefined);
    await svc.deleteRoom(room).catch(() => undefined); // already empty: nothing to end
    return { ended: true };
  }
  if (!identity || identity === `u:${p.id}`) throw new Invalid("choose someone else in the meeting");
  const who = await svc.getParticipant(room, identity).catch(() => null);
  if (!who) throw new NotFound("this person is not in the meeting");
  if (action === "remove") {
    await svc.removeParticipant(room, identity);
    return { removed: true };
  }
  const mic = who.tracks.find((t) => t.source === TrackSource.MICROPHONE && !t.muted);
  if (mic) await svc.mutePublishedTrack(room, identity, mic.sid, true);
  return { muted: true };
}

/**
 * Recordings are kept for a fixed period (MEET_RECORDING_RETENTION_DAYS, default 365): older files
 * are removed from object storage, then their rows. Failures are retried on the next run.
 */
export async function sweepRecordings(pool: import("pg").Pool, storage: ObjectStorage, days: number, limit = 200): Promise<number> {
  const rows = (
    await pool.query<{ id: string; object_key: string }>(
      `SELECT id, object_key FROM meeting_recordings
        WHERE status <> 'recording' AND started_at < now() - make_interval(days => $1)
        ORDER BY started_at LIMIT $2`,
      [days, limit],
    )
  ).rows;
  let removed = 0;
  for (const r of rows) {
    try {
      await storage.delete(r.object_key).catch((e: { name?: string }) => {
        if (e?.name !== "NoSuchKey" && e?.name !== "NotFound") throw e;
      });
      await pool.query("DELETE FROM meeting_recordings WHERE id = $1", [r.id]);
      removed++;
    } catch {
      /* retried next run */
    }
  }
  return removed;
}

/** The call going on in a chat conversation right now (started there in the last 12 hours, someone in it). */
export async function liveInChannel(c: PoolClient, cfg: MeetConfig, channelId: string) {
  const rooms = (
    await c.query<RoomRow>(`SELECT ${ROOM_COLS} FROM meeting_rooms WHERE channel_id = $1 AND created_at > now() - interval '12 hours' ORDER BY created_at DESC LIMIT 3`, [
      channelId,
    ])
  ).rows;
  for (const r of rooms) {
    const n = await liveCount(cfg, r);
    if (n > 0) return { code: r.code, title: r.title, participants: n };
  }
  return null;
}
