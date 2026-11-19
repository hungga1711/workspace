import { describe, expect, it } from "vitest";
import { countOf, coverageNotes, followUps, stepText, Trace, type Step } from "./progress.js";
import type { ToolResult } from "./tools.js";

const ok = (content: string, more: Partial<ToolResult> = {}): ToolResult => ({ ok: true, content, sources: [], ...more });
const title = (name: string) => name.replace(/_/g, " ");

describe("steps", () => {
  it("says what a call does with its subject, then how many items it found", () => {
    expect(stepText("overdue_tasks", { department: "Kỹ thuật" }, "vi", "x").text).toBe("Đọc việc trễ hạn: Kỹ thuật…");
    const done = stepText("overdue_tasks", { department: "Kỹ thuật" }, "vi", "x", ok("- T-1 a\n- T-2 b\n- T-3 c"));
    expect(done).toEqual({ text: "Đọc việc trễ hạn: Kỹ thuật · 3 mục", n: 3 });
    expect(stepText("search_workspace", { query: "ngân sách" }, "en", "x").text).toBe("Searching the workspace: “ngân sách”…");
    expect(stepText("search_workspace", { query: "x y" }, "zh", "x", ok("Nothing in the workspace matches.")).text).toBe("搜索工作区: “x y” · 未找到");
  });

  it("never shows an id, and says when a call was refused or failed", () => {
    expect(stepText("read_item", { id: "01M7MXYM7H23B928VE3K24PMAJ", type: "task" }, "en", "x").text).toBe("Opening…");
    expect(stepText("get_task", { task: "T-9" }, "es", "x", { ok: false, content: "DENIED: not found or not permitted", sources: [] }).text).toBe(
      "Leyendo la tarea: T-9 · sin acceso",
    );
    expect(stepText("get_task", {}, "en", "x", { ok: false, content: "Tool failed; try again later.", sources: [] }).text).toBe("Reading the task · could not read");
  });

  it("a tool without a phrase reads as its title", () => {
    expect(stepText("some_new_tool", {}, "en", "Some new tool").text).toBe("Some new tool…");
  });

  it("counts list lines, table rows and codes; zero when the result says nothing was found", () => {
    expect(countOf("[total] 3 people\n[person Lan] 2 tasks\n[person Minh] 1 task")).toBe(3);
    expect(countOf("| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |")).toBe(2);
    expect(countOf("Không có gì trong workspace khớp. Thử từ khác.")).toBe(0);
    expect(countOf("Just a paragraph.")).toBeUndefined();
  });

  it("the trace streams each step as it starts and ends, and keeps them for the answer", () => {
    const seen: Step[] = [];
    const t = new Trace("en", title, (s) => seen.push(s));
    const a = t.start("list_my_tasks", {});
    t.start("list_calendar", { from: "x" });
    t.end(a, ok("- T-1 a\n- T-2 b"));
    expect(seen.map((s) => [s.id, s.state])).toEqual([
      ["s1", "running"],
      ["s2", "running"],
      ["s1", "done"],
    ]);
    // A call still running when the answer ends reads as failed.
    expect(t.steps().map((s) => [s.text, s.state])).toEqual([
      ["Reading your tasks · 2 items", "done"],
      ["Reading the calendar · could not read", "failed"],
    ]);
    expect(t.used().map((u) => u.tool)).toEqual(["list_my_tasks"]);
  });
});

describe("notes", () => {
  it("says a refused or failed source, nothing found, and what a tool reports it left out", () => {
    const notes = coverageNotes(
      [
        { tool: "team_status", result: ok("[total] 2 people", { coverage: [{ kind: "scope", scope: "reports" }] }) },
        { tool: "get_task", result: { ok: false, content: "DENIED: not found or not permitted", sources: [] } },
        { tool: "project_status", result: { ok: false, content: "Tool failed; try again later.", sources: [] } },
      ],
      "vi",
    );
    expect(notes).toEqual([
      "Một phần dữ liệu bạn không có quyền xem nên không có trong câu trả lời.",
      "1 nguồn không đọc được: câu trả lời có thể thiếu.",
      "Chỉ tính những người báo cáo cho bạn.",
    ]);
    expect(coverageNotes([{ tool: "search_workspace", result: ok("Nothing in the workspace matches. Try other words.") }], "en")).toEqual([
      "Nothing in the workspace matched: anything beyond that is not from your data.",
    ]);
  });

  it("a model's own bad arguments are not the person lacking access; a full answer has no notes", () => {
    expect(coverageNotes([{ tool: "get_task", result: { ok: false, content: "DENIED: invalid tool input (task: Required)", sources: [] } }], "en")).toEqual([]);
    expect(coverageNotes([{ tool: "list_my_tasks", result: ok("- T-1 a") }], "en")).toEqual([]);
    expect(coverageNotes([], "en")).toEqual([]);
  });

  it("windows and cut lists, each said once", () => {
    const c = {
      coverage: [
        { kind: "window" as const, days: 14 },
        { kind: "truncated" as const, shown: 50, total: 120 },
      ],
    };
    expect(
      coverageNotes(
        [
          { tool: "a", result: ok("- x", c) },
          { tool: "b", result: ok("- y", c) },
        ],
        "en",
      ),
    ).toEqual(["Based on the last 14 days of data.", "Showing 50 of 120: the list was cut."]);
  });
});

describe("follow-ups", () => {
  const all = () => true;
  it("from the items read: a task's history and estimate, a person's week, a project's late work", () => {
    const next = followUps(
      "how is the team doing",
      [{ tool: "team_status" }],
      [
        { type: "task", id: "1", title: "T-41 Ship the portal", url: "" },
        { type: "employee", id: "2", title: "Lan Nguyen", url: "" },
      ],
      "en",
      all,
    );
    expect(next).toEqual(["What changed on T-41?", "When will T-41 be done?", "What did Lan Nguyen finish this week?"]);
  });

  it("only questions whose tools the person is offered, never the question just asked", () => {
    const offered = (t: string) => t !== "workload_balance";
    expect(followUps("Việc nào đang bị chặn?", [{ tool: "overdue_tasks" }], [], "vi", offered)).toEqual([]);
    expect(followUps("x", [{ tool: "overdue_tasks" }], [], "vi", offered)).toEqual(["Việc nào đang bị chặn?"]);
  });

  it("a channel summary leads to its action items and open questions; a plan to the end-of-day report", () => {
    expect(followUps("tóm tắt kênh", [{ tool: "summarize_channel" }], [], "vi", all)).toEqual(["Rút việc cần làm từ cuộc trò chuyện này", "Câu hỏi nào chưa được trả lời?"]);
    expect(followUps("plan my day", [{ tool: "plan_my_day" }], [], "en", all)).toEqual(["Write my end-of-day report", "Find a free hour today"]);
  });

  it("a task screen offers to split the task", () => {
    expect(followUps("x", [{ tool: "get_task" }], [{ type: "task", id: "1", title: "WEB-7 Login", url: "" }], "en", all, "task")).toContain("Break WEB-7 into smaller tasks");
  });
});
