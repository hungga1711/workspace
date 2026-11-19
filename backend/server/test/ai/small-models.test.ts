import { describe, expect, it } from "vitest";
import { repairToolInput, textToolCalls } from "../../src/modules/ai/runtime.js";

// Shapes seen from qwen2.5:1.5b, llama3.2:1b and qwen3:1.7b on Ollama (2026-10).
describe("tool calls from small models", () => {
  it("unwraps arguments sent as a JSON schema or as typed values", () => {
    expect(repairToolInput({ type: "object", properties: { status: "todo" } })).toEqual({ status: "todo" });
    expect(repairToolInput({ query: { type: "string", value: "quy trình nghỉ phép" } })).toEqual({ query: "quy trình nghỉ phép" });
    expect(repairToolInput('{"query":"x"}')).toEqual({ query: "x" });
    expect(repairToolInput("not json")).toEqual({});
    expect(repairToolInput(undefined)).toEqual({});
    // Ordinary arguments pass unchanged; the tool's own validation still decides.
    expect(repairToolInput({ query: "x", limit: 5, filters: { a: 1 } })).toEqual({ query: "x", limit: 5, filters: { a: 1 } });
  });

  it("takes a tool call written as the whole answer, only for allowed tools", () => {
    expect(textToolCalls('{"name": "search_documents", "parameters": {"query": "ngân sách"}}', ["search_documents"])).toEqual([
      { id: "text_search_documents", name: "search_documents", input: { query: "ngân sách" } },
    ]);
    expect(textToolCalls('```json\n{"name":"list_my_tasks","arguments":{"type":"object","properties":{}}}\n```', ["list_my_tasks"])).toEqual([
      { id: "text_list_my_tasks", name: "list_my_tasks", input: {} },
    ]);
    expect(textToolCalls('{"name": "Email", "parameters": {"to": "Khách hàng"}}', ["search_documents"])).toEqual([]);
    expect(textToolCalls('Đây là email: {"name": "search_documents"}', ["search_documents"])).toEqual([]);
  });
});
