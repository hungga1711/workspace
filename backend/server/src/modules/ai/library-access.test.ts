import { describe, expect, it } from "vitest";
import type { Principal } from "@workspace/shared";
import { canDelete, canEdit, canManageAudience, canSee, manageScope, type PromptRow } from "./library-access.js";

const P = (id: string, departmentId: string | null, grants: Principal["grants"] = []): Principal => ({ type: "user", id, teamIds: [], departmentId, grants });
const admin = P("admin", "ops", [{ permission: "ai.policy.manage", scope: "WORKSPACE" }]);
const manager = P("mgr", "sales", [{ permission: "ai.prompt.manage", scope: "DEPARTMENT" }]);
const staff = P("staff", "sales");
const outsider = P("out", "kho");
const row = (r: Partial<PromptRow>): PromptRow => ({ level: "personal", visibility: "private", status: "live", author_id: "staff", department_id: "sales", audience: [], ...r });

describe("prompt library access", () => {
  it("gives company-wide management to AI admins and holders at WORKSPACE scope, department management to managers", () => {
    expect(manageScope(admin)).toBe("workspace");
    expect(manageScope(P("x", null, [{ permission: "ai.prompt.manage", scope: "WORKSPACE" }]))).toBe("workspace");
    expect(manageScope(manager)).toBe("department");
    expect(manageScope(P("x", null, [{ permission: "ai.prompt.manage", scope: "DEPARTMENT" }]))).toBeNull();
    expect(manageScope(staff)).toBeNull();
  });

  it("lets a department manager publish only for their own department", () => {
    expect(canManageAudience(manager, "department", ["sales"])).toBe(true);
    expect(canManageAudience(manager, "department", [])).toBe(false);
    expect(canManageAudience(manager, "department", ["sales", "kho"])).toBe(false);
    expect(canManageAudience(admin, "workspace", [])).toBe(true);
  });

  it("shows a live company prompt to its audience, a proposal only to its proposer and reviewers", () => {
    const forSales = row({ level: "company", audience: ["sales"], author_id: "admin" });
    expect(canSee(staff, null, forSales)).toBe(true);
    expect(canSee(outsider, null, forSales)).toBe(false);
    expect(canSee(admin, "workspace", forSales)).toBe(true);
    const proposal = row({ level: "company", status: "proposed", author_id: "staff", audience: ["sales"] });
    expect(canSee(staff, null, proposal)).toBe(true);
    expect(canSee(manager, "department", proposal)).toBe(true);
    expect(canSee(outsider, null, proposal)).toBe(false);
  });

  it("keeps personal prompts private, to the department, or open, as the author chose", () => {
    expect(canSee(outsider, null, row({}))).toBe(false);
    expect(canSee(P("other", "sales"), null, row({ visibility: "department" }))).toBe(true);
    expect(canSee(outsider, null, row({ visibility: "department" }))).toBe(false);
    expect(canSee(outsider, null, row({ visibility: "everyone" }))).toBe(true);
  });

  it("lets only the author edit a personal prompt; an AI admin may remove it", () => {
    const shared = row({ visibility: "everyone" });
    expect(canEdit(staff, null, shared)).toBe(true);
    expect(canEdit(admin, "workspace", shared)).toBe(false);
    expect(canDelete(admin, "workspace", shared)).toBe(true);
    expect(canDelete(outsider, null, shared)).toBe(false);
  });

  it("lets a proposer reword a waiting proposal but not a live company prompt", () => {
    expect(canEdit(staff, null, row({ level: "company", status: "proposed" }))).toBe(true);
    expect(canEdit(staff, null, row({ level: "company", status: "live" }))).toBe(false);
    expect(canEdit(manager, "department", row({ level: "company", audience: ["sales"] }))).toBe(true);
    expect(canEdit(manager, "department", row({ level: "company", audience: [] }))).toBe(false);
  });
});
