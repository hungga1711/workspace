import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { INestApplication } from "@nestjs/common";
import { migrate, signInternalToken, PRINCIPAL_HEADER } from "@workspace/service-kit";
import { newId, withTransaction, type Principal } from "@workspace/shared";
import { createIdentityApp, depsFromEnv } from "../../src/modules/identity/app.js";
import { imageMatches } from "../../src/modules/identity/profile.controller.js";
import { resetTestDatabase } from "../test-db.js";

/** Của tôi › Hồ sơ: one's own full name (with the event projections follow) and profile photo. */
const SECRET = "dev-internal-secret-change-me-32bytes!";
const gateway: Principal = {
  type: "service",
  id: "gateway",
  teamIds: [],
  departmentId: null,
  grants: [
    { permission: "workspace.provision", scope: "PLATFORM" },
    { permission: "principal.resolve", scope: "PLATFORM" },
  ],
};
const run = newId().toLowerCase().slice(-8);
const deps = depsFromEnv();
let app: INestApplication;
let base: string;
let owner: Principal;

async function call(p: Principal, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  headers[PRINCIPAL_HEADER] = await signInternalToken({ principal: p, requestId: newId() }, SECRET);
  const res = await fetch(`${base}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  const buf = Buffer.from(await res.arrayBuffer());
  const ct = res.headers.get("content-type") ?? "";
  return { status: res.status, headers: res.headers, body: ct.includes("json") && buf.length ? JSON.parse(buf.toString()) : buf };
}
const bootstrap = async (email: string) => {
  const r = await call(gateway, "POST", "/internal/workspace/bootstrap", { name: "Công ty Hồ Sơ", owner: { email, displayName: "Trần Minh", password: "Passw0rd!dev" } });
  return (await call(gateway, "POST", "/internal/resolve", { userId: r.body.ownerUserId })).body as Principal;
};

// A real 1×1 PNG, and the start of a WebP (RIFF….WEBP).
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

beforeAll(async () => {
  await resetTestDatabase();
  await migrate("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test", fileURLToPath(new URL("../../migrations/identity", import.meta.url)), "identity");
  app = await createIdentityApp(deps);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "127.0.0.1");
  owner = await bootstrap(`profile-owner-${run}@example.com`);
});
afterAll(async () => {
  await app?.close();
});

describe("full name", () => {
  it("renames the member, audits it and emits identity.member.renamed.v1 for the projections", async () => {
    const r = await call(owner, "PUT", "/me/display-name", { displayName: "  Trần   Minh Hưng " });
    expect(r.status).toBe(200);
    expect(r.body.displayName).toBe("Trần Minh Hưng");
    const summary = await call(owner, "GET", "/members/summary?limit=5");
    expect(summary.body.me.displayName).toBe("Trần Minh Hưng");
    const [event, auditRow] = await withTransaction(deps.pool, async (c) => [
      (await c.query("SELECT payload FROM outbox WHERE type = 'identity.member.renamed.v1' AND aggregateid = $1", [owner.id])).rows[0]?.payload,
      (await c.query("SELECT metadata FROM audit_log WHERE action = 'member.renamed' AND resource_id = $1", [owner.id])).rows[0]?.metadata,
    ]);
    expect((typeof event === "string" ? JSON.parse(event) : event).payload).toMatchObject({ userId: owner.id, displayName: "Trần Minh Hưng" });
    expect(auditRow).toMatchObject({ from: "Trần Minh", to: "Trần Minh Hưng" });
  });

  it("refuses markup, digits-only noise and empty names", async () => {
    for (const displayName of ["<b>Minh</b>", "", "   ", "x".repeat(101)]) expect((await call(owner, "PUT", "/me/display-name", { displayName })).status).toBe(400);
  });
});

describe("profile photo", () => {
  it("checks the file's own signature against the declared type", () => {
    expect(imageMatches("image/png", PNG)).toBe(true);
    expect(imageMatches("image/webp", PNG)).toBe(false);
    expect(imageMatches("image/jpeg", Buffer.from("<svg onload=alert(1)>"))).toBe(false);
    expect(imageMatches("image/webp", Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]))).toBe(true);
  });

  it("stores a photo, bumps the version the directory ships, serves it long-cached, and removes it", async () => {
    expect((await call(owner, "PUT", "/me/avatar", { contentType: "image/webp", data: PNG.toString("base64") })).status).toBe(400);
    expect((await call(owner, "PUT", "/me/avatar", { contentType: "image/png", data: Buffer.alloc(70_000).toString("base64") })).status).toBe(400);
    const set = await call(owner, "PUT", "/me/avatar", { contentType: "image/png", data: PNG.toString("base64") });
    expect(set.status).toBe(200);
    const v = set.body.avatarVersion as number;
    expect(v).toBeGreaterThan(0);
    expect((await call(owner, "GET", "/members/summary?limit=5")).body.me.avatarVersion).toBe(v);
    const img = await call(owner, "GET", `/members/${owner.id}/avatar?v=${v}`);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(img.headers.get("cache-control")).toContain("immutable");
    expect(img.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.compare(img.body as Buffer, PNG)).toBe(0);
    expect((await call(owner, "DELETE", "/me/avatar")).status).toBe(204);
    expect((await call(owner, "GET", `/members/${owner.id}/avatar?v=${v}`)).status).toBe(404);
    expect((await call(owner, "GET", "/members/summary?limit=5")).body.me.avatarVersion).toBe(0);
  });
});
