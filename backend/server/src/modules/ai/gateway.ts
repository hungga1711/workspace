import {
  AnthropicProvider,
  LocalProvider,
  stoppedAnswer,
  streamOf,
  type ModelBackend,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type WebPage,
} from "./providers.js";
import { sseData } from "./stream.js";

/**
 * AI gateway ("model routing"). Every model call in the ai module goes through here; callers
 * never name a vendor or model. A route is "<provider>:<model>", chosen per request:
 *
 *   feature override (AI_ROUTES)  ─▶  tier default (AI_MODEL_FAST / AI_MODEL_SMART)
 *        │ provider error that a retry elsewhere could fix (timeout, 429, 5xx, network)
 *        ▼
 *   AI_FALLBACK routes, in order  ─▶  error to the caller
 *
 * Switching model or vendor is configuration only, e.g.
 *   GEMINI_API_KEY=…  AI_MODEL_FAST=gemini:gemini-3.8-flash  AI_MODEL_SMART=gemini:gemini-3.8-flash
 *   AI_ROUTES={"thread_summary":"anthropic:claude-haiku-5-5"}  AI_FALLBACK=anthropic:claude-sonnet-5-5
 * Without any key it runs the deterministic LocalProvider.
 */
export interface Route {
  provider: string;
  model: string;
}

export function parseRoute(spec: string): Route {
  const i = spec.indexOf(":");
  if (i <= 0 || i === spec.length - 1) throw new Error(`AI route must be "provider:model", got "${spec}"`);
  return { provider: spec.slice(0, i).trim(), model: spec.slice(i + 1).trim() };
}

/** Errors worth trying the next route for. A 400 (bad request, blocked content) would fail everywhere. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retriable: boolean,
  ) {
    super(message);
  }
}
const retriable = (e: unknown) =>
  e instanceof ProviderError
    ? e.retriable
    : typeof (e as { status?: unknown })?.status === "number"
      ? [408, 409, 429].includes((e as { status: number }).status) || (e as { status: number }).status >= 500
      : true; // network errors, timeouts

export interface GatewayConfig {
  fast: Route;
  smart: Route;
  features?: Record<string, Route>;
  fallback?: Route[];
  /** How long a route that hit a rate limit / timeout is skipped (ms). Default 60s for 429, 30s otherwise. */
  cooldownMs?: { rateLimited: number; failing: number };
}

export class AiGateway implements ModelProvider {
  /** The primary vendor; runtime.ts switches to its retrieval-first path when this is "local". */
  readonly name: string;

  /**
   * Circuit breaker: a route that just returned 429 or timed out is skipped until this time, so while a
   * vendor is rate-limited every request goes straight to the next route instead of waiting for it to fail.
   */
  private readonly openUntil = new Map<string, number>();
  /** Last success and failure per route, so admins can be told when answers come from the fallback. */
  private readonly health = new Map<string, { okAt: number; failAt: number; status: number | null }>();

  constructor(
    private readonly backends: Record<string, ModelBackend>,
    private readonly config: GatewayConfig,
    private readonly log: (line: Record<string, unknown>) => void = (l) => console.log(JSON.stringify(l)),
    private readonly now: () => number = Date.now,
  ) {
    for (const r of [config.fast, config.smart, ...Object.values(config.features ?? {}), ...(config.fallback ?? [])]) {
      if (!backends[r.provider]) throw new Error(`AI route uses provider "${r.provider}" but it is not configured (missing API key?)`);
    }
    this.name = config.smart.provider;
  }

  /**
   * Whether the main model failed on its last call in the past 15 minutes (answers then come from a
   * fallback route, or the local extractive one). Shown to workspace admins in Admin › AI.
   */
  status(): { degraded: boolean; reason?: "rate_limited" | "failing"; since?: string } {
    const h = this.health.get(`${this.config.smart.provider}:${this.config.smart.model}`);
    if (!h || h.failAt <= h.okAt || this.now() - h.failAt > 15 * 60_000) return { degraded: false };
    return { degraded: true, reason: h.status === 429 ? "rate_limited" : "failing", since: new Date(h.failAt).toISOString() };
  }

  /** Vendors with a key, for the assistant's model menu (the local extractive one is never offered). */
  providers(): string[] {
    return Object.keys(this.backends).filter((x) => x !== "local");
  }

  routesFor(req: ModelRequest): Route[] {
    const picked = req.route ? parseRoute(req.route) : null;
    const first = (picked && this.backends[picked.provider] ? picked : null) || (req.feature && this.config.features?.[req.feature]) || this.config[req.tier];
    const rest = (this.config.fallback ?? []).filter((r) => r.provider !== first.provider || r.model !== first.model);
    return [first, ...rest];
  }

  async generate(req: ModelRequest): Promise<ModelResponse> {
    const routes = this.routesFor(req);
    let last: unknown;
    for (const [i, route] of routes.entries()) {
      const key = `${route.provider}:${route.model}`;
      // Skip a cooling-down route while another one remains to try.
      if ((this.openUntil.get(key) ?? 0) > this.now() && i < routes.length - 1) {
        this.log({ msg: "ai.gateway.route_skipped", feature: req.feature, tier: req.tier, route: key, until: new Date(this.openUntil.get(key)!).toISOString() });
        continue;
      }
      const started = Date.now();
      try {
        const r = { ...(await this.backends[route.provider]!.call(route.model, req)), provider: route.provider };
        this.openUntil.delete(key);
        this.health.set(key, { ...(this.health.get(key) ?? { failAt: 0, status: null }), okAt: this.now() });
        if (i > 0) this.log({ msg: "ai.gateway.fallback_used", feature: req.feature, tier: req.tier, route: `${route.provider}:${route.model}`, attempt: i + 1 });
        return r;
      } catch (e) {
        last = e;
        // Stopped by the person: no other model should start answering instead.
        if (req.stream?.signal.aborted) throw e;
        // Part of an answer was already shown: the next route writes it again from the start.
        req.stream?.reset();
        this.log({
          msg: "ai.gateway.route_failed",
          feature: req.feature,
          tier: req.tier,
          route: `${route.provider}:${route.model}`,
          ms: Date.now() - started,
          status: (e as { status?: number }).status ?? null,
          error: (e as Error).message?.slice(0, 300),
        });
        const status = (e as { status?: number }).status ?? null;
        this.health.set(key, { ...(this.health.get(key) ?? { okAt: 0 }), failAt: this.now(), status });
        if (!retriable(e)) throw e;
        if (status === 429 || status === null || status >= 500) {
          const cd = this.config.cooldownMs ?? { rateLimited: 60_000, failing: 30_000 };
          this.openUntil.set(key, this.now() + (status === 429 ? cd.rateLimited : cd.failing));
        }
      }
    }
    throw last;
  }
}

/**
 * OpenAI Chat Completions (api.openai.com, or any compatible base URL). Used when a company wants its
 * people on GPT inside workspace instead of on chatgpt.com, where nobody sees what they paste.
 */
export class OpenAiProvider implements ModelBackend {
  readonly name = "openai";

  constructor(
    private readonly apiKey: string,
    private readonly opts: { baseUrl?: string | undefined; timeoutMs?: number; fetch?: typeof fetch; noThinking?: boolean } = {},
  ) {
    this.thinkOff = !!opts.noThinking;
  }

  /**
   * Self-hosted "thinking" models (qwen3 on Ollama) write a hidden chain of thought before every answer: a one-line
   * reply took 9-14 s instead of under one. `reasoning_effort: "none"` turns it off; a server that rejects the field is
   * asked again without it, once, and never sent it again.
   */
  private thinkOff: boolean;

  async call(model: string, req: ModelRequest): Promise<ModelResponse> {
    try {
      return await this.send(model, req);
    } catch (e) {
      if (!this.thinkOff || !(e instanceof ProviderError) || e.status !== 400 || !/reasoning/i.test(e.message)) throw e;
      this.thinkOff = false;
      return this.send(model, req);
    }
  }

  private async send(model: string, req: ModelRequest): Promise<ModelResponse> {
    const body = {
      model,
      messages: [
        { role: "system", content: req.system },
        ...req.messages.map((m) =>
          m.images?.length
            ? {
                role: m.role,
                content: [{ type: "text", text: m.content }, ...m.images.map((i) => ({ type: "image_url", image_url: { url: `data:${i.mediaType};base64,${i.data}` } }))],
              }
            : { role: m.role, content: m.content },
        ),
      ],
      max_completion_tokens: req.maxTokens,
      ...(this.thinkOff ? { reasoning_effort: "none" } : {}),
      // Chat Completions searches the web only on OpenAI's search models; other models have no web tool here.
      ...(req.web?.search && /search/i.test(model) ? { web_search_options: {} } : {}),
      ...(req.tools?.length ? { tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })) } : {}),
    };
    const live = streamOf(req);
    let res: Response;
    try {
      res = await (this.opts.fetch ?? fetch)(`${this.opts.baseUrl ?? "https://api.openai.com/v1"}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
        body: JSON.stringify(live ? { ...body, stream: true, stream_options: { include_usage: true } } : body),
        // A streamed answer may take longer than one that must arrive whole: the person watches it come.
        signal: live ? AbortSignal.any([live.signal, AbortSignal.timeout(this.opts.timeoutMs ?? 120_000)]) : AbortSignal.timeout(this.opts.timeoutMs ?? 45_000),
      });
    } catch (e) {
      if (live?.signal.aborted) return stoppedAnswer(req, "", model);
      throw new ProviderError(`openai ${model}: ${(e as Error).name === "TimeoutError" ? "timeout" : (e as Error).message}`, null, true);
    }
    // A server that does not stream answers with plain JSON: read below as usual.
    if (live && res.ok && res.body && /event-stream/.test(res.headers.get("content-type") ?? "")) return this.read(model, req, res.body, live);
    const data = (await res.json().catch(() => null)) as OpenAiResponse | null;
    if (!res.ok || !data) {
      throw new ProviderError(
        `openai ${model}: HTTP ${res.status} ${data?.error?.message ?? ""}`.trim(),
        res.status,
        res.status === 429 || res.status === 408 || res.status >= 500,
      );
    }
    const msg = data.choices?.[0]?.message;
    const cited = (msg?.annotations ?? []).flatMap((a) => (a.url_citation?.url ? [{ url: a.url_citation.url, title: a.url_citation.title || a.url_citation.url }] : []));
    return {
      ...(cited.length ? { pages: cited.slice(0, 8) } : {}),
      text: msg?.content ?? "",
      toolCalls: (msg?.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name, input: toolArgs(c.function.arguments) })),
      usage: { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0 },
      model: data.model ?? model,
    };
  }

  /** A streamed Chat Completions answer: `delta.content` pieces, then (with include_usage) the token counts. */
  private async read(model: string, req: ModelRequest, body: ReadableStream<Uint8Array>, live: NonNullable<ReturnType<typeof streamOf>>): Promise<ModelResponse> {
    let text = "";
    let usage: OpenAiResponse["usage"];
    let name: string | undefined;
    const calls: { id: string; name: string; args: string }[] = [];
    try {
      for await (const payload of sseData(body)) {
        let chunk: OpenAiChunk;
        try {
          chunk = JSON.parse(payload) as OpenAiChunk;
        } catch {
          continue;
        }
        if (chunk.error) throw new ProviderError(`openai ${model}: ${chunk.error.message ?? "stream error"}`, 502, true);
        name ??= chunk.model;
        if (chunk.usage) usage = chunk.usage;
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          text += delta;
          live.text(delta);
        }
        // A tool call comes in pieces: its id and name first, its arguments a few characters at a time, by index.
        for (const c of chunk.choices?.[0]?.delta?.tool_calls ?? []) {
          const at = (calls[c.index ?? 0] ??= { id: "", name: "", args: "" });
          if (c.id) at.id = c.id;
          if (c.function?.name) at.name = c.function.name;
          if (c.function?.arguments) at.args += c.function.arguments;
        }
      }
    } catch (e) {
      if (live.signal.aborted) return stoppedAnswer(req, text, name ?? model);
      if (e instanceof ProviderError) throw e;
      throw new ProviderError(`openai ${model}: ${(e as Error).name === "TimeoutError" ? "timeout" : (e as Error).message}`, null, true);
    }
    const stop = stoppedAnswer(req, text, name ?? model);
    const toolCalls = calls.filter((c) => c?.name).map((c, i) => ({ id: c.id || `call_${i}`, name: c.name, input: toolArgs(c.args) }));
    // Words before a tool call were not the answer: the next turn writes it.
    if (toolCalls.length && text) live.reset();
    return {
      text,
      toolCalls,
      // Servers that ignore include_usage send no counts: the rough ones keep the usage log honest about size.
      usage: usage ? { inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0 } : stop.usage,
      model: name ?? model,
    };
  }
}

interface OpenAiChunk {
  model?: string;
  choices?: { delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[];
  usage?: OpenAiResponse["usage"];
  error?: { message?: string };
}

/** Tool arguments as sent; unparseable ones (small models) become {} and the tool's validation answers. */
function toolArgs(raw: string | undefined): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(raw || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

interface OpenAiResponse {
  model?: string;
  choices?: {
    message?: {
      content?: string | null;
      tool_calls?: { id: string; function: { name: string; arguments: string } }[];
      /** A search model's sources. */
      annotations?: { url_citation?: { url?: string; title?: string } }[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

/**
 * Gemini API (generativelanguage.googleapis.com, key from Google AI Studio). Tools go as
 * `parametersJsonSchema`, so our JSON schemas pass through unchanged. Thought parts are dropped
 * from the text; thinking tokens are billed as output, so they are counted as output here too.
 */
export class GeminiProvider implements ModelBackend {
  readonly name = "gemini";

  constructor(
    private readonly apiKey: string,
    private readonly opts: { baseUrl?: string | undefined; timeoutMs?: number; thinkingLevel?: string | undefined; fetch?: typeof fetch } = {},
  ) {}

  async call(model: string, req: ModelRequest): Promise<ModelResponse> {
    try {
      return await this.send(model, req);
    } catch (e) {
      // A model that will not mix its own web tools with ours answers this web question with its own tools alone.
      if (!geminiBuiltIn(req).length || !req.tools?.length || !(e instanceof ProviderError) || e.status !== 400) throw e;
      return this.send(model, { ...req, tools: [] });
    }
  }

  private async send(model: string, req: ModelRequest): Promise<ModelResponse> {
    const builtIn = geminiBuiltIn(req);
    const body = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: req.messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [...(m.images ?? []).map((i) => ({ inlineData: { mimeType: i.mediaType, data: i.data } })), { text: m.content }],
      })),
      ...(req.tools?.length || builtIn.length
        ? {
            tools: [
              ...(req.tools?.length ? [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.inputSchema })) }] : []),
              ...builtIn,
            ],
          }
        : {}),
      generationConfig: {
        // Thinking shares the output budget; give it room so a short maxTokens still yields an answer.
        maxOutputTokens: req.maxTokens + 1024,
        // gemini-3.8-flash rejects "minimal"; "low" is the cheapest level it accepts.
        ...(this.opts.thinkingLevel ? { thinkingConfig: { thinkingLevel: this.opts.thinkingLevel } } : {}),
      },
    };
    const base = this.opts.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
    const live = streamOf(req);
    let res: Response;
    try {
      res = await (this.opts.fetch ?? fetch)(`${base}/models/${encodeURIComponent(model)}:${live ? "streamGenerateContent?alt=sse" : "generateContent"}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify(body),
        // Short enough that the gateway can still fall back within the callers' budgets (home → ai: 40s). A streamed
        // answer is watched as it comes, so it may take longer.
        signal: live ? AbortSignal.any([live.signal, AbortSignal.timeout(this.opts.timeoutMs ?? 120_000)]) : AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
      });
    } catch (e) {
      if (live?.signal.aborted) return stoppedAnswer(req, "", model);
      throw new ProviderError(`gemini ${model}: ${(e as Error).name === "TimeoutError" ? "timeout" : (e as Error).message}`, null, true);
    }
    if (live && res.ok && res.body && /event-stream/.test(res.headers.get("content-type") ?? "")) return this.read(model, req, res.body, live);
    const data = (await res.json().catch(() => null)) as GeminiResponse | null;
    if (!res.ok || !data) {
      throw new ProviderError(
        `gemini ${model}: HTTP ${res.status} ${data?.error?.message?.split("\n")[0] ?? ""}`.trim(),
        res.status,
        res.status === 429 || res.status === 408 || res.status >= 500,
      );
    }
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    if (!parts.length && (data.promptFeedback?.blockReason || candidate?.finishReason === "SAFETY")) {
      throw new ProviderError(`gemini ${model}: blocked (${data.promptFeedback?.blockReason ?? candidate?.finishReason})`, 400, false);
    }
    const text = parts
      .filter((p) => p.text && !p.thought)
      .map((p) => p.text)
      .join("");
    const toolCalls = parts.filter((p) => p.functionCall).map((p, i) => ({ id: p.functionCall!.id ?? `call_${i}`, name: p.functionCall!.name, input: p.functionCall!.args ?? {} }));
    const u = data.usageMetadata ?? {};
    return {
      text,
      toolCalls,
      usage: { inputTokens: u.promptTokenCount ?? 0, outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) },
      model: data.modelVersion ?? model,
      ...geminiGrounding([candidate]),
    };
  }

  /** streamGenerateContent: each event is a GeminiResponse with the next parts; the last one carries the usage. */
  private async read(model: string, req: ModelRequest, body: ReadableStream<Uint8Array>, live: NonNullable<ReturnType<typeof streamOf>>): Promise<ModelResponse> {
    let text = "";
    let usage: GeminiResponse["usageMetadata"];
    let name: string | undefined;
    const toolCalls: ModelResponse["toolCalls"] = [];
    const seen: GeminiCandidate[] = [];
    try {
      for await (const payload of sseData(body)) {
        let chunk: GeminiResponse;
        try {
          chunk = JSON.parse(payload) as GeminiResponse;
        } catch {
          continue;
        }
        if (chunk.error) throw new ProviderError(`gemini ${model}: ${chunk.error.message?.split("\n")[0] ?? "stream error"}`, 502, true);
        const candidate = chunk.candidates?.[0];
        if (candidate) seen.push(candidate);
        if (!text && (chunk.promptFeedback?.blockReason || candidate?.finishReason === "SAFETY"))
          throw new ProviderError(`gemini ${model}: blocked (${chunk.promptFeedback?.blockReason ?? candidate?.finishReason})`, 400, false);
        name = chunk.modelVersion ?? name;
        if (chunk.usageMetadata) usage = chunk.usageMetadata;
        const delta = (candidate?.content?.parts ?? [])
          .filter((p) => p.text && !p.thought)
          .map((p) => p.text)
          .join("");
        if (delta) {
          text += delta;
          live.text(delta);
        }
        for (const p of candidate?.content?.parts ?? [])
          if (p.functionCall) toolCalls.push({ id: p.functionCall.id ?? `call_${toolCalls.length}`, name: p.functionCall.name, input: p.functionCall.args ?? {} });
      }
    } catch (e) {
      if (live.signal.aborted) return stoppedAnswer(req, text, name ?? model);
      if (e instanceof ProviderError) throw e;
      throw new ProviderError(`gemini ${model}: ${(e as Error).name === "TimeoutError" ? "timeout" : (e as Error).message}`, null, true);
    }
    const u = usage ?? {};
    // Words before a tool call were not the answer: the next turn writes it.
    if (toolCalls.length && text) live.reset();
    return {
      text,
      toolCalls,
      usage: usage ? { inputTokens: u.promptTokenCount ?? 0, outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) } : stoppedAnswer(req, text, model).usage,
      model: name ?? model,
      ...geminiGrounding(seen),
    };
  }
}

interface GeminiCandidate {
  content?: { parts?: { text?: string; thought?: boolean; functionCall?: { id?: string; name: string; args?: Record<string, unknown> }; executableCode?: unknown }[] };
  finishReason?: string;
  /** Google Search's grounding: the queries it ran and the pages it used. */
  groundingMetadata?: { webSearchQueries?: string[]; groundingChunks?: { web?: { uri?: string; title?: string } }[] };
  /** URL context: the pages it read. */
  urlContextMetadata?: { urlMetadata?: { retrievedUrl?: string; urlRetrievalStatus?: string }[] };
}
interface GeminiResponse {
  candidates?: GeminiCandidate[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  modelVersion?: string;
  error?: { message?: string };
}

/** Gemini's own tools for a question that needs them (web-need.ts): Google Search, reading the linked pages, code. */
export function geminiBuiltIn(req: Pick<ModelRequest, "web">): Record<string, unknown>[] {
  const w = req.web;
  if (!w) return [];
  return [...(w.search ? [{ googleSearch: {} }] : []), ...(w.fetch ? [{ urlContext: {} }] : []), ...(w.code ? [{ codeExecution: {} }] : [])];
}

/** What Gemini's own tools did, from its candidates: the pages it cited and its searches and reads, for the steps. */
export function geminiGrounding(candidates: (GeminiCandidate | undefined)[]): Pick<ModelResponse, "pages" | "serverTools"> {
  const pages: WebPage[] = [];
  const serverTools: NonNullable<ModelResponse["serverTools"]> = [];
  for (const c of candidates) {
    if (!c) continue;
    for (const q of c.groundingMetadata?.webSearchQueries ?? []) if (!serverTools.some((t) => t.input.query === q)) serverTools.push({ name: "web_search", input: { query: q } });
    for (const g of c.groundingMetadata?.groundingChunks ?? []) if (g.web?.uri) pages.push({ url: g.web.uri, title: g.web.title || g.web.uri });
    for (const m of c.urlContextMetadata?.urlMetadata ?? [])
      if (m.retrievedUrl && !serverTools.some((t) => t.input.url === m.retrievedUrl)) {
        serverTools.push({ name: "web_fetch", input: { url: m.retrievedUrl } });
        if (!/ERROR|UNSAFE|PAYWALL/i.test(m.urlRetrievalStatus ?? "")) pages.push({ url: m.retrievedUrl, title: m.retrievedUrl });
      }
    if (c.content?.parts?.some((p) => p.executableCode) && !serverTools.some((t) => t.name === "code_execution")) serverTools.push({ name: "code_execution", input: {} });
  }
  const unique = pages.filter((p, i) => pages.findIndex((x) => x.url === p.url) === i).slice(0, 8);
  return { ...(unique.length ? { pages: unique } : {}), ...(serverTools.length ? { serverTools } : {}) };
}

export const DEFAULTS: Record<string, { fast: string; smart: string }> = {
  gemini: { fast: "gemini-3.8-flash", smart: "gemini-3.8-flash" },
  anthropic: { fast: "claude-haiku-5-5", smart: "claude-sonnet-5-5" },
  openai: { fast: "gpt-5-mini", smart: "gpt-5" },
  local: { fast: "local-extractive", smart: "local-extractive" },
};

/** Builds the gateway from env. Vendors are enabled by their key; routes default to the first enabled vendor. */
export function gatewayFromEnv(env: NodeJS.ProcessEnv = process.env): AiGateway {
  const { backends, config } = envGatewayParts(env);
  const gw = new AiGateway(backends, config);
  console.log(
    JSON.stringify({
      msg: "ai.gateway.config",
      providers: Object.keys(backends),
      fast: `${config.fast.provider}:${config.fast.model}`,
      smart: `${config.smart.provider}:${config.smart.model}`,
      features: Object.keys(config.features ?? {}),
      fallback: (config.fallback ?? []).map((r) => `${r.provider}:${r.model}`),
    }),
  );
  return gw;
}

/** The env-configured backends and routes; connections set in Admin › AI are layered on top (workspace-gateway.ts). */
export function envGatewayParts(env: NodeJS.ProcessEnv = process.env): { backends: Record<string, ModelBackend>; config: GatewayConfig } {
  const backends: Record<string, ModelBackend> = { local: new LocalProvider() };
  if (env.GEMINI_API_KEY)
    backends.gemini = new GeminiProvider(env.GEMINI_API_KEY, { thinkingLevel: env.GEMINI_THINKING_LEVEL || "low", baseUrl: env.GEMINI_BASE_URL || undefined });
  if (env.ANTHROPIC_API_KEY) backends.anthropic = new AnthropicProvider(env.ANTHROPIC_API_KEY);
  // An OpenAI-compatible server (Ollama, vLLM, LM Studio, LiteLLM) may need only a base URL, no key.
  if (env.OPENAI_API_KEY || env.OPENAI_BASE_URL) backends.openai = new OpenAiProvider(env.OPENAI_API_KEY ?? "", { baseUrl: env.OPENAI_BASE_URL || undefined });
  const primary = env.AI_PROVIDER || (backends.gemini ? "gemini" : backends.anthropic ? "anthropic" : backends.openai ? "openai" : "local");
  const d = DEFAULTS[primary] ?? DEFAULTS.local!;
  const features = Object.fromEntries(Object.entries(JSON.parse(env.AI_ROUTES || "{}") as Record<string, string>).map(([k, v]) => [k, parseRoute(v)]));
  // Unset: a hosted vendor degrades to the extractive local answer (free-tier 429s should not break AI for users).
  // Set to "none" to surface vendor errors instead.
  const fallbackSpec = env.AI_FALLBACK ?? (primary === "local" ? "" : "local:local-extractive");
  const fallback =
    fallbackSpec === "none"
      ? []
      : fallbackSpec
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean)
          .map(parseRoute);
  const config: GatewayConfig = {
    fast: parseRoute(env.AI_MODEL_FAST || `${primary}:${d.fast}`),
    smart: parseRoute(env.AI_MODEL_SMART || `${primary}:${d.smart}`),
    features,
    fallback,
  };
  return { backends, config };
}
