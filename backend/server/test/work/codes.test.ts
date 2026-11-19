import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { INestApplication } from "@nestjs/common";
import pg from "pg";
import { migrate, signInternalToken, PRINCIPAL_HEADER, S3Storage } from "@workspace/service-kit";
import { newId, type Grant, type Principal } from "@workspace/shared";
import { createWorkApp } from "../../src/modules/work/app.js";
import { resetTestDatabase } from "../test-db.js";

/** Readable codes for requests (YC-001) and meetings (H-001; a series H-002-1, H-002-2…): made, found, kept apart. */
const SECRET = "dev-internal-secret-change-me-32bytes!";
const OWNER_URL = "postgres://workspace_owner:owner_pw@localhost:5432/workspace_test";
const MIGRATIONS = fileURLToPath(new URL("../../migrations/work", import.meta.url));
const S = (...ps: string[]): Grant[] => ps.map((permission) => ({ permission, scope: "SELF" }));
const mk = (id: string): Principal => ({ type: "user", id, teamIds: [], departmentId: null, grants: S("calendar.read", "calendar.edit") });
const lan = mk("lan");
const huy = mk("huy");

let app: INestApplication;
let base: string;
let pool: pg.Pool;

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
  await migrate(OWNER_URL, MIGRATIONS, "work");
  // Each suite starts from an empty installation: counts and codes below assume only its own rows.
  await resetTestDatabase();
  const storage = new S3Storage({
    endpoint: "http://localhost:8333",
    region: "auto",
    bucket: "workspace-files",
    accessKeyId: "workspace_dev_key",
    secretAccessKey: "workspace_dev_secret",
  });
  pool = new pg.Pool({ connectionString: "postgres://workspace_work:app_pw@localhost:5432/workspace_test", max: 5 });
  app = await createWorkApp({ pool, storage, internalSecret: SECRET });
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "127.0.0.1");
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe("request codes", () => {
  it("numbers requests per workspace and opens them by code in any case", async () => {
    const first = (await call(lan, "POST", "/approvals", { title: "Mua màn hình", approverId: "huy" })).body;
    const second = (await call(lan, "POST", "/approvals", { title: "Công tác Đà Nẵng", approverId: "huy" })).body;
    expect(first.code).toBe("YC-001");
    expect(second.code).toBe("YC-002");
    const byCode = (await call(huy, "GET", "/approvals/yc-002")).body;
    expect(byCode).toMatchObject({ id: second.id, code: "YC-002", title: "Công tác Đà Nẵng" });
    expect((await call(lan, "GET", `/approvals/${second.id}`)).body.code).toBe("YC-002");
    expect((await call(lan, "GET", "/approvals?role=requester")).body.approvals.map((a: { code: string }) => a.code)).toEqual(["YC-002", "YC-001"]);
  });
});

describe("meeting codes", () => {
  it("gives a meeting a code, a series one number with numbered occurrences, and a deadline none", async () => {
    const one = (await call(lan, "POST", "/calendar/events", { title: "Họp kế hoạch", startsAt: "2026-11-02T02:00:00Z", endsAt: "2026-11-02T03:00:00Z", attendeeIds: ["huy"] }))
      .body;
    expect(one.code).toBe("H-001");
    const series = (
      await call(lan, "POST", "/calendar/events", {
        title: "Giao ban tuần",
        startsAt: "2026-11-03T02:00:00Z",
        endsAt: "2026-11-03T02:30:00Z",
        attendeeIds: ["huy"],
        recurrence: { rule: "weekly", until: "2026-11-24T03:00:00Z", timeZone: "Asia/Ho_Chi_Minh" },
      })
    ).body;
    expect(series).toMatchObject({ code: "H-002-1", occurrences: 4 });
    const third = (await call(huy, "GET", "/meetings/h-002-3")).body;
    expect(third.event).toMatchObject({ code: "H-002-3", title: "Giao ban tuần" });
    expect(third.series.previous.code).toBe("H-002-2");
    const deadline = (await call(lan, "POST", "/calendar/events", { title: "Nộp báo cáo", kind: "deadline", startsAt: "2026-11-05T10:00:00Z", endsAt: "2026-11-05T10:00:00Z" }))
      .body;
    expect(deadline.code).toBeNull();
    expect((await call(lan, "POST", "/calendar/events", { title: "Họp tiếp", startsAt: "2026-11-06T02:00:00Z", endsAt: "2026-11-06T03:00:00Z" })).body.code).toBe("H-003");
  });
});
