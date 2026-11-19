import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import type { INestApplication } from "@nestjs/common";
import type { EventEnvelope } from "@workspace/contracts";
import { PRINCIPAL_HEADER, ServiceClient, signInternalToken } from "@workspace/service-kit";
import { newId, withTransaction, type Principal } from "@workspace/shared";
import { createPlatformApp, depsFromEnv } from "../../src/modules/platform/app.js";
import { auditEvent } from "../../src/modules/platform/audit/trail.js";
import { pruneRetention } from "../../src/modules/platform/retention.js";

// The audit trail (ADR 0025): the consumer's mapping against the real table, reading it (access, filters, cursor
// pages, reads recorded), the web's export entries, and that the module's own role can only append.
const SECRET = "dev-internal-secret-change-me-32bytes!";
const OWNER = "postgres://workspace_owner:owner_pw@localhost:5432/workspace_test?options=-c%20search_path%3Dplatform";
const deps = depsFromEnv();
const owner = new pg.Client({ connectionString: OWNER });
let app: INestApplication;
let base: string;

const principal = (id: string, grants: Principal["grants"]): Principal => ({ type: "user", id, teamIds: [], departmentId: null, grants });
const admin = principal("admin-1", [{ permission: "audit.read", scope: "WORKSPACE" }]);
const staff = principal("staff-1", [{ permission: "task.read", scope: "SELF" }]);

async function call(p: Principal, method: string, path: string, body?: unknown) {
  const token = await signInternalToken({ principal: p, requestId: newId(), origin: { ip: "203.0.113.9", userAgent: "Vitest", via: "session" } }, SECRET);
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", [PRINCIPAL_HEADER]: token },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const envelope = (eventType: string, payload: Record<string, unknown>, extra: Partial<EventEnvelope> = {}): EventEnvelope => ({
  eventId: newId(),
  eventType,
  version: 1,
  aggregateType: eventType.split(".").slice(0, 2).join("."),
  aggregateId: "x",
  actorId: "user:u1",
  occurredAt: new Date().toISOString(),
  requestId: "req-audit-test-1",
  origin: { ip: "198.51.100.7", userAgent: "Firefox", via: "session" },
  payload,
  ...extra,
});

const task = (over: Record<string, unknown> = {}) => ({
  taskId: "t-1",
  code: "T-142",
  title: "Gửi báo giá",
  description: "giá nội bộ 1 tỷ",
  ownerId: "u1",
  assigneeId: null,
  projectId: null,
  status: "todo",
  priority: "normal",
  dueAt: null,
  labels: [],
  version: 1,
  blockedReason: null,
  source: null,
  ...over,
});

const feed = (e: EventEnvelope) => withTransaction(deps.pool, (c) => auditEvent(c, e));

beforeAll(async () => {
  await owner.connect();
  app = await createPlatformApp({ ...deps, identity: new ServiceClient("http://127.0.0.1:9", SECRET, "platform", []) });
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "127.0.0.1");
  await owner.query("DELETE FROM audit_trail");
  await owner.query("DELETE FROM audit_subjects");
});

afterAll(async () => {
  await app?.close();
  await owner.end();
});

describe("audit trail", () => {
  it("turns events into rows once, with origin and changes, and never private text", async () => {
    const created = envelope("work.task.created.v1", task());
    expect(await feed(created)).toBe(1);
    expect(await feed(created)).toBe(0); // redelivered
    await feed(envelope("work.task.updated.v1", task({ status: "doing", version: 2 }), { requestId: "req-audit-test-2" }));
    // Not mapped: skipped.
    expect(await feed(envelope("work.task.checkin_due.v1", { taskId: "t-1", code: "T-142", title: "x", assigneeId: null, ownerId: "u1", dueAt: null, progress: null }))).toBe(0);
    const rows = (await owner.query("SELECT * FROM audit_trail WHERE target_id = 't-1' ORDER BY at")).rows;
    expect(rows.map((r) => r.action)).toEqual(["work.task.created", "work.task.status_changed"]);
    expect(rows[1]).toMatchObject({
      actor_type: "user",
      actor_id: "u1",
      via: "session",
      ip: "198.51.100.7",
      user_agent: "Firefox",
      module: "work",
      target_label: "T-142 · Gửi báo giá",
    });
    expect(rows[1].changes).toEqual({ status: { from: "todo", to: "doing" } });
    const all = JSON.stringify((await owner.query("SELECT * FROM audit_trail")).rows) + JSON.stringify((await owner.query("SELECT * FROM audit_subjects")).rows);
    expect(all).not.toContain("tỷ");
  });

  it("is readable only with audit.read", async () => {
    expect((await call(staff, "GET", "/audit")).status).toBe(403);
    expect((await call(staff, "GET", "/audit/stats")).status).toBe(403);
    expect((await call(admin, "GET", "/audit")).status).toBe(200);
  });

  it("pages with a cursor without gaps or repeats, and filters", async () => {
    for (let i = 0; i < 5; i++)
      await feed(
        envelope(
          "audit.entry.recorded.v1",
          { action: "work.file.downloaded", targetType: "file", targetId: `f-${i}`, targetLabel: `bao-gia-${i}.pdf`, outcome: "success" },
          { actorId: "user:u2" },
        ),
      );
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const r: { status: number; body: { entries: { id: string }[]; next: string | null } } = await call(
        admin,
        "GET",
        `/audit?actor=u2&limit=2${cursor ? `&cursor=${cursor}` : ""}`,
      );
      expect(r.status).toBe(200);
      seen.push(...r.body.entries.map((e) => e.id));
      cursor = r.body.next;
    } while (cursor);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);

    expect((await call(admin, "GET", "/audit?q=bao-gia-3")).body.entries.map((e: { targetId: string }) => e.targetId)).toEqual(["f-3"]);
    expect((await call(admin, "GET", "/audit?targetType=task&targetId=t-1")).body.entries).toHaveLength(2);
    expect((await call(admin, "GET", "/audit?requestId=req-audit-test-2")).body.entries.map((e: { action: string }) => e.action)).toEqual(["work.task.status_changed"]);
    expect((await call(admin, "GET", "/audit?action=work.task.")).body.entries).toHaveLength(2);
    expect((await call(admin, "GET", "/audit?cursor=nonsense")).status).toBe(400);
    const stats = (await call(admin, "GET", "/audit/stats?module=work")).body;
    expect(stats.total).toBeGreaterThanOrEqual(7);
    expect(stats.modules).toEqual([{ module: "work", n: stats.total }]);
  });

  it("records reads of the trail: a view at most every ten minutes, every export", async () => {
    await owner.query("DELETE FROM audit_trail WHERE action LIKE 'platform.audit.%'");
    await call(admin, "GET", "/audit?module=work");
    await call(admin, "GET", "/audit?module=chat");
    await call(admin, "GET", "/audit?purpose=export");
    await call(admin, "GET", "/audit?purpose=export");
    const rows = (await owner.query("SELECT action, actor_id, ip, meta FROM audit_trail WHERE action LIKE 'platform.audit.%' ORDER BY at")).rows;
    expect(rows.map((r) => r.action)).toEqual(["platform.audit.viewed", "platform.audit.exported", "platform.audit.exported"]);
    expect(rows[0]).toMatchObject({ actor_id: "admin-1", ip: "203.0.113.9", meta: { filter: { module: "work" } } });
  });

  it("takes the web app's own exports, and nothing else", async () => {
    expect((await call(staff, "POST", "/audit/record", { action: "work.project.exported", targetType: "project", targetId: "p-1", targetLabel: "DA-1 · Website" })).status).toBe(
      204,
    );
    expect((await call(staff, "POST", "/audit/record", { action: "identity.member.roles_set", targetType: "member", targetId: "x" })).status).toBe(400);
    const r = (await owner.query("SELECT actor_id, target_label FROM audit_trail WHERE action = 'work.project.exported'")).rows;
    expect(r).toEqual([{ actor_id: "staff-1", target_label: "DA-1 · Website" }]);
  });

  it("is append-only for the module's role, and pruned by the retention job", async () => {
    await expect(deps.pool.query("UPDATE audit_trail SET action = 'x'")).rejects.toThrow(/permission denied/);
    await expect(deps.pool.query("DELETE FROM audit_trail")).rejects.toThrow(/permission denied/);
    const old = envelope(
      "audit.entry.recorded.v1",
      { action: "identity.auth.signed_in", targetType: "member", targetId: "u9", outcome: "success" },
      { occurredAt: new Date(Date.now() - 400 * 86400_000).toISOString() },
    );
    await feed(old);
    const r = await pruneRetention(deps.pool, { auditLog: 730, auditTrail: 365, webhookDeliveries: 30 });
    expect(r.auditTrail).toBeGreaterThanOrEqual(1);
    expect((await owner.query("SELECT 1 FROM audit_trail WHERE id = $1", [old.eventId])).rowCount).toBe(0);
    expect((await owner.query("SELECT 1 FROM audit_trail WHERE target_id = 't-1'")).rowCount).toBe(2);
  });
});
