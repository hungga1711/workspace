import { describe, expect, it } from "vitest";
import { agentOnBehalfOf, authorize, type Principal } from "./authz.js";

const user = (over: Partial<Principal> = {}): Principal => ({
  type: "user",
  id: "u1",
  teamIds: ["team1"],
  departmentId: "dep1",
  grants: [],
  ...over,
});

describe("authorize", () => {
  it("denies without the permission", () => {
    expect(authorize(user(), "task.read", {}).allowed).toBe(false);
  });

  it("SELF covers only own resources", () => {
    const p = user({ grants: [{ permission: "task.edit", scope: "SELF" }] });
    expect(authorize(p, "task.edit", { ownerId: "u1" }).allowed).toBe(true);
    expect(authorize(p, "task.edit", { ownerId: "u2" }).allowed).toBe(false);
  });

  it("TEAM covers resources of the principal's teams", () => {
    const p = user({ grants: [{ permission: "task.edit", scope: "TEAM" }] });
    expect(authorize(p, "task.edit", { teamId: "team1" }).allowed).toBe(true);
    expect(authorize(p, "task.edit", { teamId: "team2" }).allowed).toBe(false);
  });

  it("DEPARTMENT covers the principal's department", () => {
    const p = user({ grants: [{ permission: "employee.salary.read", scope: "DEPARTMENT" }] });
    expect(authorize(p, "employee.salary.read", { departmentId: "dep1" }).allowed).toBe(true);
    expect(authorize(p, "employee.salary.read", { departmentId: "dep2" }).allowed).toBe(false);
  });

  it("TEAM and DEPARTMENT never match a principal without a team or department", () => {
    const loner = user({
      teamIds: [],
      departmentId: null,
      grants: [
        { permission: "task.edit", scope: "TEAM" },
        { permission: "employee.salary.read", scope: "DEPARTMENT" },
      ],
    });
    expect(authorize(loner, "task.edit", { teamId: "team1" }).allowed).toBe(false);
    expect(authorize(loner, "employee.salary.read", { departmentId: "dep1" }).allowed).toBe(false);
    // A resource without a team (a project no one assigned to a team) is outside every TEAM grant.
    const manager = user({ grants: [{ permission: "task.edit", scope: "TEAM" }] });
    expect(authorize(manager, "task.edit", { teamId: null, ownerId: "u2" }).allowed).toBe(false);
  });

  it("any covering grant wins when several scopes are held", () => {
    const p = user({
      grants: [
        { permission: "task.edit", scope: "SELF" },
        { permission: "task.edit", scope: "TEAM" },
      ],
    });
    expect(authorize(p, "task.edit", { teamId: "team1", ownerId: "u9" }).allowed).toBe(true);
  });

  it("rejects malformed permission names", () => {
    expect(() => authorize(user(), "TASK READ", {})).toThrow();
  });
});

describe("agentOnBehalfOf", () => {
  const agent: Principal = {
    type: "agent",
    id: "agent:project",
    teamIds: [],
    departmentId: null,
    grants: [
      { permission: "task.read", scope: "WORKSPACE" },
      { permission: "task.create", scope: "WORKSPACE" },
      { permission: "employee.salary.read", scope: "WORKSPACE" },
    ],
  };

  it("cannot read salary when the asker cannot", () => {
    const asker = user({ grants: [{ permission: "task.read", scope: "TEAM" }] });
    const eff = agentOnBehalfOf(agent, asker);
    expect(authorize(eff, "employee.salary.read", { departmentId: "dep1" }).allowed).toBe(false);
  });

  it("takes the narrower of agent and asker scope", () => {
    const asker = user({ grants: [{ permission: "task.read", scope: "TEAM" }] });
    const eff = agentOnBehalfOf(agent, asker);
    expect(authorize(eff, "task.read", { teamId: "team1" }).allowed).toBe(true);
    expect(authorize(eff, "task.read", { teamId: "team2" }).allowed).toBe(false);
  });

  it("never gains a permission the agent lacks", () => {
    const asker = user({ grants: [{ permission: "project.delete", scope: "WORKSPACE" }] });
    expect(authorize(agentOnBehalfOf(agent, asker), "project.delete", {}).allowed).toBe(false);
  });
});
