import { describe, expect, it } from "vitest";
import { buildProfiles, patternOf } from "./adoption-people.js";
import { dayRange } from "./local-usage-report.js";

const people = [
  { userId: "an", displayName: "An", department: "Sales" },
  { userId: "binh", displayName: "Bình", department: "Sales" },
  { userId: "chi", displayName: "Chi", department: "Engineering" },
];
const range = dayRange(30, "2026-11-10");

describe("patternOf", () => {
  it("names the pattern from uses a week and the window before", () => {
    expect(patternOf(0, 0, 30)).toBe("none");
    expect(patternOf(0, 12, 30)).toBe("lapsed");
    expect(patternOf(4, 0, 30)).toBe("new");
    expect(patternOf(4, 9, 30)).toBe("light");
    expect(patternOf(20, 0, 30)).toBe("regular");
    expect(patternOf(60, 10, 30)).toBe("power");
    expect(patternOf(10, 0, 7)).toBe("power");
  });
});

describe("buildProfiles", () => {
  const r = buildProfiles(
    people,
    range,
    [
      { userId: "an", day: "2026-11-10", prompts: 30, calls: 10 },
      { userId: "an", day: "2026-11-09", prompts: 10, calls: 0 },
      { userId: "an", day: "2026-01-01", prompts: 99, calls: 0 },
      { userId: "chi", day: "2026-10-20", prompts: 2, calls: 0 },
    ],
    new Map([
      ["an", 20],
      ["binh", 5],
    ]),
    [
      { userId: "an", source: "chatgpt", topic: "sales", conversations: 8, prompts: 30, rated: 4, yes: 3, partly: 1, flagged: 0, tasks: 2 },
      { userId: "an", source: "company", topic: "other", conversations: 3, prompts: 10, rated: 0, yes: 0, partly: 0, flagged: 0, tasks: 0 },
      { userId: "chi", source: "claude", topic: "code", conversations: 1, prompts: 2, rated: 3, yes: 0, partly: 1, flagged: 1, tasks: 0 },
    ],
    [
      { userId: "an", feature: "summarize", calls: 10, tokens: 5000, costUsd: 0.5, unpriced: 0 },
      { userId: "an", feature: "brief", calls: 4, tokens: 1000, costUsd: 0.1, unpriced: 0 },
    ],
    [{ userId: "binh", tool: "claude-code", tokens: 900_000, listValueUsd: 3 }],
  );
  const by = Object.fromEntries(r.people.map((x) => [x.userId, x]));

  it("sums a person's use, tools, topics and rating, leaving days outside the window out", () => {
    expect(by.an).toMatchObject({ uses: 50, prompts: 40, inAppCalls: 10, activeDays: 2, pattern: "power", trend: "up", helpful: 0.88, aiTasks: 2, attention: null });
    expect(by.an!.sources[0]).toEqual({ key: "chatgpt", count: 30 });
    expect(by.an!.topics).toEqual([{ key: "sales", count: 30 }]);
    expect(by.an!.spark.at(-1)).toBe(40);
    expect(by.an!.spark).toHaveLength(30);
  });

  it("counts automatic calls in tokens and cost but not as the person's own features", () => {
    expect(by.an!.companyTokens).toBe(6000);
    expect(by.an!.costUsd).toBe(0.6);
    expect(by.an!.features).toEqual([{ key: "summarize", count: 10 }]);
  });

  it("counts a coding agent on the computer as using AI, and flags sensitive data", () => {
    expect(by.binh).toMatchObject({ uses: 0, pattern: "regular", localTokens: 900_000, listValueUsd: 3 });
    expect(by.chi).toMatchObject({ pattern: "new", attention: "sensitive", helpful: 0.17 });
  });

  it("rolls up totals, departments and features", () => {
    expect(r.totals).toMatchObject({ people: 3, using: 3, uses: 52, outsidePrompts: 32, costUsd: 0.6, attention: 1, companyTokens: 6000, localTokens: 900_000 });
    expect(r.departments.map((d) => [d.name, d.people, d.using])).toEqual([
      ["Sales", 2, 2],
      ["Engineering", 1, 1],
    ]);
    expect(r.features[0]).toMatchObject({ feature: "summarize", people: 1 });
  });

  it("uses a cell per week beyond 30 days", () => {
    expect(buildProfiles(people, dayRange(90, "2026-11-10"), [], new Map(), [], [], []).people[0]!.spark).toHaveLength(13);
  });
});
