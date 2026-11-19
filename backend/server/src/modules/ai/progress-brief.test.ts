import { describe, expect, it } from "vitest";
import { ATTENTION_MAX, cleanReading, progressFindings, type TeamPerson } from "./progress-brief.js";

const NOW = Date.parse("2026-11-02T09:00:00Z");
const ago = (days: number) => new Date(NOW - days * 86400_000).toISOString();
const person = (userId: string, x: Partial<TeamPerson> = {}): TeamPerson => ({
  userId,
  displayName: userId,
  open: 2,
  overdue: 0,
  stale: 0,
  blocked: 0,
  atRisk: 0,
  done7: 1,
  doneWeeks: [1, 1, 1, 1],
  onTimeRate: 100,
  lastActivityAt: ago(1),
  tasks: [],
  ...x,
});

describe("progressFindings", () => {
  it("lists late and blocked people first, with the task to nudge", () => {
    const r = progressFindings(
      [
        person("ok"),
        person("late", {
          overdue: 2,
          tasks: [
            { id: "t1", code: "W-1", title: "Báo giá", status: "in_progress", dueAt: ago(3), overdue: true },
            { id: "t2", code: "W-2", title: "Hợp đồng", status: "todo", dueAt: null, stale: true },
          ],
        }),
        person("blocked", { blocked: 1, tasks: [{ id: "t3", code: "W-3", title: "Sửa lỗi", status: "in_progress", dueAt: null, blockedReason: "chờ khách" }] }),
      ],
      NOW,
    );
    expect(r.attention.map((a) => a.userId)).toEqual(["late", "blocked"]);
    expect(r.attention[0]!.nudgeTaskId).toBe("t1");
    expect(r.attention[0]!.tasks.map((t) => t.flag)).toEqual(["overdue", "stale"]);
    expect(r.attention[1]!.reasons).toEqual([{ kind: "blocked", count: 1 }]);
  });

  it("flags quiet people, a slowing week and an overload", () => {
    const r = progressFindings(
      [person("quiet", { lastActivityAt: ago(9), stale: 2 }), person("slow", { doneWeeks: [4, 5, 3, 0] }), person("busy", { open: 12 }), person("a"), person("b")],
      NOW,
    );
    const kinds = Object.fromEntries([...r.attention, ...r.watch].map((a) => [a.userId, a.reasons.map((x) => x.kind)]));
    expect(kinds.quiet).toEqual(["quiet"]);
    expect(kinds.slow).toEqual(["slowing"]);
    expect(kinds.busy).toEqual(["overloaded"]);
    // Quiet open work needs someone today; a slower week or a heavy load is only worth watching.
    expect(r.attention.map((a) => a.userId)).toEqual(["quiet"]);
    expect(r.watch.map((a) => a.userId).sort()).toEqual(["busy", "slow"]);
  });

  it("keeps the list short: the worst ATTENTION_MAX, lighter signs to watch", () => {
    const team = [
      ...Array.from({ length: 14 }, (_, i) => person(`late${String(i).padStart(2, "0")}`, { overdue: 1 + (i % 3) })),
      ...Array.from({ length: 30 }, (_, i) => person(`stale${i}`, { stale: 1 })),
    ];
    const r = progressFindings(team, NOW);
    expect(r.attention).toHaveLength(ATTENTION_MAX);
    expect(r.attention.every((a) => a.reasons.some((x) => x.kind === "overdue"))).toBe(true);
    expect(r.attention[0]!.score).toBeGreaterThanOrEqual(r.attention.at(-1)!.score);
    expect(r.watch).toHaveLength(14 - ATTENTION_MAX + 30);
  });

  it("highlights a good week", () => {
    const r = progressFindings([person("star", { done7: 5 }), person("late", { done7: 6, overdue: 1 })], NOW);
    expect(r.highlights.map((h) => h.userId)).toEqual(["star"]);
  });
});

describe("cleanReading", () => {
  it("keeps only known people and trims the model's output", () => {
    const r = cleanReading(
      {
        summary: " ok ",
        people: [
          { userId: "u1", why: "a", nudge: "b" },
          { userId: "x", why: "c", nudge: "d" },
        ],
        next: ["1", "", "2"],
      },
      new Set(["u1"]),
    );
    expect(r).toEqual({ summary: "ok", people: [{ userId: "u1", why: "a", nudge: "b" }], next: ["1", "2"] });
  });
});
