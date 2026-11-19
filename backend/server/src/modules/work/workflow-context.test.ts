import { describe, expect, it } from "vitest";
import { contextText } from "./workflow-context.js";

describe("contextText", () => {
  const empty = { related: null, subtasks: [], comments: [], files: [] };

  it("is empty when the workspace knows nothing more", () => {
    expect(contextText(empty)).toBe("");
  });

  it("lists project, parent, subtasks, files, comments, documents and how similar tasks were done", () => {
    const text = contextText({
      related: {
        project: { id: "p", code: "P-010", name: "Customer portal 2.0", description: "Self-serve billing" },
        goals: [{ goal: "Grow revenue", keyResult: "Portal live by Q4" }],
        parent: { id: "t0", code: "T-600", title: "Launch", status: "in_progress", description: "" },
        docs: [{ id: "d", code: "D-001", title: "Pricing", why: "mentioned", excerpt: "Standard is $1,200/month", updatedAt: null, url: "/x" }],
        similar: [
          { id: "s", code: "T-101", title: "Quote for Acme", assigneeId: null, completedAt: "2026-10-01", how: "Used the pricing doc", subtasks: 0, shared: 2 },
          { id: "s2", code: "T-102", title: "Open one", assigneeId: null, completedAt: null, how: "n/a", subtasks: 0, shared: 2 },
        ],
      },
      subtasks: [{ code: "T-601", title: "Draft", status: "done" }],
      comments: [{ body: "Customer wants 12 months" }],
      files: [{ name: "brief.pdf" }],
    });
    expect(text).toContain("Project: P-010 · Customer portal 2.0 — Self-serve billing");
    expect(text).toContain("Goals: Grow revenue (Portal live by Q4)");
    expect(text).toContain("Parent task: T-600 · Launch");
    expect(text).toContain("- T-601 Draft [done]");
    expect(text).toContain("Attached files: brief.pdf");
    expect(text).toContain("- Customer wants 12 months");
    expect(text).toContain("- D-001 Pricing: Standard is $1,200/month");
    expect(text).toContain("- T-101 Quote for Acme: Used the pricing doc");
    expect(text).not.toContain("T-102");
  });

  it("stays within its budget", () => {
    const long = {
      ...empty,
      comments: Array.from({ length: 5 }, () => ({ body: "x".repeat(2000) })),
      subtasks: Array.from({ length: 15 }, (_, i) => ({ code: `T-${i}`, title: "y".repeat(500), status: "todo" })),
    };
    expect(contextText(long, 1000).length).toBeLessThanOrEqual(1000);
  });
});
