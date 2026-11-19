import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { INestApplication } from "@nestjs/common";
import pg from "pg";
import { migrate, signInternalToken, PRINCIPAL_HEADER, S3Storage } from "@workspace/service-kit";
import { newId, type Grant, type Principal } from "@workspace/shared";
import { createWorkApp } from "../../src/modules/work/app.js";
import { foldLine } from "../../src/modules/work/feeds.js";
import { resetTestDatabase } from "../test-db.js";

const SECRET = "dev-internal-secret-change-me-32bytes!";
const S = (...ps: string[]): Grant[] => ps.map((permission) => ({ permission, scope: "SELF" }));
const mk = (id: string, grants: Grant[]): Principal => ({ type: "user", id, teamIds: [], departmentId: null, grants });
const minh = mk("minh", S("calendar.read", "calendar.edit"));
const lan = mk("lan", S("calendar.read", "calendar.edit"));
const gateway: Principal = {
  type: "service",
  id: "gateway",
  teamIds: [],
  departmentId: null,
  grants: [{ permission: "principal.resolve", scope: "PLATFORM" }],
};
const storage = new S3Storage({
  endpoint: "http://localhost:8333",
  region: "auto",
  bucket: "workspace-files",
  accessKeyId: "workspace_dev_key",
  secretAccessKey: "workspace_dev_secret",
});
let app: INestApplication;
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

beforeAll(async () => {
  await migrate("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test", fileURLToPath(new URL("../../migrations/work", import.meta.url)), "work");
  // Each suite starts from an empty installation: counts and codes below assume only its own rows.
  await resetTestDatabase();
  app = await createWorkApp({ pool: new pg.Pool({ connectionString: "postgres://workspace_work:app_pw@localhost:5432/workspace_test", max: 5 }), storage, internalSecret: SECRET });
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "127.0.0.1");
});
afterAll(async () => {
  await app?.close();
});

describe("calendar subscription links", () => {
  it("fold long lines at 75 bytes without splitting Vietnamese characters", () => {
    const line = `SUMMARY:${"Họp giao ban đầu tuần ".repeat(8)}`;
    const folded = foldLine(line);
    for (const l of folded.split("\r\n")) expect(Buffer.byteLength(l)).toBeLessThanOrEqual(75);
    expect(folded.replace(/\r\n /g, "")).toBe(line);
  });

  it("a private link serves my meetings to Google Calendar; a new link revokes the old one", async () => {
    const start = new Date(Date.now() + 2 * 86400_000);
    await call(minh, "POST", "/calendar/events", {
      title: "Họp ra mắt, Q4; chốt lịch",
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + 3600_000).toISOString(),
      attendeeIds: ["lan"],
      location: "Phòng 3",
    });
    expect((await call(lan, "GET", "/calendar/feed")).body).toEqual({ active: false });
    const token = (await call(lan, "POST", "/calendar/feed")).body.token as string;
    expect((await call(lan, "GET", "/calendar/feed")).body).toEqual({ active: true });
    const ics = (await call(gateway, "GET", `/internal/calendar-feed/${token}`)).body.ics as string;
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("SUMMARY:Họp ra mắt\\, Q4\\; chốt lịch");
    expect(ics).toContain("LOCATION:Phòng 3");
    // English unless the workspace's language says otherwise.
    expect(ics).toContain("DESCRIPTION:Open in workspace");
    expect(ics).toContain("PRODID:-//workspace//Calendar//EN");
    // A calendar app sends no language: the feed's own text follows the workspace's (Admin › Settings).
    const owner = new pg.Pool({ connectionString: "postgres://workspace_owner:owner_pw@localhost:5432/workspace_test", max: 1 });
    await owner.query(`INSERT INTO work.workspace_settings (code_formats, locale, version) VALUES ('{}', 'vi', 1) ON CONFLICT (singleton) DO UPDATE SET locale = 'vi'`);
    const vi = (await call(gateway, "GET", `/internal/calendar-feed/${token}`)).body.ics as string;
    expect(vi).toContain("DESCRIPTION:Mở trong workspace");
    await owner.query("UPDATE work.workspace_settings SET locale = 'vi'");
    await owner.end();
    expect((await call(lan, "GET", `/internal/calendar-feed/${token}`)).status).toBe(403);
    const again = (await call(lan, "POST", "/calendar/feed")).body.token as string;
    expect((await call(gateway, "GET", `/internal/calendar-feed/${token}`)).status).toBe(404);
    expect((await call(gateway, "GET", `/internal/calendar-feed/${again}`)).status).toBe(200);
    await call(lan, "DELETE", "/calendar/feed");
    expect((await call(gateway, "GET", `/internal/calendar-feed/${again}`)).status).toBe(404);
  });
});
