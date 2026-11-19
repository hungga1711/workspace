import { describe, expect, it } from "vitest";
import { aiVsOutput, compareDepartments, topicBreakdown, weeklyMarkdown, workloadBalance, type TeamPersonRow } from "./report-math.js";
import { modelSpend } from "./spend-models.js";

const NOW = Date.parse("2026-11-17T09:00:00Z");
const inDays = (d: number) => new Date(NOW + d * 86400_000).toISOString();
const row = (userId: string, open: number, x: Partial<TeamPersonRow> = {}): TeamPersonRow => ({
  userId,
  displayName: userId,
  open,
  inProgress: 0,
  overdue: 0,
  stale: 0,
  blocked: 0,
  done7: 0,
  tasks: [],
  ...x,
});

describe("workloadBalance", () => {
  it("rates people against the team's median and puts the most loaded first", () => {
    const r = workloadBalance(
      [row("a", 4), row("b", 4), row("c", 12, { tasks: [{ code: "T-1", title: "x", status: "todo", dueAt: inDays(2) }] }), row("d", 0), row("e", 4, { overdue: 3 })],
      NOW,
    );
    expect(r.median).toBe(4);
    expect(r.people.map((x) => [x.userId, x.load])).toEqual([
      ["c", "overloaded"],
      ["e", "overloaded"],
      ["a", "normal"],
      ["b", "normal"],
      ["d", "room"],
    ]);
    expect(r.people[0]!.dueSoon).toBe(1);
  });

  it("does not count work due later than a week or already done as due soon", () => {
    const r = workloadBalance(
      [
        row("a", 2, {
          tasks: [
            { code: "T-1", title: "x", status: "todo", dueAt: inDays(9) },
            { code: "T-2", title: "y", status: "done", dueAt: inDays(1) },
          ],
        }),
      ],
      NOW,
    );
    expect(r.people[0]!.dueSoon).toBe(0);
  });
});

describe("compareDepartments", () => {
  const d = (name: string | null, people: number, doneWeeks: number[], open: number, overdue: number) => ({
    name,
    people,
    open,
    inProgress: 0,
    overdue,
    atRisk: 0,
    blocked: 0,
    done7: doneWeeks.at(-1)!,
    onTimeRate: null,
    doneWeeks,
    health: "ok",
  });
  it("sums the last weeks, per person, and keeps people without a department last", () => {
    const r = compareDepartments([d(null, 1, [9, 9, 9, 9], 1, 0), d("Sales", 2, [1, 2, 3, 4], 10, 2), d("Ops", 1, [0, 0, 5, 5], 4, 0)], 2);
    expect(r.map((x) => [x.name, x.done, x.donePerPerson, x.overdueShare])).toEqual([
      ["Ops", 10, 10, 0],
      ["Sales", 7, 3.5, 20],
      [null, 18, 18, 0],
    ]);
  });
});

describe("aiVsOutput", () => {
  it("joins AI use and output per person and compares the groups against the window before", () => {
    const r = aiVsOutput(
      [
        { userId: "a", displayName: "A", department: null, uses: 40, prevUses: 20, pattern: "power" },
        { userId: "b", displayName: "B", department: null, uses: 0, prevUses: 0, pattern: "none" },
      ],
      [
        { userId: "a", done: 12, donePrev: 8, dated: 10, onTime: 9 },
        { userId: "b", done: 4, donePrev: 5, dated: 0, onTime: 0 },
      ],
    );
    expect(r.people[0]).toMatchObject({ userId: "a", usesChange: 100, done: 12, doneChange: 50, onTimeRate: 90, regular: true });
    expect(r.people[1]).toMatchObject({ userId: "b", usesChange: null, doneChange: -20, onTimeRate: null, regular: false });
    expect(r.regular).toEqual({ people: 1, done: 12, donePrev: 8, change: 50 });
    expect(r.others).toEqual({ people: 1, done: 4, donePrev: 5, change: -20 });
  });

  it("counts someone with no finished tasks as zero, not missing", () => {
    const r = aiVsOutput([{ userId: "a", displayName: "A", department: null, uses: 3, prevUses: 0, pattern: "new" }], []);
    expect(r.people[0]).toMatchObject({ done: 0, doneChange: null });
  });
});

describe("topicBreakdown", () => {
  it("adds prompts per topic, people and the outside share, and names the departments asking most", () => {
    const r = topicBreakdown([
      { userId: "a", displayName: "A", department: "Eng", prompts: 10, sources: { company: 5, chatgpt: 5 }, topics: { code: 8, writing: 2 } },
      { userId: "b", displayName: "B", department: "Sales", prompts: 4, sources: { claude: 4 }, topics: { writing: 4 } },
    ]);
    expect(r).toEqual([
      { topic: "code", prompts: 8, people: 1, outside: 4, departments: [{ name: "Eng", prompts: 8 }] },
      {
        topic: "writing",
        prompts: 6,
        people: 2,
        outside: 5,
        departments: [
          { name: "Sales", prompts: 4 },
          { name: "Eng", prompts: 2 },
        ],
      },
    ]);
  });
});

describe("weeklyMarkdown", () => {
  it("writes totals, who needs attention and a section per person", () => {
    const r = weeklyMarkdown(
      "Sales",
      [
        {
          ...row("Lan", 3, { overdue: 1, done7: 2, inProgress: 1 }),
          doneRecently: [{ code: "T-1", title: "Quote" }],
          late: [{ code: "T-2", title: "Deck", dueAt: "2026-11-10T00:00:00Z" }],
        },
        row("Minh", 1),
      ],
      "en",
      "2026-11-17",
    );
    expect(r.title).toBe("Weekly report: Sales (2026-11-17)");
    expect(r.markdown).toContain("**2 people** · 2 done in 7 days · 4 open · 1 overdue");
    expect(r.markdown).toContain("## Needs attention\n- **Lan**: 1 overdue, 0 blocked");
    expect(r.markdown).toContain("- Done: T-1 Quote");
    expect(r.markdown).toContain("- Late: T-2 Deck (2026-11-10)");
    expect(r.markdown.indexOf("### Lan")).toBeLessThan(r.markdown.indexOf("### Minh"));
  });

  it("writes Vietnamese", () => {
    expect(weeklyMarkdown("đội", [], "vi", "2026-11-17").markdown).toContain("Không có ai để báo cáo.");
  });
});

describe("modelSpend", () => {
  it("prices each model's tokens, counts people, and leaves an unknown model unpriced", () => {
    const r = modelSpend(
      [
        { model: "house-model", userId: "a", calls: 2, input: 1_000_000, output: 0 },
        { model: "house-model", userId: "b", calls: 1, input: 0, output: 1_000_000 },
        { model: "mystery-1", userId: "a", calls: 5, input: 10, output: 10 },
      ],
      [{ model: "house-model", input: 1, output: 3 }],
    );
    expect(r).toEqual([
      { model: "house-model", calls: 3, tokens: 2_000_000, people: 2, costUsd: 4 },
      { model: "mystery-1", calls: 5, tokens: 20, people: 1, costUsd: null },
    ]);
  });
});
