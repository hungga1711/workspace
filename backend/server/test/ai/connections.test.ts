import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  ConnectionInput,
  decryptSecret,
  encryptSecret,
  friendlyError,
  isPrivateHost,
  keyHint,
  listModels,
  normaliseBaseUrl,
  resolve,
  sameEndpoint,
  testConnection,
  type ConnectionRow,
} from "../../src/modules/ai/connections.js";
import { connKey, WorkspaceGateway } from "../../src/modules/ai/workspace-gateway.js";
import { aiStatus } from "../../src/modules/ai/status.js";

const okChat = (model = "llama3.2") =>
  new Response(JSON.stringify({ model, choices: [{ message: { content: "OK" } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("connection input", () => {
  it("accepts the three ways to connect and rejects what cannot work", () => {
    expect(ConnectionInput.safeParse({ mode: "key", vendor: "anthropic", apiKey: "sk-ant-x" }).success).toBe(true);
    expect(ConnectionInput.safeParse({ mode: "api", baseUrl: "https://openrouter.ai/api/v1", apiKey: "k", modelSmart: "x" }).success).toBe(true);
    expect(ConnectionInput.safeParse({ mode: "selfhost", baseUrl: "http://ollama:11434", modelSmart: "llama3.2" }).success).toBe(true);
    // key mode needs a known vendor; the others need a URL; a public API over plain http is refused.
    expect(ConnectionInput.safeParse({ mode: "key", vendor: "openai_compatible", apiKey: "k" }).success).toBe(false);
    expect(ConnectionInput.safeParse({ mode: "selfhost" }).success).toBe(false);
    expect(ConnectionInput.safeParse({ mode: "api", baseUrl: "http://api.example.com/v1", apiKey: "k" }).success).toBe(false);
    expect(ConnectionInput.safeParse({ mode: "selfhost", baseUrl: "file:///etc/passwd" }).success).toBe(false);
  });

  it("adds /v1 when only a host is given, and fills vendor defaults", () => {
    expect(normaliseBaseUrl("selfhost", "http://ollama:11434")).toBe("http://ollama:11434/v1");
    expect(normaliseBaseUrl("selfhost", "http://10.0.0.5:1234/v1/")).toBe("http://10.0.0.5:1234/v1");
    expect(normaliseBaseUrl("api", "https://openrouter.ai/api/v1")).toBe("https://openrouter.ai/api/v1");
    expect(normaliseBaseUrl("key", "https://x")).toBeNull();
    const k = resolve({ mode: "key", vendor: "anthropic", apiKey: "x" });
    expect(k).toMatchObject({ vendor: "anthropic", baseUrl: null, modelSmart: "claude-sonnet-5-5", modelFast: "claude-haiku-5-5" });
    const s = resolve({ mode: "selfhost", baseUrl: "http://ollama:11434", modelSmart: "qwen3:8b" });
    expect(s).toMatchObject({ vendor: "openai_compatible", baseUrl: "http://ollama:11434/v1", modelFast: "qwen3:8b", name: "Self-host (ollama:11434)" });
    expect(() => resolve({ mode: "api", baseUrl: "https://x.example/v1" })).toThrow();
  });

  it("knows private hosts", () => {
    for (const h of ["localhost", "ollama", "127.0.0.1", "10.1.2.3", "192.168.1.9", "172.20.0.4", "gpu.local", "[::1]"]) expect(isPrivateHost(h)).toBe(true);
    for (const h of ["api.openai.com", "8.8.8.8", "172.40.0.1", "fcdn.example.com", "fd.io"]) expect(isPrivateHost(h)).toBe(false);
    expect(isPrivateHost("[fd00::1]")).toBe(true);
  });
});

describe("stored keys", () => {
  it("are reused only for the same vendor, mode and address", () => {
    const prev = { mode: "api", vendor: "openai_compatible", base_url: "https://openrouter.ai/api/v1" } as ConnectionRow;
    expect(sameEndpoint(prev, { mode: "api", vendor: "openai_compatible", baseUrl: "https://openrouter.ai/api/v1" })).toBe(true);
    expect(sameEndpoint(prev, { mode: "api", vendor: "openai_compatible", baseUrl: "https://attacker.example/v1" })).toBe(false);
    expect(sameEndpoint(prev, { mode: "selfhost", vendor: "openai_compatible", baseUrl: "https://openrouter.ai/api/v1" })).toBe(false);
    const key = { mode: "key", vendor: "openai", base_url: null } as ConnectionRow;
    expect(sameEndpoint(key, { mode: "key", vendor: "openai", baseUrl: null })).toBe(true);
    expect(sameEndpoint(key, { mode: "key", vendor: "anthropic", baseUrl: null })).toBe(false);
  });

  it("a missing model is a field error, not a crash", () => {
    expect(() => resolve({ mode: "api", baseUrl: "https://x.example/v1" })).toThrow(/pick a model/);
  });
});

describe("secrets", () => {
  it("round-trips, differs per call, and fails with another server secret", () => {
    const env = { INTERNAL_TOKEN_SECRET: "a".repeat(40) };
    const a = encryptSecret("sk-live-123456789", env);
    expect(a).not.toContain("sk-live");
    expect(encryptSecret("sk-live-123456789", env)).not.toBe(a);
    expect(decryptSecret(a, env)).toBe("sk-live-123456789");
    expect(() => decryptSecret(a, { INTERNAL_TOKEN_SECRET: "b".repeat(40) })).toThrow();
    expect(decryptSecret(encryptSecret("x", { AI_SECRETS_KEY: "k" }), { AI_SECRETS_KEY: "k" })).toBe("x");
    expect(keyHint("sk-live-123456789")).toBe("…6789");
  });
});

describe("talking to a connection", () => {
  it("lists models and tests a self-hosted OpenAI-compatible server (Ollama) without a key", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const fake = (async (url: string | URL, init?: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      if (String(url).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "qwen3:8b" }, { id: "llama3.2" }] }), { status: 200 });
      return okChat();
    }) as typeof fetch;
    const draft = { mode: "selfhost" as const, vendor: "openai_compatible" as const, baseUrl: "http://ollama:11434/v1", apiKey: "" };
    expect(await listModels(draft, fake)).toEqual(["llama3.2", "qwen3:8b"]);
    const t = await testConnection(draft, "llama3.2", fake);
    expect(t).toMatchObject({ ok: true, model: "llama3.2" });
    expect(seen.map((s) => s.url)).toEqual(["http://ollama:11434/v1/models", "http://ollama:11434/v1/chat/completions"]);
    expect(seen.every((s) => s.auth === null)).toBe(true);
  });

  it("explains failures in words an admin can act on", async () => {
    const refused = (async () => new Response(JSON.stringify({ error: { message: "bad key sk-abcdefghijklmnop" } }), { status: 401 })) as typeof fetch;
    const t = await testConnection({ mode: "api", vendor: "openai_compatible", baseUrl: "https://x.example/v1", apiKey: "k" }, "m", refused);
    expect(t.ok).toBe(false);
    expect(t.error).toMatch(/^auth:/);
    expect(friendlyError(new TypeError("fetch failed"))).toMatch(/^unreachable:/);
    expect(friendlyError({ status: 404, message: "HTTP 404 sk-abcdefghijklmnop" })).not.toContain("abcdefghijklmnop");
  });
});

describe("workspace gateway", () => {
  const row = (over: Partial<ConnectionRow>): ConnectionRow => ({
    id: "01CONN",
    mode: "selfhost",
    vendor: "openai_compatible",
    name: "Ollama",
    base_url: "http://ollama:11434/v1",
    api_key_enc: null,
    key_hint: null,
    model_fast: "llama3.2",
    model_smart: "qwen3:8b",
    is_default: true,
    enabled: true,
    tested_at: null,
    test_ok: null,
    test_error: null,
    tools_ok: null,
    web_tools: true,
    updated_at: new Date("2026-10-15T00:00:00Z"),
    ...over,
  });
  const poolWith = (rows: ConnectionRow[]) => {
    let reads = 0;
    const client = {
      query: async (sql: string) => {
        if (/FROM ai_connections/.test(sql)) reads++;
        return { rows: /FROM ai_connections/.test(sql) ? rows : [], rowCount: 0 };
      },
      release: () => undefined,
    };
    return { pool: { query: client.query, connect: async () => client } as unknown as Pool, reads: () => reads };
  };
  it("is not configured with no env key and no connection; the local model answers", async () => {
    const { pool } = poolWith([]);
    const gw = new WorkspaceGateway(pool, {});
    await gw.ready();
    expect(gw.name).toBe("local");
    expect(aiStatus(gw)).toMatchObject({ configured: false, providers: [], assistant: false });
  });

  it("routes every feature to the default connection, lists it in the menu, and reloads only after a change", async () => {
    const { pool, reads } = poolWith([row({})]);
    const gw = new WorkspaceGateway(pool, {});
    await gw.ready();
    expect(gw.name).toBe(connKey("01CONN"));
    expect(aiStatus(gw)).toMatchObject({ configured: true, providers: ["Ollama"], assistant: true });
    expect(gw.menu()).toEqual([{ route: `${connKey("01CONN")}:qwen3:8b`, vendor: "openai_compatible", label: "Ollama", model: "qwen3:8b" }]);
    await gw.ready();
    expect(reads()).toBe(1); // cached
    gw.invalidate();
    await gw.ready();
    expect(reads()).toBe(2);
  });

  it("keeps env vendors next to the admin's connections", async () => {
    const { pool } = poolWith([row({})]);
    const gw = new WorkspaceGateway(pool, { ANTHROPIC_API_KEY: "sk-ant-env" });
    await gw.ready();
    expect(gw.menu().map((m) => m.label)).toEqual(["Ollama", "Claude"]);
  });
});
