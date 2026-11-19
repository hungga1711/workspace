import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import pg from "pg";
import { PRINCIPAL_HEADER, ServiceClient, signInternalToken } from "@workspace/service-kit";
import { newId, type Principal } from "@workspace/shared";
import { createAiApp } from "../../src/modules/ai/app.js";
import { gatewayFromEnv } from "../../src/modules/ai/gateway.js";
import { aiStatus, isGenerativeRoute } from "../../src/modules/ai/status.js";
import type { ModelProvider } from "../../src/modules/ai/providers.js";

const SECRET = "test-internal-secret-change-me-32bytes!";
const quietEnv = <T>(fn: () => T): T => {
  const log = console.log;
  console.log = () => undefined;
  try {
    return fn();
  } finally {
    console.log = log;
  }
};

describe("aiStatus", () => {
  it("is not configured with no vendor key (local extractive only)", () => {
    // Without a platform client (unit fixtures) both switches count as on; `assistant` still needs a model.
    expect(aiStatus(quietEnv(() => gatewayFromEnv({})))).toEqual({ configured: false, providers: [], assistant: false, monitoring: true, assistantWanted: true });
    // Tests and demos may run the built-in extractive model as the company AI; a real connection still wins.
    expect(
      aiStatus(
        quietEnv(() => gatewayFromEnv({})),
        undefined,
        { AI_LOCAL_MODEL: "1" },
      ),
    ).toEqual({ configured: true, providers: ["local"], assistant: true, monitoring: true, assistantWanted: true });
    expect(
      aiStatus(
        quietEnv(() => gatewayFromEnv({ ANTHROPIC_API_KEY: "a" })),
        undefined,
        { AI_LOCAL_MODEL: "1" },
      ).providers,
    ).toEqual(["anthropic"]);
  });
  it("lists every hosted vendor with a key", () => {
    const s = aiStatus(quietEnv(() => gatewayFromEnv({ GEMINI_API_KEY: "g", ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" })));
    expect(s.configured).toBe(true);
    expect(s.providers.sort()).toEqual(["anthropic", "gemini", "openai"]);
  });
  it("counts an OpenAI-compatible base URL without a key (Ollama, vLLM)", () => {
    expect(aiStatus(quietEnv(() => gatewayFromEnv({ OPENAI_BASE_URL: "http://ollama:11434/v1", AI_PROVIDER: "openai" })))).toEqual({
      configured: true,
      providers: ["openai"],
      assistant: true,
      monitoring: true,
      assistantWanted: true,
    });
  });
});

describe("isGenerativeRoute", () => {
  it("covers model-backed POSTs only", () => {
    for (const p of [
      "/ask",
      "/translate",
      "/threads/m1/summarize",
      "/agents/a1/invoke",
      "/internal/brief",
      "/extract",
      "/tasks/t1/assist",
      "/docs/d1/assist",
      "/assistant/messages",
      "/assistant/conversations/c1/regenerate",
    ])
      expect(isGenerativeRoute("POST", p)).toBe(true);
  });
  it("never covers monitoring, oversight, policy, history or status", () => {
    for (const [m, p] of [
      ["POST", "/internal/monitor/events"],
      ["POST", "/monitor/connection"],
      ["DELETE", "/monitor/connection"],
      ["GET", "/oversight"],
      ["POST", "/oversight/remind-extension"],
      ["GET", "/oversight/me"],
      ["PUT", "/policy"],
      ["GET", "/assistant/conversations"],
      ["GET", "/assistant/models"],
      ["GET", "/status"],
      ["GET", "/usage"],
    ] as const)
      expect(isGenerativeRoute(m, p)).toBe(false);
  });
});

/** The HTTP surface, without Postgres: /status and the 503 guard answer before any query. */
describe("GET /status and the not-configured guard", () => {
  const apps: { app: INestApplication; url: string }[] = [];
  const principal = (): Principal => ({ type: "user", id: newId(), teamIds: [], departmentId: null, grants: [{ permission: "ai.use", scope: "WORKSPACE" }] }) as Principal;
  const start = async (provider: ModelProvider) => {
    const pool = new pg.Pool({ connectionString: "postgres://nobody:none@127.0.0.1:1/none", max: 1 });
    const client = new ServiceClient("http://127.0.0.1:1", SECRET, "test", []);
    const app = await createAiApp({ pool, provider, identity: client, services: { chat: client, work: client, employee: client, ai: client } } as never, SECRET);
    await app.listen(0);
    const url = (await app.getUrl()).replace("[::1]", "127.0.0.1");
    apps.push({ app, url });
    return url;
  };
  const call = async (url: string, method: string, path: string, body?: unknown) => {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: { "content-type": "application/json", [PRINCIPAL_HEADER]: await signInternalToken({ principal: principal(), requestId: newId() }, SECRET) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
  };
  let off: string;
  let on: string;
  beforeAll(async () => {
    off = await start(quietEnv(() => gatewayFromEnv({})));
    on = await start(quietEnv(() => gatewayFromEnv({ ANTHROPIC_API_KEY: "a" })));
  });
  afterAll(async () => {
    for (const a of apps) await a.app.close();
  });

  it("reports configured false / true", async () => {
    expect(await call(off, "GET", "/status")).toEqual({ status: 200, body: { configured: false, providers: [], assistant: false, monitoring: true, assistantWanted: true } });
    expect(await call(on, "GET", "/status")).toEqual({
      status: 200,
      body: { configured: true, providers: ["anthropic"], assistant: true, monitoring: true, assistantWanted: true },
    });
  });
  it("refuses generation with 503 ai_not_configured when no provider is set", async () => {
    for (const [path, body] of [
      ["/ask", { question: "hi" }],
      ["/translate", { text: "hi", to: "en" }],
      ["/tasks/t1/assist", {}],
      ["/assistant/messages", { text: "hi" }],
    ] as const) {
      const r = await call(off, "POST", path, body);
      expect(r.status).toBe(503);
      expect(r.body?.error).toBe("ai_not_configured");
    }
  });
  it("lets a configured service through to the handler (validation runs, no 503)", async () => {
    const r = await call(on, "POST", "/ask", {});
    expect(r.status).toBe(400);
  });
  it("leaves extension monitoring alone (validation answers, not the guard)", async () => {
    const r = await call(off, "POST", "/internal/monitor/events", {});
    expect(r.status).not.toBe(503);
  });
});
