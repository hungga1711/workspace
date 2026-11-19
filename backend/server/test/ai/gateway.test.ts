import { describe, expect, it } from "vitest";
import { AiGateway, GeminiProvider, gatewayFromEnv, OpenAiProvider, parseRoute, ProviderError } from "../../src/modules/ai/gateway.js";
import type { ModelBackend, ModelRequest, ModelResponse, ModelStream } from "../../src/modules/ai/providers.js";

const req = (over: Partial<ModelRequest> = {}): ModelRequest => ({ tier: "smart", system: "s", messages: [{ role: "user", content: "hi" }], maxTokens: 100, ...over });
const ok = (model: string): ModelResponse => ({ text: `from ${model}`, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, model });

/** Records which model was asked, and fails the ones listed. */
function backend(name: string, fail: Record<string, unknown> = {}): ModelBackend & { calls: string[] } {
  const calls: string[] = [];
  return {
    name,
    calls,
    async call(model) {
      calls.push(model);
      if (fail[model]) throw fail[model];
      return ok(model);
    },
  };
}
const quiet = () => undefined;

describe("parseRoute", () => {
  it("splits provider and model on the first colon", () => {
    expect(parseRoute("gemini:gemini-3.8-flash")).toEqual({ provider: "gemini", model: "gemini-3.8-flash" });
  });
  it("rejects a spec without a model", () => {
    expect(() => parseRoute("gemini")).toThrow(/provider:model/);
    expect(() => parseRoute("gemini:")).toThrow(/provider:model/);
  });
});

describe("AiGateway routing", () => {
  it("uses the tier route, and a feature override when one exists", async () => {
    const g = backend("gemini");
    const gw = new AiGateway({ gemini: g }, { fast: parseRoute("gemini:flash"), smart: parseRoute("gemini:pro"), features: { thread_summary: parseRoute("gemini:lite") } }, quiet);
    await gw.generate(req({ tier: "fast" }));
    await gw.generate(req({ tier: "smart" }));
    await gw.generate(req({ tier: "smart", feature: "thread_summary" }));
    expect(g.calls).toEqual(["flash", "pro", "lite"]);
    expect(gw.name).toBe("gemini");
  });

  it("falls back to the next route on 429 and reports which model answered", async () => {
    const g = backend("gemini", { pro: new ProviderError("quota", 429, true) });
    const a = backend("anthropic");
    const logs: Record<string, unknown>[] = [];
    const gw = new AiGateway({ gemini: g, anthropic: a }, { fast: parseRoute("gemini:flash"), smart: parseRoute("gemini:pro"), fallback: [parseRoute("anthropic:sonnet")] }, (l) =>
      logs.push(l),
    );
    const r = await gw.generate(req());
    expect(r.model).toBe("sonnet");
    expect(logs.map((l) => l.msg)).toEqual(["ai.gateway.route_failed", "ai.gateway.fallback_used"]);
  });

  it("tells admins the main model is failing over, and clears once it answers again", async () => {
    let t = 1_000_000;
    const fail: Record<string, unknown> = { pro: new ProviderError("quota", 429, true) };
    const g = backend("gemini", fail);
    const gw = new AiGateway(
      { gemini: g, anthropic: backend("anthropic") },
      { fast: parseRoute("gemini:flash"), smart: parseRoute("gemini:pro"), fallback: [parseRoute("anthropic:sonnet")] },
      quiet,
      () => t,
    );
    expect(gw.status()).toEqual({ degraded: false });
    await gw.generate(req());
    expect(gw.status()).toMatchObject({ degraded: true, reason: "rate_limited" });
    t += 16 * 60_000; // nothing tried for a while: no longer reported
    expect(gw.status()).toEqual({ degraded: false });
    await gw.generate(req());
    delete fail.pro;
    t += 61_000;
    await gw.generate(req());
    expect(gw.status()).toEqual({ degraded: false });
  });

  it("skips a rate-limited route for a while, then tries it again", async () => {
    let t = 1_000_000;
    const g = backend("gemini", { pro: new ProviderError("quota", 429, true) });
    const a = backend("anthropic");
    const logs: Record<string, unknown>[] = [];
    const gw = new AiGateway(
      { gemini: g, anthropic: a },
      { fast: parseRoute("gemini:flash"), smart: parseRoute("gemini:pro"), fallback: [parseRoute("anthropic:sonnet")], cooldownMs: { rateLimited: 60_000, failing: 30_000 } },
      (l) => logs.push(l),
      () => t,
    );
    await gw.generate(req());
    await gw.generate(req()); // within the cooldown: gemini is not called again
    expect(g.calls).toEqual(["pro"]);
    expect(logs.some((l) => l.msg === "ai.gateway.route_skipped")).toBe(true);
    t += 61_000;
    await gw.generate(req()); // cooldown over: gemini is tried again
    expect(g.calls).toEqual(["pro", "pro"]);
  });

  it("still calls a cooling-down route when it is the only one left", async () => {
    let t = 0;
    const g = backend("gemini", { pro: new ProviderError("quota", 429, true) });
    const gw = new AiGateway({ gemini: g }, { fast: parseRoute("gemini:flash"), smart: parseRoute("gemini:pro") }, quiet, () => t);
    await expect(gw.generate(req())).rejects.toThrow("quota");
    t += 1;
    await expect(gw.generate(req())).rejects.toThrow("quota");
    expect(g.calls).toEqual(["pro", "pro"]);
  });

  it("does not fall back on a non-retriable error (bad request / blocked)", async () => {
    const g = backend("gemini", { pro: new ProviderError("blocked", 400, false) });
    const a = backend("anthropic");
    const gw = new AiGateway({ gemini: g, anthropic: a }, { fast: parseRoute("gemini:flash"), smart: parseRoute("gemini:pro"), fallback: [parseRoute("anthropic:sonnet")] }, quiet);
    await expect(gw.generate(req())).rejects.toThrow("blocked");
    expect(a.calls).toEqual([]);
  });

  it("throws the last error when every route fails", async () => {
    const g = backend("gemini", { pro: new ProviderError("down", 503, true) });
    const a = backend("anthropic", { sonnet: new ProviderError("also down", 500, true) });
    const gw = new AiGateway({ gemini: g, anthropic: a }, { fast: parseRoute("gemini:flash"), smart: parseRoute("gemini:pro"), fallback: [parseRoute("anthropic:sonnet")] }, quiet);
    await expect(gw.generate(req())).rejects.toThrow("also down");
  });

  it("refuses a route whose provider has no key", () => {
    expect(() => new AiGateway({ gemini: backend("gemini") }, { fast: parseRoute("gemini:a"), smart: parseRoute("anthropic:b") }, quiet)).toThrow(/not configured/);
  });
});

describe("gatewayFromEnv", () => {
  it("runs locally without any key", () => {
    expect(gatewayFromEnv({}).name).toBe("local");
  });
  it("prefers Gemini when its key is set, with env-switchable models", () => {
    const gw = gatewayFromEnv({ GEMINI_API_KEY: "k", AI_MODEL_FAST: "gemini:gemini-3.5-flash-lite", AI_ROUTES: '{"ask":"gemini:gemini-3.8-flash"}' });
    expect(gw.name).toBe("gemini");
    expect(gw.routesFor(req({ tier: "fast" }))[0]).toEqual({ provider: "gemini", model: "gemini-3.5-flash-lite" });
    expect(gw.routesFor(req({ tier: "fast", feature: "ask" }))[0]).toEqual({ provider: "gemini", model: "gemini-3.8-flash" });
  });
  it("degrades to the local provider by default, unless AI_FALLBACK=none", () => {
    expect(
      gatewayFromEnv({ GEMINI_API_KEY: "k" })
        .routesFor(req())
        .map((r) => r.provider),
    ).toEqual(["gemini", "local"]);
    expect(
      gatewayFromEnv({ GEMINI_API_KEY: "k", AI_FALLBACK: "none" })
        .routesFor(req())
        .map((r) => r.provider),
    ).toEqual(["gemini"]);
  });
});

describe("GeminiProvider", () => {
  const reply = (status: number, body: unknown): typeof fetch => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("maps text, tool calls and usage (thinking counted as output), and skips thought parts", async () => {
    let sent: { url: string; body: Record<string, unknown> } | null = null;
    const f = (async (url: string, init: RequestInit) => {
      sent = { url, body: JSON.parse(String(init.body)) };
      return new Response(
        JSON.stringify({
          candidates: [
            { content: { parts: [{ text: "thinking…", thought: true }, { text: "Chào" }, { functionCall: { id: "c1", name: "search_messages", args: { query: "x" } } }] } },
          ],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 7 },
          modelVersion: "gemini-3.8-flash",
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const p = new GeminiProvider("key", { fetch: f });
    const r = await p.call(
      "gemini-3.8-flash",
      req({
        messages: [
          { role: "user", content: "q" },
          { role: "assistant", content: "a" },
        ],
        tools: [{ name: "search_messages", description: "d", inputSchema: { type: "object" } }],
      }),
    );
    expect(r).toEqual({
      text: "Chào",
      toolCalls: [{ id: "c1", name: "search_messages", input: { query: "x" } }],
      usage: { inputTokens: 10, outputTokens: 12 },
      model: "gemini-3.8-flash",
    });
    expect(sent!.url).toContain("/models/gemini-3.8-flash:generateContent");
    expect((sent!.body.contents as { role: string }[]).map((c) => c.role)).toEqual(["user", "model"]);
    expect(JSON.stringify(sent!.body.tools)).toContain("parametersJsonSchema");
  });

  it("marks 429 and 5xx retriable, 400 not", async () => {
    await expect(new GeminiProvider("k", { fetch: reply(429, { error: { message: "quota" } }) }).call("m", req())).rejects.toMatchObject({ status: 429, retriable: true });
    await expect(new GeminiProvider("k", { fetch: reply(503, {}) }).call("m", req())).rejects.toMatchObject({ status: 503, retriable: true });
    await expect(new GeminiProvider("k", { fetch: reply(400, { error: { message: "bad" } }) }).call("m", req())).rejects.toMatchObject({ status: 400, retriable: false });
  });

  it("reports a blocked prompt as non-retriable", async () => {
    await expect(new GeminiProvider("k", { fetch: reply(200, { promptFeedback: { blockReason: "SAFETY" } }) }).call("m", req())).rejects.toMatchObject({ retriable: false });
  });
});

describe("streamed answers (Hỏi đáp)", () => {
  /** A stream that records what reached the person: pieces, and a "|" for each reset. */
  const watch = () => {
    const stop = new AbortController();
    let seen = "";
    const stream: ModelStream = { text: (d) => void (seen += d), reset: () => void (seen += "|"), signal: stop.signal };
    return { stream, stop, seen: () => seen };
  };
  const sse = (...events: unknown[]) =>
    new Response(events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });

  it("OpenAI-compatible servers (Ollama, LM Studio…): text as it comes, the usage at the end", async () => {
    let sent: Record<string, unknown> = {};
    const f = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return sse(
        { model: "llama3", choices: [{ delta: { content: "Xin " } }] },
        { choices: [{ delta: { content: "chào" } }] },
        { choices: [], usage: { prompt_tokens: 9, completion_tokens: 2 } },
        "[DONE]",
      );
    }) as unknown as typeof fetch;
    const w = watch();
    const r = await new OpenAiProvider("", { baseUrl: "http://ollama/v1", fetch: f }).call("llama3", req({ stream: w.stream }));
    expect(sent).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(w.seen()).toBe("Xin chào");
    expect(r).toEqual({ text: "Xin chào", toolCalls: [], usage: { inputTokens: 9, outputTokens: 2 }, model: "llama3" });
  });

  it("a server that answers plain JSON anyway is read as before", async () => {
    const f = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "whole" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
        status: 200,
      })) as unknown as typeof fetch;
    const w = watch();
    const r = await new OpenAiProvider("k", { fetch: f }).call("m", req({ stream: w.stream }));
    expect(r.text).toBe("whole");
    expect(w.seen()).toBe("");
  });

  it("streams a turn with tools too: a tool call comes back whole, and what the turn wrote is voided", async () => {
    const w = watch();
    let sent: Record<string, unknown> = {};
    const events = [
      { choices: [{ delta: { content: "Let me look." } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "search_workspace", arguments: '{"que' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ry":"refund"}' } }] } }] },
      { choices: [], usage: { prompt_tokens: 9, completion_tokens: 4 } },
    ];
    const f = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const r = await new OpenAiProvider("k", { fetch: f }).call("m", req({ stream: w.stream, tools: [{ name: "search_workspace", description: "d", inputSchema: {} }] }));
    expect(sent.stream).toBe(true);
    expect(r.toolCalls).toEqual([{ id: "call_1", name: "search_workspace", input: { query: "refund" } }]);
    // The words before the call were not the answer: the reader's screen starts over ("|" marks the reset).
    expect(w.seen()).toBe("Let me look.|");
    expect(r.usage).toEqual({ inputTokens: 9, outputTokens: 4 });
  });

  it("stopped part-way: ends with what was written, usage counted roughly", async () => {
    const w = watch();
    const f = (async (_url: string, init: RequestInit) => {
      const signal = init.signal!;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "Half" } }] })}\n\n`));
            signal.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
            setTimeout(() => w.stop.abort(), 10);
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;
    const r = await new OpenAiProvider("k", { fetch: f }).call("m", req({ stream: w.stream }));
    expect(r).toMatchObject({ text: "Half", stopped: true });
    expect(r.usage.outputTokens).toBe(1);
  });

  it("Gemini streams through streamGenerateContent, thoughts left out", async () => {
    let url = "";
    const f = (async (u: string) => {
      url = u;
      return sse(
        { candidates: [{ content: { parts: [{ text: "hmm", thought: true }, { text: "Hel" }] } }] },
        { candidates: [{ content: { parts: [{ text: "lo" }] } }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 }, modelVersion: "gemini-x" },
      );
    }) as unknown as typeof fetch;
    const w = watch();
    const r = await new GeminiProvider("k", { fetch: f }).call("gemini-x", req({ stream: w.stream }));
    expect(url).toContain(":streamGenerateContent?alt=sse");
    expect(w.seen()).toBe("Hello");
    expect(r).toEqual({ text: "Hello", toolCalls: [], usage: { inputTokens: 4, outputTokens: 2 }, model: "gemini-x" });
  });

  it("a route that fails part-way is reset before the next one writes the answer again", async () => {
    const half: ModelBackend = {
      name: "a",
      async call(_m, r) {
        r.stream!.text("Half ");
        throw new ProviderError("a: HTTP 503", 503, true);
      },
    };
    const whole: ModelBackend = {
      name: "b",
      async call(m, r) {
        r.stream!.text("Whole");
        return ok(m);
      },
    };
    const gw = new AiGateway({ a: half, b: whole }, { fast: parseRoute("a:x"), smart: parseRoute("a:x"), fallback: [parseRoute("b:y")] }, quiet);
    const w = watch();
    await gw.generate(req({ stream: w.stream }));
    expect(w.seen()).toBe("Half |Whole");
  });

  it("no other route starts answering after the person pressed stop", async () => {
    const w = watch();
    const b = backend("b");
    const a: ModelBackend = {
      name: "a",
      async call() {
        w.stop.abort();
        throw new ProviderError("a: aborted", null, true);
      },
    };
    const gw = new AiGateway({ a, b }, { fast: parseRoute("a:x"), smart: parseRoute("a:x"), fallback: [parseRoute("b:y")] }, quiet);
    await expect(gw.generate(req({ stream: w.stream }))).rejects.toThrow(/aborted/);
    expect(b.calls).toEqual([]);
  });
});
