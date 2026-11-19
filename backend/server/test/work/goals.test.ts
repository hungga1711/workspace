import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { INestApplication } from "@nestjs/common";
import pg from "pg";
import { migrate, signInternalToken, PRINCIPAL_HEADER, S3Storage } from "@workspace/service-kit";
import { newId, type Grant, type Principal } from "@workspace/shared";
import { createWorkApp } from "../../src/modules/work/app.js";
import { currentPeriod, periodRange } from "../../src/modules/work/goals.js";
import { resetTestDatabase } from "../test-db.js";

const SECRET = "dev-internal-secret-change-me-32bytes!";
const T = (...ps: string[]): Grant[] => ps.map((permission) => ({ permission, scope: "WORKSPACE" }));
const minh: Principal = {
  type: "user",
  id: "minh",
  teamIds: [],
  departmentId: null,
  grants: T("project.read", "project.create", "project.edit", "task.read", "task.create", "task.edit", "task.assign", "task.delete"),
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

/** Can see the project but not edit tasks. */
const viewer: Principal = { ...minh, id: "lan", grants: T("project.read", "task.read") };

async function call(method: string, path: string, body?: unknown, as: Principal = minh) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", [PRINCIPAL_HEADER]: await signInternalToken({ principal: as, requestId: newId() }, SECRET) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null };
}

beforeAll(async () => {
  await migrate("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test", fileURLToPath(new URL("../../migrations/work", import.meta.url)), "work");
  // Each suite starts from an empty installation: counts and codes below assume only its own rows.
  await resetTestDatabase();
  const pool = new pg.Pool({ connectionString: "postgres://workspace_work:app_pw@localhost:5432/workspace_test", max: 5 });
  app = await createWorkApp({ pool, storage, internalSecret: SECRET });
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "127.0.0.1");
});
afterAll(async () => {
  await app?.close();
});

describe("goals: pure parts", () => {
  it("knows periods", () => {
    expect(periodRange("Q4/2026")).toEqual({ starts: "2026-10-01", ends: "2027-01-01" });
    expect(periodRange("H1/2027")).toEqual({ starts: "2027-01-01", ends: "2027-07-01" });
    expect(periodRange("N/2026")).toEqual({ starts: "2026-01-01", ends: "2027-01-01" });
    // Dated: both days inclusive on the way in, [starts, ends) in the table like the others.
    expect(periodRange("D/2026-11-03/2026-11-16")).toEqual({ starts: "2026-11-03", ends: "2026-11-17" });
    expect(() => periodRange("D/2026-11-16/2026-11-03")).toThrow();
    expect(currentPeriod(new Date("2026-10-13T03:00:00Z"))).toBe("Q4/2026");
    expect(currentPeriod(new Date("2026-12-31T20:00:00Z"))).toBe("Q1/2027"); // already 1/1 in Vietnam
    expect(currentPeriod(new Date("2026-12-31T20:00:00Z"), "America/New_York")).toBe("Q4/2026"); // still 31/12 there
  });
});

describe("goals: API", () => {
  it("a goal with a number and a project key result; check-in; only owner or admin edits", async () => {
    const project = (await call("POST", "/projects", { name: "Cổng khách hàng" })).body;
    for (const [i, title] of ["A", "B", "C", "D"].entries()) {
      const t = (await call("POST", "/tasks", { title, projectId: project.id })).body;
      if (i === 0) await call("PATCH", `/tasks/${t.id}`, { expectedVersion: t.version, status: "done" });
    }
    const period = currentPeriod();
    const made = await call("POST", "/goals", {
      title: "Tăng doanh thu quý",
      ownerId: "minh",
      department: "Kinh doanh",
      period,
      keyResults: [
        { title: "Doanh thu mới", kind: "number", start: 0, target: 2000, unit: "triệu" },
        { title: "Ra mắt cổng khách hàng", kind: "project", projectId: project.id },
      ],
    });
    expect(made.status).toBe(201);
    expect(made.body.keyResults.map((k: { progress: number }) => k.progress)).toEqual([0, 25]);
    expect(made.body.progress).toBe(13);
    const num = made.body.keyResults[0].id;
    expect((await call("PATCH", `/key-results/${num}`, { current: 1000 })).status).toBe(200);
    expect((await call("PATCH", `/key-results/${made.body.keyResults[1].id}`, { current: 1 })).status).toBe(400); // project KR moves with tasks
    // Read-only colleague: sees it, cannot move it.
    expect((await call("PATCH", `/key-results/${num}`, { current: 1500 }, viewer)).status).toBe(403);
    const list = (await call("GET", `/goals?period=${encodeURIComponent(period)}`, undefined, viewer)).body;
    const g = list.goals.find((x: { id: string }) => x.id === made.body.id);
    expect(g.progress).toBe(38); // (50 + 25) / 2
    expect(list.canCreate).toBe(false);
    expect((await call("POST", "/goals", { title: "x", ownerId: "lan", period, keyResults: [{ title: "x", kind: "number", target: 1 }] }, viewer)).status).toBe(403);
    // Editing keeps the value of a key result that stays.
    const edited = await call("PUT", `/goals/${made.body.id}`, {
      title: "Tăng doanh thu Q4",
      ownerId: "minh",
      department: "Kinh doanh",
      period,
      keyResults: [{ id: num, title: "Doanh thu mới", kind: "number", start: 0, target: 2000, unit: "triệu" }],
    });
    expect(edited.body.keyResults).toHaveLength(1);
    expect(edited.body.keyResults[0].current).toBe(1000);
    expect((await call("DELETE", `/goals/${made.body.id}`, undefined, viewer)).status).toBe(403);
    expect((await call("DELETE", `/goals/${made.body.id}`)).status).toBe(204);
    expect((await call("GET", `/goals?period=${encodeURIComponent(period)}`)).body.goals.some((x: { id: string }) => x.id === made.body.id)).toBe(false);
  });

  it("a dated goal (a sprint) shows under the quarter it falls in, and is no period of its own", async () => {
    const { starts } = periodRange(currentPeriod());
    const day = (offset: number) => new Date(Date.parse(`${starts}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
    const sprint = `D/${day(10)}/${day(23)}`;
    const made = await call("POST", "/goals", {
      title: "Sprint 42",
      ownerId: "minh",
      period: sprint,
      keyResults: [{ title: "Lỗi P1 còn lại", kind: "number", start: 12, target: 0 }],
    });
    expect(made.status).toBe(201);
    expect(made.body.period).toBe(sprint);
    expect([made.body.startsOn, made.body.endsOn]).toEqual([day(10), day(24)]);
    const quarter = (await call("GET", `/goals?period=${encodeURIComponent(currentPeriod())}`)).body;
    expect(quarter.goals.some((g: { id: string }) => g.id === made.body.id)).toBe(true);
    expect(quarter.periods).not.toContain(sprint);
    expect((await call("GET", `/goals?period=${encodeURIComponent(sprint)}`)).body.goals.map((g: { id: string }) => g.id)).toEqual([made.body.id]);
    expect((await call("POST", "/goals", { title: "x", ownerId: "minh", period: "D/2026-11-16/2026-11-03", keyResults: [{ title: "x", kind: "number", target: 1 }] })).status).toBe(
      400,
    );
  });
});
