import { describe, expect, it } from "vitest";
import { flowOf, parseScope, shape } from "./velocity.js";

describe("velocity helpers", () => {
  it("parses the four scopes and rejects the rest", () => {
    expect(parseScope(undefined)).toEqual({ kind: "workspace" });
    expect(parseScope("workspace")).toEqual({ kind: "workspace" });
    expect(parseScope("project:P-010")).toEqual({ kind: "project", id: "P-010" });
    expect(parseScope("person:01ABC")).toEqual({ kind: "person", id: "01ABC" });
    expect(parseScope("department:Customer Success")).toEqual({ kind: "department", id: "Customer Success" });
    expect(parseScope("team:x")).toBeNull();
    expect(parseScope("project:")).toBeNull();
    expect(parseScope(":x")).toBeNull();
  });

  it("lays sparse weeks onto every week, oldest first, with this week last", () => {
    const f = flowOf(
      ["2026-10-26", "2026-11-02", "2026-11-09"],
      [
        { week: "2026-11-09", done: 3, added: 5 },
        { week: "2026-10-26", done: 1, added: 0 },
      ],
      { inProgress: 4, stuck: 1 },
    );
    expect(f.done).toEqual([1, 0, 3]);
    expect(f.added).toEqual([0, 0, 5]);
    expect(f.thisWeek).toEqual({ done: 3, added: 5 });
    expect(f.inProgress).toBe(4);
    expect(f.stuck).toBe(1);
  });

  it("shapes the answer with this week's numbers and the stuck threshold", () => {
    const v = shape(
      [
        { week: "2026-11-02", done: 2, added: 1, cycle_days: 3.5 },
        { week: "2026-11-09", done: 0, added: 4, cycle_days: null },
      ],
      { in_progress: 2, review: 1, stuck: 1, overdue: 3, open: 9 },
    );
    expect(v.thisWeek).toEqual({ done: 0, added: 4 });
    expect(v.weeks[0]).toEqual({ week: "2026-11-02", done: 2, added: 1, cycleDays: 3.5 });
    expect(v.now).toEqual({ inProgress: 2, review: 1, stuck: 1, overdue: 3, open: 9 });
    expect(v.stuckDays).toBe(7);
  });

  it("summarises the last 7 days, not the calendar week, when given (no '0 done' on Monday morning)", () => {
    const monday = [
      { week: "2026-11-02", done: 6, added: 4, cycle_days: null },
      { week: "2026-11-09", done: 0, added: 0, cycle_days: null },
    ];
    const now = { in_progress: 0, review: 0, stuck: 0, overdue: 0, open: 0 };
    expect(shape(monday, now, { done: 6, added: 4 }).thisWeek).toEqual({ done: 6, added: 4 });
    expect(flowOf(["2026-11-02", "2026-11-09"], [{ week: "2026-11-02", done: 6, added: 4 }], { inProgress: 0, stuck: 0 }, { done: 5, added: 2 }).thisWeek).toEqual({
      done: 5,
      added: 2,
    });
  });
});
