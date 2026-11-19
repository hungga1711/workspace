import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { anthropicServerTools, callWithWebTools, pagesOf } from "./anthropic-web.js";
import { claimJob, DeviceBackend, deviceKey, deviceUrl, deviceWebTools, finishJob, resetDeviceHub, touchDevice } from "./device-hub.js";
import { GeminiProvider, geminiBuiltIn, OpenAiProvider } from "./gateway.js";
import type { ModelRequest, ServerToolEvent } from "./providers.js";
import { routeIntent } from "./runtime.js";
import { selectTools } from "./tool-select.js";
import { READ as WEB_READ } from "./tools-web.js";
import { readAttachments } from "./assistant-input.js";
import type { ToolContext } from "./tools.js";

const req = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  tier: "smart",
  system: "sys",
  messages: [{ role: "user", content: "Tìm trên mạng: Next.js 15 có gì mới?" }],
  maxTokens: 512,
  ...over,
});

describe("Claude's own web tools", () => {
  it("offers the dynamic tools on current models, the basic ones on older, and never two sandboxes", () => {
    expect(anthropicServerTools("claude-sonnet-5-5", { search: true, fetch: true, code: true }).map((t) => t.type)).toEqual(["web_search_20260209", "web_fetch_20260209"]);
    expect(anthropicServerTools("claude-haiku-4-5", { search: true, code: true }).map((t) => t.type)).toEqual(["web_search_20250305", "code_execution_20260521"]);
    expect(anthropicServerTools("claude-opus-5-5", { code: true }).map((t) => t.type)).toEqual(["code_execution_20260521"]);
    expect(anthropicServerTools("claude-opus-5-5", {})).toEqual([]);
  });

  it("cites the pages it cited first, else what it fetched and the top search results", () => {
    expect(
      pagesOf([
        {
          type: "web_search_tool_result",
          content: [
            { url: "https://a.dev", title: "A" },
            { url: "https://b.dev", title: "B" },
          ],
        },
        { type: "text", text: "x", citations: [{ type: "web_search_result_location", url: "https://b.dev", title: "B" }] },
      ]),
    ).toEqual([{ url: "https://b.dev", title: "B" }]);
    expect(pagesOf([{ type: "web_search_tool_result", content: [{ url: "https://a.dev", title: "A" }] }])).toEqual([{ url: "https://a.dev", title: "A" }]);
  });

  /** A stand-in client: each create() streams the next turn's events. */
  const client = (turns: Record<string, unknown>[][]) => {
    const sent: Record<string, unknown>[] = [];
    const c = {
      messages: {
        create: vi.fn(async (params: Record<string, unknown>) => {
          sent.push(params);
          const events = turns[sent.length - 1] ?? [];
          return (async function* () {
            for (const e of events) yield e;
          })();
        }),
      },
    } as unknown as Anthropic;
    return { c, sent };
  };
  const turn = (stop: string, blocks: Record<string, unknown>[], deltas: Record<number, Record<string, unknown>[]> = {}) => [
    { type: "message_start", message: { usage: { input_tokens: 10 } } },
    ...blocks.flatMap((b, i) => [
      { type: "content_block_start", index: i, content_block: b },
      ...(deltas[i] ?? []).map((d) => ({ type: "content_block_delta", index: i, delta: d })),
      { type: "content_block_stop", index: i },
    ]),
    { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ];

  it("streams the answer after its search, reports the search as a step, and carries on after a pause", async () => {
    const { c, sent } = client([
      turn(
        "pause_turn",
        [
          { type: "text", text: "Let me look." },
          { type: "server_tool_use", id: "srv1", name: "web_search", input: {} },
          { type: "web_search_tool_result", tool_use_id: "srv1", content: [{ type: "web_search_result", url: "https://nextjs.org/blog/next-15", title: "Next.js 15" }] },
        ],
        { 1: [{ type: "input_json_delta", partial_json: '{"query":"next.js 15"}' }] },
      ),
      turn("end_turn", [{ type: "text", text: "" }], {
        0: [
          { type: "text_delta", text: "Next.js 15 adds " },
          { type: "text_delta", text: "async APIs." },
        ],
      }),
    ]);
    const events: ServerToolEvent[] = [];
    const written: string[] = [];
    const live = { text: (d: string) => written.push(d), reset: () => written.push("<reset>"), signal: new AbortController().signal };
    const r = await callWithWebTools(
      c,
      "claude-sonnet-5-5",
      { model: "claude-sonnet-5-5", max_tokens: 512, system: "s", messages: [{ role: "user", content: "q" }] },
      {
        ...req({ web: { search: true }, stream: live }),
        onServerTool: (e) => events.push(e),
      },
    );
    expect(r.text).toBe("Next.js 15 adds async APIs.");
    expect(r.pages).toEqual([{ url: "https://nextjs.org/blog/next-15", title: "Next.js 15" }]);
    expect(r.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
    expect(events).toEqual([
      { phase: "start", id: "srv1", name: "web_search", input: { query: "next.js 15" } },
      { phase: "end", id: "srv1", ok: true, found: 1, pages: [{ url: "https://nextjs.org/blog/next-15", title: "Next.js 15" }] },
    ]);
    // Words before the search were voided; the answer was written as it came.
    expect(written.join("")).toBe("Let me look.<reset>Next.js 15 adds async APIs.");
    // The paused turn went back with what came so far, its search included and nothing the stream added for itself.
    expect(sent).toHaveLength(2);
    const resent = (sent[1]!.messages as { role: string; content: Record<string, unknown>[] }[]).at(-1)!;
    expect(resent.role).toBe("assistant");
    expect(resent.content[1]).toEqual({ type: "server_tool_use", id: "srv1", name: "web_search", input: { query: "next.js 15" } });
    expect((sent[0]!.tools as { type?: string }[]).map((t) => t.type)).toContain("web_search_20260209");
  });

  it("an error from a web tool fails its step without raising", async () => {
    const { c } = client([
      turn("end_turn", [
        { type: "server_tool_use", id: "s", name: "web_fetch", input: { url: "https://x.dev" } },
        { type: "web_fetch_tool_result", tool_use_id: "s", content: { type: "web_fetch_tool_error", error_code: "url_not_accessible" } },
        { type: "text", text: "I could not open that page." },
      ]),
    ]);
    const events: ServerToolEvent[] = [];
    const r = await callWithWebTools(c, "claude-opus-5-5", { messages: [] }, { ...req({ web: { fetch: true } }), onServerTool: (e) => events.push(e) });
    expect(r.text).toBe("I could not open that page.");
    expect(events.at(-1)).toEqual({ phase: "end", id: "s", ok: false });
  });
});

describe("Gemini's and OpenAI's own web tools", () => {
  it("adds Google Search, URL context and code only for what the question needs", () => {
    expect(geminiBuiltIn({ web: { search: true, fetch: true, code: true } })).toEqual([{ googleSearch: {} }, { urlContext: {} }, { codeExecution: {} }]);
    expect(geminiBuiltIn({})).toEqual([]);
  });

  it("cites Gemini's grounding pages and reports its searches", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch = vi.fn(async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: { parts: [{ text: "Next.js 15 adds async APIs." }] },
              groundingMetadata: { webSearchQueries: ["next.js 15 release"], groundingChunks: [{ web: { uri: "https://nextjs.org/blog/next-15", title: "nextjs.org" } }] },
            },
          ],
          usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const g = new GeminiProvider("k", { fetch: fetch as unknown as typeof globalThis.fetch });
    const r = await g.call("gemini-3.8-flash", req({ web: { search: true }, tools: [{ name: "search_workspace", description: "d", inputSchema: {} }] }));
    expect(r.pages).toEqual([{ url: "https://nextjs.org/blog/next-15", title: "nextjs.org" }]);
    expect(r.serverTools).toEqual([{ name: "web_search", input: { query: "next.js 15 release" } }]);
    expect((bodies[0]!.tools as unknown[]).at(-1)).toEqual({ googleSearch: {} });
  });

  it("asks OpenAI to search only on its search models", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch = vi.fn(async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok", annotations: [{ url_citation: { url: "https://a.dev", title: "A" } }] } }] }), { status: 200 });
    });
    const o = new OpenAiProvider("k", { fetch: fetch as unknown as typeof globalThis.fetch });
    const r = await o.call("gpt-5-search-api", req({ web: { search: true } }));
    await o.call("gpt-5", req({ web: { search: true } }));
    expect(bodies[0]!.web_search_options).toEqual({});
    expect(bodies[1]!.web_search_options).toBeUndefined();
    expect(r.pages).toEqual([{ url: "https://a.dev", title: "A" }]);
  });
});

describe("a computer's AI and the fallback page reader", () => {
  it("keeps only the agent's web tools from what it reports", () => {
    expect(
      deviceWebTools([
        { name: "WebSearch", input: { query: "q" } },
        { name: "Bash", input: { command: "rm -rf /" } },
        { name: "WebFetch", input: { url: "https://a.dev", prompt: "x" } },
      ]),
    ).toEqual([
      { name: "web_search", input: { query: "q" } },
      { name: "web_fetch", input: { url: "https://a.dev" } },
    ]);
  });

  it("tells a computer's AI the question needs the web, never for code, and cites what it found", async () => {
    resetDeviceHub();
    const key = deviceKey("u1", "mac");
    touchDevice(key);
    const backend = new DeviceBackend(deviceUrl("u1", "mac", "claude-code"), 5_000);
    const answer = backend.call("", req({ web: { search: true, code: true } }));
    const job = await claimJob(key, 1_000);
    expect(job?.web).toEqual({ search: true });
    finishJob(job!.id, {
      text: "Next.js 15 adds async APIs.",
      tools: [{ name: "WebSearch", input: { query: "next.js 15" } }],
      pages: [
        { url: "https://nextjs.org/blog/next-15", title: "Next.js 15" },
        { url: "javascript:alert(1)", title: "x" },
      ],
    });
    const r = await answer;
    expect(r.serverTools).toEqual([{ name: "web_search", input: { query: "next.js 15" } }]);
    expect(r.pages).toEqual([{ url: "https://nextjs.org/blog/next-15", title: "Next.js 15" }]);
    // An ordinary question goes without it.
    const plain = backend.call("", req({ messages: [{ role: "user", content: "Ai đang quá tải?" }] }));
    const job2 = await claimJob(key, 1_000);
    expect(job2?.web).toBeUndefined();
    finishJob(job2!.id, { text: "ok" });
    await plain;
  });

  it("offers read_webpage only for a question that links a page, and routes it there first", () => {
    const names = ["search_workspace", "read_webpage", "workload_balance"];
    expect(selectTools(names, "Tóm tắt trang https://example.com").has("read_webpage")).toBe(true);
    expect(selectTools(names, "Ai đang quá tải?").has("read_webpage")).toBe(false);
    expect(selectTools(names, "xem http://localhost:3000/app/work/tasks/T-1").has("read_webpage")).toBe(false);
    expect(routeIntent("Tóm tắt trang https://example.com giúp mình", names)).toEqual({ tool: "read_webpage", input: { url: "https://example.com/" } });
    expect(routeIntent("Ai đang quá tải?", names)?.tool).toBe("workload_balance");
  });

  it("reads a page through the work module and cites it as an outside link; a refused address says why", async () => {
    const tool = WEB_READ.find((t) => t.name === "read_webpage")!;
    const request = vi.fn(async (_m: string, path: string) =>
      path.includes("internal")
        ? { ok: false, kind: "web", problem: "refused" }
        : { ok: true, kind: "web", text: "Example Domain. This domain is for use in examples.", cut: false },
    );
    const ctx = { principal: { id: "u" }, services: { work: { request } }, lang: "vi" } as unknown as ToolContext;
    const r = await tool.run(ctx, { url: "https://example.com/" });
    expect(r.content).toContain("Example Domain");
    expect(r.sources).toEqual([{ type: "web", id: "https://example.com/", title: "example.com", url: "https://example.com/" }]);
    expect(request.mock.calls[0]![1]).toBe("/link-text?url=https%3A%2F%2Fexample.com%2F");
    await expect(tool.run(ctx, { url: "https://internal.example/" })).rejects.toThrow(/địa chỉ nội bộ/);
  });
});

describe("Office files attached in Hỏi đáp", () => {
  it("reads Word, Excel and PowerPoint as text; refuses a damaged one", async () => {
    const xlsx = zip({
      "xl/workbook.xml": '<workbook><sheets><sheet name="Q3" sheetId="1"/></sheets></workbook>',
      "xl/sharedStrings.xml": "<sst><si><t>Month</t></si><si><t>Revenue</t></si></sst>",
      "xl/worksheets/sheet1.xml":
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2"><v>7</v></c><c r="B2"><v>120</v></c></row></sheetData></worksheet>',
    });
    const docx = zip({ "word/document.xml": "<w:document><w:body><w:p><w:r><w:t>Hợp đồng</w:t></w:r></w:p></w:body></w:document>" });
    const files = await readAttachments([
      { name: "q3.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", data: xlsx.toString("base64") },
      { name: "hd.docx", contentType: "", data: docx.toString("base64") },
    ]);
    expect(files.map((f) => f.text)).toEqual(["Sheet: Q3\nMonth,Revenue\n7,120", "Hợp đồng"]);
    await expect(readAttachments([{ name: "broken.pptx", contentType: "", data: Buffer.from("nope").toString("base64") }])).rejects.toThrow();
    await expect(readAttachments([{ name: "old.xls", contentType: "application/vnd.ms-excel", data: Buffer.from("x").toString("base64") }])).rejects.toThrow();
  });
});

function zip(files: Record<string, string>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const n = Buffer.from(name);
    const data = Buffer.from(text);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt32LE(data.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(n.length, 26);
    local.push(head, n, data);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(n.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, n);
    offset += 30 + n.length + data.length;
  }
  const dirs = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dirs.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, dirs, end]);
}
