import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { INestApplication } from "@nestjs/common";
import { kv, migrate, PRINCIPAL_HEADER, ServiceClient, verifyInternalToken } from "@workspace/service-kit";
import { newId, type Principal } from "@workspace/shared";
import { http, passwordLogin } from "@workspace/testkit";
import { createGateway, keyForbiddenPath } from "../../src/modules/gateway/gateway.js";
import { createIdentityApp, depsFromEnv as identityDeps } from "../../src/modules/identity/app.js";
import { createPlatformApp, depsFromEnv as platformDeps } from "../../src/modules/platform/app.js";
import { resetTestDatabase } from "../test-db.js";

// MCP over the real gateway and identity: personal and workspace keys, the tools calling a stand-in work module
// as the caller, and the API docs switch.

const SECRET = "dev-internal-secret-change-me-32bytes!";
const run = newId().toLowerCase().slice(-8);
let identityApp: INestApplication;
let platformApp: INestApplication;
let server: Server;
let docsServer: Server;
/** The same gateway with two requests a minute per credential, to see what a caller past its limit is told. */
let tightServer: Server;
let tight: string;
let work: Server;
let gw: string;
let docs: string;
/** What the stand-in work module saw: method, path, body and the principal the gateway signed. */
const seen: { method: string; path: string; body: unknown; principal: Principal }[] = [];
const urlOf = async (a: INestApplication) => (await a.getUrl()).replace("[::1]", "127.0.0.1");

const TASK = {
  id: "T1",
  code: "WEB-1",
  title: "Write the launch post",
  status: "todo",
  priority: "high",
  dueAt: null,
  assigneeId: null,
  projectId: "P1",
  progress: 0,
  atRisk: false,
  blockedReason: null,
  version: 3,
  description: "long text the agent does not need",
};

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => resolve(s ? JSON.parse(s) : undefined));
  });
}

beforeAll(async () => {
  const owner = "postgres://workspace_owner:owner_pw@localhost:5432/workspace_test";
  await migrate(owner, fileURLToPath(new URL("../../migrations/identity", import.meta.url)), "identity");
  await migrate(owner, fileURLToPath(new URL("../../migrations/platform", import.meta.url)), "platform");
  identityApp = await createIdentityApp(identityDeps());
  await identityApp.listen(0);
  const identityUrl = await urlOf(identityApp);
  platformApp = await createPlatformApp({
    ...platformDeps(),
    identity: new ServiceClient(identityUrl, SECRET, "platform", [{ permission: "workspace.provision", scope: "PLATFORM" }]),
  });
  await platformApp.listen(0);
  const platformUrl = await urlOf(platformApp);
  work = createServer(async (req, res) => {
    const body = await readBody(req);
    const { principal } = await verifyInternalToken(String(req.headers[PRINCIPAL_HEADER]), SECRET);
    seen.push({ method: req.method!, path: req.url!, body, principal });
    const json = (status: number, b: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(b));
    if (req.url!.startsWith("/tasks?") || req.url === "/tasks") {
      if (req.method === "POST") return json(201, { ...TASK, ...(body as object), id: "T2" });
      return json(200, { tasks: [TASK], nextCursor: null });
    }
    if (req.url === "/tasks/T1" && req.method === "GET") return json(200, { task: TASK, comments: [] });
    if (req.url === "/tasks/T1" && req.method === "PATCH") return json(200, { ...TASK, ...(body as object), version: 4 });
    if (req.url === "/tasks/NOPE") return json(404, { error: "task not found" });
    json(404, { error: "no route" });
  });
  await new Promise<void>((r) => work.listen(0, "127.0.0.1", r));
  const workUrl = `http://127.0.0.1:${(work.address() as { port: number }).port}`;
  const cfg = (apiDocs: boolean, userPerMinute = 1000) =>
    createGateway({
      jwksUrl: `${identityUrl}/internal/auth/jwks`,
      internalSecret: SECRET,
      identity: new ServiceClient(identityUrl, SECRET, "gateway", [
        { permission: "principal.resolve", scope: "PLATFORM" },
        { permission: "account.recover", scope: "PLATFORM" },
        { permission: "auth.session", scope: "PLATFORM" },
      ]),
      platform: new ServiceClient(platformUrl, SECRET, "gateway", [
        { permission: "workspace.signup", scope: "PLATFORM" },
        { permission: "principal.resolve", scope: "PLATFORM" },
      ]),
      services: { identity: identityUrl, platform: platformUrl, work: workUrl },
      rateLimit: { userPerMinute, signupPerIpPerHour: 1000 },
      apiDocs,
    });
  server = cfg(false).listen(0);
  gw = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  tightServer = cfg(false, 2).listen(0);
  tight = `http://127.0.0.1:${(tightServer.address() as { port: number }).port}`;
  docsServer = cfg(true).listen(0);
  docs = `http://127.0.0.1:${(docsServer.address() as { port: number }).port}`;
});

afterAll(async () => {
  work?.close();
  server?.close();
  docsServer?.close();
  tightServer?.close();
  await platformApp?.close();
  await identityApp?.close();
});

/** One JSON-RPC message to /api/mcp, as an MCP client sends it (Streamable HTTP, JSON answers). */
let rpcId = 0;
async function mcp(token: string, method: string, params: unknown = {}) {
  const res = await fetch(`${gw}/api/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const toolText = (r: { body: { result: { content: { text: string }[] } } }) => r.body.result.content[0]!.text;

describe("MCP and personal API keys", () => {
  let session: string;
  let personal: string;
  let workspaceKey: string;
  let ownerId: string;

  it("a member creates a personal key; it acts as them, limited to the chosen permissions", async () => {
    await resetTestDatabase();
    const s = await http(gw, "POST", "/api/signup", { body: { companyName: `Mcp ${run}`, ownerEmail: `mcp-${run}@example.com`, ownerName: "Minh", password: "Passw0rd!dev" } });
    expect(s.status).toBe(201);
    ownerId = s.body.ownerUserId;
    session = (await passwordLogin(gw, `mcp-${run}@example.com`, "Passw0rd!dev")).accessToken;
    const mine = await http(gw, "GET", "/api/identity/me/api-keys", { token: session });
    expect(mine.body.grantable).toContain("task.read");
    expect(mine.body.grantable).not.toContain("role.manage");
    const made = await http(gw, "POST", "/api/identity/me/api-keys", {
      token: session,
      body: { name: "Claude", permissions: ["task.read", "task.create", "task.edit"] },
    });
    expect(made.status).toBe(201);
    expect(made.body.personal).toBe(true);
    personal = made.body.key;
    const me = await http(gw, "GET", "/api/me", { token: personal });
    expect(me.body.principal).toMatchObject({ type: "user", id: s.body.ownerUserId });
    expect([...new Set(me.body.principal.grants.map((g: { permission: string }) => g.permission))].sort()).toEqual(["task.create", "task.edit", "task.read"]);
    // Never more than the key was given, never account administration.
    expect((await http(gw, "POST", "/api/identity/me/api-keys", { token: session, body: { name: "x", permissions: ["role.manage"] } })).status).toBe(400);
    const ws = await http(gw, "POST", "/api/identity/api-keys", { token: session, body: { name: "ERP", permissions: ["task.read"] } });
    expect(ws.status, JSON.stringify(ws.body)).toBe(201);
    workspaceKey = ws.body.key;
  });

  it("an API key can never reach the account, its keys or the workspace handover", async () => {
    expect(keyForbiddenPath("/api/identity/me/password")).toBe(true);
    expect(keyForbiddenPath("/api/identity/me/api-keys")).toBe(true);
    expect(keyForbiddenPath("/api/identity/members")).toBe(false);
    expect((await http(gw, "GET", "/api/identity/me/api-keys", { token: personal })).status).toBe(403);
    expect((await http(gw, "POST", "/api/identity/me/password", { token: personal, body: { current: "x", next: "y" } })).status).toBe(403);
    // The modules route case-insensitively and the gateway forwards decoded paths: spellings of the same route are
    // refused too (the owner's key handing the workspace over, a key minting keys, enrolling two-step sign-in).
    for (const [method, path] of [
      ["GET", "/api/identity/ME/API-KEYS"],
      ["GET", "/api/identity/me%2Fapi-keys"],
      ["GET", "/api/identity/me/%61pi-keys"],
      ["POST", "/api/identity/Me/Mfa/setup"],
      ["POST", "/api/identity/Workspace/Owner"],
      ["POST", "/api/realtime/ticket/"],
      ["POST", "/API/realtime/TICKET"],
    ] as const) {
      const r = await http(gw, method, path, { token: personal, ...(method === "POST" ? { body: {} } : {}) });
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(r.body.error, `${method} ${path}`).toBe("not_for_api_keys");
    }
    expect(keyForbiddenPath("/api/identity/Me/Sessions/logout-all")).toBe(true);
    expect(keyForbiddenPath("/api/identity//workspace/owner/")).toBe(true);
    // The same spellings still work for a signed-in person.
    expect((await http(gw, "GET", "/api/identity/ME/API-KEYS", { token: session })).status).toBe(200);
  });

  it("speaks MCP: initialize and the tool list with input schemas", async () => {
    const init = await mcp(personal, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(init.status).toBe(200);
    expect(init.body.result.serverInfo.name).toBe("workspace");
    expect(init.body.result.capabilities.tools).toBeDefined();
    const list = await mcp(personal, "tools/list");
    const names = list.body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(["list_my_tasks", "get_task", "create_task", "update_task", "comment_on_task", "search", "my_day"]));
    expect(names).not.toContain("log_progress");
    // The key holds task permissions only: tools for projects and chat are not offered to it.
    expect(names).not.toContain("project_progress");
    expect(names).not.toContain("post_message");
    const create = list.body.result.tools.find((t: { name: string }) => t.name === "create_task");
    expect(create.inputSchema.type).toBe("object");
    expect(create.inputSchema.required).toEqual(["title"]);
  });

  it("tools call the owning service as the person behind the key", async () => {
    seen.length = 0;
    const r = await mcp(personal, "tools/call", { name: "list_my_tasks", arguments: { status: "todo" } });
    const out = JSON.parse(toolText(r));
    expect(out.tasks[0]).toMatchObject({ id: "T1", code: "WEB-1", version: 3 });
    expect(out.tasks[0].description).toBeUndefined();
    expect(seen[0]!.path).toBe("/tasks?status=todo");
    expect(seen[0]!.principal).toMatchObject({ type: "user", id: ownerId });
  });

  it("offers the workflow tools to a key that may read and edit tasks, and runs them as the caller", async () => {
    const names = (await mcp(personal, "tools/list")).body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(["list_workflows", "start_workflow_run", "get_workflow_run", "decide_workflow_run", "stop_workflow_run"]));
    // The calendar needs its own permissions, which this key was not given.
    expect(names).not.toContain("schedule_event");
    expect(names).not.toContain("list_calendar_events");
    seen.length = 0;
    const r = await mcp(personal, "tools/call", { name: "get_workflow_run", arguments: { task: "NOPE" } });
    expect(r.body.result.isError).toBe(true);
    expect(seen[0]).toMatchObject({ method: "GET", path: "/tasks/NOPE/runs", principal: { type: "user", id: ownerId } });
  });

  it("every answer says where the credential stands on its limit; past it, how long to wait", async () => {
    const ok = await fetch(`${gw}/api/work/tasks`, { headers: { authorization: `Bearer ${personal}` } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("ratelimit-limit")).toBe("1000");
    expect(Number(ok.headers.get("ratelimit-remaining"))).toBeLessThan(1000);
    expect(Number(ok.headers.get("ratelimit-reset"))).toBeGreaterThan(0);
    expect(ok.headers.get("retry-after")).toBeNull();
    // The counter is the credential's, whichever door it comes through: this key is long past two a minute.
    const over = await fetch(`${tight}/api/work/tasks`, { headers: { authorization: `Bearer ${personal}` } });
    expect(over.status).toBe(429);
    expect(over.headers.get("ratelimit-remaining")).toBe("0");
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(Number(over.headers.get("retry-after"))).toBeLessThanOrEqual(60);
    expect(await over.json()).toMatchObject({ error: "rate limit exceeded", requestId: expect.any(String) });
  });

  it("a POST retried with the same Idempotency-Key is done once", async () => {
    const post = (key: string | null, body: unknown, token = personal) =>
      fetch(`${gw}/api/work/tasks`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
        body: JSON.stringify(body),
      });
    seen.length = 0;
    const key = `retry-${run}-0001`;
    const first = await post(key, { title: "Once" });
    const again = await post(key, { title: "Once" });
    expect([first.status, again.status]).toEqual([201, 201]);
    expect(first.headers.get("idempotency-replayed")).toBeNull();
    expect(again.headers.get("idempotency-replayed")).toBe("true");
    expect(await again.json()).toEqual(await first.json());
    expect(seen.filter((x) => x.method === "POST")).toHaveLength(1);
    // The same key for something else is a mistake in the caller, never answered with the other request's result.
    const other = await post(key, { title: "Twice" });
    expect(other.status).toBe(422);
    expect(await other.json()).toMatchObject({ error: "idempotency_key_reused" });
    expect((await post("short", { title: "x" })).status).toBe(400);
    // Another credential's key of the same name is its own; without the header nothing is remembered.
    expect((await post(key, { title: "Twice" }, workspaceKey)).headers.get("idempotency-replayed")).toBeNull();
    await post(null, { title: "Once" });
    await post(null, { title: "Once" });
    expect(seen.filter((x) => x.method === "POST" && (x.body as { title: string }).title === "Once")).toHaveLength(3);
  });

  it("update_task reads the current version when none is given, and reports refusals as tool errors", async () => {
    seen.length = 0;
    const r = await mcp(personal, "tools/call", { name: "update_task", arguments: { id: "T1", status: "in_progress" } });
    expect(JSON.parse(toolText(r))).toMatchObject({ status: "in_progress", version: 4 });
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual(["GET /tasks/T1", "PATCH /tasks/T1"]);
    expect(seen[1]!.body).toEqual({ status: "in_progress", expectedVersion: 3 });
    const missing = await mcp(personal, "tools/call", { name: "update_task", arguments: { id: "NOPE", status: "done", expectedVersion: 1 } });
    expect(missing.body.result.isError).toBe(true);
    expect(toolText(missing)).toMatch(/^Not found/);
    const bad = await mcp(personal, "tools/call", { name: "create_task", arguments: {} });
    expect(bad.body.result.isError).toBe(true);
    expect(toolText(bad)).toMatch(/title/);
  });

  it("a workspace key is not a person: list_my_tasks says so", async () => {
    const r = await mcp(workspaceKey, "tools/call", { name: "list_my_tasks", arguments: {} });
    expect(r.body.result.isError).toBe(true);
    expect(toolText(r)).toMatch(/personal API key/);
  });

  it("ai_insights_summary goes to the ai module as the caller (here unreachable: a tool error, not a crash)", async () => {
    // Test workspaces have AI Insights on; this gateway has no ai module, so the call comes back as a tool error.
    const r = await mcp(personal, "tools/call", { name: "ai_insights_summary", arguments: { days: 7 } });
    expect(r.status).toBe(200);
    expect(r.body.result.isError).toBe(true);
  });

  it("refuses MCP without credentials, and GET on the stateless endpoint", async () => {
    expect((await fetch(`${gw}/api/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    expect((await fetch(`${gw}/api/mcp`, { headers: { authorization: `Bearer ${personal}` } })).status).toBe(405);
  });

  it("serves the OpenAPI document only with API_DOCS=1", async () => {
    expect((await fetch(`${gw}/api/docs/openapi.json`)).status).not.toBe(200);
    const doc = await (await fetch(`${docs}/api/docs/openapi.json`)).json();
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.paths["/api/work/tasks"].post.operationId).toBe("createTask");
    const page = await fetch(`${docs}/api/docs`);
    expect(page.headers.get("content-security-policy")).toContain("cdn.jsdelivr.net");
  });

  it("a revoked personal key stops at once for MCP too (after the 30 s key cache)", async () => {
    const mine = await http(gw, "GET", "/api/identity/me/api-keys", { token: session });
    const id = mine.body.keys[0].id;
    expect((await http(gw, "DELETE", `/api/identity/me/api-keys/${id}`, { token: session })).status).toBe(204);
    kv().delPrefix("apikey:");
    expect((await mcp(personal, "tools/list")).status).toBe(401);
  });

  it("signing out everywhere also ends the person's personal keys", async () => {
    const made = await http(gw, "POST", "/api/identity/me/api-keys", { token: session, body: { name: "Laptop", permissions: ["task.read"] } });
    expect(made.status).toBe(201);
    expect((await mcp(made.body.key, "tools/list")).status).toBe(200);
    expect((await http(gw, "POST", "/api/identity/me/sessions/logout-all", { token: session })).status).toBe(204);
    kv().delPrefix("apikey:");
    expect((await mcp(made.body.key, "tools/list")).status).toBe(401);
    // The workspace's own keys are not a person's and stay.
    expect((await http(gw, "GET", "/api/me", { token: workspaceKey })).status).toBe(200);
  });
});
