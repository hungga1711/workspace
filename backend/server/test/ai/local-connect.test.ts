import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { INestApplication } from "@nestjs/common";
import { migrate, PRINCIPAL_HEADER, ServiceClient, signInternalToken } from "@workspace/service-kit";
import { newId, type Principal } from "@workspace/shared";
import { createAiApp, depsFromEnv } from "../../src/modules/ai/app.js";
import { LocalProvider } from "../../src/modules/ai/providers.js";
import {
  askDevice,
  claimJob,
  DeviceBackend,
  deviceKey,
  deviceOnline,
  deviceUrl,
  finishJob,
  flatten,
  parseDeviceUrl,
  partJob,
  resetDeviceHub,
} from "../../src/modules/ai/device-hub.js";
import type { ModelStream } from "../../src/modules/ai/providers.js";
import { probeModels } from "../../src/modules/ai/local-connect.js";
import { WorkspaceGateway } from "../../src/modules/ai/workspace-gateway.js";
import { forgetPersonal, runWithPersonal, toChoice } from "../../src/modules/ai/personal-ai.js";

const SECRET = "dev-internal-secret-change-me-32bytes!";
const admin: Principal = {
  type: "user",
  id: newId(),
  teamIds: [],
  departmentId: null,
  grants: [
    { permission: "ai.use", scope: "WORKSPACE" },
    { permission: "ai.agent.manage", scope: "WORKSPACE" },
    { permission: "ai.policy.manage", scope: "WORKSPACE" },
  ],
} as Principal;
const staff: Principal = { ...admin, id: newId(), grants: [{ permission: "ai.use", scope: "WORKSPACE" }] } as Principal;

let app: INestApplication;
let base: string;
let pool: import("pg").Pool;
let gateway: WorkspaceGateway;

async function call(p: Principal, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", [PRINCIPAL_HEADER]: await signInternalToken({ principal: p, requestId: newId() }, SECRET) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null };
}

const FOUND = [
  { id: "claude-code", name: "Claude Code", kind: "agent", cloud: true, hook: true, logs: true },
  { id: "ollama", name: "Ollama", kind: "server", cloud: false, models: ["qwen3:8b", "llama3.2:1b"] },
];
const beat = (p: Principal, device: string, extra: Record<string, unknown> = {}) =>
  call(p, "POST", "/local/connect/heartbeat", {
    device,
    os: "darwin",
    version: "1",
    keyPrefix: "0a1b2c3d",
    found: FOUND,
    state: { workflow: true, usage: true, guard: true },
    ...extra,
  });

beforeAll(async () => {
  await migrate("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test", fileURLToPath(new URL("../../migrations/ai", import.meta.url)), "ai");
  const { deps } = depsFromEnv(new LocalProvider());
  pool = deps.pool;
  gateway = new WorkspaceGateway(pool, {}, 0);
  deps.provider = gateway;
  await pool.query("DELETE FROM ai_keywords");
  await pool.query("DELETE FROM ai_policy");
  await pool.query("DELETE FROM ai_connections");
  deps.identity = new ServiceClient("http://127.0.0.1:1", SECRET, "ai", []);
  delete deps.platform;
  app = await createAiApp(deps, SECRET);
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "127.0.0.1");
});

afterAll(async () => {
  await app?.close();
});

describe("device hub", () => {
  it("streams the answer as the computer writes it, reasoning left out, and stops it there", async () => {
    resetDeviceHub();
    const key = deviceKey("u1", "mac");
    const waiting = claimJob(key, 5000);
    const stop = new AbortController();
    let seen = "";
    const stream: ModelStream = { text: (d) => void (seen += d), reset: () => void (seen += "|"), signal: stop.signal };
    const answer = new DeviceBackend(deviceUrl("u1", "mac", "ollama")).call("qwen3", {
      tier: "smart",
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 50,
      stream,
    });
    const job = (await waiting)!;
    expect(job.stream).toBe(true);
    expect(partJob(job.id, "<think>let me see")).toEqual({ ok: true, stop: false });
    expect(partJob(job.id, "<think>let me see</think>\nXin ")).toEqual({ ok: true, stop: false });
    expect(partJob(job.id, "<think>let me see</think>\nXin chào")).toEqual({ ok: true, stop: false });
    expect(seen).toBe("Xin chào");
    stop.abort();
    expect(await answer).toMatchObject({ text: "Xin chào", stopped: true });
    // The computer hears it at its next part, and its late answer is nobody's.
    expect(partJob(job.id, "Xin chào bạn")).toEqual({ ok: false, stop: true });
    expect(finishJob(job.id, { text: "Xin chào bạn" })).toBe(false);
  });

  it("an older program that does not stream still answers at the end", async () => {
    resetDeviceHub();
    const key = deviceKey("u1", "mac");
    const waiting = claimJob(key, 5000);
    let seen = "";
    const stream: ModelStream = { text: (d) => void (seen += d), reset: () => undefined, signal: new AbortController().signal };
    const answer = new DeviceBackend(deviceUrl("u1", "mac", "claude-code")).call("", {
      tier: "smart",
      system: "",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 50,
      stream,
    });
    finishJob((await waiting)!.id, { text: "hello" });
    expect((await answer).text).toBe("hello");
    expect(seen).toBe("");
  });

  it("hands a question to the waiting computer and returns its answer", async () => {
    resetDeviceHub();
    const key = deviceKey("u1", "mac");
    expect(deviceOnline(key)).toBe(false);
    const waiting = claimJob(key, 5000);
    expect(deviceOnline(key)).toBe(true);
    const answer = askDevice(key, { target: "ollama:qwen3:8b", system: "s", prompt: "2+2?", maxTokens: 50 }, 5000);
    const job = (await waiting)!;
    expect(job).toMatchObject({ target: "ollama:qwen3:8b", prompt: "2+2?" });
    expect(finishJob(job.id, { text: "4", usage: { input: 9, output: 1 } })).toBe(true);
    expect(await answer).toMatchObject({ text: "4" });
    // Answered once: a second answer for the same question is nobody's.
    expect(finishJob(job.id, { text: "5" })).toBe(false);
  });

  it("queues a question asked between two polls, and gives up after the timeout", async () => {
    resetDeviceHub();
    const key = deviceKey("u1", "mac");
    const answer = askDevice(key, { target: "claude-code", system: "", prompt: "hi", maxTokens: 50 }, 5000);
    const job = (await claimJob(key, 1000))!;
    finishJob(job.id, { text: "hello" });
    expect((await answer).text).toBe("hello");
    expect(await askDevice(key, { target: "claude-code", system: "", prompt: "late", maxTokens: 50 }, 30)).toEqual({ error: "timeout" });
    // The question nobody answered in time is not handed out afterwards.
    expect(await claimJob(key, 30)).toBeNull();
  });

  it("names a computer's AI in a connection address, and writes a conversation as one prompt", () => {
    const url = deviceUrl("u 1", "Hưng's MacBook", "claude-code");
    expect(parseDeviceUrl(url)).toEqual({ userId: "u 1", device: "Hưng's MacBook", ai: "claude-code" });
    expect(parseDeviceUrl("http://x")).toBeNull();
    expect(flatten({ messages: [{ role: "user", content: "one" }] })).toBe("one");
    expect(
      flatten({
        messages: [
          { role: "user", content: "one" },
          { role: "assistant", content: "two" },
          { role: "user", content: "three" },
        ],
      }),
    ).toContain("User: one\n\nAssistant: two\n\nAnswer the user's next message.\n\nUser: three");
  });

  it("an offline computer fails at once, so the gateway can fall back", async () => {
    resetDeviceHub();
    const b = new DeviceBackend(deviceUrl("u1", "mac", "ollama"));
    await expect(b.call("qwen3:8b", { tier: "smart", system: "", maxTokens: 10, messages: [{ role: "user", content: "x" }] })).rejects.toThrow(/offline/);
  });
});

describe("a model server found from the workspace server", () => {
  it("lists chat models and ignores embedding ones and dead ports", async () => {
    const fake = (async () => new Response(JSON.stringify({ data: [{ id: "qwen3:8b" }, { id: "nomic-embed-text" }, { id: 7 }] }), { status: 200 })) as unknown as typeof fetch;
    expect(await probeModels("http://127.0.0.1:11434/v1", fake)).toEqual(["qwen3:8b"]);
    expect(await probeModels("http://127.0.0.1:9/v1")).toEqual([]);
  });
});

describe("local connect", () => {
  it("a computer reports what it found; its owner sees it, nobody else does", async () => {
    resetDeviceHub();
    expect((await beat(staff, "Lan-PC")).body).toMatchObject({ ok: true, prefer: "", sensitiveMode: "warn" });
    const mine = (await call(staff, "GET", "/local/connect")).body;
    expect(mine.devices).toHaveLength(1);
    expect(mine.devices[0]).toMatchObject({ device: "Lan-PC", online: true, keyPrefix: "0a1b2c3d", state: { workflow: true, usage: true, guard: true } });
    expect(mine.devices[0].found.map((f: { id: string }) => f.id)).toEqual(["claude-code", "ollama"]);
    expect(mine.canManage).toBe(false);
    expect((await call(admin, "GET", "/local/connect")).body.devices).toHaveLength(0);
    // `--status` checks the code without leaving a trace.
    expect((await beat(staff, "Other", { probe: true })).body).toEqual({ ok: true });
    expect((await call(staff, "GET", "/local/connect")).body.devices).toHaveLength(1);
  });

  it("the owner picks which AI runs workflows there, and the program hears it on its next heartbeat", async () => {
    expect((await call(staff, "PUT", "/local/connect/devices/Lan-PC", { prefer: "ollama:qwen3:8b" })).status).toBe(200);
    expect((await beat(staff, "Lan-PC")).body.prefer).toBe("ollama:qwen3:8b");
    expect((await call(admin, "PUT", "/local/connect/devices/Lan-PC", { prefer: "x" })).status).toBe(404);
  });

  it("the safety net follows the company's setting: warn lets through and counts, redact and block stop the text", async () => {
    const text = "Customer card 4111 1111 1111 1111, mail lan@example.com";
    expect((await call(staff, "POST", "/local/guard", { tool: "claude-code", text: "Summarise the plan for next sprint" })).body).toEqual({ action: "allow", kinds: [] });
    const warn = (await call(staff, "POST", "/local/guard", { tool: "claude-code", text })).body;
    expect(warn).toMatchObject({ action: "allow", warned: true, kinds: ["card"] });
    await pool.query("INSERT INTO ai_policy (sensitive_mode) VALUES ('redact')");
    const redact = (await call(staff, "POST", "/local/guard", { tool: "claude-code", text })).body;
    expect(redact.action).toBe("redact");
    expect(redact.text).toBe("Customer card [CARD], mail [EMAIL]");
    expect(redact.names).toContain("a card number");
    await pool.query("UPDATE ai_policy SET sensitive_mode = 'block'");
    const block = (await call(staff, "POST", "/local/guard", { tool: "claude-code", text })).body;
    expect(block).toMatchObject({ action: "block", kinds: ["card"] });
    expect(block.text).toBeUndefined();
    // Counted like the extension's, never with the text.
    const events = (await pool.query("SELECT source, action, kinds FROM ai_safety_events WHERE user_id = $1 ORDER BY at", [staff.id])).rows;
    expect(events.map((e) => e.action)).toEqual(["warn", "redact", "block"]);
    expect(events.every((e) => e.source === "local")).toBe(true);
    await pool.query("DELETE FROM ai_policy");
  });

  it("an admin sees the company's computers in numbers, and may use only their own computer's AI for the assistant", async () => {
    await beat(admin, "Boss-Mac");
    const o = (await call(admin, "GET", "/local/connect/overview")).body;
    expect(o.computers).toMatchObject({ online: 2, people: 2 });
    expect(o.found.find((f: { id: string }) => f.id === "ollama")).toMatchObject({ computers: 2 });
    expect(o.mine.map((d: { device: string }) => d.device)).toEqual(["Boss-Mac"]);
    expect((await call(staff, "GET", "/local/connect/overview")).status).toBe(403);
    expect((await call(staff, "POST", "/local/connect/use", { device: "Lan-PC", ai: "ollama" })).status).toBe(403);
    // Someone else's computer, or an AI that is not there: no.
    expect((await call(admin, "POST", "/local/connect/use", { device: "Lan-PC", ai: "ollama" })).status).toBe(404);
    expect((await call(admin, "POST", "/local/connect/use", { device: "Boss-Mac", ai: "codex" })).status).toBe(404);
    expect((await call(admin, "POST", "/local/connect/use", { device: "Boss-Mac", ai: "ollama", model: "nope" })).status).toBe(400);
    const made = (await call(admin, "POST", "/local/connect/use", { device: "Boss-Mac", ai: "ollama", model: "llama3.2:1b" })).body.connection;
    expect(made).toMatchObject({ mode: "device", vendor: "device", modelSmart: "llama3.2:1b", isDefault: true, tools: false, name: "Ollama · Boss-Mac" });
    // Choosing again replaces, never doubles.
    await call(admin, "POST", "/local/connect/use", { device: "Boss-Mac", ai: "ollama", model: "qwen3:8b" });
    expect((await pool.query("SELECT model_smart FROM ai_connections WHERE mode = 'device'")).rows).toEqual([{ model_smart: "qwen3:8b" }]);
  });

  it("a question for the assistant travels to that computer and its answer comes back through the gateway", async () => {
    const key = "/local/connect/jobs";
    const claimed = call(admin, "POST", `${key}/claim`, { device: "Boss-Mac" });
    // The poll is open before the question is asked.
    await new Promise((r) => setTimeout(r, 100));
    const answer = gateway.generate({ tier: "smart", feature: "ask", system: "Be brief.", maxTokens: 100, messages: [{ role: "user", content: "Capital of Vietnam?" }] });
    const job = (await claimed).body.job;
    expect(job).toMatchObject({ target: "ollama:qwen3:8b", system: "Be brief.", prompt: "Capital of Vietnam?" });
    // Only the computer that was asked may answer.
    expect((await call(admin, "POST", `${key}/${job.id}`, { text: "Hà Nội", model: "qwen3:8b", usage: { input: 12, output: 3 } })).body).toEqual({ ok: true });
    const r = await answer;
    expect(r).toMatchObject({ text: "Hà Nội", model: "qwen3:8b", usage: { inputTokens: 12, outputTokens: 3 } });
    expect(r.toolCalls).toEqual([]);
  });

  it("forgetting a computer removes it and stops its AI answering for the company", async () => {
    expect((await call(admin, "DELETE", "/local/connect/devices/Boss-Mac")).status).toBe(204);
    expect((await call(admin, "GET", "/local/connect")).body.devices).toHaveLength(0);
    expect((await pool.query("SELECT 1 FROM ai_connections WHERE mode = 'device'")).rowCount).toBe(0);
  });
});

describe("my own AI", () => {
  const ask = (person?: string, route?: string) =>
    gateway.generate({
      tier: "smart",
      feature: "ask",
      system: "",
      maxTokens: 50,
      messages: [{ role: "user", content: "Hi?" }],
      ...(person ? { person } : {}),
      ...(route ? { route } : {}),
    });
  const mine = { device: "Lan-PC", ai: "claude-code", model: "", label: "Claude Code · Lan-PC" };

  it("is the company's AI until I choose one found on one of my own computers", async () => {
    forgetPersonal();
    await beat(staff, "Lan-PC");
    expect((await call(staff, "GET", "/local/connect")).body.personal).toEqual({ allowed: true, choice: null, active: false, company: [] });
    // Someone else's computer, an AI that is not there, a model the server does not have: no.
    await beat(admin, "Boss-Mac");
    expect((await call(staff, "PUT", "/local/connect/personal", { device: "Boss-Mac", ai: "ollama" })).status).toBe(404);
    expect((await call(staff, "PUT", "/local/connect/personal", { device: "Lan-PC", ai: "codex" })).status).toBe(404);
    expect((await call(staff, "PUT", "/local/connect/personal", { device: "Lan-PC", ai: "ollama", model: "nope" })).status).toBe(400);
    // A model server without a model named takes its first one; an agent answers with its own.
    expect((await call(staff, "PUT", "/local/connect/personal", { device: "Lan-PC", ai: "ollama" })).body.choice).toEqual({ device: "Lan-PC", ai: "ollama", model: "qwen3:8b" });
    expect((await call(staff, "PUT", "/local/connect/personal", { device: "Lan-PC", ai: "claude-code" })).body.choice).toEqual({ device: "Lan-PC", ai: "claude-code", model: "" });
    expect((await call(staff, "GET", "/local/connect")).body.personal).toEqual({
      allowed: true,
      choice: { device: "Lan-PC", ai: "claude-code", model: "" },
      active: true,
      company: [],
    });
    expect((await call(admin, "GET", "/local/connect")).body.personal.choice).toBeNull();
    expect((await call(admin, "GET", "/local/connect/overview")).body.personal).toEqual({ allowed: true, people: 1 });
  });

  it("an AI that left the computer no longer counts as a choice", () => {
    const row = { device: "Lan-PC", ai: "ollama", model: "qwen3:8b", found: FOUND, allowed: true };
    expect(toChoice(row)).toMatchObject({ label: "Ollama · qwen3:8b · Lan-PC", allowed: true });
    expect(toChoice({ ...row, model: "gone" })).toBeNull();
    expect(toChoice({ ...row, found: [] })).toBeNull();
    expect(toChoice({ ...row, allowed: null })?.allowed).toBe(true);
  });

  it("makes AI available to me even when the company has none, and only to me", async () => {
    const status = async (p: Principal) => (await call(p, "GET", "/status")).body;
    expect((await status(staff)).providers).toContain("Claude Code · Lan-PC");
    expect((await status(staff)).configured).toBe(true);
    expect((await status(admin)).providers).not.toContain("Claude Code · Lan-PC");
    const models = (await call(staff, "GET", "/assistant/models")).body.models;
    expect(models[0]).toMatchObject({ route: "personal:claude-code", vendor: "device", label: "Claude Code · Lan-PC" });
  });

  it("answers my own calls on my computer; anyone else's, and a company model I picked, go to the company's AI", async () => {
    resetDeviceHub();
    const waiting = claimJob(deviceKey(staff.id, "Lan-PC"), 5000);
    await runWithPersonal(staff.id, mine, async () => {
      expect(gateway.name).toBe("device");
      expect(gateway.toolsFor()).toBe(false);
      const answer = ask(staff.id);
      const job = (await waiting)!;
      expect(job).toMatchObject({ target: "claude-code", prompt: "Hi?" });
      finishJob(job.id, { text: "Hello from my Mac" });
      expect(await answer).toMatchObject({ text: "Hello from my Mac", provider: "device" });
      // A call made for someone else in my request (a background step, a report) is never sent to my computer.
      expect((await ask(admin.id)).provider).toBe("local");
      expect((await ask()).provider).toBe("local");
      expect((await ask(staff.id, "local:local-extractive")).provider).toBe("local");
    });
    // Outside my request (a job, a service call): the company's AI.
    expect(gateway.name).toBe("local");
    expect(gateway.menu().some((m) => m.route.startsWith("personal:"))).toBe(false);
  });

  it("lists each model my computer's AI offers, and sends the one I pick", async () => {
    resetDeviceHub();
    const claude = { ...mine, name: "Claude Code", models: ["opus", "sonnet", "haiku", "claude-fable-5-2[1m]"] };
    await runWithPersonal(staff.id, claude, async () => {
      expect(gateway.menu().filter((m) => m.vendor === "device")).toEqual([
        { route: "personal:opus", vendor: "device", label: "Claude Code · Opus", model: "opus" },
        { route: "personal:sonnet", vendor: "device", label: "Claude Code · Sonnet", model: "sonnet" },
        { route: "personal:haiku", vendor: "device", label: "Claude Code · Haiku", model: "haiku" },
        { route: "personal:claude-fable-5-2[1m]", vendor: "device", label: "Claude Code · Fable 5.2 1M", model: "claude-fable-5-2[1m]" },
      ]);
      for (const [route, target] of [
        ["personal:sonnet", "claude-code:sonnet"],
        ["personal:gone", "claude-code"],
        [undefined, "claude-code"],
      ] as const) {
        const waiting = claimJob(deviceKey(staff.id, "Lan-PC"), 5000);
        const answer = ask(staff.id, route);
        const job = (await waiting)!;
        expect(job.target).toBe(target);
        finishJob(job.id, { text: "ok" });
        await answer;
      }
    });
  });

  it("falls back to the company's AI while my computer is off", async () => {
    resetDeviceHub();
    const r = await runWithPersonal(staff.id, mine, () => ask(staff.id, "personal:claude-code"));
    expect(r.provider).toBe("local");
    // The middleware does not even pick it while the computer is silent.
    expect((await call(staff, "GET", "/local/connect")).body.personal.active).toBe(false);
  });

  it("the company may keep everyone on its own AI; my choice is kept for later", async () => {
    await beat(staff, "Lan-PC");
    expect((await call(staff, "PUT", "/local/connect/personal-policy", { allow: false })).status).toBe(403);
    expect((await call(admin, "PUT", "/local/connect/personal-policy", { allow: false })).body).toEqual({ allow: false });
    expect((await call(staff, "GET", "/local/connect")).body.personal).toMatchObject({ allowed: false, active: false, choice: { ai: "claude-code" } });
    expect((await call(staff, "GET", "/status")).body.providers).not.toContain("Claude Code · Lan-PC");
    expect((await call(staff, "PUT", "/local/connect/personal", { device: "Lan-PC", ai: "claude-code" })).status).toBe(403);
    // In the audit trail, as a settings change.
    expect((await pool.query("SELECT 1 FROM outbox WHERE type = 'audit.entry.recorded.v1' AND payload::text LIKE '%personalAi%'")).rowCount).toBe(1);
    await call(admin, "PUT", "/local/connect/personal-policy", { allow: true });
    expect((await call(staff, "GET", "/local/connect")).body.personal.active).toBe(true);
  });

  it("back to the company's AI by choice, or when the computer is disconnected", async () => {
    expect((await call(staff, "DELETE", "/local/connect/personal")).status).toBe(204);
    expect((await call(staff, "GET", "/local/connect")).body.personal.choice).toBeNull();
    await call(staff, "PUT", "/local/connect/personal", { device: "Lan-PC", ai: "claude-code" });
    expect((await call(staff, "DELETE", "/local/connect/devices/Lan-PC")).status).toBe(204);
    expect((await pool.query("SELECT 1 FROM ai_personal_choice WHERE user_id = $1", [staff.id])).rowCount).toBe(0);
  });
});
