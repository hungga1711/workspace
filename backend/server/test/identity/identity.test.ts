import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { INestApplication } from "@nestjs/common";
import { migrate, signInternalToken, PRINCIPAL_HEADER } from "@workspace/service-kit";
import { newId, type Principal } from "@workspace/shared";
import { createIdentityApp, depsFromEnv } from "../../src/modules/identity/app.js";
import { resetTestDatabase } from "../test-db.js";

const SECRET = "dev-internal-secret-change-me-32bytes!";
const service: Principal = {
  type: "service",
  id: "gateway",
  teamIds: [],
  departmentId: null,
  grants: [
    { permission: "workspace.provision", scope: "PLATFORM" },
    { permission: "principal.resolve", scope: "PLATFORM" },
  ],
};

let app: INestApplication;
let base: string;
const run = newId().toLowerCase().slice(-8);

async function call(principal: Principal | null, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (principal) headers[PRINCIPAL_HEADER] = await signInternalToken({ principal, requestId: newId() }, SECRET);
  const res = await fetch(`${base}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function resolve(userId: string): Promise<Principal> {
  const r = await call(service, "POST", "/internal/resolve", { userId });
  expect(r.status).toBe(201);
  return r.body as Principal;
}

let ownerA: Principal;
let deps: ReturnType<typeof depsFromEnv>;

beforeAll(async () => {
  await resetTestDatabase();
  await migrate("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test", fileURLToPath(new URL("../../migrations/identity", import.meta.url)), "identity");
  deps = depsFromEnv();
  app = await createIdentityApp(deps);
  await app.listen(0);
  base = await app.getUrl();
  base = base.replace("[::1]", "127.0.0.1");

  const r = await call(service, "POST", "/internal/workspace/bootstrap", {
    name: "Company A",
    owner: { email: `owner-a-${run}@example.com`, displayName: "Owner a", password: "Passw0rd!dev" },
  });
  expect(r.status).toBe(200);
  expect(typeof r.body.ownerUserId).toBe("string");
  ownerA = await resolve((await deps.users.findUserByEmail(`owner-a-${run}@example.com`))!);
});

afterAll(async () => {
  await app?.close();
});

describe("identity module", () => {
  it("bootstraps the owner with Owner grants", () => {
    expect(ownerA.grants).toContainEqual({ permission: "role.manage", scope: "WORKSPACE" });
    expect(ownerA.grants).toContainEqual({ permission: "workspace.configure", scope: "WORKSPACE" });
  });

  it("is idempotent on repeated bootstrap", async () => {
    const r = await call(service, "POST", "/internal/workspace/bootstrap", {
      name: "Company A",
      owner: { email: `owner-a-${run}@example.com`, displayName: "Owner a" },
    });
    expect(r.status).toBe(200);
    expect(typeof r.body.ownerUserId).toBe("string");
    const members = await call(ownerA, "GET", "/members");
    expect(members.body.members).toHaveLength(1);
  });

  it("rejects requests without a principal", async () => {
    expect((await call(null, "GET", "/members")).status).toBe(401);
  });

  it("rejects internal endpoints for user principals", async () => {
    expect((await call(ownerA, "POST", "/internal/resolve", { userId: ownerA.id })).status).toBe(403);
  });

  it("refuses to resolve an account that is not a member of the workspace", async () => {
    const stranger = await deps.users.ensureUser(`stranger-${run}@example.com`, "Người Lạ");
    expect((await call(service, "POST", "/internal/resolve", { userId: stranger })).status).toBe(403);
  });

  it("invites members without a seat limit, and cancels a pending invite", async () => {
    const first = await call(ownerA, "POST", "/members/invite", { email: `emp1-${run}@example.com`, displayName: "Lan Nguyen", password: "Passw0rd!dev" });
    expect(first.status).toBe(201);
    expect((await call(ownerA, "DELETE", `/members/${first.body.userId}/invite`)).status).toBe(204);
    for (const n of [2, 3, 4]) expect((await call(ownerA, "POST", "/members/invite", { email: `emp${n}-${run}@example.com`, displayName: `Người ${n}` })).status).toBe(201);
    // Pending invites are not active members yet: only the owner counts.
    expect((await call(ownerA, "GET", "/members")).body.counts).toEqual({ active: 1 });
  });

  it("gives invited employees Employee grants only, and activates on first resolve", async () => {
    const members = (await call(ownerA, "GET", "/members")).body.members as { userId: string; email: string; status: string }[];
    const huy = members.find((m) => m.email === `emp2-${run}@example.com`)!;
    expect(huy.status).toBe("invited");
    const p = await resolve(huy.userId);
    expect(p.grants).toContainEqual({ permission: "task.edit", scope: "SELF" });
    expect(p.grants.some((g) => g.permission === "employee.salary.read")).toBe(false);
    expect(p.grants.some((g) => g.permission === "role.manage")).toBe(false);
    const after = (await call(ownerA, "GET", "/members")).body.members as { email: string; status: string }[];
    expect(after.find((m) => m.email === `emp2-${run}@example.com`)!.status).toBe("active");
    // An employee cannot invite.
    expect((await call(p, "POST", "/members/invite", { email: `x-${run}@example.com`, displayName: "X" })).status).toBe(403);
  });

  it("rejects roles with unknown permissions", async () => {
    const r = await call(ownerA, "POST", "/roles", { name: "Bad", grants: [{ permission: "salary.steal", scope: "WORKSPACE" }] });
    expect(r.status).toBe(400);
  });

  it("keeps the Owner role on the owner when roles are replaced", async () => {
    const roles = (await call(ownerA, "GET", "/roles")).body.roles as { id: string; name: string }[];
    const employee = roles.find((r) => r.name === "Employee")!;
    expect((await call(ownerA, "PUT", `/members/${ownerA.id}/roles`, { roleIds: [employee.id] })).status).toBe(204);
    const again = await resolve(ownerA.id);
    expect(again.grants).toContainEqual({ permission: "role.manage", scope: "WORKSPACE" });
  });

  it("assigns only known roles, and never the Owner role to someone who is not the owner", async () => {
    const roles = (await call(ownerA, "GET", "/roles")).body.roles as { id: string; name: string }[];
    const owner = roles.find((r) => r.name === "Owner")!;
    const mate = (await call(ownerA, "POST", "/members/invite", { email: `roles-${run}@example.com`, displayName: "Roles" })).body;
    expect((await call(ownerA, "PUT", `/members/${mate.userId}/roles`, { roleIds: ["nope"] })).status).toBe(404);
    expect((await call(ownerA, "PUT", `/members/${mate.userId}/roles`, { roleIds: [owner.id] })).status).toBe(403);
    expect((await call(ownerA, "PUT", `/members/${ownerA.id}/roles`, { roleIds: [owner.id] })).status).toBe(204);
  });

  it("edits and deletes custom roles; built-in roles keep their names and Owner/Admin stay untouchable", async () => {
    const created = await call(ownerA, "POST", "/roles", { name: `Reviewer ${run}`, grants: [{ permission: "document.read", scope: "WORKSPACE" }] });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    expect((await call(ownerA, "PUT", `/roles/${id}`, { name: `Auditor ${run}`, grants: [{ permission: "audit.read", scope: "WORKSPACE" }] })).status).toBe(204);
    const roles = (await call(ownerA, "GET", "/roles")).body.roles as { id: string; name: string; system: boolean; grants: { permission: string }[] }[];
    expect(roles.find((r) => r.id === id)).toMatchObject({ name: `Auditor ${run}`, grants: [{ permission: "audit.read" }] });
    const owner = roles.find((r) => r.name === "Owner")!;
    const manager = roles.find((r) => r.name === "Manager")!;
    expect((await call(ownerA, "PUT", `/roles/${owner.id}`, { grants: [{ permission: "audit.read", scope: "WORKSPACE" }] })).status).toBe(403);
    expect((await call(ownerA, "PUT", `/roles/${manager.id}`, { name: "Boss" })).status).toBe(403);
    expect((await call(ownerA, "DELETE", `/roles/${manager.id}`)).status).toBe(403);
    // Assigned roles need an explicit force; the holder keeps Employee.
    const members = (await call(ownerA, "GET", "/members")).body.members as { userId: string; email: string }[];
    const holder = members.find((m) => m.email === `emp3-${run}@example.com`)!;
    expect((await call(ownerA, "PUT", `/members/${holder.userId}/roles`, { roleIds: [id] })).status).toBe(204);
    expect((await call(ownerA, "DELETE", `/roles/${id}`)).status).toBe(409);
    expect((await call(ownerA, "DELETE", `/roles/${id}?force=1`)).body).toEqual({ unassigned: [holder.userId] });
    const p = await resolve(holder.userId);
    expect(p.grants.some((g) => g.permission === "audit.read")).toBe(false);
    expect(p.grants).toContainEqual({ permission: "task.edit", scope: "SELF" });
  });

  it("renames teams, replaces their members and deletes them; principals follow", async () => {
    const members = (await call(ownerA, "GET", "/members")).body.members as { userId: string; email: string }[];
    const a = members.find((m) => m.email === `emp3-${run}@example.com`)!.userId;
    const b = members.find((m) => m.email === `emp4-${run}@example.com`)!.userId;
    const team = await call(ownerA, "POST", "/teams", { name: `Mobile ${run}`, memberIds: [a] });
    expect(team.status).toBe(201);
    expect((await resolve(a)).teamIds).toContain(team.body.id);
    expect((await call(ownerA, "PATCH", `/teams/${team.body.id}`, { name: `Platform ${run}`, memberIds: [b] })).status).toBe(204);
    const teams = (await call(ownerA, "GET", "/teams")).body.teams as { id: string; name: string; memberIds: string[] }[];
    expect(teams.find((t) => t.id === team.body.id)).toEqual({ id: team.body.id, name: `Platform ${run}`, memberIds: [b] });
    expect((await resolve(a)).teamIds).not.toContain(team.body.id);
    expect((await resolve(b)).teamIds).toContain(team.body.id);
    expect((await call(ownerA, "DELETE", `/teams/${team.body.id}`)).status).toBe(204);
    expect((await call(ownerA, "DELETE", `/teams/${team.body.id}`)).status).toBe(404);
    expect((await resolve(b)).teamIds).not.toContain(team.body.id);
  });

  it("resolves seeded agents as principals with their own grants", async () => {
    const agents = (await call(ownerA, "GET", "/agents")).body.agents as { id: string; name: string }[];
    const projectAgent = agents.find((a) => a.name === "Project Agent")!;
    const r = await call(service, "POST", "/internal/agents/resolve", { agentId: projectAgent.id });
    expect(r.status).toBe(201);
    expect(r.body.type).toBe("agent");
    expect(r.body.grants.some((g: { permission: string }) => g.permission === "project.delete")).toBe(false);
    expect((await call(service, "POST", "/internal/agents/resolve", { agentId: newId() })).status).toBe(404);
  });

  it("deletes an agent: it no longer resolves, and a second delete is a 404", async () => {
    const created = await call(ownerA, "POST", "/agents", { name: `Temp Agent ${run}`, budget: 0 });
    expect(created.status).toBe(201);
    expect((await call(service, "POST", "/internal/agents/resolve", { agentId: created.body.id })).status).toBe(201);
    expect((await call(ownerA, "DELETE", `/agents/${created.body.id}`)).status).toBe(204);
    expect((await call(service, "POST", "/internal/agents/resolve", { agentId: created.body.id })).status).toBe(404);
    expect((await call(ownerA, "DELETE", `/agents/${created.body.id}`)).status).toBe(404);
  });

  it("tells callers their own permissions, and which they hold for the whole company", async () => {
    const r = await call(ownerA, "GET", "/me/permissions");
    expect(r.status).toBe(200);
    expect(r.body.permissions).toContain("workspace.configure");
    expect(r.body.workspaceWide).toContain("workspace.configure");
  });

  it("records audit entries for admin actions", async () => {
    const r = await call(ownerA, "GET", "/audit");
    const actions = (r.body.entries as { action: string }[]).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["workspace.bootstrap", "member.invite", "member.roles_set"]));
  });
});
