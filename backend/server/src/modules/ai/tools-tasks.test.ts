import { describe, expect, it } from "vitest";
import { blockedTime, historyWhat, READ, WRITE } from "./tools-tasks.js";

const H = 3_600_000;
describe("blockedTime", () => {
  it("adds up blocked spans from the activity, including one still open", () => {
    const at = (h: number) => new Date(Date.UTC(2026, 10, 1) + h * H).toISOString();
    const activity = [
      { action: "updated", changes: { blocked_reason: { from: null, to: "waiting on legal" } }, at: at(30) },
      { action: "updated", changes: { status: { from: "todo", to: "in_progress" } }, at: at(20) },
      { action: "updated", changes: { blocked_reason: { from: "no access", to: null } }, at: at(10) },
      { action: "updated", changes: { blocked_reason: { from: null, to: "no access" } }, at: at(4) },
    ];
    const r = blockedTime(activity, { blockedReason: "waiting on legal", createdAt: at(0) }, Date.parse(at(40)));
    expect(r.spans).toHaveLength(2);
    expect(r.totalMs).toBe(6 * H + 10 * H);
  });
  it("counts from creation when it was blocked before the oldest entry", () => {
    const r = blockedTime([{ action: "updated", changes: { blocked_reason: { from: "x", to: null } }, at: "2026-11-02T00:00:00Z" }], {
      blockedReason: null,
      createdAt: "2026-11-01T00:00:00Z",
    });
    expect(r.totalMs).toBe(24 * H);
  });
});

describe("task tools", () => {
  it("are all named once and write tools have previews", () => {
    const names = [...READ.map((t) => t.name), ...WRITE.map((w) => w.tool.name)];
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(
      expect.arrayContaining([
        "overdue_tasks",
        "find_duplicate_tasks",
        "task_history",
        "estimate_due_date",
        "assign_task",
        "split_task",
        "move_tasks_bulk",
        "link_tasks",
        "onboarding_checklist",
      ]),
    );
    const card = WRITE.find((w) => w.tool.name === "move_tasks_bulk")!.preview({ tasks: ["T-1", "T-2"], status: "done" }, "en");
    expect(card.title).toBe("Change 2 tasks");
    expect(card.fields.map((f) => f.label)).toEqual(["Tasks", "Status"]);
  });
  it("validates bulk input", () => {
    const bulk = WRITE.find((w) => w.tool.name === "move_tasks_bulk")!.tool;
    expect(bulk.input.safeParse({ tasks: Array.from({ length: 51 }, (_, i) => `T-${i}`) }).success).toBe(false);
  });
});

describe("historyWhat", () => {
  it("reads each activity shape the work module writes, never a blank from → to", () => {
    expect(historyWhat("created", { title: "Plan", source: null })).toBe("created");
    expect(historyWhat("updated", { status: { from: "todo", to: "done" }, priority: { from: "low", to: "high" } })).toBe("status: todo → done, priority: low → high");
    expect(historyWhat("moved", { from: "todo", to: "review" })).toBe("status: todo → review");
    expect(historyWhat("dependency_added", { predecessor: "T-3" })).toBe("now waits on T-3");
    expect(historyWhat("dependency_removed", {})).toBe("dependency removed");
    expect(historyWhat("updated", {})).toBe("updated");
  });
});
