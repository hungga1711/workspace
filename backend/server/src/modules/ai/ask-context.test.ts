import { describe, expect, it } from "vitest";
import { onScreen, RefInput, traceNote } from "./assistant-input.js";
import { pageSurface } from "./activity.js";
import { tracing, type TraceItem } from "./mcp/chat.js";

describe("the ask panel's context", () => {
  it("takes the new kinds, the page flag and a thread, and refuses a bad thread id", () => {
    expect(RefInput.parse({ kind: "channel", id: "c1", label: "general", page: true, thread: "01M7AAAAAAAAAAAAAAAAAAAAAA" })).toMatchObject({ page: true });
    for (const kind of ["message", "person", "report"]) expect(RefInput.safeParse({ kind, id: "x", label: "y" }).success).toBe(true);
    expect(RefInput.safeParse({ kind: "channel", id: "c1", label: "g", thread: "short" }).success).toBe(false);
    expect(RefInput.safeParse({ kind: "secret", id: "c1", label: "g" }).success).toBe(false);
  });

  it("says what is on screen and which tools fit the place", () => {
    expect(onScreen({ kind: "task", label: "T-41 Launch" })).toContain('task "T-41 Launch" open on screen');
    expect(pageSurface([{ kind: "channel", id: "c", label: "g", page: true }])).toBe("channel");
    expect(pageSurface([{ kind: "message", id: "m", label: "hi", page: true }])).toBe("channel");
    expect(pageSurface([{ kind: "task", id: "t", label: "T-1", page: true }])).toBe("task");
    // Something dragged in is not where the question was asked.
    expect(pageSurface([{ kind: "task", id: "t", label: "T-1" }])).toBeNull();
    expect(pageSurface([{ kind: "document", id: "d", label: "Plan", page: true }])).toBeNull();
  });

  it("writes the last lookups compactly, as data, with how to refine them", () => {
    const note = traceNote([
      { tool: "overdue_tasks", input: { department: "Kỹ thuật" }, ok: true, head: `Lan: 3 overdue\n${"x".repeat(400)}` },
      { tool: "find_people", input: { query: "Huy" }, ok: false, head: "" },
    ]);
    expect(note).toContain('- overdue_tasks {"department":"Kỹ thuật"} → Lan: 3 overdue');
    expect(note).toContain("…");
    expect(note).toContain('- find_people {"query":"Huy"} (failed)');
    expect(note).toContain("<untrusted_content>");
    expect(note.length).toBeLessThan(1200);
  });

  it("records what each tool was asked and returned, at most six, without changing the result", async () => {
    const trace: TraceItem[] = [];
    const tools = tracing({ run: async (key: string, input: unknown) => ({ ok: true, content: `${key}:${JSON.stringify(input)}`, use: key }) }, trace);
    const r = await tools.run("search_workspace", { query: "launch" });
    expect(r).toEqual({ ok: true, content: 'search_workspace:{"query":"launch"}', use: "search_workspace" });
    for (let i = 0; i < 8; i++) await tools.run("read_item", "not an object");
    expect(trace).toHaveLength(6);
    expect(trace[0]).toEqual({ tool: "search_workspace", input: { query: "launch" }, ok: true, head: 'search_workspace:{"query":"launch"}' });
    expect(trace[1]!.input).toEqual({});
  });
});
