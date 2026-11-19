import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type { INestApplication } from "@nestjs/common";
import { migrate, ServiceClient } from "@workspace/service-kit";
import { newId } from "@workspace/shared";
import { http } from "@workspace/testkit";
import { createGateway, type GatewayConfig } from "../../src/modules/gateway/gateway.js";
import type { DemoConfig } from "../../src/modules/gateway/demo.js";
import { createIdentityApp, depsFromEnv as identityDeps } from "../../src/modules/identity/app.js";
import { createPlatformApp, depsFromEnv as platformDeps } from "../../src/modules/platform/app.js";
import { resetTestDatabase } from "../test-db.js";

// The demo gateway sits next to a normal one on the same identity and platform: the workspace is created through
// the normal one (signup is locked in the demo), then both are asked the same things.

const SECRET = "dev-internal-secret-change-me-32bytes!";
const run = newId().toLowerCase().slice(-8);
const OWNER = { email: `demo-${run}@example.com`, password: "Passw0rd!dev" };
const SEED_SECRET = `seed-${run}-secret`;
let identityApp: INestApplication;
let platformApp: INestApplication;
let servers: Server[] = [];
let normal: string;
let demo: string;
const urlOf = async (a: INestApplication) => (await a.getUrl()).replace("[::1]", "127.0.0.1");

beforeAll(async () => {
  await migrate("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test", fileURLToPath(new URL("../../migrations/identity", import.meta.url)), "identity");
  await migrate("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test", fileURLToPath(new URL("../../migrations/platform", import.meta.url)), "platform");
  identityApp = await createIdentityApp(identityDeps());
  await identityApp.listen(0);
  const identityUrl = await urlOf(identityApp);
  platformApp = await createPlatformApp({
    ...platformDeps(),
    identity: new ServiceClient(identityUrl, SECRET, "platform", [{ permission: "workspace.provision", scope: "PLATFORM" }]),
  });
  await platformApp.listen(0);
  const platformUrl = await urlOf(platformApp);
  const base = (demoCfg: DemoConfig | null): GatewayConfig => ({
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
    services: { identity: identityUrl, platform: platformUrl },
    rateLimit: { userPerMinute: 1000, signupPerIpPerHour: 4 },
    demo: demoCfg,
  });
  const listen = (cfg: GatewayConfig) => {
    const s = createGateway(cfg).listen(0);
    servers.push(s);
    return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
  };
  normal = listen(base(null));
  demo = listen(base({ accounts: { owner: OWNER, manager: OWNER, staff: OWNER }, perIpPerMinute: 10_000, seedSecret: SEED_SECRET }));
  await resetTestDatabase();
  const r = await http(normal, "POST", "/api/signup", { body: { companyName: `Demo ${run}`, ownerEmail: OWNER.email, ownerName: "Minh", password: OWNER.password } });
  expect(r.status).toBe(201);
});

afterAll(async () => {
  for (const s of servers) s.close();
  servers = [];
  await platformApp?.close();
  await identityApp?.close();
});

describe("demo mode", () => {
  it("quick sign-in exists only in the demo", async () => {
    const off = await http(normal, "POST", "/api/auth/demo", { body: { as: "owner" } });
    expect(off.status).toBe(404);
    const bad = await http(demo, "POST", "/api/auth/demo", { body: { as: "root" } });
    expect(bad.status).toBe(400);
    const on = await http(demo, "POST", "/api/auth/demo", { body: { as: "owner" } });
    expect(on.status).toBe(200);
    expect(typeof on.body.accessToken).toBe("string");
    const me = await http(demo, "GET", "/api/me", { token: on.body.accessToken });
    expect(me.status).toBe(200);
  });

  it("locks dangerous admin actions server-side, only in the demo", async () => {
    const token = (await http(demo, "POST", "/api/auth/demo", { body: { as: "owner" } })).body.accessToken as string;
    const locked = await http(demo, "POST", "/api/identity/api-keys", { token, body: { name: "x", permissions: ["task.read"] } });
    expect(locked.status).toBe(403);
    expect(locked.body.error).toBe("demo_locked");
    for (const path of ["/api/identity/API-KEYS", "/api/identity/api-keys/", "/api/identity/Workspace/Owner"]) {
      const r = await http(demo, "POST", path, { token, body: { name: "x", permissions: ["task.read"], userId: "x" } });
      expect(r.body?.error, path).toBe("demo_locked");
    }
    const open = await http(normal, "POST", "/api/identity/api-keys", { token, body: { name: "x", permissions: ["task.read"] } });
    expect(open.body?.error).not.toBe("demo_locked");
    // Reads stay open.
    const list = await http(demo, "GET", "/api/identity/api-keys", { token });
    expect(list.status).toBe(200);
  });

  it("refuses account recovery in the demo", async () => {
    const reset = await http(demo, "POST", "/api/auth/password-reset", { body: { email: OWNER.email } });
    expect(reset.status).toBe(403);
    expect(reset.body.error).toBe("demo_locked");
  });

  it("lets the seed through with its secret, nobody else", async () => {
    const token = (await http(demo, "POST", "/api/auth/demo", { body: { as: "owner" } })).body.accessToken as string;
    const wrong = await http(demo, "POST", "/api/identity/api-keys", {
      token,
      body: { name: "x", permissions: ["task.read"] },
      headers: { "x-demo-seed": "nope" },
    });
    expect(wrong.body.error).toBe("demo_locked");
    const seed = await http(demo, "POST", "/api/identity/api-keys", {
      token,
      body: { name: "x", permissions: ["task.read"] },
      headers: { "x-demo-seed": SEED_SECRET },
    });
    expect(seed.body?.error).not.toBe("demo_locked");
  });
});
