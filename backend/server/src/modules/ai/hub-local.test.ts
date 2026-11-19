import { describe, expect, it } from "vitest";
import { localAdoption, localProgress, localTaskPrompt } from "./hub-local.js";

describe("built-in model for AI › Tiến độ and Áp dụng AI", () => {
  it("reads the team's facts and drafts a nudge per person", () => {
    const r = JSON.parse(
      localProgress(
        {
          scope: "team",
          people: 3,
          totals: { open: 9, overdue: 2, blocked: 1, done7: 4 },
          attention: [{ userId: "u1", name: "Tom Becker", reasons: [{ kind: "blocked", count: 1 }], open: 3 }],
        },
        "en",
      ),
    );
    expect(r.summary).toContain("2 late and 1 blocked");
    expect(r.people).toEqual([{ userId: "u1", why: "Tom Becker: 1 blocked task.", nudge: expect.stringContaining("Hi Tom") }]);
  });

  it("gives one person next steps instead of nudges", () => {
    const r = JSON.parse(localProgress({ scope: "self", attention: [{ userId: "me", name: "", reasons: [{ kind: "overdue", count: 2 }], open: 4 }] }, "vi"));
    expect(r.people).toEqual([]);
    expect(r.next[0]).toMatch(/việc trễ/);
  });

  it("turns suggestions into ideas with a prompt", () => {
    const r = JSON.parse(
      localAdoption(
        {
          suggestions: [
            { topic: "sales", tasks: 5, coverage: 0.2, departments: ["Kinh doanh"] },
            { topic: "other", tasks: 9, coverage: 0 },
          ],
        },
        "vi",
      ),
    );
    expect(r.ideas).toHaveLength(1);
    expect(r.ideas[0]).toMatchObject({ topic: "sales", who: "Kinh doanh" });
    expect(r.ideas[0].prompt).toContain("[");
  });
});

describe("localTaskPrompt", () => {
  it("names the task and asks for its kind of work", () => {
    const r = JSON.parse(localTaskPrompt({ code: "T-1", title: "Monthly sales report", topic: "analysis" }, "en")) as { prompt: string };
    expect(r.prompt).toContain('T-1 "Monthly sales report"');
    expect(r.prompt).toContain("measures");
    const vi = JSON.parse(localTaskPrompt({ code: "T-2", title: "Lunch", topic: "nope" }, "vi")) as { prompt: string };
    expect(vi.prompt).toContain("Tôi đang làm việc T-2");
  });
});
