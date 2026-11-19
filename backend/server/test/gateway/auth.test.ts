import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { INestApplication } from "@nestjs/common";
import { SignJWT } from "jose";
import { kv, migrate, ServiceClient } from "@workspace/service-kit";
import { newId } from "@workspace/shared";
import { http } from "@workspace/testkit";
import { createGateway } from "../../src/modules/gateway/gateway.js";
import { createIdentityApp, depsFromEnv as identityDeps } from "../../src/modules/identity/app.js";
import { createPlatformApp, depsFromEnv as platformDeps } from "../../src/modules/platform/app.js";
import { currentStep, hotp } from "../../src/modules/identity/auth/totp.js";
import { resetTestDatabase } from "../test-db.js";

/**
 * Own authentication end to end (identity + gateway, real Postgres): password sign-in,
 * lockout, access-token checks, refresh rotation and reuse, revocation, password change, two-step codes
 * and the workspace policy that requires them.
 */
const SECRET = "dev-internal-secret-change-me-32bytes!";
const PW = "Passw0rd!dev";
const run = newId().toLowerCase().slice(-8);
let identityApp: INestApplication;
let platformApp: INestApplication;
let server: ReturnType<ReturnType<typeof createGateway>["listen"]>;
let gw: string;
const iDeps = identityDeps();
const urlOf = async (a: INestApplication) => (await a.getUrl()).replace("[::1]", "127.0.0.1");

const login = (email: string, password = PW) => http(gw, "POST", "/api/auth/login", { body: { email, password } });
const refresh = (refreshToken: string) => http(gw, "POST", "/api/auth/refresh", { body: { refreshToken } });
const me = (token: string) => http(gw, "GET", "/api/me", { token });
const call = (token: string, method: string, path: string, body?: unknown) => http(gw, method, path, { token, ...(body === undefined ? {} : { body }) });

/** A fresh installation: emptied, then first-run setup (an installation holds one workspace). */
async function signup(tag: string): Promise<{ email: string }> {
  await resetTestDatabase();
  const email = `auth-${tag}-${run}@example.com`;
  const r = await http(gw, "POST", "/api/signup", { body: { companyName: `Auth ${tag} ${run}`, ownerEmail: email, ownerName: "Trần Minh", password: PW } });
  expect(r.status).toBe(201);
  return { email };
}

beforeAll(async () => {
  await migrate("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test", fileURLToPath(new URL("../../migrations/identity", import.meta.url)), "identity");
  await migrate("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test", fileURLToPath(new URL("../../migrations/platform", import.meta.url)), "platform");
  identityApp = await createIdentityApp(iDeps);
  await identityApp.listen(0);
  const identityUrl = await urlOf(identityApp);
  platformApp = await createPlatformApp({
    ...platformDeps(),
    identity: new ServiceClient(identityUrl, SECRET, "platform", [{ permission: "workspace.provision", scope: "PLATFORM" }]),
  });
  await platformApp.listen(0);
  const app = createGateway({
    jwksUrl: `${identityUrl}/internal/auth/jwks`,
    internalSecret: SECRET,
    identity: new ServiceClient(identityUrl, SECRET, "gateway", [
      { permission: "principal.resolve", scope: "PLATFORM" },
      { permission: "account.recover", scope: "PLATFORM" },
      { permission: "auth.session", scope: "PLATFORM" },
    ]),
    platform: new ServiceClient(await urlOf(platformApp), SECRET, "gateway", [
      { permission: "workspace.signup", scope: "PLATFORM" },
      { permission: "principal.resolve", scope: "PLATFORM" },
    ]),
    services: { identity: identityUrl, platform: await urlOf(platformApp) },
    rateLimit: { userPerMinute: 5000, signupPerIpPerHour: 100, recoveryPerIpPerHour: 1000 },
  });
  server = app.listen(0);
  gw = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  server?.close();
  await platformApp?.close();
  await identityApp?.close();
});

describe("password sign-in", () => {
  it("answers the same for a wrong password and an unknown email, after a real bcrypt comparison either way", async () => {
    const { email } = await signup("pw");
    const t0 = Date.now();
    const wrong = await login(email, "Wrong-pass-1");
    const known = Date.now() - t0;
    const t1 = Date.now();
    const unknown = await login(`nobody-${run}@example.com`, "Wrong-pass-1");
    const ghost = Date.now() - t1;
    expect([wrong.status, wrong.body.error]).toEqual([401, "invalid"]);
    expect([unknown.status, unknown.body.error]).toEqual([401, "invalid"]);
    // Both paths ran bcrypt (cost 12 ≈ 100–300 ms): the unknown email is not answered early.
    expect(ghost).toBeGreaterThan(known * 0.5);
    expect(ghost).toBeGreaterThan(50);
    const ok = await login(email);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ expiresIn: 600, user: { email } });
    expect(ok.body.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(ok.body)).not.toContain("password");
  });

  it("locks an email after five failures (known or not), and the right password waits too", async () => {
    const { email } = await signup("lock");
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await login(email, `Wrong-${i}-pass`)).status);
    expect(statuses.slice(0, 4)).toEqual([401, 401, 401, 401]);
    expect(statuses[4]).toBe(423);
    const right = await login(email);
    expect(right.status).toBe(423);
    expect(right.body.retryAfter).toBeGreaterThan(0);
    // An unknown email locks the same way, so locking never tells whether an account exists.
    const ghost = `ghost-${run}@example.com`;
    let last = 0;
    for (let i = 0; i < 5; i++) last = (await login(ghost, `Wrong-${i}-pass`)).status;
    expect(last).toBe(423);
    // The history records the failures for the admin's sign-in log.
    const n = (await iDeps.pool.query("SELECT count(*)::int AS n FROM auth_events WHERE email = $1 AND type = 'LOGIN_ERROR'", [email])).rows[0].n;
    expect(n).toBeGreaterThanOrEqual(5);
  });

  it("parallel guesses get no more tries than one after another", async () => {
    // Straight at the service, as the gateway calls it in process: every guess is in flight at once, and the
    // right password among the later ones must find the lock the earlier ones started.
    const { email } = await signup("burst");
    const guesses = [...Array.from({ length: 11 }, (_, i) => `Wrong-${i}-pass`), PW];
    const results = await Promise.all(guesses.map((g) => iDeps.auth.login(email, g, {})));
    expect(results.at(-1)).toMatchObject({ ok: false, error: "locked" });
    expect(results.filter((r) => "error" in r && r.error === "invalid").length).toBeLessThanOrEqual(4);
  });

  it("refuses passwords longer than bcrypt reads (72 bytes) instead of truncating them", async () => {
    const { email } = await signup("long");
    const r = await login(email, PW + "x".repeat(80));
    expect(r.status).toBe(401);
  });
});

describe("access tokens", () => {
  let token: string;
  beforeAll(async () => {
    const s = await signup("jwt");
    token = (await login(s.email)).body.accessToken;
  });

  it("accepts a valid token", async () => {
    expect((await me(token)).status).toBe(200);
    expect((await call(token, "GET", "/api/platform/workspace")).status).toBe(200);
  });

  it("refuses alg none, HS256 with the public key, a foreign key, a wrong kid, expiry, audience and a missing session", async () => {
    const [h, p] = token.split(".") as [string, string];
    const claims = JSON.parse(Buffer.from(p, "base64url").toString()) as Record<string, unknown>;
    const header = JSON.parse(Buffer.from(h, "base64url").toString()) as { kid: string };
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    // alg none
    expect((await me(`${enc({ alg: "none", typ: "at+jwt" })}.${p}.`)).status).toBe(401);
    // HS256 signed with the public JWK as the secret (algorithm confusion)
    const jwks = (await iDeps.keys.jwks()).keys;
    const hs = await new SignJWT(claims).setProtectedHeader({ alg: "HS256", kid: header.kid, typ: "at+jwt" }).sign(new TextEncoder().encode(JSON.stringify(jwks[0])));
    expect((await me(hs)).status).toBe(401);
    // a key we never published, with our kid and with an unknown kid
    const { privateKey } = generateKeyPairSync("ed25519");
    for (const kid of [header.kid, "not-a-real-kid"]) {
      const forged = await new SignJWT(claims).setProtectedHeader({ alg: "EdDSA", kid, typ: "at+jwt" }).sign(privateKey);
      expect((await me(forged)).status).toBe(401);
    }
    // our own key, but expired / for another audience / without a session id / with a changed subject
    const { kid, key } = await iDeps.keys.signer();
    const sign = (c: Record<string, unknown>) => new SignJWT(c).setProtectedHeader({ alg: "EdDSA", kid, typ: "at+jwt" }).sign(key);
    const now = Math.floor(Date.now() / 1000);
    expect((await me(await sign({ ...claims, iat: now - 1200, exp: now - 600 }))).status).toBe(401);
    expect((await me(await sign({ ...claims, aud: "someone-else" }))).status).toBe(401);
    const { sid: _sid, ...noSid } = claims;
    void _sid;
    expect((await me(await sign(noSid))).status).toBe(401);
    expect((await me(await sign({ ...claims, sub: newId() }))).body.error).toBe("session_revoked");
    // tampering with a valid token's payload breaks the signature
    expect((await me(`${h}.${enc({ ...claims, sub: newId() })}.${token.split(".")[2]}`)).status).toBe(401);
  });
});

describe("refresh, sign-out and revocation", () => {
  it("rotates the refresh token; reusing a spent one ends the whole session at once", async () => {
    const { email } = await signup("refresh");
    const first = (await login(email)).body;
    const second = await refresh(first.refreshToken);
    expect(second.status).toBe(200);
    expect(second.body.refreshToken).not.toBe(first.refreshToken);
    expect(second.body.sessionId).toBe(first.sessionId);
    expect((await me(second.body.accessToken)).status).toBe(200);
    // The spent token comes back (it was copied): refused, and the session family is gone.
    expect((await refresh(first.refreshToken)).status).toBe(401);
    expect((await refresh(second.body.refreshToken)).status).toBe(401);
    expect((await me(second.body.accessToken)).body.error).toBe("session_revoked");
    expect((await iDeps.pool.query("SELECT revoke_reason FROM auth_sessions WHERE id = $1", [first.sessionId])).rows[0].revoke_reason).toBe("refresh_reuse");
  });

  it("signing out ends the session: its access token stops working immediately, other sessions go on", async () => {
    const { email } = await signup("logout");
    const a = (await login(email)).body;
    const b = (await login(email)).body;
    expect((await http(gw, "POST", "/api/auth/logout", { body: { refreshToken: a.refreshToken } })).status).toBe(204);
    expect((await me(a.accessToken)).body.error).toBe("session_revoked");
    expect((await refresh(a.refreshToken)).status).toBe(401);
    expect((await me(b.accessToken)).status).toBe(200);
  });

  it("a password change signs out every other device; this one refreshes into the new account version", async () => {
    const { email } = await signup("pwchange");
    const here = (await login(email)).body;
    const there = (await login(email)).body;
    const r = await call(here.accessToken, "POST", "/api/identity/me/password", { current: PW, next: "N3w-passw0rd" });
    expect(r.status).toBe(204);
    expect((await me(there.accessToken)).body.error).toBe("session_revoked");
    expect((await refresh(there.refreshToken)).status).toBe(401);
    // This device: the old token predates the change, a refresh carries on.
    expect((await me(here.accessToken)).body.error).toBe("token_stale");
    const fresh = await refresh(here.refreshToken);
    expect(fresh.status).toBe(200);
    expect((await me(fresh.body.accessToken)).status).toBe(200);
    expect((await login(email)).status).toBe(401);
    expect((await login(email, "N3w-passw0rd")).status).toBe(200);
  });

  it("lists my sessions (this one marked) and signs out everywhere", async () => {
    const { email } = await signup("everywhere");
    const a = (await login(email)).body;
    await login(email);
    const list = await call(a.accessToken, "GET", "/api/identity/me/sessions");
    expect(list.body.sessions).toHaveLength(2);
    expect(list.body.sessions.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    expect(list.body.history.some((h: { type: string }) => h.type === "LOGIN")).toBe(true);
    // Someone else's session id cannot be ended through my account.
    const colleague = `auth-stranger-${run}@example.com`;
    await call(a.accessToken, "POST", "/api/identity/members/invite", { email: colleague, displayName: "Đồng Nghiệp", password: PW });
    const stranger = (await login(colleague)).body;
    expect((await call(a.accessToken, "DELETE", `/api/identity/me/sessions/${stranger.sessionId}`)).status).toBe(404);
    expect((await me(stranger.accessToken)).status).toBe(200);
    expect((await call(a.accessToken, "POST", "/api/identity/me/sessions/logout-all")).status).toBe(204);
    expect((await me(a.accessToken)).status).toBe(401);
  });
});

describe("two-step sign-in", () => {
  const code = (secret: string, offset = 0) => hotp(secret, currentStep() + offset);
  // The replay checks compare codes made at different moments: they hold only inside one 30-second step.
  const startOfAStep = async () => {
    const left = 30_000 - (Date.now() % 30_000);
    if (left < 15_000) await new Promise((r) => setTimeout(r, left + 100));
  };

  it("set-up, sign-in with a code, no replay, recovery codes once each, attempts limited", async () => {
    await startOfAStep();
    const { email } = await signup("totp");
    const s = (await login(email)).body;
    const setup = await call(s.accessToken, "POST", "/api/identity/me/mfa/setup");
    expect(setup.body.otpauthUrl).toContain("otpauth://totp/");
    const secret = setup.body.secret as string;
    expect((await call(s.accessToken, "POST", "/api/identity/me/mfa/enable", { code: "000000" === code(secret) ? "111111" : "000000" })).status).toBe(400);
    const on = await call(s.accessToken, "POST", "/api/identity/me/mfa/enable", { code: code(secret) });
    expect(on.status).toBe(200);
    const recovery = on.body.recoveryCodes as string[];
    expect(recovery).toHaveLength(10);
    // Secrets are stored encrypted, recovery codes hashed.
    const row = (await iDeps.pool.query("SELECT totp_secret_enc FROM users WHERE lower(email) = $1", [email])).rows[0];
    expect(row.totp_secret_enc).toMatch(/^v1\./);
    expect(row.totp_secret_enc).not.toContain(secret);

    // The password alone is no longer enough.
    const step1 = await login(email);
    expect(step1.body).toEqual({ mfa: true, challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    expect(step1.body.accessToken).toBeUndefined();
    expect((await http(gw, "POST", "/api/auth/mfa", { body: { challenge: step1.body.challenge, code: "12345" } })).body.error).toBe("invalid_code");
    // The code used to switch it on (this time step) cannot be replayed; the next step's code works once.
    expect((await http(gw, "POST", "/api/auth/mfa", { body: { challenge: step1.body.challenge, code: code(secret) } })).body.error).toBe("code_used");
    const ok = await http(gw, "POST", "/api/auth/mfa", { body: { challenge: step1.body.challenge, code: code(secret, 1) } });
    expect(ok.status).toBe(200);
    expect((await me(ok.body.accessToken)).status).toBe(200);
    // A spent challenge is spent.
    expect((await http(gw, "POST", "/api/auth/mfa", { body: { challenge: step1.body.challenge, code: code(secret, 1) } })).body.error).toBe("expired");
    const again = (await login(email)).body.challenge;
    expect((await http(gw, "POST", "/api/auth/mfa", { body: { challenge: again, code: code(secret, 1) } })).body.error).toBe("code_used");

    // Recovery codes: each works once.
    const viaRecovery = await http(gw, "POST", "/api/auth/mfa", { body: { challenge: again, code: recovery[0] } });
    expect(viaRecovery.status).toBe(200);
    const third = (await login(email)).body.challenge;
    expect((await http(gw, "POST", "/api/auth/mfa", { body: { challenge: third, code: recovery[0] } })).body.error).toBe("invalid_code");

    // Five wrong tries and the challenge is gone (a valid recovery code no longer helps).
    const fourth = (await login(email)).body.challenge;
    for (let i = 0; i < 5; i++) await http(gw, "POST", "/api/auth/mfa", { body: { challenge: fourth, code: "99999" + i } });
    expect((await http(gw, "POST", "/api/auth/mfa", { body: { challenge: fourth, code: recovery[1] } })).body.error).toBe("expired");
  });

  it("code guesses share the password lock: parallel ones over many challenges, and a right password does not reset it", async () => {
    const { email } = await signup("totpburst");
    const s = (await login(email)).body;
    const secret = (await call(s.accessToken, "POST", "/api/identity/me/mfa/setup")).body.secret as string;
    expect((await call(s.accessToken, "POST", "/api/identity/me/mfa/enable", { code: code(secret) })).status).toBe(200);
    const challenge = async () => {
      const r = await iDeps.auth.login(email, PW, {});
      if (!("mfa" in r)) throw new Error(`no challenge: ${JSON.stringify(r)}`);
      return r.challenge;
    };
    const challenges = await Promise.all(Array.from({ length: 5 }, challenge));
    // Twelve wrong codes over four challenges, all at once: every one counts, so the lock is on when they settle and
    // the right code on the fifth challenge is refused.
    const guesses = challenges.slice(0, 4).flatMap((ch, i) => [0, 1, 2].map((j) => [ch, String(100000 + i * 10 + j)] as const));
    const results = await Promise.all(guesses.map(([ch, c]) => iDeps.auth.verifyMfa(ch, c, {})));
    expect(results.every((r) => !r.ok)).toBe(true);
    expect((await iDeps.auth.verifyMfa(challenges[4]!, code(secret, 1), {})).ok).toBe(false);
    // Locked: a right password still gets a challenge, but no code is tried until the lock ends.
    expect((await iDeps.auth.login(email, PW, {})).ok).toBe(false);
  });

  it("a workspace that requires it lets a session in only after it is set up; the admin must use it first", async () => {
    const { email: ownerEmail } = await signup("policy");
    const owner = (await login(ownerEmail)).body;
    expect((await call(owner.accessToken, "PUT", "/api/identity/security/mfa-policy", { required: true })).body.error).toBe("enable_mfa_first");
    const setup = await call(owner.accessToken, "POST", "/api/identity/me/mfa/setup");
    await call(owner.accessToken, "POST", "/api/identity/me/mfa/enable", { code: code(setup.body.secret) });
    expect((await call(owner.accessToken, "PUT", "/api/identity/security/mfa-policy", { required: true })).body).toEqual({ required: true });
    // The owner's current session passed the code while enabling: it carries on.
    expect((await call(owner.accessToken, "GET", "/api/platform/workspace")).status).toBe(200);

    const staffEmail = `staff-policy-${run}@example.com`;
    await call(owner.accessToken, "POST", "/api/identity/members/invite", { email: staffEmail, displayName: "Nhân Viên", password: PW, temporary: true });
    // A password typed by the inviter is temporary: replacing it comes before everything, even the two-step gate.
    const temp = (await login(staffEmail)).body;
    expect((await call(temp.accessToken, "GET", "/api/platform/workspace")).body.error).toBe("password_change_required");
    expect((await call(temp.accessToken, "POST", "/api/identity/me/password", { current: PW, next: "Staff1ownpass" })).status).toBe(204);
    const staff = (await login(staffEmail, "Staff1ownpass")).body;
    expect((await call(staff.accessToken, "GET", "/api/platform/workspace")).body.error).toBe("mfa_setup_required");
    // Only setting it up is reachable.
    const s = await call(staff.accessToken, "POST", "/api/identity/me/mfa/setup");
    expect(s.status).toBe(200);
    await call(staff.accessToken, "POST", "/api/identity/me/mfa/enable", { code: code(s.body.secret) });
    expect((await call(staff.accessToken, "GET", "/api/platform/workspace")).status).toBe(200);
    // Required: it cannot be switched off.
    expect((await call(staff.accessToken, "POST", "/api/identity/me/mfa/disable", { code: code(s.body.secret, 1) })).body.error).toBe("required_by_workspace");
    // An employee cannot change the policy.
    expect((await call(staff.accessToken, "PUT", "/api/identity/security/mfa-policy", { required: false })).status).toBe(403);
  });

  it("a workspace that requires it refuses the personal keys of people who do not use it", async () => {
    const { email } = await signup("keys-mfa");
    const owner = (await login(email)).body;
    const key = (await call(owner.accessToken, "POST", "/api/identity/me/api-keys", { name: "Script", permissions: ["task.read"] })).body.key as string;
    expect((await http(gw, "GET", "/api/me", { token: key })).status).toBe(200);
    // Turned on behind the key's back (here directly; through the API the admin must already use it).
    await iDeps.pool.query("UPDATE workspace_settings SET require_mfa = true");
    kv().delPrefix("apikey:");
    expect((await http(gw, "GET", "/api/me", { token: key })).status).toBe(401);
  });
});
