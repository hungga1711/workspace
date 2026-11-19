import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fileURLToPath } from "node:url";
import type { INestApplication } from "@nestjs/common";
import { migrate, ServiceClient, signInternalToken, PRINCIPAL_HEADER } from "@workspace/service-kit";
import { newId, type Principal } from "@workspace/shared";
import { createPlatformApp, depsFromEnv } from "../../src/modules/platform/app.js";
import { defaultConfig, readWorkspaceConfig } from "../../src/modules/platform/config.js";
let poolDeps: ReturnType<typeof depsFromEnv> | null = null;
const deps = () => (poolDeps ??= depsFromEnv());
import { createIdentityApp, depsFromEnv as identityDeps } from "../../src/modules/identity/app.js";
import { resetTestDatabase } from "../test-db.js";

const SECRET = "dev-internal-secret-change-me-32bytes!";
const iDeps = identityDeps();
let identityApp: INestApplication;
let platformApp: INestApplication;
let base: string;
let identity: ServiceClient;
const run = newId().toLowerCase().slice(-8);

const gateway: Principal = {
  type: "service",
  id: "gateway",
  teamIds: [],
  departmentId: null,
  grants: [{ permission: "workspace.signup", scope: "PLATFORM" }],
};

async function call(principal: Principal | null, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (principal) headers[PRINCIPAL_HEADER] = await signInternalToken({ principal, requestId: newId() }, SECRET);
  const res = await fetch(`${base}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function signup(company: string, email: string) {
  const r = await call(gateway, "POST", "/signup", { companyName: company, ownerEmail: email, ownerName: "Minh Le", password: "Passw0rd!dev" });
  expect(r.status).toBe(201);
  const userId = await iDeps.users.findUserByEmail(email);
  const owner = await identity.request<Principal>("POST", "/internal/resolve", { userId });
  return { owner };
}

let a: { owner: Principal };

beforeAll(async () => {
  await migrate("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test", fileURLToPath(new URL("../../migrations/identity", import.meta.url)), "identity");
  await migrate("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test", fileURLToPath(new URL("../../migrations/platform", import.meta.url)), "platform");
  identityApp = await createIdentityApp(iDeps);
  await identityApp.listen(0);
  const identityUrl = (await identityApp.getUrl()).replace("[::1]", "127.0.0.1");
  identity = new ServiceClient(identityUrl, SECRET, "test", [
    { permission: "principal.resolve", scope: "PLATFORM" },
    { permission: "workspace.provision", scope: "PLATFORM" },
  ]);
  const deps = depsFromEnv();
  platformApp = await createPlatformApp({
    ...deps,
    webhooks: { allowPrivate: true },
    identity: new ServiceClient(identityUrl, SECRET, "platform", [
      { permission: "workspace.provision", scope: "PLATFORM" },
      { permission: "principal.resolve", scope: "PLATFORM" },
    ]),
  });
  await platformApp.listen(0);
  base = (await platformApp.getUrl()).replace("[::1]", "127.0.0.1");
  await resetTestDatabase();
  a = await signup(`Alpha ${run}`, `minh-${run}@alpha.example.com`);
});

afterAll(async () => {
  await platformApp?.close();
  await identityApp?.close();
});

describe("platform module", () => {
  it("setup creates an active workspace with every module on and no plan", async () => {
    const w = await call(a.owner, "GET", "/workspace");
    expect(w.status).toBe(200);
    expect(w.body.workspace).toMatchObject({ name: `Alpha ${run}`, status: "active" });
    expect(w.body.workspace).not.toHaveProperty("plan_id");
    expect(w.body).not.toHaveProperty("plan");
    // `meet` is the server's own configuration (LiveKit), not a workspace setting: true here because tests run in development.
    // The AI switches default off at /setup; under TEST_FIXTURES=1 (test installations) they default on.
    expect(w.body.features).toEqual({
      chat: true,
      work: true,
      attendance: true,
      customWorkflow: true,
      aiAssistant: true,
      aiMonitoring: true,
      meet: true,
      insightsOnly: false,
      // What a deployment may leave out (DISABLED_FEATURES, ADR-0026): all on here.
      docs: true,
      whiteboards: true,
      calendar: true,
      time: true,
      ai: true,
    });
    const setup = (await call(null, "GET", "/setup")).body;
    expect(setup.setUp).toBe(true);
    expect(typeof setup.timezone).toBe("string"); // the web formats dates in it
    expect(setup.locale).toBe("en"); // the language for anyone without a personal choice
    expect(setup.meet).toBe(true);
  });

  it("refuses a second workspace: an installation holds exactly one", async () => {
    const r = await call(gateway, "POST", "/signup", { companyName: `Gamma ${run}`, ownerEmail: `gamma-${run}@gamma.example.com`, ownerName: "G", password: "Passw0rd!dev" });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("already_set_up");
  });

  it("only the gateway can call signup", async () => {
    expect((await call(a.owner, "POST", "/signup", { companyName: "X", ownerEmail: "x@x.com", ownerName: "X", password: "Passw0rd!dev" })).status).toBe(403);
  });

  it("validates signup input", async () => {
    expect((await call(gateway, "POST", "/signup", { companyName: "X", ownerEmail: "not-an-email", ownerName: "X", password: "short" })).status).toBe(400);
  });

  it("reads a stored config whose name is longer than the limit instead of failing", () => {
    const stored = defaultConfig("Công ty");
    stored.branding.displayName = "Đ".repeat(120);
    expect(readWorkspaceConfig(stored).branding.displayName).toHaveLength(80);
  });

  it("updates config with optimistic concurrency and audits it", async () => {
    const w = (await call(a.owner, "GET", "/workspace")).body;
    const config = { ...w.config, features: { ...w.config.features, attendance: false }, home: { sections: { ...w.config.home.sections, announcements: false } } };
    const ok = await call(a.owner, "PUT", "/workspace/config", { version: w.configVersion, config });
    expect(ok.status).toBe(200);
    expect(ok.body.version).toBe(w.configVersion + 1);
    const stale = await call(a.owner, "PUT", "/workspace/config", { version: w.configVersion, config });
    expect(stale.status).toBe(409);
    expect((await call(a.owner, "GET", "/workspace")).body.features.attendance).toBe(false);
  });

  it("rejects invalid config (bad code format)", async () => {
    const w = (await call(a.owner, "GET", "/workspace")).body;
    const bad = { ...w.config, codeFormats: { ...w.config.codeFormats, task: "task-{random}" } };
    expect((await call(a.owner, "PUT", "/workspace/config", { version: w.configVersion, config: bad })).status).toBe(400);
  });

  it("exposes the workspace's audit trail", async () => {
    const r = await call(a.owner, "GET", "/workspace/audit");
    expect(r.status).toBe(200);
    const actions = r.body.entries.map((e: { action: string }) => e.action);
    expect(actions).toContain("workspace.create");
    expect(actions).toContain("workspace.config_update");
  });

  it("employees cannot change config", async () => {
    const employee: Principal = { ...a.owner, id: "emp", grants: [{ permission: "workspace.read", scope: "WORKSPACE" }] };
    const w = (await call(employee, "GET", "/workspace")).body;
    expect((await call(employee, "PUT", "/workspace/config", { version: w.configVersion, config: w.config })).status).toBe(403);
  });
});

describe("webhooks", () => {
  it("delivers signed events to subscribed hooks once, and retries failures", async () => {
    const { createServer } = await import("node:http");
    const { createHmac } = await import("node:crypto");
    const { runWithContext, withTransaction } = await import("@workspace/shared");
    const { enqueueWebhookDeliveries, deliverDue, checkTarget, post } = await import("../../src/modules/platform/webhooks.js");
    const got: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];
    let failNext = 1;
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        got.push({ headers: req.headers, body });
        res.statusCode = failNext-- > 0 ? 500 : 200;
        res.end("ok");
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/hook`;
    try {
      expect((await call(a.owner, "POST", "/workspace/webhooks", { url, events: ["chat.message.created.v1"] })).status).toBe(400);
      const hook = (await call(a.owner, "POST", "/workspace/webhooks", { url, events: ["work.task.created.v1"], description: "ERP" })).body;
      expect(hook.secret).toMatch(/^whsec_/);
      // Webhook changes are audited and the audit can be filtered by kind and period.
      const hooksAudit = (await call(a.owner, "GET", "/workspace/audit?action=webhook.&limit=5")).body.entries as {
        action: string;
        resourceId: string;
        metadata: { url?: string };
      }[];
      expect(hooksAudit[0]).toMatchObject({ action: "webhook.create", resourceId: hook.id, metadata: { url } });
      expect(hooksAudit.every((e) => e.action.startsWith("webhook."))).toBe(true);
      expect((await call(a.owner, "GET", `/workspace/audit?from=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`)).body.entries).toEqual([]);
      expect((await call(a.owner, "GET", "/workspace/audit?action=DROP")).status).toBe(400);
      const employee = { ...a.owner, grants: [] };
      expect((await call(employee, "GET", "/workspace/webhooks")).status).toBe(403);
      // The ping goes through the normal path; the receiver fails the first attempt.
      const ping = (await call(a.owner, "POST", `/workspace/webhooks/${hook.id}/test`)).body;
      expect(ping).toMatchObject({ status: "pending", responseStatus: 500 });
      const e = {
        eventId: newId(),
        eventType: "work.task.created.v1",
        version: 1,
        aggregateType: "work.task",
        aggregateId: "t1",
        actorId: "user:x",
        occurredAt: new Date().toISOString(),
        payload: { taskId: "t1", title: "Gửi báo giá", text: "secret doc" },
      };
      for (const x of [e, e]) await runWithContext({ actorId: "test", requestId: newId() }, () => withTransaction(deps().pool, (c) => enqueueWebhookDeliveries(x as never, c)));
      await deliverDue(deps().pool, { allowPrivate: true }, 50);
      const task = got.filter((g) => g.headers["x-workspace-event"] === "work.task.created.v1");
      expect(task).toHaveLength(1); // once, despite the duplicate event
      const body = JSON.parse(task[0]!.body);
      expect(body).toMatchObject({ type: "work.task.created.v1", data: { title: "Gửi báo giá" } });
      expect(body).not.toHaveProperty("workspaceId");
      expect(body.data.text).toBeUndefined();
      const [tPart, vPart] = String(task[0]!.headers["x-workspace-signature"]).split(",");
      expect(vPart!.slice(3)).toBe(
        createHmac("sha256", hook.secret)
          .update(`${tPart!.slice(2)}.${task[0]!.body}`)
          .digest("hex"),
      );
      const log = (await call(a.owner, "GET", `/workspace/webhooks/${hook.id}/deliveries`)).body.deliveries;
      expect(log.find((d: { eventType: string }) => d.eventType === "webhook.ping")).toMatchObject({ status: "pending", attempts: 1 });
      // SSRF guard in production mode.
      expect(await checkTarget("http://example.com/x", { allowPrivate: false })).toBe("URL must use https");
      expect(await checkTarget("https://127.0.0.1/x", { allowPrivate: false })).toBe("URL resolves to a private address");
      for (const ip of ["0.0.0.0", "169.254.169.254", "224.0.0.1", "255.255.255.255"])
        expect(await checkTarget(`https://${ip}/x`, { allowPrivate: false })).toBe("URL resolves to a private address");
      // The connection resolves the name again and refuses a private answer too (DNS rebinding).
      await expect(post("https://localhost:9/x", {}, "{}", { allowPrivate: false })).rejects.toThrow("private address");
      expect(await checkTarget("https://user:pw@example.com/x", { allowPrivate: false })).toBe("URL must not contain credentials");
    } finally {
      server.close();
    }
  });
});

// These empty the installation first: setup only runs while there is no workspace. They come last, after every
// test that uses workspace A.
describe("first-run setup on an empty installation", () => {
  it("setup keeps the company's language and time zone, and refuses a zone it does not know", async () => {
    await resetTestDatabase();
    const email = `delta-${run}@delta.example.com`;
    const bad = await call(gateway, "POST", "/signup", { companyName: `Delta ${run}`, ownerEmail: email, ownerName: "D", password: "Passw0rd!dev", timezone: "Mars/Olympus" });
    expect(bad.status).toBe(400);
    const r = await call(gateway, "POST", "/signup", {
      companyName: `Delta ${run}`,
      ownerEmail: email,
      ownerName: "D",
      password: "Passw0rd!dev",
      locale: "en",
      timezone: "Europe/Berlin",
    });
    expect(r.status).toBe(201);
    const owner = await identity.request<Principal>("POST", "/internal/resolve", { userId: await iDeps.users.findUserByEmail(email) });
    const w = (await call(owner, "GET", "/workspace")).body;
    expect(w.config.locale).toBe("en");
    expect(w.config.timezone).toBe("Europe/Berlin");
  });

  it("refuses setup for an email that already has an account", async () => {
    await resetTestDatabase();
    // Before setup the other modules learn there is no workspace yet.
    const none = await call({ ...gateway, id: "gateway", grants: [{ permission: "principal.resolve", scope: "PLATFORM" }] }, "GET", "/internal/workspace");
    expect(none.status).toBe(404);
    expect(none.body.error).toBe("not_set_up");
    await iDeps.users.ensureUser(`minh-${run}@alpha.example.com`, "Minh Le", "Passw0rd!dev");
    const r = await call(gateway, "POST", "/signup", {
      companyName: `Gamma ${run}`,
      ownerEmail: `minh-${run}@alpha.example.com`,
      ownerName: "Someone Else",
      password: "Another1!pass",
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("email_exists");
  });

  it("keeps a long Vietnamese company name (up to 80 characters) readable everywhere", async () => {
    // A normal legal name; 61–80 characters must pass setup and every read of the workspace.
    const name = `Công ty TNHH Thương mại Dịch vụ Kỹ thuật Số Phương Nam ${run}`.padEnd(78, ".");
    expect(name.length).toBeGreaterThan(72);
    await resetTestDatabase();
    const long = await signup(name, `minh-${run}@long.example.com`);
    const w = await call(long.owner, "GET", "/workspace");
    expect(w.status).toBe(200);
    expect(w.body.config.branding.displayName).toBe(name);
    const internal = await call({ ...gateway, id: "identity", grants: [{ permission: "principal.resolve", scope: "PLATFORM" }] }, "GET", "/internal/workspace");
    expect(internal.status).toBe(200);
    expect(internal.body).toMatchObject({ name, status: "active", locale: "en" });
    expect(Object.keys(internal.body).sort()).toEqual(["features", "locale", "name", "status", "timezone"]);
    const rename = (displayName: string) =>
      call(long.owner, "PUT", "/workspace/config", { version: w.body.configVersion, config: { ...w.body.config, branding: { ...w.body.config.branding, displayName } } });
    expect((await rename("x".repeat(81))).status).toBe(400);
    expect((await rename("x".repeat(80))).status).toBe(200);
    expect(
      (await call(gateway, "POST", "/signup", { companyName: "x".repeat(81), ownerEmail: `minh-${run}@toolong.example.com`, ownerName: "Minh", password: "Passw0rd!dev" })).status,
    ).toBe(400);
  });
});
