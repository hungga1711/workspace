/**
 * RBAC + permission + scope. Authentication (the identity module) proves who the principal is; this decides what it
 * may do. Every principal type, AI agents included, goes through the same check.
 *
 *   SELF < TEAM < DEPARTMENT < WORKSPACE < PLATFORM
 *
 * WORKSPACE covers the installation's one workspace; PLATFORM is for service principals (module-to-module calls).
 *
 * A grant {permission, scope} lets the principal act on resources inside that scope relative to itself. Agents act
 * for an asker: their effective grants are the intersection of the agent's own and the asker's, so an agent can
 * never see or do more than the person who asked.
 */
export const SCOPES = ["SELF", "TEAM", "DEPARTMENT", "WORKSPACE", "PLATFORM"] as const;
export type Scope = (typeof SCOPES)[number];

export type PrincipalType = "user" | "service" | "agent";

export interface Grant {
  permission: string;
  scope: Scope;
}

export interface Principal {
  type: PrincipalType;
  id: string;
  teamIds: readonly string[];
  departmentId: string | null;
  grants: readonly Grant[];
}

export interface Resource {
  ownerId?: string | null;
  teamId?: string | null;
  departmentId?: string | null;
}

export type Decision = { allowed: true; scope: Scope } | { allowed: false; reason: string };

const rank = (s: Scope): number => SCOPES.indexOf(s);

const PERMISSION = /^[a-z_]+(\.[a-z_]+)+$/;

function assertPermissionName(p: string): void {
  if (!PERMISSION.test(p)) throw new Error(`Invalid permission name: ${p}`);
}

/** Highest scope the principal holds for a permission, or null. */
function scopeFor(principal: Principal, permission: string): Scope | null {
  let best: Scope | null = null;
  for (const g of principal.grants) {
    if (g.permission !== permission) continue;
    if (best === null || rank(g.scope) > rank(best)) best = g.scope;
  }
  return best;
}

function scopeCovers(scope: Scope, principal: Principal, resource: Resource): boolean {
  switch (scope) {
    case "PLATFORM":
    case "WORKSPACE":
      return true;
    case "DEPARTMENT":
      return resource.departmentId != null && resource.departmentId === principal.departmentId;
    case "TEAM":
      return resource.teamId != null && principal.teamIds.includes(resource.teamId);
    case "SELF":
      return resource.ownerId != null && resource.ownerId === principal.id;
  }
}

export function authorize(principal: Principal, permission: string, resource: Resource = {}): Decision {
  assertPermissionName(permission);
  const scope = scopeFor(principal, permission);
  if (scope === null) return { allowed: false, reason: `missing permission ${permission}` };
  // Any covering grant allows, whatever its rank.
  for (const g of principal.grants) {
    if (g.permission === permission && scopeCovers(g.scope, principal, resource)) {
      return { allowed: true, scope: g.scope };
    }
  }
  return { allowed: false, reason: `scope ${scope} does not cover resource` };
}

/** Effective principal for an agent acting for an asker: grants intersect, the narrower scope wins. */
export function agentOnBehalfOf(agent: Principal, asker: Principal): Principal {
  if (agent.type !== "agent") throw new Error("agentOnBehalfOf requires an agent principal");
  const grants: Grant[] = [];
  for (const ag of agent.grants) {
    const askerScope = scopeFor(asker, ag.permission);
    if (askerScope === null) continue;
    grants.push({ permission: ag.permission, scope: rank(ag.scope) <= rank(askerScope) ? ag.scope : askerScope });
  }
  // The agent acts with the asker's identity for SELF/TEAM/DEPARTMENT resolution.
  return { ...asker, type: "agent", id: asker.id, grants };
}
