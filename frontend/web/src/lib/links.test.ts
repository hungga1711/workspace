import { describe, expect, it } from "vitest";
import { approvalHref, docHref, meetingHref, projectHref, routeOf, taskHref, whiteboardHref } from "./links";

describe("record links", () => {
  it("prefer the code and fall back to the id", () => {
    expect(taskHref({ id: "01JABCDEFGHJKMNPQRSTVWXYZ4", code: "T-041" })).toBe("/app/work/tasks/T-041");
    expect(projectHref({ id: "01JABCDEFGHJKMNPQRSTVWXYZ4", code: null })).toBe("/app/work/projects/01JABCDEFGHJKMNPQRSTVWXYZ4");
    expect(docHref({ id: "x", code: "TL/2026 #1" })).toBe("/app/work/docs/TL%2F2026%20%231");
    expect(approvalHref({ id: "01JABCDEFGHJKMNPQRSTVWXYZ4", code: "YC-007" })).toBe("/app/work/approvals/YC-007");
    expect(meetingHref({ id: "01JABCDEFGHJKMNPQRSTVWXYZ4", code: "H-012-3" })).toBe("/app/work/meetings/H-012-3");
    expect(whiteboardHref({ id: "01JABCDEFGHJKMNPQRSTVWXYZ4", code: "W-001" })).toBe("/app/work/whiteboards/W-001");
  });

  it("collapse ids and codes into one route name", () => {
    expect(routeOf("/app/work/tasks/T-041")).toBe("/app/work/tasks/:id");
    expect(routeOf("/app/work/projects/01JABCDEFGHJKMNPQRSTVWXYZ4/export")).toBe("/app/work/projects/:id/export");
    expect(routeOf("/app/chat/01JABCDEFGHJKMNPQRSTVWXYZ4")).toBe("/app/chat/:id");
    expect(routeOf("/app/work/approvals/YC-007")).toBe("/app/work/approvals/:id");
    expect(routeOf("/app/work/meetings/H-012-3")).toBe("/app/work/meetings/:id");
    expect(routeOf("/app/work/whiteboards/W-001")).toBe("/app/work/whiteboards/:id");
  });
});
