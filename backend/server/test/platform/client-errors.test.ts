import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { INestApplication } from "@nestjs/common";
import { migrate, PRINCIPAL_HEADER, signInternalToken } from "@workspace/service-kit";
import { newId, type Principal } from "@workspace/shared";
import { createPlatformApp, depsFromEnv } from "../../src/modules/platform/app.js";

// Browser errors (Admin › Lỗi trình duyệt): a person's report is stored under their own id, an admin reads it by
// code and in groups, and a Manager without workspace.configure is refused.
const SECRET = "dev-internal-secret-change-me-32bytes!";
const OWNER = "postgres://workspace_owner:owner_pw@localhost:5432/workspace_test";
const deps = depsFromEnv();
const owner = new pg.Client({ connectionString: `${OWNER}?options=-c%20search_path%3Dplatform` });
let app: INestApplication;
let base: string;
const tag = newId().slice(-6).toUpperCase();

const principal = (id: string, grants: Principal["grants"]): Principal => ({ type: "user", id, teamIds: [], departmentId: null, grants });
const admin = principal(`admin-${tag}`, [{ permission: "workspace.configure", scope: "WORKSPACE" }]);
const staff = principal(`staff-${tag}`, [{ permission: "task.read", scope: "SELF" }]);

async function call(p: Principal, method: string, path: string, body?: unknown) {
  const token = await signInternalToken({ principal: p, requestId: newId() }, SECRET);
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", [PRINCIPAL_HEADER]: token },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

beforeAll(async () => {
  await migrate(OWNER, fileURLToPath(new URL("../../migrations/platform", import.meta.url)), "platform");
  await owner.connect();
  app = await createPlatformApp(deps);
  await app.listen(0);
  base = await app.getUrl();
});

afterAll(async () => {
  await owner.query("DELETE FROM client_errors WHERE code LIKE $1", [`C-${tag}%`]);
  await owner.end();
  await app.close();
  await deps.pool.end();
});

describe("client errors", () => {
  it("stores a report under the caller, not an id from the body, and an admin finds it by code", async () => {
    const r = await call(staff, "POST", "/client-errors", {
      code: `C-${tag}AAAA`,
      kind: "boundary",
      message: "i is not a function",
      stack: "TypeError: i is not a function\n    at o_ (http://x/_next/static/chunks/a.js:1:2)",
      frames: [{ file: "frontend/web/src/components/work/Board.tsx", line: 178, col: 10, name: "TaskCard" }],
      route: "/app/work",
      path: "/app/work?view=board",
      userAgent: "Mozilla/5.0 Chrome/130.0 Safari/537.36",
      userId: "someone-else",
    });
    expect(r.status).toBe(204);
    const got = await call(admin, "GET", `/client-errors?code=c-${tag}aaaa`);
    expect(got.status).toBe(200);
    expect(got.body.occurrence).toMatchObject({
      code: `C-${tag}AAAA`,
      userId: staff.id,
      browser: "Chrome",
      route: "/app/work",
      frames: [{ file: "frontend/web/src/components/work/Board.tsx", line: 178 }],
    });
  });

  it("groups the same message across people and lists a group's occurrences", async () => {
    await call(staff, "POST", "/client-errors", { code: `C-${tag}BBBB`, kind: "uncaught", message: "Cannot read properties of undefined (reading 'name')", route: "/app/home" });
    await call(admin, "POST", "/client-errors", {
      code: `C-${tag}CCCC`,
      kind: "uncaught",
      message: "Cannot read properties of undefined (reading 'title')",
      route: "/app/chat/[channelId]",
    });
    const list = await call(admin, "GET", "/client-errors");
    expect(list.status).toBe(200);
    const g = list.body.groups.find((x: { lastCode: string }) => x.lastCode === `C-${tag}CCCC`);
    expect(g).toMatchObject({ count: 2, users: 2 });
    expect([...g.routes].sort()).toEqual(["/app/chat/[channelId]", "/app/home"]);
    const occ = await call(admin, "GET", `/client-errors?group=${g.groupKey}`);
    expect(occ.body.occurrences.map((o: { code: string }) => o.code)).toEqual([`C-${tag}CCCC`, `C-${tag}BBBB`]);
  });

  it("refuses readers without workspace.configure and an unknown code", async () => {
    expect((await call(staff, "GET", "/client-errors")).status).toBe(403);
    expect((await call(admin, "GET", `/client-errors?code=C-${tag}ZZZZ`)).status).toBe(404);
    expect((await call(staff, "POST", "/client-errors", { code: "bad code", kind: "boundary", message: "x" })).status).toBe(400);
  });
});
