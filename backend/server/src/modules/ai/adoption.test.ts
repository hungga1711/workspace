import { describe, expect, it } from "vitest";
import { adoptionSuggestions, myTasks, teamAdoption, teamOpenTasks } from "./adoption.js";

const people = [
  { userId: "an", displayName: "An", department: "Kinh doanh" },
  { userId: "binh", displayName: "Bình", department: "Kinh doanh" },
  { userId: "chi", displayName: "Chi", department: "Kỹ thuật" },
];

describe("adoptionSuggestions", () => {
  it("suggests the kind of work done a lot without AI, with who does it", () => {
    const tasks = [
      { userId: "an", title: "Soạn email cảm ơn đối tác" },
      { userId: "an", title: "Viết nội dung bài đăng tháng 11" },
      { userId: "binh", title: "Soạn thông báo nghỉ lễ" },
      { userId: "chi", title: "Sửa lỗi đăng nhập API" },
    ];
    const r = adoptionSuggestions("team", people, tasks, [], { writing: 4 });
    const writing = r.suggestions.find((s) => s.topic === "writing")!;
    expect(writing.tasks).toBe(3);
    expect(writing.people.map((x) => x.userId)).toEqual(["an", "binh"]);
    expect(writing.departments).toEqual(["Kinh doanh"]);
    expect(writing.library).toBe(4);
    expect(writing.coverage).toBe(0);
  });

  it("counts AI recorded on a task as using AI for that kind of work, and keeps it out of the examples", () => {
    const tasks = [
      { userId: "an", title: "Soạn email cảm ơn đối tác", ai: true },
      { userId: "an", title: "Viết nội dung bài đăng tháng 11" },
      { userId: "binh", title: "Soạn thông báo nghỉ lễ" },
    ];
    const writing = adoptionSuggestions("team", people, tasks, [], {}).suggestions.find((s) => s.topic === "writing")!;
    expect(writing.coverage).toBe(0.5);
    expect(writing.people.find((x) => x.userId === "an")?.usesAi).toBe(true);
    expect(writing.examples).not.toContain("Soạn email cảm ơn đối tác");
  });

  it("drops work that most people already do with AI and names mentors", () => {
    const tasks = ["an", "binh", "an"].map((userId, i) => ({ userId, title: `Soạn email ${i}` }));
    const use = [
      { userId: "an", topic: "writing", conversations: 5, rated: 3, yes: 3, partly: 0 },
      { userId: "binh", topic: "writing", conversations: 1, rated: 0, yes: 0, partly: 0 },
    ];
    expect(adoptionSuggestions("team", people, tasks, use, {}).suggestions).toEqual([]);
    const half = adoptionSuggestions(
      "team",
      people,
      [...tasks, { userId: "chi", title: "Viết tài liệu hướng dẫn" }, { userId: "chi", title: "Soạn biên bản họp" }],
      use.slice(0, 1),
      {},
    );
    const s = half.suggestions[0]!;
    expect(s.coverage).toBeCloseTo(0.33, 2);
    expect(s.mentors.map((m) => m.userId)).toEqual(["an"]);
    expect(s.helpful).toBe(1);
  });

  it("uses company-wide ratings only over enough people, and no mentors for one person", () => {
    const tasks = [
      { userId: "an", title: "Soạn email A" },
      { userId: "an", title: "Soạn email B" },
    ];
    const few = adoptionSuggestions("self", people.slice(0, 1), tasks, [], {}, { writing: { raters: 2, rated: 9, yes: 9, partly: 0 } });
    expect(few.suggestions[0]!.helpful).toBeNull();
    const many = adoptionSuggestions("self", people.slice(0, 1), tasks, [], {}, { writing: { raters: 6, rated: 10, yes: 5, partly: 0 } });
    expect(many.suggestions[0]!.helpful).toBe(0.5);
    expect(many.suggestions[0]!.mentors).toEqual([]);
  });
});

describe("classifyTask", () => {
  it("reads task titles, not only prompts", async () => {
    const { classifyTask } = await import("./adoption.js");
    expect(classifyTask("Fix flaky integration tests")).toBe("code");
    expect(classifyTask("Runbook for payment provider incidents")).toBe("writing");
    expect(classifyTask("Budget vs actuals for August")).toBe("analysis");
    expect(classifyTask("Close the renewal with Redwood Hotels")).toBe("sales");
    expect(classifyTask("Soạn email cảm ơn đối tác")).toBe("writing");
  });
});

describe("myTasks", () => {
  it("leaves out work AI already helped with; known kinds first, then by urgency", () => {
    const t = (id: string, title: string, extra: Partial<{ status: string; dueAt: string | null; overdue: boolean }> = {}) => ({
      id,
      code: id,
      title,
      status: "in_progress",
      dueAt: null,
      ...extra,
    });
    const { list: r, assisted } = myTasks([
      t("A", "Lunch with the team"),
      t("B", "Write release notes", { dueAt: "2026-11-10" }),
      t("C", "Fix flaky integration tests", { overdue: true, dueAt: "2026-11-01" }),
      t("D", "Monthly sales report", { status: "done" }),
      { ...t("E", "Draft the newsletter"), aiAssists: 2 },
    ]);
    expect(assisted).toBe(1);
    expect(r.map((x) => [x.id, x.topic])).toEqual([
      ["C", "code"],
      ["B", "writing"],
      ["A", "other"],
    ]);
  });
});

describe("teamAdoption and teamOpenTasks", () => {
  const person = (userId: string, department: string | null, tasks: { id: string; title: string; status: string; aiAssists?: number; overdue?: boolean }[]) => ({
    userId,
    displayName: userId.toUpperCase(),
    department,
    open: 0,
    overdue: 0,
    stale: 0,
    blocked: 0,
    atRisk: 0,
    done7: 0,
    onTimeRate: null,
    lastActivityAt: null,
    tasks: tasks.map((t) => ({ code: t.id, dueAt: null, ...t })),
  });
  const people = [
    person("a", "Sales", [{ id: "T-1", title: "Follow up demo with Bluepeak", status: "todo", aiAssists: 2 }]),
    person("b", "Sales", [{ id: "T-2", title: "Renewal quote for Northgate", status: "todo", overdue: true }]),
    person("c", null, [{ id: "T-3", title: "Release notes for 2.0", status: "done" }]),
  ];

  it("levels people by AI conversations plus AI-helped tasks, and counts departments", () => {
    const r = teamAdoption(people, [
      { userId: "a", conversations: 9 },
      { userId: "c", conversations: 3 },
    ]);
    expect(r).toMatchObject({ people: 3, using: 2, regular: 1 });
    expect(r.rows.map((x) => [x.userId, x.level])).toEqual([
      ["a", 2],
      ["c", 1],
      ["b", 0],
    ]);
    expect(r.departments).toEqual([
      { name: "Sales", people: 2, using: 1 },
      { name: null, people: 1, using: 1 },
    ]);
  });

  it("suggests the team's open tasks without AI help, not the caller's own", () => {
    const r = teamOpenTasks(people, "c");
    expect(r.map((x) => [x.code, x.assignee])).toEqual([["T-2", "B"]]);
  });
});
