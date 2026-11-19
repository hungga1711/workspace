import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { PRINCIPAL_HEADER, ServiceCallError, signInternalToken } from "@workspace/service-kit";
import { newId, type Principal } from "@workspace/shared";
import { createAiApp, depsFromEnv } from "../../src/modules/ai/app.js";
import { stoppedAnswer, type ModelProvider, type ModelRequest, type ModelResponse } from "../../src/modules/ai/providers.js";

const SECRET = "dev-internal-secret-change-me-32bytes!";

/**
 * Hỏi đáp's answer as it is written (stream.ts), end to end in the ai module: the Server-Sent Events, the stored
 * answer equal to what was streamed, the stop button keeping exactly what was shown, a stop before any word keeping
 * nothing, and errors before and after the stream opened.
 */
class StreamingProvider implements ModelProvider {
  readonly name = "streaming";
  /** What the next answer does: its pieces, and what happens after them. */
  plan: { pieces: string[]; then: "finish" | "wait" | "fail" } = { pieces: [], then: "finish" };
  async generate(req: ModelRequest): Promise<ModelResponse> {
    if (!req.stream) return { text: "{}", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, model: "streaming" };
    const live = req.stream;
    let text = "";
    for (const p of this.plan.pieces) {
      await new Promise((r) => setTimeout(r, 5));
      text += p;
      live.text(p);
    }
    if (this.plan.then === "fail") throw new Error("the model went away");
    if (this.plan.then === "wait") {
      await new Promise((resolve) => (live.signal.aborted ? resolve(null) : live.signal.addEventListener("abort", () => resolve(null), { once: true })));
      return { ...stoppedAnswer(req, text, "streaming"), provider: "streaming" };
    }
    return { text, toolCalls: [], usage: { inputTokens: 12, outputTokens: 3 }, model: "streaming" };
  }
}
const model = new StreamingProvider();

const none = {
  async request(_m: string, path: string): Promise<never> {
    throw new ServiceCallError(404, { error: "not found" }, `GET ${path} → 404`);
  },
};

let ai: INestApplication;
let aiUrl = "";
let pool: import("pg").Pool;
const lan: Principal = { type: "user", id: newId(), teamIds: [], departmentId: null, grants: [{ permission: "ai.use", scope: "WORKSPACE" }] };
const huy: Principal = { ...lan, id: newId() };

const headers = async (p: Principal) => ({ "content-type": "application/json", [PRINCIPAL_HEADER]: await signInternalToken({ principal: p, requestId: newId() }, SECRET) });

/** The events of one streamed request; `onStart` runs once the stream says its id. */
async function stream(p: Principal, path: string, body: unknown, onStart?: (id: string) => void | Promise<void>) {
  const res = await fetch(`${aiUrl}${path}`, { method: "POST", headers: await headers(p), body: JSON.stringify(body) });
  if (!res.headers.get("content-type")?.startsWith("text/event-stream"))
    return { status: res.status, json: await res.json(), events: [] as { event: string; data: Record<string, unknown> }[] };
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let end: number;
    while ((end = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, end);
      buf = buf.slice(end + 2);
      const event = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      if (!event || !data) continue;
      events.push({ event, data: JSON.parse(data) });
      if (event === "start") await onStart?.(String(JSON.parse(data).id));
    }
  }
  return { status: res.status, json: null, events };
}
const deltas = (events: { event: string; data: Record<string, unknown> }[]) =>
  events
    .filter((e) => e.event === "delta")
    .map((e) => e.data.t)
    .join("");
const stored = async (conversationId: string) =>
  (await pool.query<{ role: string; content: string }>("SELECT role, content FROM ai_messages WHERE conversation_id = $1 ORDER BY at", [conversationId])).rows;

beforeAll(async () => {
  const { deps } = depsFromEnv(model);
  pool = deps.pool;
  delete deps.platform;
  deps.services = { work: none, employee: none, chat: none } as unknown as typeof deps.services;
  deps.identity = { request: async () => ({ userIds: [] }) } as unknown as typeof deps.identity;
  ai = await createAiApp(deps, SECRET);
  await ai.listen(0);
  aiUrl = (await ai.getUrl()).replace("[::1]", "127.0.0.1");
});

afterAll(async () => {
  await ai?.close();
});

describe("Hỏi đáp, streamed", () => {
  let conversationId = "";

  it("sends the answer piece by piece and keeps exactly what was streamed", async () => {
    model.plan = { pieces: ["Mưa ", "rơi ", "nhẹ."], then: "finish" };
    const r = await stream(lan, "/assistant/messages/stream", { content: "Write a short poem about rain" });
    expect(r.status).toBe(200);
    expect(r.events[0]?.event).toBe("start");
    expect(deltas(r.events)).toBe("Mưa rơi nhẹ.");
    const done = r.events.at(-1)!;
    expect(done.event).toBe("done");
    expect(done.data).toMatchObject({ answer: "Mưa rơi nhẹ.", model: "streaming" });
    conversationId = String(done.data.conversationId);
    expect(await stored(conversationId)).toEqual([
      { role: "user", content: "Write a short poem about rain" },
      { role: "assistant", content: "Mưa rơi nhẹ." },
    ]);
    // Metered like any answer.
    const usage = (await pool.query("SELECT output_tokens FROM ai_usage WHERE user_id = $1 AND feature = 'assistant' ORDER BY at DESC LIMIT 1", [lan.id])).rows[0];
    expect(usage).toEqual({ output_tokens: 3 });
  });

  it("the stop button keeps what was written; nobody else can stop it", async () => {
    model.plan = { pieces: ["Một ", "hai "], then: "wait" };
    const r = await stream(lan, "/assistant/messages/stream", { content: "Count to ten slowly", conversationId }, async (id) => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      const other = await fetch(`${aiUrl}/assistant/streams/${id}/stop`, { method: "POST", headers: await headers(huy) });
      expect(other.status).toBe(204);
      await new Promise((resolve) => setTimeout(resolve, 30));
      const mine = await fetch(`${aiUrl}/assistant/streams/${id}/stop`, { method: "POST", headers: await headers(lan) });
      expect(mine.status).toBe(204);
    });
    const done = r.events.at(-1)!;
    expect(done).toMatchObject({ event: "done", data: { answer: "Một hai ", stopped: true } });
    expect((await stored(conversationId)).at(-1)).toEqual({ role: "assistant", content: "Một hai " });
  });

  it("stopped before a word was written: nothing is kept", async () => {
    model.plan = { pieces: [], then: "wait" };
    const before = (await stored(conversationId)).length;
    const r = await stream(lan, "/assistant/messages/stream", { content: "Never mind", conversationId }, async (id) => {
      await fetch(`${aiUrl}/assistant/streams/${id}/stop`, { method: "POST", headers: await headers(lan) });
    });
    expect(r.events.at(-1)).toMatchObject({ event: "done", data: { answer: "", stopped: true } });
    expect((await stored(conversationId)).length).toBe(before);
  });

  it("redoes the last answer as a stream, in place", async () => {
    model.plan = { pieces: ["Ba ", "bốn."], then: "finish" };
    const r = await stream(lan, `/assistant/conversations/${conversationId}/regenerate/stream`, {});
    expect(deltas(r.events)).toBe("Ba bốn.");
    expect((await stored(conversationId)).at(-1)).toEqual({ role: "assistant", content: "Ba bốn." });
  });

  it("a refusal before the stream opens is a plain HTTP error; a failure after it is an error event", async () => {
    const bad = await stream(lan, "/assistant/messages/stream", { content: "" });
    expect(bad.status).toBe(400);
    const notMine = await stream(huy, "/assistant/messages/stream", { content: "hi", conversationId });
    expect(notMine.status).toBe(404);
    model.plan = { pieces: ["Half"], then: "fail" };
    const r = await stream(lan, "/assistant/messages/stream", { content: "Tell me a story" });
    expect(r.events.at(-1)).toMatchObject({ event: "error", data: { status: 500 } });
  });
});
