import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { INestApplication } from "@nestjs/common";
import pg from "pg";
import { migrate, signInternalToken, PRINCIPAL_HEADER, S3Storage, ServiceClient } from "@workspace/service-kit";
import { newId, type Grant, type Principal } from "@workspace/shared";
import { createAiApp, depsFromEnv } from "../../src/modules/ai/app.js";
import { LocalProvider, type ModelProvider, type ModelRequest, type ModelResponse } from "../../src/modules/ai/providers.js";
import { createWorkApp } from "../../src/modules/work/app.js";
import { resetTestDatabase } from "../test-db.js";

/**
 * AI on a whiteboard: summarize, group sticky notes, suggest notes. With the built-in model (AI_LOCAL_MODEL=1) in
 * English and Vietnamese; with a real provider through the same prompts, its answer checked before it is returned.
 */
const SECRET = "dev-internal-secret-change-me-32bytes!";
const grants = (...ps: string[]): Grant[] => ps.map((permission) => ({ permission, scope: "WORKSPACE" }));
const mk = (id: string): Principal => ({
  type: "user",
  id,
  teamIds: [],
  departmentId: null,
  grants: grants("document.read", "document.create", "project.read", "task.read", "ai.use"),
});
const minh = mk("minh");
const lan = mk("lan");

class ScriptedProvider implements ModelProvider {
  readonly name = "scripted";
  last: ModelRequest | null = null;
  reply = "{}";
  async generate(req: ModelRequest): Promise<ModelResponse> {
    this.last = req;
    return { text: this.reply, toolCalls: [], usage: { inputTokens: 10, outputTokens: 10 }, model: "scripted" };
  }
}

const apps: INestApplication[] = [];
const url: Record<string, string> = {};
const scripted = new ScriptedProvider();
const urlOf = async (a: INestApplication) => (await a.getUrl()).replace("[::1]", "127.0.0.1");

async function call(svc: string, p: Principal, method: string, path: string, body?: unknown, locale = "vi") {
  const res = await fetch(`${url[svc]}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-locale": locale, [PRINCIPAL_HEADER]: await signInternalToken({ principal: p, requestId: newId() }, SECRET) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null };
}

async function aiApp(provider: ModelProvider) {
  const { deps } = depsFromEnv(provider);
  deps.services = { ...deps.services, work: new ServiceClient(url.work!, SECRET, "ai", []) };
  const a = await createAiApp(deps, SECRET);
  await a.listen(0);
  apps.push(a);
  return urlOf(a);
}

let seq = 0;
const note = (id: string, text: string, x: number, y: number) => [
  {
    id,
    type: "rectangle",
    version: 1,
    versionNonce: 1,
    index: `a${String(seq++).padStart(2, "0")}`,
    x,
    y,
    backgroundColor: "#FEF3C7",
    customData: { sticky: true },
    boundElements: [{ type: "text", id: `${id}t` }],
  },
  { id: `${id}t`, type: "text", version: 1, versionNonce: 1, index: `a${String(seq++).padStart(2, "0")}`, x, y, text, originalText: text, containerId: id },
];
async function board(owner: Principal, title: string, template: string, locale: string, notes: [string, string, number, number][], visibility = "workspace") {
  const b = (await call("work", owner, "POST", "/whiteboards", { title, template, visibility }, locale)).body;
  // Template elements first (their headings), then the notes.
  const elements = [...b.scene.elements, ...notes.flatMap(([id, text, x, y]) => note(id, text, x, y))];
  const saved = await call("work", owner, "PUT", `/whiteboards/${b.id}/scene`, { baseVersion: 1, scene: { elements, appState: {}, files: {} } });
  expect(saved.status).toBe(200);
  return b.id as string;
}

let retroEn: string;
let retroVi: string;
let secret: string;
const before = process.env.AI_LOCAL_MODEL;

beforeAll(async () => {
  process.env.AI_LOCAL_MODEL = "1";
  await resetTestDatabase();
  for (const m of ["work", "ai"])
    await migrate("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test", fileURLToPath(new URL(`../../migrations/${m}`, import.meta.url)), m);
  const work = await createWorkApp({
    pool: new pg.Pool({ connectionString: "postgres://workspace_work:app_pw@localhost:5432/workspace_test", max: 5 }),
    storage: new S3Storage({
      endpoint: "http://localhost:8333",
      region: "auto",
      bucket: "workspace-files",
      accessKeyId: "workspace_dev_key",
      secretAccessKey: "workspace_dev_secret",
    }),
    internalSecret: SECRET,
  });
  await work.listen(0);
  apps.push(work);
  url.work = await urlOf(work);
  url.ai = await aiApp(new LocalProvider());
  url.scripted = await aiApp(scripted);

  // Headings sit at y≈14 in each 340-wide column (whiteboard-templates.ts).
  retroEn = await board(minh, "Sprint 12 retro", "retro", "en", [
    ["n1", "Code reviews were fast", 0, 100],
    ["n2", "Release notes were late", 340, 100],
    ["n3", "Automate release notes", 680, 100],
    ["n4", "Customers liked onboarding", 0, 320],
  ]);
  retroVi = await board(minh, "Retro tháng 10", "retro", "vi", [
    ["v1", "Khách hàng phản hồi nhanh hơn", 0, 100],
    ["v2", "Báo giá gửi chậm", 340, 100],
    ["v3", "Làm mẫu báo giá chung", 680, 100],
    ["v4", "Khách hàng cũ quay lại", 0, 320],
  ]);
  secret = await board(minh, "Riêng tư", "blank", "vi", [["p1", "Lương thưởng", 0, 0]], "private");
});

afterAll(async () => {
  process.env.AI_LOCAL_MODEL = before;
  for (const a of apps.reverse()) await a.close();
});

describe("whiteboard AI with the built-in model", () => {
  it("summarizes under the board's own headings, in English and in Vietnamese", async () => {
    const en = await call("ai", lan, "POST", "/whiteboard/summarize", { whiteboardId: retroEn }, "en");
    expect(en.status).toBe(200);
    expect(en.body.summary).toBe(
      "**Sprint 12 retro** · 4 notes\n\n### Went well\n- Code reviews were fast\n- Customers liked onboarding\n\n### To improve\n- Release notes were late\n\n### Actions\n- Automate release notes",
    );
    const vi = await call("ai", lan, "POST", "/whiteboard/summarize", { whiteboardId: retroVi }, "vi");
    expect(vi.body.summary).toMatch(
      /^\*\*Retro tháng 10\*\* · 4 ghi chú\n\n### Điều làm tốt\n- Khách hàng phản hồi nhanh hơn\n- Khách hàng cũ quay lại\n\n### Cần cải thiện\n- Báo giá gửi chậm/,
    );
  });

  it("groups notes by theme, every note once", async () => {
    const en = (await call("ai", lan, "POST", "/whiteboard/cluster", { whiteboardId: retroEn }, "en")).body.groups;
    expect(en).toEqual([
      { title: "Release notes", elementIds: ["n2", "n3"] },
      { title: "Other", elementIds: ["n1", "n4"] },
    ]);
    const vi = (await call("ai", lan, "POST", "/whiteboard/cluster", { whiteboardId: retroVi }, "vi")).body.groups;
    expect(vi.map((g: { title: string }) => g.title)).toEqual(["Khách hàng", "Báo giá"]);
    // Only the notes asked about.
    const some = (await call("ai", lan, "POST", "/whiteboard/cluster", { whiteboardId: retroEn, elementIds: ["n2", "n3"] }, "en")).body.groups;
    expect(some.flatMap((g: { elementIds: string[] }) => g.elementIds).sort()).toEqual(["n2", "n3"]);
  });

  it("suggests new notes about the request or the board, in the reader's language", async () => {
    const en = (await call("ai", lan, "POST", "/whiteboard/ideas", { whiteboardId: retroEn, prompt: "release notes" }, "en")).body.ideas;
    expect(en.length).toBeGreaterThanOrEqual(4);
    expect(en[0]).toBe("Ask three customers what is hardest about release notes");
    const vi = (await call("ai", lan, "POST", "/whiteboard/ideas", { whiteboardId: retroVi }, "vi")).body.ideas;
    expect(vi[0]).toBe("Hỏi ba khách hàng điều gì khó nhất về retro tháng 10");
    // A Vietnamese request is answered in Vietnamese even from an English interface.
    expect((await call("ai", lan, "POST", "/whiteboard/ideas", { whiteboardId: retroEn, prompt: "Tuyển dụng nhân viên mới" }, "en")).body.ideas[0]).toMatch(/^Hỏi ba khách hàng/);
  });

  it("only reads boards the person can open, and refuses without an AI connection", async () => {
    expect(await call("ai", lan, "POST", "/whiteboard/summarize", { whiteboardId: secret })).toMatchObject({ status: 404, body: { error: "not_found" } });
    expect((await call("ai", minh, "POST", "/whiteboard/summarize", { whiteboardId: secret })).status).toBe(200);
    expect((await call("ai", { ...lan, grants: grants("document.read") }, "POST", "/whiteboard/ideas", { whiteboardId: retroEn })).status).toBe(403);
    expect((await call("ai", lan, "POST", "/whiteboard/cluster", { whiteboardId: "../../tasks" })).status).toBe(400);
    process.env.AI_LOCAL_MODEL = "";
    try {
      expect(await call("ai", lan, "POST", "/whiteboard/summarize", { whiteboardId: retroEn })).toMatchObject({ status: 503, body: { error: "ai_not_configured" } });
    } finally {
      process.env.AI_LOCAL_MODEL = "1";
    }
  });
});

describe("whiteboard AI with a provider", () => {
  it("sends the board as untrusted note lines and keeps only valid groups", async () => {
    scripted.reply = JSON.stringify({
      groups: [
        { title: "Release", elementIds: ["n2", "n3", "invented", "n2"] },
        { title: "Empty", elementIds: ["nope"] },
      ],
    });
    const r = await call("scripted", lan, "POST", "/whiteboard/cluster", { whiteboardId: retroEn }, "en");
    expect(r.body.groups).toEqual([
      { title: "Release", elementIds: ["n2", "n3"] },
      { title: "Other", elementIds: ["n1", "n4"] },
    ]);
    expect(scripted.last!.messages[0]!.content).toMatch(/<untrusted_content>\n\[note n1 \d+,\d+\] Code reviews were fast/);
    expect(scripted.last!.system).toMatch(/Write in English/);

    scripted.reply = "not json";
    expect((await call("scripted", lan, "POST", "/whiteboard/summarize", { whiteboardId: retroEn })).status).toBe(502);
    scripted.reply = JSON.stringify({ ideas: ["  Một ý   tưởng  ", "", 42] });
    expect((await call("scripted", lan, "POST", "/whiteboard/ideas", { whiteboardId: retroEn })).body.ideas).toEqual(["Một ý tưởng", "42"]);
  });
});
