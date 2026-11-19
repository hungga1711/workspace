import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { INestApplication } from "@nestjs/common";
import { migrate, signInternalToken, PRINCIPAL_HEADER } from "@workspace/service-kit";
import { newId, type Principal } from "@workspace/shared";
import { createIdentityApp, depsFromEnv } from "../../src/modules/identity/app.js";
import { resetTestDatabase } from "../test-db.js";

/** Sessions and sign-in history (auth_sessions, auth_events), scoped to the workspace. */
const SECRET = "dev-internal-secret-change-me-32bytes!";
const gateway: Principal = {
  type: "service",
  id: "gateway",
  teamIds: [],
  departmentId: null,
  grants: [
    { permission: "workspace.provision", scope: "PLATFORM" },
    { permission: "principal.resolve", scope: "PLATFORM" },
    { permission: "auth.session", scope: "PLATFORM" },
  ],
};
const run = newId().toLowerCase().slice(-8);
const PW = "Passw0rd!dev";
const deps = depsFromEnv();
let app: INestApplication;
let base: string;

async function call(p: Principal | null, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (p) headers[PRINCIPAL_HEADER] = await signInternalToken({ principal: p, requestId: newId() }, SECRET);
  const res = await fetch(`${base}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null };
}
/** A fresh installation (emptied) set up with this owner: each test starts from its own workspace. */
async function workspace(name: string, email: string) {
  await resetTestDatabase();
  const r = await call(gateway, "POST", "/internal/workspace/bootstrap", { name, owner: { email, displayName: "Chủ", password: PW } });
  return (await call(gateway, "POST", "/internal/resolve", { userId: r.body.ownerUserId })).body as Principal;
}
/** A real password sign-in as the gateway forwards it, returning the tokens. */
async function signIn(email: string, password: string) {
  return call(gateway, "POST", "/internal/auth/login", { email, password, ip: "203.0.113.7" }) as Promise<{ status: number; body: { refreshToken?: string; sessionId?: string } }>;
}

beforeAll(async () => {
  await migrate("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test", fileURLToPath(new URL("../../migrations/identity", import.meta.url)), "identity");
  app = await createIdentityApp(deps);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "127.0.0.1");
});
afterAll(async () => {
  await app?.close();
});

describe("security", () => {
  it("lists my sessions and sign-ins, ends one, and signs out everywhere", async () => {
    const email = `sec-a-${run}@example.com`;
    const owner = await workspace("Sec A", email);
    expect((await signIn(email, PW)).status).toBe(200);
    expect((await signIn(email, PW)).status).toBe(200);
    let mine = (await call(owner, "GET", "/me/sessions")).body;
    expect(mine.sessions.length).toBeGreaterThanOrEqual(2);
    expect(mine.history.some((h: { type: string }) => h.type === "LOGIN")).toBe(true);
    expect((await call(owner, "DELETE", `/me/sessions/${mine.sessions[0].id}`)).status).toBe(204);
    expect((await call(owner, "DELETE", "/me/sessions/not-mine")).status).toBe(404);
    mine = (await call(owner, "GET", "/me/sessions")).body;
    expect((await call(owner, "POST", "/me/sessions/logout-all")).status).toBe(204);
    expect((await call(owner, "GET", "/me/sessions")).body.sessions).toEqual([]);
  });

  it("admins see only their members' sign-ins, including failures; they can sign a member out", async () => {
    const emailA = `sec-b-${run}@example.com`;
    const emailOther = `sec-c-${run}@example.com`;
    const owner = await workspace("Sec B", emailA);
    // An account that is not a member (a cancelled invite keeps its account).
    await deps.users.ensureUser(emailOther, "Người Ngoài", PW);
    await signIn(emailA, PW);
    expect((await signIn(emailA, "wrong-password")).status).toBe(401);
    await signIn(emailOther, PW);
    const log = (await call(owner, "GET", "/security/sign-ins")).body;
    const emails = new Set(log.signIns.map((s: { email: string }) => s.email));
    expect(emails.has(emailA)).toBe(true);
    expect(emails.has(emailOther)).toBe(false);
    expect(log.signIns.some((s: { type: string; email: string }) => s.type === "LOGIN_ERROR" && s.email === emailA)).toBe(true);
    expect(log.summary.failures24h).toBeGreaterThanOrEqual(1);
    const employee = { ...owner, grants: [] };
    expect((await call(employee, "GET", "/security/sign-ins")).status).toBe(403);
    expect((await call(owner, "POST", `/members/${owner.id}/sessions/logout`)).status).toBe(204);
    const admin = { ...owner, id: `admin-${run}` };
    expect((await call(admin, "POST", `/members/${owner.id}/sessions/logout`)).status).toBe(403);
    expect((await call(owner, "POST", `/members/not-a-member/sessions/logout`)).status).toBe(404);
  });

  it("offboarding: disabling blocks the workspace, signs out; enabling restores", async () => {
    const email = `sec-d-${run}@example.com`;
    const owner = await workspace("Sec D", email);
    const adminEmail = `sec-d-admin-${run}@example.com`;
    const leaverEmail = `sec-d-leaver-${run}@example.com`;
    const admin = (await call(owner, "POST", "/members/invite", { email: adminEmail, displayName: "Quản Trị", roleNames: ["Admin"], password: PW })).body.userId as string;
    const leaver = (await call(owner, "POST", "/members/invite", { email: leaverEmail, displayName: "Người Nghỉ", password: PW })).body.userId as string;
    const asAdmin = (await call(gateway, "POST", "/internal/resolve", { userId: admin })).body as Principal;
    expect((await call(gateway, "POST", "/internal/resolve", { userId: leaver })).status).toBe(201);
    expect((await signIn(leaverEmail, PW)).status).toBe(200);
    const invited = (await call(owner, "POST", "/members/invite", { email: `sec-d-pending-${run}@example.com`, displayName: "Chưa Nhận" })).body.userId as string;

    // Guards: not yourself, not the owner, not a pending invite, only admins.
    expect((await call(owner, "POST", `/members/${owner.id}/disable`)).status).toBe(400);
    expect((await call(asAdmin, "POST", `/members/${owner.id}/disable`)).body.error).toBe("owner_cannot_be_disabled");
    expect((await call(owner, "POST", `/members/${invited}/disable`)).status).toBe(409);
    expect((await call({ ...owner, id: leaver, grants: [] }, "POST", `/members/${admin}/disable`)).status).toBe(403);

    const activeBefore = (await call(owner, "GET", "/members")).body.counts.active as number;
    expect((await call(asAdmin, "POST", `/members/${leaver}/disable`)).status).toBe(204);
    expect((await call(asAdmin, "POST", `/members/${leaver}/disable`)).status).toBe(204); // idempotent
    const after = (await call(owner, "GET", "/members")).body;
    expect(after.members.find((m: { userId: string }) => m.userId === leaver).status).toBe("disabled");
    expect(after.counts.active).toBe(activeBefore - 1);
    expect((await call(gateway, "POST", "/internal/resolve", { userId: leaver })).status).toBe(403);
    expect((await call({ ...owner, id: leaver }, "GET", "/me/sessions")).body.sessions).toEqual([]); // signed out everywhere
    const audit = (await call(owner, "GET", "/audit?action=member.&limit=3")).body.entries as { action: string; resourceId: string }[];
    expect(audit[0]).toMatchObject({ action: "member.disabled", resourceId: leaver });
    expect(audit.every((e) => e.action.startsWith("member."))).toBe(true);
    const older = (await call(owner, "GET", `/audit?before=${encodeURIComponent(new Date(Date.now() - 3600_000).toISOString())}`)).body.entries;
    expect(older).toEqual([]); // this workspace is minutes old

    expect((await call(asAdmin, "POST", `/members/${leaver}/enable`)).status).toBe(204);
    expect((await call(gateway, "POST", "/internal/resolve", { userId: leaver })).status).toBe(201);
    expect((await call(owner, "GET", "/members")).body.counts.active).toBe(activeBefore);
  });

  it("bulk invite: per-row results and validation; invites never escalate roles", async () => {
    const email = `sec-e-${run}@example.com`;
    const owner = await workspace("Sec E", email);
    const e = (n: string) => `sec-e-${n}-${run}@example.com`;
    const out = (
      await call(owner, "POST", "/members/invite/bulk", {
        rows: [
          { email: e("a"), displayName: "Nguyễn An" },
          { email: e("a"), displayName: "Trùng Lặp" },
          { email: "khong-phai-email", displayName: "Sai" },
          { email: e("b"), displayName: "Lê Bình", roleName: "manager" },
          { email: e("c"), displayName: "" },
          { email, displayName: "Chủ" },
          { email: e("d"), displayName: "Trần Dũng", roleName: "Owner" },
          { email: e("f"), displayName: "Phạm Phúc", roleName: "admin" },
          { email: e("g"), displayName: "Hồ Giang" },
          { email: e("h"), displayName: "Vũ Hà" },
        ],
      })
    ).body;
    const by = Object.fromEntries(out.results.map((x: { email: string; status: string; error?: string }, i: number) => [i, x.error ?? x.status]));
    expect(by).toEqual({
      0: "invited",
      1: "duplicate_row",
      2: "invalid_email",
      3: "invited",
      4: "missing_name",
      5: "already_member",
      6: "role_not_allowed",
      7: "invited",
      8: "invited",
      9: "invited",
    });
    expect(out.invited).toBe(5);
    const members = (await call(owner, "GET", "/members")).body.members as { email: string; roles: string[] }[];
    expect(members.find((m) => m.email === e("b"))?.roles).toEqual(["Employee", "Manager"]); // role names match case-insensitively; Employee is always the base role

    // Someone who may invite but not manage roles can only invite Employees.
    const inviter = { ...owner, id: "inviter", grants: [{ permission: "member.invite", scope: "WORKSPACE" as const }] };
    expect((await call(inviter, "POST", "/members/invite", { email: e("x"), displayName: "X", roleNames: ["Admin"] })).body.error).toBe("role_not_allowed");
    expect((await call(owner, "POST", "/members/invite", { email: e("y"), displayName: "Y", roleNames: ["Owner"] })).status).toBe(403);
  });

  it("access review lists everyone with admin rights and last activity, and active API keys", async () => {
    const email = `sec-f-${run}@example.com`;
    const owner = await workspace("Sec F", email); // resolving the owner marks them active now
    const pending = (await call(owner, "POST", "/members/invite", { email: `sec-f-new-${run}@example.com`, displayName: "Mới Mời" })).body.userId as string;
    await call(owner, "POST", "/api-keys", { name: "ERP", permissions: ["member.read"] });
    expect((await call({ ...owner, grants: [] }, "GET", "/security/access-review")).status).toBe(403);
    const r = (await call(owner, "GET", "/security/access-review")).body;
    const me = r.members.find((m: { userId: string }) => m.userId === owner.id);
    expect(me).toMatchObject({ isOwner: true, admin: true });
    expect(Date.now() - Date.parse(me.lastSeenAt)).toBeLessThan(60_000);
    expect(r.members.find((m: { userId: string }) => m.userId === pending)).toMatchObject({ status: "invited", admin: false, lastSeenAt: null });
    expect(r.apiKeys.map((k: { name: string }) => k.name)).toContain("ERP");
    expect((await call(owner, "GET", "/security/sign-ins")).body.summary.activeUsers7d).toBe(1);
  });
});
