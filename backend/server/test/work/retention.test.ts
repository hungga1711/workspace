import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { INestApplication } from "@nestjs/common";
import pg from "pg";
import { migrate, signInternalToken, PRINCIPAL_HEADER, S3Storage } from "@workspace/service-kit";
import { newId, runWithContext, withTransaction, type Grant, type Principal } from "@workspace/shared";
import { createWorkApp } from "../../src/modules/work/app.js";
import { pruneActivity } from "../../src/modules/work/start.js";
import { resetTestDatabase } from "../test-db.js";

const SECRET = "dev-internal-secret-change-me-32bytes!";
const T = (...ps: string[]): Grant[] => ps.map((permission) => ({ permission, scope: "WORKSPACE" }));
const admin: Principal = {
  type: "user",
  id: "minh",
  teamIds: [],
  departmentId: null,
  grants: T("project.read", "project.create", "task.read", "task.create", "task.edit", "task.assign"),
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
let pool: pg.Pool;
const inTx = <R>(fn: (c: pg.PoolClient) => Promise<R>) => runWithContext({ actorId: "test", requestId: newId() }, () => withTransaction(pool, fn));

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
  await storage.ensureBucket();
  pool = new pg.Pool({ connectionString: "postgres://workspace_work:app_pw@localhost:5432/workspace_test", max: 5 });
  app = await createWorkApp({ pool, storage, internalSecret: SECRET });
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "127.0.0.1");
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe("activity retention", () => {
  it("deletes old rows in batches through work_activity_prune and keeps recent ones", async () => {
    await inTx(async (c) => {
      for (let i = 0; i < 12; i++)
        await c.query("INSERT INTO activity (id, entity_type, entity_id, actor, action, at) VALUES ($1, 'task', 't1', 'minh', 'created', now() - make_interval(days => $2))", [
          newId(),
          i < 8 ? 400 : 10,
        ]);
    });
    expect(await pruneActivity(pool, 365)).toBe(8);
    const left = await inTx((c) => c.query<{ n: number }>("SELECT count(*)::int AS n FROM activity WHERE entity_id = 't1'"));
    expect(left.rows[0]!.n).toBe(4);
    expect(await pruneActivity(pool, 365)).toBe(0);
  });
});

describe("insights weekly buckets", () => {
  it("match the former per-bucket counts on tasks spread over the last ten weeks", async () => {
    const project = (await call(admin, "POST", "/projects", { name: "Buckets" })).body;
    for (let i = 0; i < 40; i++) {
      const r = await call(admin, "POST", "/tasks", { title: `B${i}`, projectId: project.id, assigneeId: "minh" });
      expect(r.status).toBe(201);
    }
    // Spread creation over 70 days and finish every other task somewhere in the last 70 days, bucket edges included.
    await inTx((c) =>
      c.query(
        `WITH r AS (SELECT id, row_number() OVER (ORDER BY id) AS n FROM tasks WHERE project_id = $1)
         UPDATE tasks t SET created_at = now() - make_interval(days => ((r.n * 7) % 70)::int, hours => (r.n % 3)::int),
                            status = CASE WHEN r.n % 2 = 0 THEN 'done' ELSE status END,
                            completed_at = CASE WHEN r.n % 2 = 0 THEN now() - make_interval(days => ((r.n * 3) % 70)::int, mins => r.n::int) END
           FROM r WHERE t.id = r.id`,
        [project.id],
      ),
    );
    // The former sixteen correlated counts, over the same scope insightsSql uses (done tasks older than 56 days drop out).
    const expected = await inTx((c) =>
      c.query<{ bucket: number; done: number; created: number }>(
        `SELECT b.bucket,
                (SELECT count(*)::int FROM tasks WHERE project_id = $1 AND status <> 'cancelled' AND (status <> 'done' OR completed_at > now() - interval '56 days') AND completed_at >= now() - make_interval(days => 7 * (8 - b.bucket)) AND completed_at < now() - make_interval(days => 7 * (7 - b.bucket))) AS done,
                (SELECT count(*)::int FROM tasks WHERE project_id = $1 AND status <> 'cancelled' AND (status <> 'done' OR completed_at > now() - interval '56 days') AND created_at >= now() - make_interval(days => 7 * (8 - b.bucket)) AND created_at < now() - make_interval(days => 7 * (7 - b.bucket))) AS created
           FROM generate_series(0, 7) AS b(bucket) ORDER BY b.bucket`,
        [project.id],
      ),
    );
    expect(expected.rows.reduce((s, r) => s + r.done + r.created, 0)).toBeGreaterThan(20);
    const r = await call(admin, "GET", "/insights");
    expect(r.status).toBe(200);
    const weeks = r.body.weeks as { weekStart: string; done: number; created: number }[];
    expect(weeks).toHaveLength(8);
    expect(weeks.map((w) => [w.done, w.created])).toEqual(expected.rows.map((w) => [w.done, w.created]));
    // Week starts are 7 days apart and the last one is 7 days before now.
    const starts = weeks.map((w) => Date.parse(w.weekStart));
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBe(7 * 86400_000);
    expect(Date.now() - starts[7]!).toBeGreaterThan(7 * 86400_000 - 60_000);
    expect(Date.now() - starts[7]!).toBeLessThan(7 * 86400_000 + 60_000);
  });
});
