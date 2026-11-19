import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import type { INestApplication } from "@nestjs/common";
import { kv, migrate, ServiceClient } from "@workspace/service-kit";
import { newId } from "@workspace/shared";
import { http, passwordLogin } from "@workspace/testkit";
import { aiRouteFeature, createGateway, evictAfterChange, requiredFeature } from "../../src/modules/gateway/gateway.js";
import { createIdentityApp, depsFromEnv as identityDeps } from "../../src/modules/identity/app.js";
import { createPlatformApp, depsFromEnv as platformDeps } from "../../src/modules/platform/app.js";
import { resetTestDatabase } from "../test-db.js";
import { BFF_READ_HEADER, bffReadKey } from "../../src/modules/gateway/bff-read.js";

const SECRET = "dev-internal-secret-change-me-32bytes!";
const run = newId().toLowerCase().slice(-8);
let identityApp: INestApplication;
let platformApp: INestApplication;
let server: Server;
let echo: Server;
let gw: string;
let identityUrl = "";
let platformUrl = "";
const urlOf = async (a: INestApplication) => (await a.getUrl()).replace("[::1]", "127.0.0.1");

beforeAll(async () => {
  await resetTestDatabase();
  await migrate("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test", fileURLToPath(new URL("../../migrations/identity", import.meta.url)), "identity");
  await migrate("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test", fileURLToPath(new URL("../../migrations/platform", import.meta.url)), "platform");
  const iDeps = identityDeps();
  identityApp = await createIdentityApp(iDeps);
  await identityApp.listen(0);
  identityUrl = await urlOf(identityApp);
  platformApp = await createPlatformApp({
    ...platformDeps(),
    identity: new ServiceClient(identityUrl, SECRET, "platform", [{ permission: "workspace.provision", scope: "PLATFORM" }]),
  });
  await platformApp.listen(0);
  platformUrl = await urlOf(platformApp);
  // Stands in for the work module: answers with the headers the gateway sent.
  echo = createServer((req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ headers: req.headers })));
  await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
  const workUrl = `http://127.0.0.1:${(echo.address() as { port: number }).port}`;
  const app = createGateway({
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
    rateLimit: { userPerMinute: 1000, signupPerIpPerHour: 4 },
  });
  server = app.listen(0);
  gw = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  echo?.close();
  server?.close();
  await platformApp?.close();
  await identityApp?.close();
});

describe("gateway", () => {
  let tokenA: string;

  it("first-run setup → password sign-in → the installation's one workspace, with no selector", async () => {
    const a = await http(gw, "POST", "/api/signup", { body: { companyName: `Gw A ${run}`, ownerEmail: `gw-a-${run}@example.com`, ownerName: "Minh", password: "Passw0rd!dev" } });
    expect(a.status).toBe(201);
    // One installation, one workspace: a second setup is refused.
    const b = await http(gw, "POST", "/api/signup", { body: { companyName: `Gw B ${run}`, ownerEmail: `gw-b-${run}@example.com`, ownerName: "Lan", password: "Passw0rd!dev" } });
    expect(b.status).toBe(409);
    expect(b.body.error).toBe("already_set_up");
    tokenA = (await passwordLogin(gw, `gw-a-${run}@example.com`, "Passw0rd!dev")).accessToken;
    const me = await http(gw, "GET", "/api/me", { token: tokenA });
    expect(me.status).toBe(200);
    expect(me.body.principal).toMatchObject({ type: "user", id: a.body.ownerUserId });
    expect(Object.keys(me.body.principal).sort()).toEqual(["departmentId", "grants", "id", "teamIds", "type"]);
  });

  it("proxies to the owning service with the user's principal", async () => {
    const w = await http(gw, "GET", "/api/platform/workspace", { token: tokenA });
    expect(w.status).toBe(200);
    expect(w.body.workspace.name).toBe(`Gw A ${run}`);
  });

  it("gives every request an id: echoes a well-formed caller id, replaces a malformed one", async () => {
    const ok = await http(gw, "GET", "/api/platform/workspace", { token: tokenA, headers: { "x-request-id": "client-req-0001" } });
    expect(ok.headers.get("x-request-id")).toBe("client-req-0001");
    const bad = await http(gw, "GET", "/api/setup", { headers: { "x-request-id": "<script>" } });
    expect(bad.headers.get("x-request-id")).toMatch(/^[0-9A-Z]{26}$/);
  });

  it("puts the request id in every error body", async () => {
    const r = await http(gw, "GET", "/api/platform/workspace", { headers: { "x-request-id": "client-req-0002" } });
    expect(r.status).toBe(401);
    expect(r.body.requestId).toBe("client-req-0002");
    const unauth = await http(gw, "GET", "/api/me");
    expect(unauth.body.requestId).toBe(unauth.headers.get("x-request-id"));
  });

  it("rejects missing, forged and foreign tokens", async () => {
    expect((await http(gw, "GET", "/api/me")).status).toBe(401);
    const [h, p] = tokenA.split(".");
    expect((await http(gw, "GET", "/api/me", { token: `${h}.${p}.invalidsig` })).status).toBe(401);
    const forgedPayload = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p!, "base64url").toString()), sub: "someone-else" })).toString("base64url");
    expect((await http(gw, "GET", "/api/me", { token: `${h}.${forgedPayload}.${tokenA.split(".")[2]}` })).status).toBe(401);
  });

  it("ignores a workspace header from the client (the installation has one workspace)", async () => {
    const r = await http(gw, "GET", "/api/platform/workspace", { token: tokenA, headers: { "x-workspace-id": newId() } });
    expect(r.status).toBe(200);
    expect(r.body.workspace.name).toBe(`Gw A ${run}`);
  });

  it("counts the web app's page-render reads in their own bucket; a forged key or a write never gets it", async () => {
    const tight = createGateway({
      jwksUrl: `${identityUrl}/internal/auth/jwks`,
      internalSecret: SECRET,
      identity: new ServiceClient(identityUrl, SECRET, "gateway", [
        { permission: "principal.resolve", scope: "PLATFORM" },
        { permission: "auth.session", scope: "PLATFORM" },
      ]),
      platform: new ServiceClient(platformUrl, SECRET, "gateway", [{ permission: "principal.resolve", scope: "PLATFORM" }]),
      services: { identity: identityUrl, platform: platformUrl },
      rateLimit: { userPerMinute: 3, signupPerIpPerHour: 4, ssrReadsPerMinute: 8 },
    });
    const srv = tight.listen(0);
    try {
      const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
      // Earlier tests already spent part of this person's minute in the shared counters.
      const sub = JSON.parse(Buffer.from(tokenA.split(".")[1]!, "base64url").toString()).sub as string;
      kv().del(`rl:user:${sub}`, `rl:ssr:${sub}`);
      // The person's own bucket (3) runs out first.
      const own: number[] = [];
      for (let i = 0; i < 4; i++) own.push((await http(base, "GET", "/api/platform/workspace", { token: tokenA })).status);
      expect(own).toEqual([200, 200, 200, 429]);
      // A forged key is just another browser request: still limited.
      expect((await http(base, "GET", "/api/platform/workspace", { token: tokenA, headers: { [BFF_READ_HEADER]: bffReadKey("not-the-secret") } })).status).toBe(429);
      // The server's key opens the separate page-render bucket (8) for reads.
      const ssr: number[] = [];
      for (let i = 0; i < 9; i++) ssr.push((await http(base, "GET", "/api/platform/workspace", { token: tokenA, headers: { [BFF_READ_HEADER]: bffReadKey(SECRET) } })).status);
      expect(ssr.slice(0, 8).every((s) => s === 200)).toBe(true);
      expect(ssr[8]).toBe(429);
    } finally {
      srv.close();
    }
  });

  it("rate limits signups per IP", async () => {
    let last = 0;
    for (let i = 0; i < 4; i++) {
      last = (await http(gw, "POST", "/api/signup", { body: { companyName: "X", ownerEmail: "bad", ownerName: "X", password: "x" } })).status;
    }
    expect(last).toBe(429);
    // The web BFF forwards each visitor's IP; a different visitor is not blocked by someone else's attempts.
    const other = await http(gw, "POST", "/api/signup", {
      headers: { "x-forwarded-for": `203.0.113.${Date.now() % 250}` },
      body: { companyName: "X", ownerEmail: "bad", ownerName: "X", password: "x" },
    });
    expect(other.status).toBe(400);
  });

  it("caps reset emails per address without revealing it", async () => {
    const email = `cap-${run}@example.com`;
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await http(gw, "POST", "/api/auth/password-reset", { headers: { "x-forwarded-for": `198.51.100.${i}` }, body: { email } })).status);
    expect(codes.every((c) => c === 202)).toBe(true);
    expect(Number(kv().get(`rl:recover:email:${email}`))).toBeGreaterThan(5);
  });

  it("API keys act as a scoped service principal of one workspace, and revocation sticks", async () => {
    const made = await http(gw, "POST", "/api/identity/api-keys", { token: tokenA, body: { name: "ERP sync", permissions: ["member.read"] } });
    expect(made.status).toBe(201);
    const key = made.body.key as string;
    expect(key).toMatch(/^wos_[0-9a-f]{8}_/);
    // Never more than the creator, never admin powers.
    expect((await http(gw, "POST", "/api/identity/api-keys", { token: tokenA, body: { name: "x", permissions: ["role.manage"] } })).status).toBe(400);
    const members = await http(gw, "GET", "/api/identity/members", { token: key });
    expect(members.status).toBe(200);
    expect((await http(gw, "GET", "/api/identity/api-keys", { token: key })).status).toBe(403);
    expect((await http(gw, "GET", "/api/identity/members", { token: "wos_00000000_" + "A".repeat(32) })).status).toBe(401);
    const list = (await http(gw, "GET", "/api/identity/api-keys", { token: tokenA })).body.keys;
    expect(list.find((k: { id: string }) => k.id === made.body.id)).toMatchObject({ name: "ERP sync", permissions: ["member.read"] });
    expect(JSON.stringify(list)).not.toContain(key);
    expect((await http(gw, "DELETE", `/api/identity/api-keys/${made.body.id}`, { token: tokenA })).status).toBe(204);
    kv().del(`apikey:${createHash("sha256").update(key).digest("hex")}`);
    expect((await http(gw, "GET", "/api/identity/members", { token: key })).status).toBe(401);
  });

  it("returns 404 for unknown services", async () => {
    expect((await http(gw, "GET", "/api/nope/x", { token: tokenA })).status).toBe(404);
  });

  it("member/role changes drop the cached principals; a config change drops the workspace state", async () => {
    const cache = kv();
    cache.set("principal:u1", "{}", { ttlMs: 60_000 });
    cache.set("principal:u2", "{}", { ttlMs: 60_000 });
    cache.set("workspace-state", "{}", { ttlMs: 30_000 });
    // A work-module write leaves them alone.
    evictAfterChange("work", "/members/u1");
    expect(cache.get("principal:u1")).toBe("{}");
    evictAfterChange("identity", "/members/u1/disable");
    expect(cache.mget(["principal:u1", "principal:u2"])).toEqual([null, null]);
    // A workspace config change (modules switched on or off) applies at once.
    expect(cache.get("workspace-state")).toBe("{}");
    evictAfterChange("platform", "/workspace/config");
    expect(cache.get("workspace-state")).toBeNull();
  });

  it("never forwards a meeting length limit sent by the browser", async () => {
    const r = await http(gw, "GET", "/api/work/meet/rooms", { token: tokenA, headers: { "x-meet-cap-minutes": "600" } });
    expect(r.body.headers["x-meet-cap-minutes"]).toBeUndefined();
  });

  it("never forwards module-to-module endpoints, however the path is spelled", async () => {
    for (const path of ["/api/work/internal/meet/abc", "/api/work/Internal/meet/abc", "/api/work/internal%2Fmeet%2Fabc", "/api/work//internal/"])
      expect((await http(gw, "GET", path, { token: tokenA })).status, path).toBe(404);
  });

  it("a feature left out at deploy time (DISABLED_FEATURES) answers 404 for reads and writes; tasks stay", async () => {
    expect((await http(gw, "GET", "/api/work/whiteboards", { token: tokenA })).status).toBe(200);
    process.env.DISABLED_FEATURES = "whiteboards, calendar";
    try {
      for (const [method, path] of [
        ["GET", "/api/work/whiteboards"],
        ["POST", "/api/work/whiteboards"],
        ["GET", "/api/work/Whiteboards/abc/"],
        ["GET", "/api/work/calendar/events"],
      ] as const) {
        const r = await http(gw, method, path, { token: tokenA, ...(method === "POST" ? { body: {} } : {}) });
        expect(r.status, `${method} ${path}`).toBe(404);
        expect(r.body.error).toBe("feature_off");
      }
      expect((await http(gw, "GET", "/api/work/tasks", { token: tokenA })).status).toBe(200);
      expect((await http(gw, "GET", "/api/work/docs", { token: tokenA })).status).toBe(200);
    } finally {
      delete process.env.DISABLED_FEATURES;
    }
  });

  it("writes to a module the admin switched off are refused at the gateway; reads stay open", () => {
    expect(requiredFeature("POST", "employee", "/attendance/check-in")).toBe("attendance");
    // AI routes need the matching switch; status and the monitoring purge always answer.
    expect(aiRouteFeature("/status")).toBeNull();
    expect(aiRouteFeature("/monitor/data")).toBeNull();
    // A person's computer (workspace-connect.mjs) serves both sides; the ai module answers each part by its own switch.
    expect(aiRouteFeature("/local/connect/heartbeat")).toBeNull();
    expect(aiRouteFeature("/local/guard")).toBeNull();
    expect(aiRouteFeature("/local-usage")).toBe("aiAssistant");
    expect(aiRouteFeature("/oversight?days=7")).toBe("aiMonitoring");
    expect(aiRouteFeature("/oversight/me")).toBe("aiMonitoring");
    expect(aiRouteFeature("/policy")).toBe("aiMonitoring");
    expect(aiRouteFeature("/monitor/connection")).toBe("aiMonitoring");
    expect(aiRouteFeature("/insights/library?q=x")).toBe("aiMonitoring");
    expect(aiRouteFeature("/insights/report")).toBe("aiMonitoring");
    expect(aiRouteFeature("/ask")).toBe("aiAssistant");
    expect(aiRouteFeature("/connections")).toBe("aiAssistant");
    expect(aiRouteFeature("/assistant/conversations")).toBe("aiAssistant");
    expect(requiredFeature("PUT", "employee", "/attendance/u1/2026-10-01")).toBe("attendance");
    expect(requiredFeature("GET", "employee", "/attendance?month=2026-10")).toBeNull();
    expect(requiredFeature("POST", "identity", "/agents")).toBeNull();
    expect(requiredFeature("POST", "employee", "/leave")).toBeNull();
    expect(requiredFeature("POST", "work", "/meet/rooms/abc-defg-hij/recording")).toBeNull();
    expect(requiredFeature("POST", "work", "/meet/rooms")).toBeNull();
    // Other spellings of the same route (modules route case-insensitively, the gateway forwards decoded paths).
    expect(requiredFeature("POST", "employee", "/Attendance/check-in")).toBe("attendance");
    expect(aiRouteFeature("/Oversight/")).toBe("aiMonitoring");
    expect(aiRouteFeature("/insights%2Freport")).toBe("aiMonitoring");
  });
});
