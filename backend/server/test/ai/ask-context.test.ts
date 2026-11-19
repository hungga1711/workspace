import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { PRINCIPAL_HEADER, ServiceCallError, signInternalToken } from "@workspace/service-kit";
import { newId, type Principal } from "@workspace/shared";
import { createAiApp, depsFromEnv } from "../../src/modules/ai/app.js";
import type { ModelProvider, ModelRequest, ModelResponse } from "../../src/modules/ai/providers.js";

const SECRET = "dev-internal-secret-change-me-32bytes!";

/**
 * The ask panel (⌘J), end to end in the ai module with a scripted model: the screen the question was asked on is read
 * as the asker and told to the model as "on screen" (and a channel screen shows the chat tools), something unreadable
 * is left out without failing the answer, and a follow-up carries the tools the last answer ran, with their input, so
 * it can refine the same lookup. The lookups are never sent to the browser.
 */
class ScriptedProvider implements ModelProvider {
  readonly name = "scripted";
  requests: ModelRequest[] = [];
  /** The tool the next question calls first (then the answer is written), or none. */
  plan: { tool: string; input: Record<string, unknown> } | null = null;
  async generate(req: ModelRequest): Promise<ModelResponse> {
    this.requests.push(req);
    const last = req.messages.at(-1);
    const text = typeof last?.content === "string" ? last.content : "";
    if (req.tools?.length && this.plan && !text.startsWith("Result of")) {
      return { text: "", toolCalls: [{ id: newId(), name: this.plan.tool, input: this.plan.input }], usage: { inputTokens: 5, outputTokens: 5 }, model: "scripted" };
    }
    return { text: "Here is what I found.", toolCalls: [], usage: { inputTokens: 5, outputTokens: 5 }, model: "scripted" };
  }
}
const model = new ScriptedProvider();

const CHANNEL = "01M7AAAAAAAAAAAAAAAAAAAAAA";
const SECRET_CHANNEL = "01M7BBBBBBBBBBBBBBBBBBBBBB";
const people = [
  { userId: "u-lan", displayName: "Lan Nguyen", title: "Designer", department: "Design", managerId: null },
  { userId: "u-huy", displayName: "Huy Tran", title: "Engineer", department: "Engineering", managerId: null },
];
const services = {
  employee: {
    async request(_m: string, path: string) {
      if (path.startsWith("/employees")) return { employees: people };
      throw new ServiceCallError(404, { error: "not found" }, `GET ${path} → 404`);
    },
  },
  chat: {
    async request(_m: string, path: string) {
      if (path.startsWith(`/channels/${CHANNEL}/messages`))
        return { messages: [{ id: "01M7CCCCCCCCCCCCCCCCCCCCCC", body: "Launch moved to Friday, design review Thursday", deletedAt: null }] };
      if (path.startsWith(`/channels/${SECRET_CHANNEL}`)) throw new ServiceCallError(403, { error: "forbidden" }, `GET ${path} → 403`);
      throw new ServiceCallError(404, { error: "not found" }, `GET ${path} → 404`);
    },
  },
  work: {
    async request(_m: string, path: string): Promise<never> {
      throw new ServiceCallError(404, { error: "not found" }, `GET ${path} → 404`);
    },
  },
};

let ai: INestApplication;
let aiUrl = "";
let pool: import("pg").Pool;
const grants = ["ai.use", "employee.profile.read", "message.read", "task.read"].map((permission) => ({ permission, scope: "WORKSPACE" as const }));
const lan: Principal = { type: "user", id: newId(), teamIds: [], departmentId: null, grants };

async function post(path: string, body: unknown) {
  const res = await fetch(`${aiUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", [PRINCIPAL_HEADER]: await signInternalToken({ principal: lan, requestId: newId() }, SECRET) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
async function get(path: string) {
  const res = await fetch(`${aiUrl}${path}`, { headers: { [PRINCIPAL_HEADER]: await signInternalToken({ principal: lan, requestId: newId() }, SECRET) } });
  return { status: res.status, text: await res.text() };
}
/** Everything the model was told for one question, as one text. */
const told = (req: ModelRequest) => [req.system, ...req.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))].join("\n");

beforeAll(async () => {
  const { deps } = depsFromEnv(model);
  pool = deps.pool;
  delete deps.platform;
  deps.services = services as unknown as typeof deps.services;
  deps.identity = { request: async () => ({ userIds: [] }) } as unknown as typeof deps.identity;
  ai = await createAiApp(deps, SECRET);
  await ai.listen(0);
  aiUrl = (await ai.getUrl()).replace("[::1]", "127.0.0.1");
});

afterAll(async () => {
  await ai?.close();
});

describe("the ask panel", () => {
  it("reads the screen it was opened on as the asker and tells the model it is on screen", async () => {
    model.plan = null;
    model.requests = [];
    const r = await post("/assistant/messages", {
      content: "Tóm tắt giúp tôi",
      refs: [{ kind: "channel", id: CHANNEL, label: "launch", page: true }],
    });
    expect(r.status).toBe(201);
    const first = model.requests[0]!;
    expect(told(first)).toContain('channel "launch" open on screen');
    expect(told(first)).toContain("Launch moved to Friday");
    // Asked on a channel: the chat tools are among those shown, as for @AI in that channel.
    expect((first.tools ?? []).map((t) => t.name)).toContain("summarize_channel");
  });

  it("leaves out a screen the asker cannot read, and still answers", async () => {
    model.plan = null;
    model.requests = [];
    const r = await post("/assistant/messages", {
      content: "What is this about?",
      refs: [
        { kind: "channel", id: SECRET_CHANNEL, label: "board", page: true },
        { kind: "report", id: "nonsense", label: "?" },
      ],
    });
    expect(r.status).toBe(201);
    expect(r.body.answer).toBe("Here is what I found.");
    expect(told(model.requests[0]!)).not.toContain('channel "board" open on screen');
  });

  it("a follow-up carries the last answer's lookups, with their input, so it can refine them", async () => {
    model.plan = { tool: "find_people", input: { query: "Design" } };
    model.requests = [];
    const one = await post("/assistant/messages", { content: "Who works in Design?" });
    expect(one.status).toBe(201);
    const conversationId = String(one.body.conversationId);
    // Stored with the question, never sent to the browser.
    const kept = await pool.query<{ tool_trace: { tool: string; input: unknown; head: string }[] | null }>(
      "SELECT tool_trace FROM ai_messages WHERE conversation_id = $1 AND role = 'user'",
      [conversationId],
    );
    expect(kept.rows[0]!.tool_trace).toEqual([expect.objectContaining({ tool: "find_people", input: { query: "Design" }, ok: true })]);
    expect(kept.rows[0]!.tool_trace![0]!.head).toContain("Lan Nguyen");
    expect(JSON.stringify(one.body)).not.toContain("tool_trace");
    const opened = await get(`/assistant/conversations/${conversationId}`);
    expect(opened.status).toBe(200);
    expect(opened.text).not.toContain('"query":"Design"');

    model.plan = null;
    model.requests = [];
    const two = await post("/assistant/messages", { conversationId, content: "chỉ phòng Engineering thôi" });
    expect(two.status).toBe(201);
    const second = told(model.requests[0]!);
    expect(second).toContain('find_people {"query":"Design"}');
    expect(second).toContain("Lan Nguyen");
    expect(second).toContain("call the same tool again with the changed input");
  });
});
