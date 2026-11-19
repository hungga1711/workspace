import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { afterCall, cachedRead, clearToolCache, markTools, setToolCache, toolCacheSize } from "./tool-cache.js";
import type { ToolContext, ToolResult } from "./tools.js";

const ctx = (id: string, more: Partial<ToolContext> = {}): ToolContext =>
  ({ principal: { type: "user", id, teamIds: [], departmentId: null, grants: [] }, agentId: null, services: {} as ToolContext["services"], lang: "en", ...more }) as ToolContext;
const res = (content: string, ok = true): ToolResult => ({ ok, content, sources: [] });

describe("tool cache", () => {
  beforeEach(() => {
    markTools(["list_my_tasks", "search_workspace"], ["create_task", "update_task"]);
    setToolCache(true);
  });
  afterEach(() => setToolCache(false));

  it("answers the same read by the same person from its last result, inputs in any key order", () => {
    afterCall(ctx("a"), "search_workspace", { query: "x", types: ["task"] }, res("found"), 1000);
    expect(cachedRead(ctx("a"), "search_workspace", { types: ["task"], query: "x" }, 2000)?.content).toBe("found");
    // Someone else, another language, another input: not the same call.
    expect(cachedRead(ctx("b"), "search_workspace", { query: "x", types: ["task"] }, 2000)).toBeUndefined();
    expect(cachedRead(ctx("a", { lang: "vi" }), "search_workspace", { query: "x", types: ["task"] }, 2000)).toBeUndefined();
    expect(cachedRead(ctx("a"), "search_workspace", { query: "y" }, 2000)).toBeUndefined();
  });

  it("a change anywhere in the workspace (a domain event) clears everyone's results", () => {
    afterCall(ctx("a"), "list_my_tasks", {}, res("mine"), 0);
    afterCall(ctx("b"), "search_workspace", { query: "x" }, res("found"), 0);
    clearToolCache();
    expect(toolCacheSize()).toBe(0);
    expect(cachedRead(ctx("a"), "list_my_tasks", {}, 10)).toBeUndefined();
  });

  it("forgets after a minute and a half", () => {
    afterCall(ctx("a"), "list_my_tasks", {}, res("mine"), 0);
    expect(cachedRead(ctx("a"), "list_my_tasks", {}, 89_000)).toBeDefined();
    expect(cachedRead(ctx("a"), "list_my_tasks", {}, 91_000)).toBeUndefined();
  });

  it("never keeps a write, a failure, or an unknown tool; a change clears that person's results only", () => {
    afterCall(ctx("a"), "create_task", { title: "x" }, res("Created"), 0);
    afterCall(ctx("a"), "list_my_tasks", { failed: 1 }, res("no", false), 0);
    afterCall(ctx("a"), "who_knows", {}, res("?"), 0);
    expect(toolCacheSize()).toBe(0);
    afterCall(ctx("a"), "list_my_tasks", {}, res("mine"), 0);
    afterCall(ctx("b"), "list_my_tasks", {}, res("theirs"), 0);
    afterCall(ctx("a"), "update_task", { task: "T-1" }, res("Changed"), 10);
    expect(cachedRead(ctx("a"), "list_my_tasks", {}, 20)).toBeUndefined();
    expect(cachedRead(ctx("b"), "list_my_tasks", {}, 20)?.content).toBe("theirs");
  });

  it("stays bounded: the oldest go first", () => {
    for (let i = 0; i < 450; i++) afterCall(ctx("a"), "search_workspace", { query: `q${i}` }, res(`r${i}`), 0);
    expect(toolCacheSize()).toBe(400);
    expect(cachedRead(ctx("a"), "search_workspace", { query: "q0" }, 1)).toBeUndefined();
    expect(cachedRead(ctx("a"), "search_workspace", { query: "q449" }, 1)?.content).toBe("r449");
  });

  it("is off unless turned on", () => {
    setToolCache(false);
    afterCall(ctx("a"), "list_my_tasks", {}, res("mine"), 0);
    expect(cachedRead(ctx("a"), "list_my_tasks", {}, 1)).toBeUndefined();
  });
});
