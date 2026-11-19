import { describe, expect, it } from "vitest";
import { ruleProposal } from "./assist.js";

const workflows = [
  { id: "w-code", category: "coding" },
  { id: "w-mkt", category: "marketing" },
];
const projects = [{ id: "p1", name: "Customer portal 2.0" }];

describe("ruleProposal (a task from a chat request without a model)", () => {
  it("drops the 'tạo task' lead-in and keeps the first line as the title", () => {
    const p = ruleProposal("Tạo task: sửa lỗi đăng nhập trên Customer portal 2.0\nNgười dùng bị đăng xuất sau 5 phút", workflows, projects);
    expect(p.title).toBe("sửa lỗi đăng nhập trên Customer portal 2.0");
    expect(p.description).toBe("Người dùng bị đăng xuất sau 5 phút");
    expect(p.workflowId).toBe("w-code");
    expect(p.projectId).toBe("p1");
  });
  it("matches English requests and marketing work", () => {
    const p = ruleProposal("create a task write the launch newsletter", workflows, projects);
    expect(p.title).toBe("write the launch newsletter");
    expect(p.workflowId).toBe("w-mkt");
    expect(p.projectId).toBeNull();
  });
  it("shortens a long single line and keeps it whole in the description", () => {
    const long = "x".repeat(150);
    const p = ruleProposal(long, [], []);
    expect(p.title.length).toBeLessThanOrEqual(100);
    expect(p.description).toBe(long);
  });
});
