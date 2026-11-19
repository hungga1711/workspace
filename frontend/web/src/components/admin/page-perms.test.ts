import { describe, expect, it } from "vitest";
import { canOpen, permTokens } from "./page-perms";

describe("canOpen", () => {
  const manager = new Set(permTokens({ permissions: ["attendance.read", "leave.approve", "task.read"], workspaceWide: ["task.read"] }));
  const hr = new Set(permTokens({ permissions: ["member.manage", "attendance.read", "leave.approve"], workspaceWide: ["member.manage", "attendance.read", "leave.approve"] }));
  it("needs a company-wide grant where the section says so", () => {
    expect(canOpen(manager, "/admin/workspace/attendance")).toBe(false);
    expect(canOpen(manager, "/admin/workspace/attendance/U1")).toBe(false);
    expect(canOpen(hr, "/admin/workspace/attendance/U1")).toBe(true);
    expect(canOpen(hr, "/admin/workspace/leave")).toBe(true);
    expect(canOpen(hr, "/admin/workspace/leave/requests")).toBe(true);
    expect(canOpen(manager, "/admin/workspace/leave/requests")).toBe(false);
  });
  it("opens the overview to anyone, and everything when permissions are unknown", () => {
    expect(canOpen(manager, "/admin/workspace")).toBe(true);
    expect(canOpen(manager, "/admin/workspace/settings")).toBe(false);
    expect(canOpen(null, "/admin/workspace/settings")).toBe(true);
  });
});
