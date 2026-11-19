import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { INestApplication } from "@nestjs/common";
import pg from "pg";
import { TokenVerifier } from "livekit-server-sdk";
import { migrate, signInternalToken, PRINCIPAL_HEADER, S3Storage } from "@workspace/service-kit";
import { newId, runWithContext, withTransaction, type Grant, type Principal } from "@workspace/shared";
import { createWorkApp } from "../../src/modules/work/app.js";
import { CODE_RE, newCode, sweepRecordings, type MeetConfig } from "../../src/modules/work/rooms.js";
import { resetTestDatabase } from "../test-db.js";

const SECRET = "dev-internal-secret-change-me-32bytes!";
const S = (...ps: string[]): Grant[] => ps.map((permission) => ({ permission, scope: "SELF" }));
const mk = (id: string, type: Principal["type"] = "user", grants: Grant[] = S("calendar.read", "calendar.edit")): Principal => ({
  type,
  id,
  teamIds: [],
  departmentId: null,
  grants,
});
const minh = mk("minh");
const lan = mk("lan");
const gateway = mk("gateway", "service", [{ permission: "principal.resolve", scope: "PLATFORM" }]);
const meet: MeetConfig = {
  publicUrl: "ws://localhost:7880",
  apiUrl: "http://localhost:7880",
  apiKey: "workspace_dev",
  apiSecret: "workspace-dev-livekit-secret-change-me-32b",
  recording: null,
};

const storage = new S3Storage({
  endpoint: "http://localhost:8333",
  region: "auto",
  bucket: "workspace-files",
  accessKeyId: "workspace_dev_key",
  secretAccessKey: "workspace_dev_secret",
});
let app: INestApplication;
let pool: pg.Pool;
let base: string;

async function call(p: Principal, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", [PRINCIPAL_HEADER]: await signInternalToken({ principal: p, requestId: newId() }, SECRET) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null };
}
const claims = (token: string) => new TokenVerifier(meet.apiKey, meet.apiSecret).verify(token);

beforeAll(async () => {
  await migrate("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test", fileURLToPath(new URL("../../migrations/work", import.meta.url)), "work");
  // Each suite starts from an empty installation: counts and codes below assume only its own rows.
  await resetTestDatabase();
  pool = new pg.Pool({ connectionString: "postgres://workspace_work:app_pw@localhost:5432/workspace_test", max: 5 });
  app = await createWorkApp({ pool, storage, internalSecret: SECRET, meet });
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "127.0.0.1");
});
afterAll(async () => {
  await app?.close();
});

describe("meeting codes", () => {
  it("look like abc-defg-hij", () => {
    for (let i = 0; i < 50; i++) expect(newCode()).toMatch(CODE_RE);
  });
});

describe("video meetings", () => {
  let code: string;

  it("a member starts a meeting and colleagues join it directly with a token for that room", async () => {
    const r = await call(minh, "POST", "/meet/rooms", { title: "Họp nhanh" });
    expect(r.status).toBe(201);
    code = r.body.code;
    expect(code).toMatch(CODE_RE);
    expect(r.body.guestAccess).toBe("lobby");

    const j = await call(lan, "POST", `/meet/rooms/${code}/join`, { name: "Lan" });
    expect(j.status).toBe(200);
    expect(j.body.url).toBe(meet.publicUrl);
    const c = await claims(j.body.token);
    expect(c.sub).toBe("u:lan");
    expect(c.name).toBe("Lan");
    expect(c.video?.room).toBe(r.body.id);
    expect(c.video?.roomJoin).toBe(true);
    expect((await call(minh, "GET", "/meet/rooms")).body.rooms.map((x: { code: string }) => x.code)).toContain(code);
  });

  it("before joining, members see who is already in the call", async () => {
    // Nobody has connected to the SFU yet, so the room does not exist there.
    expect((await call(lan, "GET", `/meet/rooms/${code}/presence`)).body).toEqual({ participants: 0, names: [] });
  });

  it("only the host can mute, remove or end; nobody is removed from an empty room", async () => {
    expect((await call(lan, "POST", `/meet/rooms/${code}/end`)).status).toBe(403);
    expect((await call(lan, "POST", `/meet/rooms/${code}/participants/u:minh/remove`)).status).toBe(403);
    expect((await call(minh, "POST", `/meet/rooms/${code}/participants/u:minh/mute`)).status).toBe(400);
    expect((await call(minh, "POST", `/meet/rooms/${code}/participants/u:lan/remove`)).status).toBe(404);
    expect((await call(minh, "POST", `/meet/rooms/${code}/participants/u:lan/explode`)).status).toBe(404);
    expect((await call(minh, "POST", `/meet/rooms/${code}/end`)).body).toEqual({ ended: true });
  });

  it("recordings are for the people in the meeting, not the whole workspace", async () => {
    const huy = mk("huy");
    expect((await call(huy, "GET", `/meet/rooms/${code}/recordings`)).status).toBe(403);
    expect((await call(lan, "GET", `/meet/rooms/${code}/recordings`)).body).toEqual({ recordings: [] }); // lan joined
    expect((await call(minh, "GET", `/meet/rooms/${code}/recordings`)).status).toBe(200); // started it
    // Joined rooms show up in my recent rooms (where their recordings are).
    expect((await call(lan, "GET", "/meet/rooms")).body.rooms.map((x: { code: string }) => x.code)).toContain(code);
    expect((await call(huy, "GET", "/meet/rooms")).body.rooms.map((x: { code: string }) => x.code)).not.toContain(code);
  });

  it("recordings past the retention period are deleted", async () => {
    const room = (await call(minh, "GET", `/meet/rooms/${code}`)).body.room;
    const old = newId();
    const fresh = newId();
    await runWithContext({ actorId: "test", requestId: newId() }, () =>
      withTransaction(pool, async (c) => {
        for (const [id, days] of [
          [old, 400],
          [fresh, 10],
        ] as const)
          await c.query(
            "INSERT INTO meeting_recordings (id, room_id, egress_id, object_key, status, started_by, started_at) VALUES ($1,$2,'eg',$3,'ready','minh', now() - make_interval(days => $4))",
            [id, room.id, `recordings/${id}.mp4`, days],
          );
      }),
    );
    expect(await sweepRecordings(pool, storage, 365)).toBeGreaterThanOrEqual(1);
    const left = await runWithContext({ actorId: "test", requestId: newId() }, () =>
      withTransaction(pool, (c) => c.query<{ id: string }>("SELECT id FROM meeting_recordings WHERE id = ANY($1)", [[old, fresh]])),
    );
    expect(left.rows.map((r) => r.id)).toEqual([fresh]);
  });

  it("a guest waits in the lobby until a member admits them", async () => {
    const preview = await call(gateway, "GET", `/internal/meet/${code}`);
    expect(preview.body).toEqual({ code, title: "Họp nhanh", guestAccess: "lobby" });

    const ask = await call(gateway, "POST", `/internal/meet/${code}/join`, { name: "  Khách   ngoài " });
    expect(ask.body.status).toBe("waiting");
    const { requestId, secret } = ask.body;
    expect((await call(gateway, "POST", `/internal/meet/${code}/status`, { requestId, secret })).body).toEqual({ status: "waiting" });
    // The secret is what proves it is this guest asking.
    expect((await call(gateway, "POST", `/internal/meet/${code}/status`, { requestId, secret: "nope" })).status).toBe(404);

    const waiting = (await call(lan, "GET", `/meet/rooms/${code}/lobby`)).body.waiting;
    expect(waiting.map((g: { name: string }) => g.name)).toEqual(["Khách ngoài"]);
    expect((await call(lan, "POST", `/meet/rooms/${code}/lobby/${requestId}`, { admit: true })).status).toBe(204);
    expect((await call(lan, "POST", `/meet/rooms/${code}/lobby/${requestId}`, { admit: true })).status).toBe(404);

    const ok = (await call(gateway, "POST", `/internal/meet/${code}/status`, { requestId, secret })).body;
    expect(ok.status).toBe("admitted");
    const c = await claims(ok.token);
    expect(c.sub).toBe(`g:${requestId}`);
    expect(JSON.parse(c.metadata!)).toEqual({ kind: "guest" });
  });

  it("a denied guest is told so", async () => {
    const ask = (await call(gateway, "POST", `/internal/meet/${code}/join`, { name: "Spam" })).body;
    await call(minh, "POST", `/meet/rooms/${code}/lobby/${ask.requestId}`, { admit: false });
    expect((await call(gateway, "POST", `/internal/meet/${code}/status`, { requestId: ask.requestId, secret: ask.secret })).body).toEqual({ status: "denied" });
  });

  it("the host can open the room to guests or close it to members only", async () => {
    expect((await call(lan, "PATCH", `/meet/rooms/${code}`, { guestAccess: "open" })).status).toBe(403);
    expect((await call(minh, "PATCH", `/meet/rooms/${code}`, { guestAccess: "open" })).body.guestAccess).toBe("open");
    const open = (await call(gateway, "POST", `/internal/meet/${code}/join`, { name: "Đối tác" })).body;
    expect(open.status).toBe("admitted");
    expect((await claims(open.token)).name).toBe("Đối tác");

    await call(minh, "PATCH", `/meet/rooms/${code}`, { guestAccess: "off" });
    expect((await call(gateway, "POST", `/internal/meet/${code}/join`, { name: "X" })).status).toBe(403);
    expect((await call(gateway, "POST", `/internal/meet/${code}/join`, { name: "  " })).status).toBe(400);
  });

  it("guest routes are for the gateway only, and unknown codes are 404", async () => {
    expect((await call(lan, "GET", `/internal/meet/${code}`)).status).toBe(403);
    expect((await call(gateway, "GET", "/internal/meet/abc-defg-hij")).status).toBe(404);
    expect((await call(gateway, "GET", "/internal/meet/not-a-code")).status).toBe(404);
  });

  it("a calendar meeting has one room, for the people on the invite", async () => {
    const ev = (
      await call(minh, "POST", "/calendar/events", {
        title: "Weekly sync",
        startsAt: "2026-11-02T09:00:00+07:00",
        endsAt: "2026-11-02T09:30:00+07:00",
        attendeeIds: ["lan"],
      })
    ).body;
    expect(ev.id).toBeTruthy();
    const r1 = (await call(minh, "POST", "/meet/rooms", { eventId: ev.id })).body;
    const r2 = (await call(lan, "POST", "/meet/rooms", { eventId: ev.id })).body;
    expect(r1.code).toBe(r2.code);
    expect(r1.title).toBe("Weekly sync");
    expect((await call(mk("huy"), "POST", "/meet/rooms", { eventId: ev.id })).status).toBe(404);
  });

  it("recording is refused when the server has it disabled", async () => {
    expect((await call(minh, "POST", `/meet/rooms/${code}/recording`)).status).toBe(400);
  });
});
