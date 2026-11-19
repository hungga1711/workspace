import { z } from "zod";
import { secretBox } from "@workspace/service-kit";
import { AnthropicProvider, type ModelBackend } from "./providers.js";
import { DEFAULTS, GeminiProvider, OpenAiProvider, ProviderError } from "./gateway.js";
import { DeviceBackend, parseDeviceUrl } from "./device-hub.js";

/**
 * The company's own AI connections (Admin › AI), one gateway with three ways in:
 *
 *   key      — a vendor API key: OpenAI, Anthropic or Gemini. Models default per vendor.
 *   api      — an OpenAI-compatible LLM API: OpenRouter, LiteLLM, Azure OpenAI, Groq, vLLM… (base URL + key + model).
 *   selfhost — a model the company runs itself: Ollama, LM Studio, llama.cpp server (base URL, usually no key).
 *   device   — the AI on an admin's own connected computer (workspace-connect.mjs): a command-line agent or a local
 *              model there. Made in one click from what that computer found (local-connect.ts), never typed in.
 *
 * All three end up as gateway backends (gateway.ts), so every AI feature, the quota and the usage log work
 * the same whichever way the company connects. Keys are encrypted here, before they reach the database.
 */
const MODES = ["key", "api", "selfhost", "device"] as const;
export type Mode = (typeof MODES)[number];
const KEY_VENDORS = ["openai", "anthropic", "gemini"] as const;
export type Vendor = (typeof KEY_VENDORS)[number] | "openai_compatible" | "device";

export interface ConnectionRow {
  id: string;
  mode: Mode;
  vendor: Vendor;
  name: string;
  base_url: string | null;
  api_key_enc: string | null;
  key_hint: string | null;
  model_fast: string;
  model_smart: string;
  is_default: boolean;
  enabled: boolean;
  tested_at: Date | null;
  test_ok: boolean | null;
  test_error: string | null;
  tools_ok: boolean | null;
  /** The AI may use its own web and cloud tools when a question needs them (web-need.ts). */
  web_tools: boolean;
  updated_at: Date;
}
export const CONNECTION_COLS =
  "id, mode, vendor, name, base_url, api_key_enc, key_hint, model_fast, model_smart, is_default, enabled, tested_at, test_ok, test_error, tools_ok, web_tools, updated_at";

/** What admins see: never the key, only its last four characters. */
export const connectionDto = (r: ConnectionRow) => ({
  id: r.id,
  mode: r.mode,
  vendor: r.vendor,
  name: r.name,
  baseUrl: r.base_url,
  hasKey: !!r.api_key_enc,
  keyHint: r.key_hint,
  modelFast: r.model_fast,
  modelSmart: r.model_smart,
  isDefault: r.is_default,
  enabled: r.enabled,
  test: r.tested_at ? { at: r.tested_at, ok: !!r.test_ok, error: r.test_error } : null,
  /** Whether the main model calls tools (null: not tested yet). */
  tools: r.tools_ok,
  /** Its own web tools (search, reading pages, code) when a question needs them. */
  web: r.web_tools !== false,
  updatedAt: r.updated_at,
});

// ---------------------------------------------------------------- input

const url = z
  .string()
  .trim()
  .max(500)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === "https:" || u.protocol === "http:";
    } catch {
      return false;
    }
  }, "must be an http(s) URL");
const model = z.string().trim().min(1).max(200);

/** A connection as an admin enters it. `apiKey` omitted on an edit keeps the stored key. */
export const ConnectionInput = z
  .object({
    mode: z.enum(MODES),
    vendor: z.enum([...KEY_VENDORS, "openai_compatible"]).optional(),
    name: z.string().trim().min(1).max(80).optional(),
    baseUrl: url.optional().nullable(),
    apiKey: z.string().trim().max(2000).optional().nullable(),
    modelFast: model.optional().nullable(),
    modelSmart: model.optional().nullable(),
    enabled: z.boolean().optional(),
  })
  .superRefine((b, ctx) => {
    if (b.mode === "key" && !(KEY_VENDORS as readonly string[]).includes(b.vendor ?? ""))
      ctx.addIssue({ code: "custom", path: ["vendor"], message: "pick OpenAI, Anthropic or Gemini" });
    // A device connection is edited only as a whole (on/off, default): its address never comes from a form.
    if (b.mode === "device") return;
    if (b.mode !== "key" && !b.baseUrl) ctx.addIssue({ code: "custom", path: ["baseUrl"], message: "base URL is required" });
    if (b.mode !== "key" && b.baseUrl && new URL(b.baseUrl).protocol === "http:" && b.mode === "api" && !isPrivateHost(new URL(b.baseUrl).hostname))
      ctx.addIssue({ code: "custom", path: ["baseUrl"], message: "a public LLM API must use https" });
  });
export type ConnectionInput = z.infer<typeof ConnectionInput>;

/** Hosts a self-hosted model typically lives on (plain http is fine there: same machine or company network). */
export function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "");
  return (
    h === "localhost" ||
    !h.includes(".") || // docker service names: ollama, llm…
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    h === "::1" ||
    (h.includes(":") && /^f[cd]/i.test(h)) // IPv6 unique-local (fc00::/7), not names like fcdn.example.com
  );
}

/**
 * Normalises what admins paste: no trailing slash, and for OpenAI-compatible servers the `/v1` path that
 * Ollama, LM Studio, vLLM and llama.cpp all serve when only a host was given (http://ollama:11434).
 */
export function normaliseBaseUrl(mode: Mode, raw: string | null | undefined): string | null {
  if (!raw || mode === "key") return null;
  const u = new URL(raw.trim());
  let path = u.pathname.replace(/\/+$/, "");
  if (!path) path = "/v1";
  return `${u.origin}${path}${u.search}`;
}

/** A connection that cannot work as entered; the controller answers 400 with the field. */
export class InvalidConnection extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Whether a stored key may be reused for what was entered. Only for the same vendor, mode and address:
 * otherwise an edit (or a "Kiểm tra") could send the company's real key to a different server.
 */
export function sameEndpoint(prev: ConnectionRow, r: { mode: Mode; vendor: Vendor; baseUrl: string | null }): boolean {
  return prev.mode === r.mode && prev.vendor === r.vendor && (prev.base_url ?? null) === (r.baseUrl ?? null);
}

/** Resolved fields for a new connection or an edit merged over the stored one. */
export function resolve(b: ConnectionInput, prev?: ConnectionRow) {
  if (b.mode === "device") {
    if (!prev || prev.mode !== "device") throw new InvalidConnection("mode", "connect a computer first, then choose its AI");
    return { mode: prev.mode, vendor: prev.vendor, baseUrl: prev.base_url, modelFast: prev.model_fast, modelSmart: prev.model_smart, name: b.name || prev.name };
  }
  const vendor: Vendor = b.mode === "key" ? (b.vendor as Vendor) : "openai_compatible";
  const d = DEFAULTS[vendor === "openai_compatible" ? "openai" : vendor]!;
  const baseUrl = normaliseBaseUrl(b.mode, b.baseUrl ?? prev?.base_url);
  const modelSmart = b.modelSmart || (prev && prev.vendor === vendor ? prev.model_smart : null) || (b.mode === "key" ? d.smart : null);
  // Vendor keys get the vendor's cheaper model for quick jobs; a typed-in model (API, self-host) does both.
  const modelFast = b.modelFast || (prev && prev.vendor === vendor ? prev.model_fast : null) || (b.mode === "key" && !b.modelSmart ? d.fast : modelSmart);
  if (!modelSmart || !modelFast) throw new InvalidConnection("modelSmart", "pick a model");
  const label = b.mode === "key" ? VENDOR_LABEL[vendor] : b.mode === "selfhost" ? `Self-host (${new URL(baseUrl!).host})` : new URL(baseUrl!).host;
  return { mode: b.mode, vendor, baseUrl, modelFast, modelSmart, name: b.name || prev?.name || label };
}
export const VENDOR_LABEL: Record<Vendor, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic (Claude)",
  gemini: "Google Gemini",
  openai_compatible: "LLM API",
  device: "AI on a computer",
};

// ---------------------------------------------------------------- secrets

/**
 * AES-256-GCM (`secretBox` in service-kit). The key is AI_SECRETS_KEY when set, otherwise derived from
 * INTERNAL_TOKEN_SECRET. Changing either makes stored keys unreadable: admins then enter them again (the connection
 * shows a test error).
 */
const box = secretBox("ai-connections/v1", "AI_SECRETS_KEY");
export const encryptSecret = (plain: string, env?: NodeJS.ProcessEnv): string => box.encrypt(plain, env);
export const decryptSecret = (enc: string, env?: NodeJS.ProcessEnv): string => box.decrypt(enc, env);

export const keyHint = (key: string) => (key.length > 8 ? `…${key.slice(-4)}` : "…");

// ---------------------------------------------------------------- backends

export interface Draft {
  mode: Mode;
  vendor: Vendor;
  baseUrl: string | null;
  apiKey: string;
}

/**
 * Self-hosted models on CPUs answer slowly: give them longer, but stay under the API gateway's 60 s limit for AI
 * routes so the local fallback can still answer instead of the request being cut.
 */
// A self-hosted model on a company box (Ollama on a laptop GPU, a "thinking" model) can take a couple of minutes on a
// long prompt; a cut-off answer would fall back to the extractive model, which is worse than waiting.
const timeoutFor = (mode: Mode) => (mode === "selfhost" || mode === "device" ? 120_000 : 45_000);

export function backendFor(d: Draft, fetchImpl?: typeof fetch, timeoutMs = timeoutFor(d.mode)): ModelBackend {
  switch (d.vendor) {
    case "device":
      return new DeviceBackend(d.baseUrl, Math.min(timeoutMs, 110_000));
    case "anthropic":
      return new AnthropicProvider(d.apiKey);
    case "gemini":
      return new GeminiProvider(d.apiKey, { thinkingLevel: "low", timeoutMs, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
    case "openai":
      return new OpenAiProvider(d.apiKey, { timeoutMs, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
    default:
      return new OpenAiProvider(d.apiKey, { baseUrl: d.baseUrl ?? undefined, timeoutMs, noThinking: true, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  }
}

/** The models a connection offers, for the admin's model picker (best effort; an empty list means "type it"). */
export async function listModels(d: Draft, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const get = async (u: string, headers: Record<string, string>) => {
    const res = await fetchImpl(u, { headers, signal: AbortSignal.timeout(8_000) });
    const body = (await res.json().catch(() => null)) as {
      data?: { id?: string }[];
      models?: { name?: string; supportedGenerationMethods?: string[] }[];
      error?: { message?: string };
    } | null;
    if (!res.ok) throw new ProviderError(`HTTP ${res.status} ${body?.error?.message ?? ""}`.trim(), res.status, false);
    return body ?? {};
  };
  let ids: string[];
  // The computer's own list (what its connect program found) is shown by local-connect.ts, not asked for here.
  if (d.vendor === "device") return [];
  if (d.vendor === "anthropic") {
    const b = await get("https://api.anthropic.com/v1/models?limit=100", { "x-api-key": d.apiKey, "anthropic-version": "2023-06-01" });
    ids = (b.data ?? []).map((m) => m.id ?? "");
  } else if (d.vendor === "gemini") {
    const b = await get("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { "x-goog-api-key": d.apiKey });
    ids = (b.models ?? []).filter((m) => m.supportedGenerationMethods?.includes("generateContent")).map((m) => (m.name ?? "").replace(/^models\//, ""));
  } else {
    const base = d.vendor === "openai" ? "https://api.openai.com/v1" : d.baseUrl!;
    const b = await get(`${base}/models`, d.apiKey ? { authorization: `Bearer ${d.apiKey}` } : {});
    ids = (b.data ?? []).map((m) => m.id ?? "");
  }
  return [...new Set(ids.filter(Boolean))].sort();
}

/** One tiny call through the real backend: proves the URL, key and model together. */
export async function testConnection(d: Draft, modelName: string, fetchImpl?: typeof fetch): Promise<{ ok: boolean; ms: number; model?: string; error?: string }> {
  const started = Date.now();
  try {
    // 8 s for the model list plus this stays inside the gateway's 60 s for one "Kiểm tra".
    const r = await backendFor(d, fetchImpl, 40_000).call(modelName, {
      tier: "fast",
      feature: "connection_test",
      system: "You are a connection test. Reply with the single word OK.",
      maxTokens: 16,
      messages: [{ role: "user", content: "Reply with OK." }],
    });
    return { ok: true, ms: Date.now() - started, model: r.model };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, error: friendlyError(e) };
  }
}

/**
 * Whether a model calls tools usably: one request offering a "list my tasks" tool for a question that needs it.
 * Arguments shaped like a JSON schema count (repairToolInput fixes those). null when the probe itself failed
 * (timeout, network), so an unknown model is still tried with tools.
 */
export async function probeTools(d: Draft, modelName: string, fetchImpl?: typeof fetch, timeoutMs = 15_000): Promise<boolean | null> {
  // A computer's AI answers with text only (device-hub.ts); asking would only spend one of its answers.
  if (d.vendor === "device") return parseDeviceUrl(d.baseUrl) ? false : null;
  try {
    const r = await backendFor(d, fetchImpl, timeoutMs).call(modelName, {
      tier: "smart",
      feature: "connection_test",
      system: "You are the AI assistant inside a company workspace. Use the tools to look up the user's data.",
      maxTokens: 200,
      messages: [{ role: "user", content: "Liệt kê các việc tôi cần làm hôm nay." }],
      tools: [
        {
          name: "list_my_tasks",
          description: "List the asking user's open tasks",
          inputSchema: { type: "object", properties: { status: { type: "string", enum: ["todo", "in_progress"] } } },
        },
      ],
    });
    return r.toolCalls.some((c) => c.name === "list_my_tasks");
  } catch (e) {
    // A server that refuses tools outright ("does not support tools") answers 400.
    return (e as { status?: number }).status === 400 ? false : null;
  }
}

/** Errors in words an admin can act on, without echoing anything sensitive back. */
export function friendlyError(e: unknown): string {
  const status = (e as { status?: number }).status ?? null;
  const msg = ((e as Error).message ?? "").replace(/(sk|key|Bearer)[-_ ]?[A-Za-z0-9_-]{8,}/g, "$1…").slice(0, 240);
  if (/^(offline|timeout|device):/.test(msg)) return msg;
  if (status === 401 || status === 403) return `auth: the key was refused (HTTP ${status})`;
  if (status === 404) return `not_found: wrong base URL or model name (${msg})`;
  if (status === 429) return `rate_limited: the provider is rate limiting or out of credit (${msg})`;
  if (/timeout/i.test(msg)) return "timeout: no answer in time; is the server reachable from workspace?";
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed/i.test(msg)) return `unreachable: workspace cannot reach this address (${msg})`;
  return msg || "failed";
}
