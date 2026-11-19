import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import type { INestApplication } from "@nestjs/common";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { migrate, PRINCIPAL_HEADER, ServiceClient, verifyInternalToken } from "@workspace/service-kit";
import { newId, type Principal } from "@workspace/shared";
import { http, passwordLogin } from "@workspace/testkit";
import { createGateway } from "../../src/modules/gateway/gateway.js";
import { createIdentityApp, depsFromEnv as identityDeps } from "../../src/modules/identity/app.js";
import { createPlatformApp, depsFromEnv as platformDeps } from "../../src/modules/platform/app.js";
import { resetTestDatabase } from "../test-db.js";

// OAuth 2.1 for remote MCP clients, end to end over the real gateway and identity: discovery from a 401, dynamic
// registration, consent as the signed-in person, code + PKCE, the token on /api/mcp (with the official SDK client),
// refresh rotation and replay, revocation, and the activity log. A stand-in work module answers the tools.

const SECRET = "dev-internal-secret-change-me-32bytes!";
const run = newId().toLowerCase().slice(-8);
let identityApp: INestApplication;
let platformApp: INestApplication;
let server: Server;
let work: Server;
let gw: string;
const seen: { method: string; path: string; principal: Principal }[] = [];
const urlOf = async (a: INestApplication) => (await a.getUrl()).replace("[::1]", "127.0.0.1");

const TASK = {
  id: "01JTASK0000000000000000001",
  code: "WEB-1",
  title: "Launch post",
  status: "todo",
  priority: "high",
  dueAt: null,
  assigneeId: null,
  projectId: null,
  progress: 0,
  atRisk: false,
  blockedReason: null,
  version: 3,
};

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => resolve(s ? JSON.parse(s) : undefined));
  });
}

const b64url = (b: Buffer) => b.toString("base64url");
const pkce = () => {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
};
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();

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
    await readBody(req);
    const { principal } = await verifyInternalToken(String(req.headers[PRINCIPAL_HEADER]), SECRET);
    seen.push({ method: req.method!, path: req.url!, principal });
    const json = (status: number, b: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(b));
    if (req.url!.startsWith("/tasks?") || req.url === "/tasks") return json(200, { tasks: [TASK], nextCursor: null });
    if (req.url === "/tasks/WEB-1" && req.method === "GET") return json(200, { task: TASK });
    if (req.url === `/tasks/${TASK.id}/comments` && req.method === "POST") return json(201, { id: "C1" });
    json(404, { error: "no route" });
  });
  await new Promise<void>((r) => work.listen(0, "127.0.0.1", r));
  const workUrl = `http://127.0.0.1:${(work.address() as { port: number }).port}`;
  server = createGateway({
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
    rateLimit: { userPerMinute: 1000, signupPerIpPerHour: 1000 },
    publicOrigins: ["https://app.example.com"],
  }).listen(0);
  gw = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  work?.close();
  server?.close();
  await platformApp?.close();
  await identityApp?.close();
});

const REDIRECT = "http://127.0.0.1:33418/callback";

describe("MCP OAuth", () => {
  let session: string;
  let ownerId: string;
  let clientId: string;
  let access: string;
  let refresh: string;

  it("a 401 from /api/mcp points to the metadata, which names the endpoints", async () => {
    await resetTestDatabase();
    const s = await http(gw, "POST", "/api/signup", { body: { companyName: `Oauth ${run}`, ownerEmail: `oauth-${run}@example.com`, ownerName: "Minh", password: "Passw0rd!dev" } });
    expect(s.status).toBe(201);
    ownerId = s.body.ownerUserId;
    session = (await passwordLogin(gw, `oauth-${run}@example.com`, "Passw0rd!dev")).accessToken;

    const r = await fetch(`${gw}/api/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(401);
    // A loopback address is this computer (development): the metadata names it as is.
    expect(r.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${gw}/.well-known/oauth-protected-resource/api/mcp"`);
    const prm = await (await fetch(`${gw}/.well-known/oauth-protected-resource/api/mcp`)).json();
    expect(prm).toMatchObject({ resource: `${gw}/api/mcp`, authorization_servers: [gw] });
    const as = await (await fetch(`${gw}/.well-known/oauth-authorization-server`)).json();
    expect(as).toMatchObject({
      issuer: gw,
      authorization_endpoint: "https://app.example.com/oauth/authorize",
      token_endpoint: `${gw}/oauth/token`,
      registration_endpoint: `${gw}/oauth/register`,
      code_challenge_methods_supported: ["S256"],
    });
    // A forged Host never becomes the issuer: unknown hosts get the configured app origin.
    const forged = await new Promise<{ issuer: string }>((resolve, reject) =>
      request(`${gw}/.well-known/oauth-authorization-server`, { headers: { host: "evil.example" } }, (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve(JSON.parse(b)));
      })
        .on("error", reject)
        .end(),
    );
    expect(forged.issuer).toBe("https://app.example.com");
    // The consent page lives in the web app.
    const auth = await fetch(`${gw}/oauth/authorize?client_id=x`, { redirect: "manual" });
    expect(auth.status).toBe(302);
    expect(auth.headers.get("location")).toBe("https://app.example.com/oauth/authorize?client_id=x");
  });

  it("registers clients (RFC 7591) and refuses unsafe redirect URIs", async () => {
    const bad = await fetch(`${gw}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["javascript:alert(1)"] }),
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("invalid_redirect_uri");
    const plainHttp = await fetch(`${gw}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }),
    });
    expect(plainHttp.status).toBe(400);
    const r = await fetch(`${gw}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Test Agent", redirect_uris: [REDIRECT, "cursor://anysphere.cursor-mcp/oauth/callback"], token_endpoint_auth_method: "none" }),
    });
    expect(r.status).toBe(201);
    const c = await r.json();
    expect(c.client_id).toMatch(/^woc_/);
    expect(c.client_secret).toBeUndefined();
    clientId = c.client_id;
  });

  it("the consent API shows the app, refuses a redirect it never registered, and issues a code bound to PKCE", async () => {
    expect((await http(gw, "GET", `/api/identity/oauth/clients/${clientId}?redirect_uri=${encodeURIComponent("https://evil.example/cb")}`, { token: session })).status).toBe(404);
    // Loopback redirects may use another port (RFC 8252).
    const info = await http(gw, "GET", `/api/identity/oauth/clients/${clientId}?redirect_uri=${encodeURIComponent("http://127.0.0.1:5555/callback")}`, { token: session });
    expect(info.status).toBe(200);
    expect(info.body.client).toMatchObject({ name: "Test Agent", redirectHost: "127.0.0.1:5555" });
    expect(info.body.presets.write).toContain("task.edit");
    expect(info.body.presets.read).not.toContain("task.edit");

    const { verifier, challenge } = pkce();
    const deny = await http(gw, "POST", "/api/identity/oauth/authorize", {
      token: session,
      body: { clientId, redirectUri: REDIRECT, codeChallenge: challenge, codeChallengeMethod: "S256", state: "s1", approve: false },
    });
    expect(deny.body.redirectTo).toBe(`${REDIRECT}?error=access_denied&error_description=The+person+declined.&state=s1`);

    const ok = await http(gw, "POST", "/api/identity/oauth/authorize", {
      token: session,
      body: {
        clientId,
        redirectUri: REDIRECT,
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
        state: "s2",
        permissions: ["task.read", "task.edit", "role.manage"],
        approve: true,
      },
    });
    expect(ok.status).toBe(200);
    const back = new URL(ok.body.redirectTo);
    expect(back.searchParams.get("state")).toBe("s2");
    const code = back.searchParams.get("code")!;

    const wrongVerifier = await fetch(`${gw}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({ grant_type: "authorization_code", code, code_verifier: pkce().verifier, redirect_uri: REDIRECT, client_id: clientId }),
    });
    expect(wrongVerifier.status).toBe(400);
    expect((await wrongVerifier.json()).error).toBe("invalid_grant");

    const t = await fetch(`${gw}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: clientId }),
    });
    expect(t.status).toBe(200);
    expect(t.headers.get("cache-control")).toBe("no-store");
    const tokens = await t.json();
    expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "mcp:read mcp:write" });
    access = tokens.access_token;
    refresh = tokens.refresh_token;
    expect(access).toMatch(/^woa_/);
  });

  it("the token works with the MCP SDK client, as the person, with only the approved permissions", async () => {
    const client = new Client({ name: "oauth-test", version: "1.0.0" });
    // The SDK's transport class is not assignable to its own Transport under exactOptionalPropertyTypes (same cast as src/modules/gateway/mcp.ts).
    const transport = new StreamableHTTPClientTransport(new URL(`${gw}/api/mcp`), { requestInit: { headers: { authorization: `Bearer ${access}` } } });
    await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("comment_on_task");
    const get = tools.tools.find((t) => t.name === "get_task")!;
    expect(get.annotations).toMatchObject({ readOnlyHint: true });
    const upd = tools.tools.find((t) => t.name === "update_task")!;
    expect(upd.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((p) => p.name)).toContain("daily_standup");
    const p = await client.getPrompt({ name: "project_status_report", arguments: { project: "WEB" } });
    expect(JSON.stringify(p.messages)).toContain("WEB");
    const templates = await client.listResourceTemplates();
    expect(templates.resourceTemplates.map((r) => r.uriTemplate)).toContain("workspace://tasks/{id}");

    seen.length = 0;
    const r = await client.callTool({ name: "comment_on_task", arguments: { id: "WEB-1", body: "Done from the agent" } });
    expect(r.isError).toBeFalsy();
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual(["GET /tasks/WEB-1", `POST /tasks/${TASK.id}/comments`]);
    expect(seen[0]!.principal).toMatchObject({ type: "user", id: ownerId });
    expect([...new Set(seen[0]!.principal.grants.map((g) => g.permission))].sort()).toEqual(["task.edit", "task.read"]);
    const res = await client.readResource({ uri: "workspace://tasks/WEB-1" });
    expect(res.contents[0]!.text).toContain("WEB-1");
    await client.close();
  });

  it("the token opens /api/mcp only", async () => {
    expect((await http(gw, "GET", "/api/me", { token: access })).status).toBe(403);
    expect((await http(gw, "GET", "/api/work/tasks", { token: access })).status).toBe(403);
  });

  it("logs each tool call (who, app, tool, result) for the admin and the person", async () => {
    // The log is written without waiting for it; give it a moment.
    await new Promise((r) => setTimeout(r, 300));
    const mine = await http(gw, "GET", "/api/identity/me/mcp/activity", { token: session });
    expect(mine.body.calls[0]).toMatchObject({ tool: "get_task", via: "oauth", clientName: "Test Agent", ok: true, userId: ownerId });
    const admin = await http(gw, "GET", "/api/identity/mcp/activity?days=7", { token: session });
    expect(admin.status).toBe(200);
    expect(admin.body.totals.calls).toBeGreaterThanOrEqual(2);
    expect(admin.body.byTool.map((x: { tool: string }) => x.tool)).toContain("comment_on_task");
    const grants = await http(gw, "GET", "/api/identity/oauth/grants", { token: session });
    expect(grants.body.grants[0]).toMatchObject({ clientName: "Test Agent", userId: ownerId, redirectHost: "127.0.0.1:33418" });
  });

  it("refresh tokens rotate; replaying a used one ends the connection", async () => {
    const r1 = await fetch(`${gw}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({ grant_type: "refresh_token", refresh_token: refresh, client_id: clientId }),
    });
    expect(r1.status).toBe(200);
    const t1 = await r1.json();
    expect(t1.refresh_token).not.toBe(refresh);
    const replay = await fetch(`${gw}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({ grant_type: "refresh_token", refresh_token: refresh, client_id: clientId }),
    });
    expect(replay.status).toBe(400);
    // Reuse revoked the whole grant: the newest tokens stop too.
    const after = await fetch(`${gw}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({ grant_type: "refresh_token", refresh_token: t1.refresh_token, client_id: clientId }),
    });
    expect(after.status).toBe(400);
    const r = await fetch(`${gw}/api/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${t1.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("the person disconnects an app and its token stops at once", async () => {
    const { verifier, challenge } = pkce();
    const ok = await http(gw, "POST", "/api/identity/oauth/authorize", {
      token: session,
      body: { clientId, redirectUri: REDIRECT, codeChallenge: challenge, codeChallengeMethod: "S256", permissions: ["task.read"], approve: true },
    });
    const code = new URL(ok.body.redirectTo).searchParams.get("code")!;
    const tokens = await (
      await fetch(`${gw}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: clientId }),
      })
    ).json();
    expect(tokens.scope).toBe("mcp:read");
    const list = async () =>
      fetch(`${gw}/api/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokens.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    expect((await list()).status).toBe(200);
    // A code works once.
    const again = await fetch(`${gw}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: clientId }),
    });
    expect(again.status).toBe(400);
    // …and replaying it ended the grant it made (RFC 6749 §4.1.2); identity drops the gateway's cached token at once.
    expect((await list()).status).toBe(401);
    expect((await http(gw, "GET", "/api/identity/me/oauth/grants", { token: session })).body.grants).toEqual([]);

    // Connect once more and disconnect from Hồ sơ › AI agent.
    const p2 = pkce();
    const ok2 = await http(gw, "POST", "/api/identity/oauth/authorize", {
      token: session,
      body: { clientId, redirectUri: REDIRECT, codeChallenge: p2.challenge, codeChallengeMethod: "S256", permissions: ["task.read"], approve: true },
    });
    const t2 = await (
      await fetch(`${gw}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form({
          grant_type: "authorization_code",
          code: new URL(ok2.body.redirectTo).searchParams.get("code")!,
          code_verifier: p2.verifier,
          redirect_uri: REDIRECT,
          client_id: clientId,
        }),
      })
    ).json();
    const call = () =>
      fetch(`${gw}/api/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${t2.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    expect((await call()).status).toBe(200);
    const g = (await http(gw, "GET", "/api/identity/me/oauth/grants", { token: session })).body.grants[0];
    expect((await http(gw, "DELETE", `/api/identity/me/oauth/grants/${g.id}`, { token: session })).status).toBe(204);
    expect((await call()).status).toBe(401);
  });

  it("a personal key cannot approve apps or list connections", async () => {
    const made = await http(gw, "POST", "/api/identity/me/api-keys", { token: session, body: { name: "k", permissions: ["task.read"] } });
    const r = await http(gw, "GET", "/api/identity/me/oauth/grants", { token: made.body.key });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("not_for_api_keys");
  });
});
