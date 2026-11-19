import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { INestApplication } from "@nestjs/common";
import pg from "pg";
import {
  EventBus,
  migrate,
  signInternalToken,
  startOutboxRelay,
  PRINCIPAL_HEADER,
  S3Storage,
  type EventConsumer,
  type OutboxRelay,
  type ServiceClient,
} from "@workspace/service-kit";
import { newId, type Principal } from "@workspace/shared";
import { DEFAULT_ROLES } from "../../src/modules/identity/catalog.js";
import { createWorkApp } from "../../src/modules/work/app.js";
import { afterCall, cachedRead, clearOnChanges, markTools, setToolCache } from "../../src/modules/ai/tool-cache.js";
import type { ToolContext } from "../../src/modules/ai/tools.js";
import { resetTestDatabase } from "../test-db.js";

/**
 * The AI's recent tool results are never read after a change made outside the AI: a task moved in the UI
 * goes through the work module's outbox to the bus, and the ai-tool-cache group clears the cache (tool-cache.ts).
 */
const SECRET = "dev-internal-secret-change-me-32bytes!";
const lan: Principal = { type: "user", id: newId(), teamIds: [], departmentId: null, grants: DEFAULT_ROLES.find((r) => r.name === "Employee")!.grants };
const ctx = { principal: lan, agentId: null, services: {} as ToolContext["services"], lang: "en" } as ToolContext;
const bus = new EventBus();

let app: INestApplication;
let pool: pg.Pool;
let base = "";
let relay: OutboxRelay;
let consumer: EventConsumer;

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", [PRINCIPAL_HEADER]: await signInternalToken({ principal: lan, requestId: newId() }, SECRET) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null };
}

beforeAll(async () => {
  await migrate("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test", fileURLToPath(new URL("../../migrations/work", import.meta.url)), "work");
  await resetTestDatabase();
  pool = new pg.Pool({ connectionString: "postgres://workspace_work:app_pw@localhost:5432/workspace_test", max: 4 });
  const ai = { request: async () => ({ text: "unused" }) } as unknown as ServiceClient;
  // Never used here (no files); the app needs one.
  const storage = new S3Storage({
    endpoint: "http://localhost:8333",
    region: "auto",
    bucket: "workspace-files",
    accessKeyId: "workspace_dev_key",
    secretAccessKey: "workspace_dev_secret",
  });
  app = await createWorkApp({ pool, storage, internalSecret: SECRET, ai, resolvePrincipal: async () => lan });
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "127.0.0.1");
  consumer = await clearOnChanges(bus);
  bus.start();
  relay = startOutboxRelay({ pool, bus, pollMs: 60_000 });
  markTools(["list_my_tasks"], []);
  setToolCache(true);
});

afterAll(async () => {
  setToolCache(false);
  await relay?.stop();
  await consumer?.stop();
  await app?.close();
  await pool?.end();
});

describe("the AI's tool cache and changes made in the UI", () => {
  it("keeps a result while nothing changes, and drops it once a task is changed through the work API", async () => {
    const created = await call("POST", "/tasks", { title: "Send the quote", assigneeId: lan.id });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    await relay.flush();

    afterCall(ctx, "list_my_tasks", {}, { ok: true, content: "T-1 Send the quote (to do)", sources: [] });
    await relay.flush();
    expect(cachedRead(ctx, "list_my_tasks", {})?.content).toContain("to do");

    const moved = await call("PATCH", `/tasks/${created.body.id}`, { expectedVersion: created.body.version, status: "in_progress" });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(await relay.flush()).toBeGreaterThan(0);
    expect(cachedRead(ctx, "list_my_tasks", {})).toBeUndefined();
  });
});
