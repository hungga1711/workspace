import { describe, expect, it } from "vitest";
import { briefStamp, buildBrief, citedSources, normalizeCitations, localTaskAnswer, taskCodesIn, type BriefRelated, type BriefTaskDetail } from "./task-brief.js";

const detail = (over: Partial<BriefTaskDetail["task"]> = {}, extra: Partial<BriefTaskDetail> = {}): BriefTaskDetail => ({
  task: {
    id: "01TASK0000000000000000000A",
    code: "WEB-42",
    title: "Fix the login page on Safari",
    description: "Users on Safari 17 cannot sign in.\n\n- [ ] Reproduce on Safari 17\n- [ ] Check the cookie SameSite flag\n- [x] Collect logs",
    status: "in_progress",
    priority: "high",
    dueAt: "2026-11-10T10:00:00.000Z",
    assigneeId: "u-lan",
    ownerId: "u-minh",
    blockedReason: "Waiting for a Safari test device",
    progress: 40,
    version: 3,
    ...over,
  },
  comments: [
    { authorId: "u-minh", body: "Please ask <@u-huy>, he fixed the same thing last year.", createdAt: "2026-11-01T09:00:00.000Z" },
    { authorId: "u-lan", body: "Started on it.", createdAt: "2026-11-02T09:00:00.000Z" },
  ],
  subtasks: [{ id: "01SUB00000000000000000000A", code: "WEB-43", title: "Write a regression test", status: "todo", assigneeId: "u-lan" }],
  activity: [{ actor: "user:u-lan", action: "moved", changes: { from: "todo", to: "in_progress" }, at: "2026-11-02T09:00:00.000Z" }],
  files: [{ name: "safari-console.txt" }],
  dependencies: { waitingOn: [{ id: "01DEP00000000000000000000A", code: "WEB-40", title: "Upgrade the auth library", status: "done" }], blocking: [] },
  ...extra,
});

const related: BriefRelated = {
  keywords: ["login", "page", "safari"],
  project: { id: "01PRJ00000000000000000000A", code: "P-001", name: "Website", description: "The public website and sign-in." },
  goals: [{ goal: "Fewer support tickets", keyResult: "Sign-in errors under 1%" }],
  parent: null,
  docs: [
    {
      id: "01DOC00000000000000000000A",
      code: "TL-003",
      title: "Auth runbook",
      why: "project",
      excerpt: "How sign-in cookies are set.",
      url: "/app/work/docs/01DOC00000000000000000000A",
    },
  ],
  similar: [
    {
      id: "01OLD00000000000000000000A",
      code: "WEB-7",
      title: "Fix login on Firefox",
      assigneeId: "u-huy",
      completedAt: "2025-10-01T00:00:00.000Z",
      how: "It was the SameSite=None cookie; set Secure too.",
      subtasks: 2,
    },
  ],
  messages: [
    {
      id: "01MSG00000000000000000000A",
      channel: "web",
      body: "WEB-42 is the Safari bug from support",
      url: "/app/chat/m/01MSG00000000000000000000A",
      at: "2026-11-03T00:00:00.000Z",
    },
  ],
};
const names = { "u-lan": "Lan", "u-minh": "Minh", "u-huy": "Huy" };

describe("task brief", () => {
  it("lays out every section in priority order with numbered sources", () => {
    const b = buildBrief(detail(), related, { budget: 20_000, lang: "en", names });
    const order = [
      "## The task [1] WEB-42",
      "### Description",
      "### Subtasks",
      "### Comments",
      "### Status history",
      "### Attachments",
      "## Around the task",
      "## Documents",
      "## Similar finished tasks",
      "## Chat messages",
    ];
    const at = order.map((h) => b.text.indexOf(h));
    expect(at.every((x) => x >= 0)).toBe(true);
    expect([...at].sort((x, y) => x - y)).toEqual(at);
    expect(b.cut).toEqual([]);
    expect(b.sources.map((s) => s.type)).toEqual(["task", "task", "project", "document", "task", "message"]);
    expect(b.sources.map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6]);
    // Names, never raw ids; who did the similar task and how.
    expect(b.text).toContain("@Huy");
    expect(b.text).not.toContain("<@u-huy>");
    expect(b.text).toMatch(/\[5\] WEB-7: Fix login on Firefox · done by Huy/);
    expect(b.text).toContain("Waiting for a Safari test device");
  });

  it("keeps the task itself when the budget is small, dropping later sections first", () => {
    const b = buildBrief(detail(), related, { budget: 900, lang: "vi", names });
    expect(b.text).toContain("WEB-42: Fix the login page on Safari");
    expect(b.text.length).toBeLessThanOrEqual(900);
    expect(b.cut).toContain("messages");
    expect(b.cut).toContain("similar");
    // A source whose line was cut cannot be cited.
    expect(b.sources.every((s) => b.text.includes(`[${s.n}]`))).toBe(true);
  });

  it("works without related data (the work module did not answer)", () => {
    const b = buildBrief(detail(), null, { budget: 5000, lang: "en" });
    expect(b.sources).toHaveLength(1);
    expect(b.text).toContain("## The task [1]");
  });

  it("reads the sources an answer cites, ignoring numbers it made up", () => {
    const b = buildBrief(detail(), related, { budget: 20_000, lang: "en", names });
    const cited = citedSources("Ask Huy [5]. The runbook explains cookies [4][5], see also [2, 99].", b.sources);
    expect(cited.map((s) => s.n)).toEqual([5, 4, 2]);
  });

  it("reads citations written as links to a number", () => {
    expect(normalizeCitations("See [Auth runbook](#4) and [5](#5), also [source 2].")).toBe("See Auth runbook [4] and [5], also [2].");
  });

  it("changes its cache stamp when the task or its comments change", () => {
    const a = briefStamp(detail());
    expect(briefStamp(detail({ version: 4 }))).not.toBe(a);
    const d = detail();
    d.comments.push({ authorId: "u-huy", body: "Try a private window", createdAt: "2026-11-04T00:00:00.000Z" });
    expect(briefStamp(d)).not.toBe(a);
    const e = detail();
    e.comments[0]!.editedAt = "2026-11-05T00:00:00.000Z";
    expect(briefStamp(e)).not.toBe(a);
  });
});

describe("task codes in a question", () => {
  it("finds codes with or without @, at most two, not inside words or paths", () => {
    expect(taskCodesIn("Giải thích @WEB-42 và T-041 giúp, rồi T-9 nữa")).toEqual(["WEB-42", "T-041"]);
    expect(taskCodesIn("see /app/work/tasks/T-041 or xWEB-42 or utf-8")).toEqual([]);
    expect(taskCodesIn("what is WEB-42?")).toEqual(["WEB-42"]);
  });
});

describe("built-in model answers from the brief", () => {
  it("explains, lists steps and finds similar work without a hosted model", () => {
    expect(localTaskAnswer("Giải thích task này", detail(), related, "vi", names)).toMatch(/WEB-42 Fix the login page on Safari.*Lan/s);
    const steps = localTaskAnswer("Cần làm những bước nào?", detail(), related, "vi", names)!;
    expect(steps.split("\n").slice(1)).toEqual(["1. Reproduce on Safari 17", "2. Check the cookie SameSite flag", "3. Collect logs"]);
    expect(localTaskAnswer("Đã có ai làm giống vậy chưa?", detail(), related, "vi", names)).toMatch(/WEB-7 Fix login on Firefox · do Huy/);
    expect(localTaskAnswer("What is the budget for lunch?", detail(), related, "en", names)).toBeNull();
  });
});
