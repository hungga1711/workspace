import type { Pool, PoolClient } from "pg";
import { appendToOutbox, getRequestContext, maybeRequestContext, newId, recordAudit, runWithContext, withTransaction, type Grant, type Principal } from "@workspace/shared";
import { DEFAULT_AGENTS, DEFAULT_ROLES, mergeGrants, PERMISSIONS } from "./catalog.js";
import type { EventPayloadInput, EventType } from "@workspace/contracts";

export class NotMemberError extends Error {
  constructor() {
    super("Not a member of this workspace");
    this.name = "NotMemberError";
  }
}
export class UnknownPermissionError extends Error {
  constructor(p: string) {
    super(`Unknown permission ${p}`);
    this.name = "UnknownPermissionError";
  }
}

/**
 * An identity admin or account action: the legacy per-module log (kept for its endpoint) and the audit trail
 * (ADR 0025, `identity.<action>`, through the outbox). `extra.label` overrides the readable target name looked up here.
 */
export async function audit(
  c: PoolClient,
  action: string,
  resource: string,
  resourceId: string,
  metadata: Record<string, unknown> = {},
  extra: { label?: string | null; changes?: Record<string, unknown> } = {},
) {
  const { actorId } = getRequestContext();
  await c.query("INSERT INTO audit_log (id, actor, action, resource, resource_id, source, metadata) VALUES ($1,$2,$3,$4,$5,'identity',$6)", [
    newId(),
    actorId,
    action,
    resource,
    resourceId,
    JSON.stringify(metadata),
  ]);
  const targetLabel = extra.label !== undefined ? extra.label : await auditLabel(c, resource, resourceId, metadata);
  await recordAudit(c, {
    action: `identity.${action}`,
    targetType: resource,
    targetId: resourceId,
    targetLabel,
    meta: metadata,
    ...(extra.changes ? { changes: extra.changes } : {}),
  });
}

/** The readable name of an audited identity object: a member's email, a role, team, agent or key's name. */
async function auditLabel(c: PoolClient, resource: string, id: string, meta: Record<string, unknown>): Promise<string | null> {
  for (const k of ["email", "name", "client"]) if (typeof meta[k] === "string" && meta[k]) return meta[k] as string;
  const sql: Record<string, string> = {
    member: "SELECT email AS label FROM members WHERE user_id = $1",
    role: "SELECT name AS label FROM roles WHERE id = $1",
    team: "SELECT name AS label FROM teams WHERE id = $1",
    agent: "SELECT name AS label FROM agents WHERE id = $1",
    api_key: "SELECT name AS label FROM api_keys WHERE id = $1",
  };
  const q = sql[resource];
  if (!q) return null;
  return (await c.query<{ label: string }>(q, [id])).rows[0]?.label ?? null;
}

/** Names of a member's roles, sorted (for "roles: Employee → Employee, Manager" in the audit trail). */
async function roleNames(c: PoolClient, userId: string): Promise<string[]> {
  return (await c.query<{ name: string }>("SELECT r.name FROM member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.user_id = $1 ORDER BY r.name", [userId])).rows.map(
    (r) => r.name,
  );
}

export async function emit<T extends EventType>(c: PoolClient, eventType: T, aggregateType: string, aggregateId: string, payload: EventPayloadInput<T>) {
  const { actorId } = getRequestContext();
  await appendToOutbox(c, {
    eventId: newId(),
    eventType,
    version: 1,
    aggregateType,
    aggregateId,
    actorId,
    occurredAt: new Date().toISOString(),
    payload,
  });
}

/** Runs fn in a transaction under the caller's request context, or as the identity module when there is none (jobs). */
export function inContext<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const ctx = maybeRequestContext() ?? { actorId: "service:identity", requestId: newId() };
  return runWithContext(ctx, () => withTransaction(pool, fn));
}

export function validateGrants(grants: Grant[]): void {
  for (const g of grants) {
    if (!(PERMISSIONS as readonly string[]).includes(g.permission)) throw new UnknownPermissionError(g.permission);
    if (g.scope === "PLATFORM") throw new UnknownPermissionError(`${g.permission} at PLATFORM scope`);
  }
}

async function insertRole(c: PoolClient, name: string, grants: Grant[], system: boolean): Promise<string> {
  const id = newId();
  await c.query("INSERT INTO roles (id, name, system) VALUES ($1,$2,$3)", [id, name, system]);
  for (const g of grants) {
    await c.query("INSERT INTO role_grants (role_id, permission, scope) VALUES ($1,$2,$3)", [id, g.permission, g.scope]);
  }
  return id;
}

export interface BootstrapInput {
  name?: string;
  owner: { userId: string; email: string; displayName: string };
}

/** Idempotent workspace bootstrap at first-run setup: system roles, owner membership, default agents. */
export async function bootstrapWorkspace(pool: Pool, input: BootstrapInput): Promise<void> {
  await inContext(pool, async (c) => {
    const existing = await c.query("SELECT 1 FROM roles LIMIT 1");
    if (existing.rowCount) return;
    await c.query("INSERT INTO workspace_settings (workspace_name) VALUES ($1)", [input.name ?? null]);
    const roleIds = new Map<string, string>();
    for (const r of DEFAULT_ROLES) roleIds.set(r.name, await insertRole(c, r.name, r.grants, true));
    await c.query("INSERT INTO members (user_id, email, display_name, status, is_owner) VALUES ($1,$2,$3,'active',true)", [
      input.owner.userId,
      input.owner.email,
      input.owner.displayName,
    ]);
    for (const name of ["Owner", "Employee"]) {
      await c.query("INSERT INTO member_roles (user_id, role_id) VALUES ($1,$2)", [input.owner.userId, roleIds.get(name)]);
    }
    for (const a of DEFAULT_AGENTS) {
      const id = newId();
      await c.query("INSERT INTO agents (id, name, owner_user_id, status, monthly_budget_tokens, allowed_tools, description) VALUES ($1,$2,$3,'active',2000000,$4,$5)", [
        id,
        a.name,
        input.owner.userId,
        a.tools,
        a.description,
      ]);
      for (const g of a.grants) {
        await c.query("INSERT INTO agent_grants (agent_id, permission, scope) VALUES ($1,$2,$3)", [id, g.permission, g.scope]);
      }
    }
    await audit(c, "workspace.bootstrap", "workspace", input.owner.userId, { owner: input.owner.email });
    await emit(c, "identity.member.joined.v1", "identity.member", input.owner.userId, {
      userId: input.owner.userId,
      email: input.owner.email,
      displayName: input.owner.displayName,
      owner: true,
    });
  });
}

/** Builds the principal for a member: merged role grants, teams, department. */
export async function resolvePrincipal(pool: Pool, userId: string): Promise<Principal> {
  return inContext(pool, async (c) => {
    const m = await c.query<{ status: string; department_id: string | null; email: string; display_name: string }>(
      "SELECT status, department_id, email, display_name FROM members WHERE user_id = $1",
      [userId],
    );
    const member = m.rows[0];
    if (!member || member.status === "disabled") throw new NotMemberError();
    await c.query("UPDATE members SET last_seen_at = now() WHERE user_id = $1 AND (last_seen_at IS NULL OR last_seen_at < now() - interval '5 minutes')", [userId]);
    if (member.status === "invited") {
      await c.query("UPDATE members SET status = 'active' WHERE user_id = $1", [userId]);
      await emit(c, "identity.member.joined.v1", "identity.member", userId, { userId, email: member.email, displayName: member.display_name });
    }
    const grants = await c.query<Grant>(
      `SELECT rg.permission, rg.scope FROM member_roles mr
         JOIN role_grants rg ON rg.role_id = mr.role_id
        WHERE mr.user_id = $1`,
      [userId],
    );
    const teams = await c.query<{ team_id: string }>("SELECT team_id FROM team_members WHERE user_id = $1", [userId]);
    return {
      type: "user",
      id: userId,
      departmentId: member.department_id,
      teamIds: teams.rows.map((t) => t.team_id),
      grants: mergeGrants(grants.rows),
    };
  });
}

export async function resolveAgent(pool: Pool, agentId: string): Promise<Principal & { name: string; budget: number; allowedTools: string[] }> {
  return inContext(pool, async (c) => {
    const a = await c.query<{ name: string; status: string; monthly_budget_tokens: string; allowed_tools: string[] }>(
      "SELECT name, status, monthly_budget_tokens, allowed_tools FROM agents WHERE id = $1",
      [agentId],
    );
    const agent = a.rows[0];
    if (!agent || agent.status !== "active") throw new NotMemberError();
    const grants = await c.query<Grant>("SELECT permission, scope FROM agent_grants WHERE agent_id = $1", [agentId]);
    return {
      type: "agent",
      id: agentId,
      teamIds: [],
      departmentId: null,
      grants: grants.rows,
      name: agent.name,
      budget: Number(agent.monthly_budget_tokens),
      allowedTools: agent.allowed_tools,
    };
  });
}

export interface InviteInput {
  userId: string;
  email: string;
  displayName: string;
  roleNames: string[];
}

/** Adds an invited member with the Employee base role plus the given roles. */
export async function inviteMember(c: PoolClient, input: InviteInput): Promise<void> {
  await c.query("INSERT INTO members (user_id, email, display_name, status) VALUES ($1,$2,$3,'invited')", [input.userId, input.email, input.displayName]);
  // Every member gets Employee as the base role; Manager/Admin/custom roles add rights on top.
  const roles = await c.query<{ id: string; name: string }>("SELECT id, name FROM roles WHERE name = ANY($1)", [[...new Set([...input.roleNames, "Employee"])]]);
  for (const r of roles.rows) {
    await c.query("INSERT INTO member_roles (user_id, role_id) VALUES ($1,$2)", [input.userId, r.id]);
  }
  await audit(c, "member.invite", "member", input.userId, { email: input.email, roles: roles.rows.map((r) => r.name) });
  await emit(c, "identity.member.invited.v1", "identity.member", input.userId, { userId: input.userId, email: input.email, displayName: input.displayName });
}

export async function cancelInvite(c: PoolClient, userId: string): Promise<boolean> {
  const r = await c.query("DELETE FROM members WHERE user_id = $1 AND status = 'invited'", [userId]);
  if (r.rowCount) await audit(c, "member.invite_cancel", "member", userId);
  return (r.rowCount ?? 0) > 0;
}

export async function createRole(c: PoolClient, name: string, grants: Grant[]): Promise<string> {
  validateGrants(grants);
  const id = await insertRole(c, name, grants, false);
  await audit(c, "role.create", "role", id, { name, grants });
  return id;
}

export class RoleStateError extends Error {
  constructor(readonly code: "not_found" | "system" | "assigned" | "name_taken" | "owner_role") {
    super(code);
    this.name = "RoleStateError";
  }
}

/**
 * Edits a role's name and/or grants. Built-in roles keep their names (code and the UI refer to them), and
 * Owner/Admin keep every permission: editing them could lock a workspace out of its own administration.
 */
export async function updateRole(c: PoolClient, roleId: string, input: { name?: string | undefined; grants?: Grant[] | undefined }): Promise<void> {
  const role = (await c.query<{ name: string; system: boolean }>("SELECT name, system FROM roles WHERE id = $1", [roleId])).rows[0];
  if (!role) throw new RoleStateError("not_found");
  if (role.system && (role.name === "Owner" || role.name === "Admin")) throw new RoleStateError("system");
  if (input.name !== undefined && input.name !== role.name && role.system) throw new RoleStateError("system");
  if (input.grants) {
    validateGrants(input.grants);
    await c.query("DELETE FROM role_grants WHERE role_id = $1", [roleId]);
    for (const g of mergeGrants(input.grants)) {
      await c.query("INSERT INTO role_grants (role_id, permission, scope) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [roleId, g.permission, g.scope]);
    }
  }
  if (input.name !== undefined && input.name !== role.name) {
    try {
      await c.query("UPDATE roles SET name = $2 WHERE id = $1", [roleId, input.name]);
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new RoleStateError("name_taken");
      throw e;
    }
  }
  await audit(c, "role.update", "role", roleId, { ...(input.name !== undefined ? { name: input.name } : {}), ...(input.grants ? { grants: input.grants } : {}) });
}

/**
 * Deletes a custom role. Members still holding it keep their other roles (everyone is an Employee); the
 * caller must say so explicitly (`force`) so a role is never silently taken away from people.
 */
export async function deleteRole(c: PoolClient, roleId: string, force: boolean): Promise<{ unassigned: string[] }> {
  const role = (await c.query<{ name: string; system: boolean }>("SELECT name, system FROM roles WHERE id = $1", [roleId])).rows[0];
  if (!role) throw new RoleStateError("not_found");
  if (role.system) throw new RoleStateError("system");
  const holders = (await c.query<{ user_id: string }>("SELECT user_id FROM member_roles WHERE role_id = $1", [roleId])).rows.map((r) => r.user_id);
  if (holders.length && !force) throw new RoleStateError("assigned");
  await c.query("DELETE FROM roles WHERE id = $1", [roleId]);
  for (const userId of holders) {
    const left = (await c.query<{ role_id: string }>("SELECT role_id FROM member_roles WHERE user_id = $1", [userId])).rows.map((r) => r.role_id);
    await emit(c, "identity.member.roles_changed.v1", "identity.member", userId, { userId, roleIds: left });
  }
  await audit(c, "role.delete", "role", roleId, { name: role.name, unassigned: holders.length });
  return { unassigned: holders };
}

export class TeamNotFoundError extends Error {
  constructor() {
    super("team not found");
    this.name = "TeamNotFoundError";
  }
}

/** Renames a team and/or replaces its members (the list is the whole membership, not a delta). */
export async function updateTeam(c: PoolClient, teamId: string, input: { name?: string | undefined; memberIds?: string[] | undefined }): Promise<void> {
  const team = (await c.query<{ name: string }>("SELECT name FROM teams WHERE id = $1", [teamId])).rows[0];
  if (!team) throw new TeamNotFoundError();
  if (input.name !== undefined && input.name !== team.name) await c.query("UPDATE teams SET name = $2 WHERE id = $1", [teamId, input.name]);
  if (input.memberIds) {
    await c.query("DELETE FROM team_members WHERE team_id = $1", [teamId]);
    for (const u of new Set(input.memberIds)) {
      await c.query("INSERT INTO team_members (team_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [teamId, u]);
    }
  }
  await audit(c, "team.update", "team", teamId, { ...(input.name !== undefined ? { name: input.name } : {}), ...(input.memberIds ? { members: input.memberIds.length } : {}) });
}

/** Deletes a team; the work module drops it from projects and tasks on the event (TEAM grants stop applying). */
export async function deleteTeam(c: PoolClient, teamId: string): Promise<void> {
  const r = await c.query<{ name: string }>("DELETE FROM teams WHERE id = $1 RETURNING name", [teamId]);
  const team = r.rows[0];
  if (!team) throw new TeamNotFoundError();
  await audit(c, "team.delete", "team", teamId, { name: team.name });
  await emit(c, "identity.team.deleted.v1", "identity.team", teamId, { teamId, name: team.name });
}

export async function setMemberRoles(c: PoolClient, userId: string, roleIds: string[]): Promise<void> {
  const owner = await c.query<{ is_owner: boolean }>("SELECT is_owner FROM members WHERE user_id = $1", [userId]);
  if (!owner.rows[0]) throw new NotMemberError();
  const known = await c.query<{ id: string; name: string; system: boolean }>("SELECT id, name, system FROM roles WHERE id = ANY($1)", [roleIds]);
  if (known.rowCount !== new Set(roleIds).size) throw new RoleStateError("not_found");
  // Ownership is the members.is_owner flag, which the Owner role follows; it is never handed out by assignment.
  if (!owner.rows[0].is_owner && known.rows.some((r) => r.system && r.name === "Owner")) throw new RoleStateError("owner_role");
  const rolesBefore = await roleNames(c, userId);
  await c.query("DELETE FROM member_roles WHERE user_id = $1", [userId]);
  for (const r of roleIds) await c.query("INSERT INTO member_roles (user_id, role_id) VALUES ($1,$2)", [userId, r]);
  // Everyone is an Employee first (chat, documents, own leave…); other roles add rights on top.
  await c.query(
    `INSERT INTO member_roles (user_id, role_id)
     SELECT $1, id FROM roles WHERE name = 'Employee' AND system ON CONFLICT DO NOTHING`,
    [userId],
  );
  if (owner.rows[0].is_owner) {
    // The owner must keep the Owner role; otherwise a workspace can lock itself out.
    await c.query(
      `INSERT INTO member_roles (user_id, role_id)
       SELECT $1, id FROM roles WHERE name = 'Owner' ON CONFLICT DO NOTHING`,
      [userId],
    );
  }
  const rolesAfter = await roleNames(c, userId);
  await audit(c, "member.roles_set", "member", userId, { roleIds }, { changes: { roles: { from: rolesBefore, to: rolesAfter } } });
  await emit(c, "identity.member.roles_changed.v1", "identity.member", userId, { userId, roleIds });
}

export class MemberStateError extends Error {
  constructor(readonly code: "not_found" | "owner" | "invited") {
    super(code);
    this.name = "MemberStateError";
  }
}

/**
 * Offboarding: a disabled member cannot open the workspace (resolve fails) and keeps authorship of everything they
 * wrote. Returns false when the member was already in the requested state.
 */
export async function setMemberEnabled(c: PoolClient, userId: string, enabled: boolean): Promise<boolean> {
  const m = (await c.query<{ status: string; is_owner: boolean; email: string }>("SELECT status, is_owner, email FROM members WHERE user_id = $1 FOR UPDATE", [userId])).rows[0];
  if (!m) throw new MemberStateError("not_found");
  if (m.status === "invited") throw new MemberStateError("invited");
  if (m.is_owner && !enabled) throw new MemberStateError("owner");
  if ((m.status === "active") === enabled) return false;
  await c.query("UPDATE members SET status = $2 WHERE user_id = $1", [userId, enabled ? "active" : "disabled"]);
  await audit(c, enabled ? "member.enabled" : "member.disabled", "member", userId, { email: m.email });
  await emit(c, enabled ? "identity.member.enabled.v1" : "identity.member.disabled.v1", "identity.member", userId, { userId });
  return true;
}
