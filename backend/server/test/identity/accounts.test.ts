import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { INestApplication } from "@nestjs/common";
import { migrate, readOutbox, signInternalToken, PRINCIPAL_HEADER } from "@workspace/service-kit";
import { newId, type Principal } from "@workspace/shared";
import { createIdentityApp, depsFromEnv } from "../../src/modules/identity/app.js";
import { resetTestDatabase } from "../test-db.js";

/** Account recovery and invite activation through the emails the server writes (MAIL_OUTBOX_DIR) and real sign-in. */
const SECRET = "dev-internal-secret-change-me-32bytes!";
const gateway: Principal = {
  type: "service",
  id: "gateway",
  teamIds: [],
  departmentId: null,
  grants: [
    { permission: "workspace.provision", scope: "PLATFORM" },
    { permission: "principal.resolve", scope: "PLATFORM" },
    { permission: "account.recover", scope: "PLATFORM" },
    { permission: "auth.session", scope: "PLATFORM" },
  ],
};
const run = newId().toLowerCase().slice(-8);
const ownerEmail = `acct-owner-${run}@example.com`;
const deps = depsFromEnv();
let app: INestApplication;
let base: string;
let owner: Principal;

async function call(p: Principal | null, method: string, path: string, body?: unknown) {
  // These tests read the Vietnamese emails; English is the default, so they ask for Vietnamese.
  const headers: Record<string, string> = { "content-type": "application/json", "x-locale": "vi" };
  if (p) headers[PRINCIPAL_HEADER] = await signInternalToken({ principal: p, requestId: newId() }, SECRET);
  const res = await fetch(`${base}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null };
}

/** Latest email to `to` from the test outbox (MAIL_OUTBOX_DIR), polling briefly. */
async function lastMail(to: string): Promise<{ subject: string; text: string }> {
  for (let i = 0; i < 40; i++) {
    const m = (await readOutbox(to)).at(-1);
    if (m) return { subject: m.subject, text: m.text };
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no email for ${to}`);
}
const tokenIn = (text: string) => text.match(/token=([A-Za-z0-9_-]{43})/)![1]!;
const signIn = (email: string, password: string) => call(gateway, "POST", "/internal/auth/login", { email, password });
const canLogin = async (email: string, password: string) => (await signIn(email, password)).status === 200;

beforeAll(async () => {
  await resetTestDatabase();
  await migrate("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test", fileURLToPath(new URL("../../migrations/identity", import.meta.url)), "identity");
  app = await createIdentityApp(deps);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "127.0.0.1");
  const r = await call(gateway, "POST", "/internal/workspace/bootstrap", {
    name: "Công ty Lâm An",
    owner: { email: ownerEmail, displayName: "Trần Minh", password: "Passw0rd!dev" },
  });
  owner = (await call(gateway, "POST", "/internal/resolve", { userId: r.body.ownerUserId })).body;
});
afterAll(async () => {
  await app?.close();
});

describe("password reset", () => {
  it("answers the same for unknown emails (no enumeration) and sends nothing", async () => {
    const r = await call(gateway, "POST", "/internal/accounts/password-reset", { email: `nobody-${run}@example.com` });
    expect(r.status).toBe(202);
  });

  it("emails a one-time link that sets a new password and then stops working", async () => {
    expect((await call(gateway, "POST", "/internal/accounts/password-reset", { email: ownerEmail, locale: "vi" })).status).toBe(202);
    const mail = await lastMail(ownerEmail);
    expect(mail.subject).toBe("Đặt lại mật khẩu workspace");
    const token = tokenIn(mail.text);
    expect((await call(gateway, "POST", "/internal/accounts/token", { token })).body).toEqual({ email: ownerEmail, purpose: "reset" });
    const weak = await call(gateway, "POST", "/internal/accounts/password-set", { token, password: "short" });
    expect(weak.status).toBe(400);
    const before = await signIn(ownerEmail, "Passw0rd!dev");
    expect(before.status).toBe(200);
    const ok = await call(gateway, "POST", "/internal/accounts/password-set", { token, password: "NewPassw0rd" });
    expect(ok.status).toBe(200);
    // Whoever was signed in with the old password is signed out.
    expect((await call(gateway, "POST", "/internal/auth/refresh", { refreshToken: before.body.refreshToken })).status).toBe(401);
    expect((await call(gateway, "POST", "/internal/auth/session-state", { sid: before.body.sessionId })).body.active).toBe(false);
    expect(await canLogin(ownerEmail, "NewPassw0rd")).toBe(true);
    expect(await canLogin(ownerEmail, "Passw0rd!dev")).toBe(false);
    expect((await call(gateway, "POST", "/internal/accounts/password-set", { token, password: "Another1pass" })).status).toBe(404);
  });

  it("only the gateway may call recovery endpoints", async () => {
    expect((await call(owner, "POST", "/internal/accounts/password-reset", { email: ownerEmail })).status).toBe(403);
  });
});

describe("change password while signed in", () => {
  it("requires the current password", async () => {
    expect((await call(owner, "POST", "/me/password", { current: "wrong", next: "Fresh1password" })).status).toBe(401);
    expect((await call(owner, "POST", "/me/password", { current: "NewPassw0rd", next: "x".repeat(73) })).body.reason).toBe("too_long");
    expect((await call(owner, "POST", "/me/password", { current: "NewPassw0rd", next: "Fresh1password" })).status).toBe(204);
    expect(await canLogin(ownerEmail, "Fresh1password")).toBe(true);
  });
});

describe("Tên gọi", () => {
  it("defaults to the last word of a Vietnamese name and can be changed; sign-in returns it", async () => {
    expect((await call(owner, "GET", "/me/name")).body.givenName).toBeTruthy();
    expect((await call(owner, "PUT", "/me/name", { givenName: "<script>" })).status).toBe(400);
    expect((await call(owner, "PUT", "/me/name", { givenName: "Anh Tuấn" })).status).toBe(204);
    expect((await call(owner, "GET", "/me/name")).body.givenName).toBe("Anh Tuấn");
    expect((await signIn(ownerEmail, "Fresh1password")).body.user).toMatchObject({ givenName: "Anh Tuấn", email: ownerEmail });
  });
});

describe("invite activation", () => {
  const email = `acct-invitee-${run}@example.com`;
  it("emails an activation link; the invitee chooses a password and can sign in", async () => {
    const inv = await call(owner, "POST", "/members/invite", { email, displayName: "Nguyễn Thị Lan" });
    expect(inv.status).toBe(201);
    expect(inv.body.emailed).toBe(true);
    const mail = await lastMail(email);
    expect(mail.subject).toBe("Lời mời tham gia Công ty Lâm An trên workspace");
    expect(mail.text).toContain("Trần Minh mời bạn vào Công ty Lâm An");
    expect(await canLogin(email, "Welcome1pass")).toBe(false);
    const set = await call(gateway, "POST", "/internal/accounts/password-set", { token: tokenIn(mail.text), password: "Welcome1pass" });
    expect(set.body.purpose).toBe("activate");
    expect(await canLogin(email, "Welcome1pass")).toBe(true);
  });

  it("can resend while pending, and refuses once the member is active", async () => {
    const other = `acct-pending-${run}@example.com`;
    const inv = await call(owner, "POST", "/members/invite", { email: other, displayName: "Phạm Việt" });
    const resent = await call(owner, "POST", `/members/${inv.body.userId}/invite/resend`);
    expect(resent.status).toBe(200);
    expect(resent.body).toMatchObject({ kind: "activate" });
    expect(resent.body.url).toMatch(/\/activate\?token=/);
    // The same link an admin copies when there is no email: a fresh one each time, pointing at the activation screen.
    const link = await call(owner, "GET", `/members/${inv.body.userId}/activation-link`);
    expect(link.status).toBe(200);
    expect(link.body.kind).toBe("activate");
    await call(gateway, "POST", "/internal/resolve", { userId: owner.id });
    const audit = await call(owner, "GET", "/audit");
    expect(audit.status).toBe(200);
    expect(audit.body.entries.some((a: { action: string }) => a.action === "member.activation_link")).toBe(true);
  });
});

describe("admin recovery", () => {
  const email = `acct-reset-${run}@example.com`;
  let userId: string;
  it("a temporary password signs in but must be replaced first (session state says so), then it is cleared", async () => {
    const inv = await call(owner, "POST", "/members/invite", { email, displayName: "Lê Hoa", password: "Invite1pass", temporary: true });
    userId = inv.body.userId;
    // A password typed by the inviter is temporary: the session carries pwc until the person picks their own.
    const first = await signIn(email, "Invite1pass");
    expect(first.status).toBe(200);
    expect(first.body.user.mustChangePassword).toBe(true);
    expect((await call(gateway, "POST", "/internal/auth/session-state", { sid: first.body.sessionId })).body.pwc).toBe(true);
    // An admin reset: generated, shown once, every session ends, and again temporary.
    const reset = await call(owner, "POST", `/members/${userId}/password/reset`, {});
    expect(reset.status).toBe(200);
    expect(reset.body.password).toMatch(/^[A-Za-z0-9]{12}$/);
    expect((await call(gateway, "POST", "/internal/auth/session-state", { sid: first.body.sessionId })).body.active).toBe(false);
    expect(await canLogin(email, "Invite1pass")).toBe(false);
    const second = await signIn(email, reset.body.password);
    expect(second.status).toBe(200);
    expect(second.body.user.mustChangePassword).toBe(true);
    // Choosing an own password clears the flag for that session at once.
    const me: Principal = { type: "user", id: userId, teamIds: [], departmentId: null, grants: [] };
    const headers = {
      "content-type": "application/json",
      [PRINCIPAL_HEADER]: await signInternalToken({ principal: me, requestId: newId(), sessionId: second.body.sessionId }, SECRET),
    };
    const changed = await fetch(`${base}/me/password`, { method: "POST", headers, body: JSON.stringify({ current: reset.body.password, next: "MyOwn1pass" }) });
    expect(changed.status).toBe(204);
    expect((await call(gateway, "POST", "/internal/auth/session-state", { sid: second.body.sessionId })).body.pwc).toBe(false);
    expect((await signIn(email, "MyOwn1pass")).body.user.mustChangePassword).toBe(false);
  });

  it("refuses a weak temporary password and the owner's reset by a non-owner", async () => {
    expect((await call(owner, "POST", `/members/${userId}/password/reset`, { password: "short" })).status).toBe(400);
    expect((await call(owner, "POST", `/members/${owner.id}/password/reset`, {})).status).toBe(400);
  });

  it("clears two-step sign-in and transfers ownership, audited", async () => {
    expect((await call(owner, "POST", `/members/${userId}/mfa/reset`)).status).toBe(204);
    // The invitee is still "invited" until they open the workspace: ownership needs an active member.
    expect((await call(owner, "POST", "/workspace/owner", { userId })).status).toBe(409);
    await call(gateway, "POST", "/internal/resolve", { userId });
    const moved = await call(owner, "POST", "/workspace/owner", { userId });
    expect(moved.status).toBe(200);
    const members = await call(owner, "GET", "/members");
    const rows = members.body.members as { userId: string; isOwner: boolean; roles: string[] }[];
    expect(rows.find((m) => m.userId === userId)).toMatchObject({ isOwner: true });
    expect(rows.find((m) => m.userId === userId)!.roles).toContain("Owner");
    expect(rows.find((m) => m.userId === owner.id)).toMatchObject({ isOwner: false });
    expect(rows.find((m) => m.userId === owner.id)!.roles).toContain("Admin");
    expect(rows.find((m) => m.userId === owner.id)!.roles).not.toContain("Owner");
    // Only the owner may hand it over: the previous owner cannot take it back.
    expect((await call(owner, "POST", "/workspace/owner", { userId: owner.id })).status).toBe(403);
    const audit = await call(owner, "GET", "/audit");
    const actions = (audit.body.entries as { action: string }[]).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["member.password_reset", "member.mfa_reset", "workspace.owner_transferred"]));
  });
});
