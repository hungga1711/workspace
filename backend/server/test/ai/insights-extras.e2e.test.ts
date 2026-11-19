import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import type { INestApplication } from "@nestjs/common";
import pg from "pg";
import { migrate, PRINCIPAL_HEADER, signInternalToken, type Mail, type ServiceClient } from "@workspace/service-kit";
import { newId, withTransaction, type Principal } from "@workspace/shared";
import { createAiApp } from "../../src/modules/ai/app.js";
import type { ModelProvider, ModelRequest, ModelResponse } from "../../src/modules/ai/providers.js";
import type { Deps } from "../../src/modules/ai/runtime.js";
import { recordTurn } from "../../src/modules/ai/activity.js";
import { classifyTopicsBatch } from "../../src/modules/ai/topics.js";
import { sendWeeklyReports } from "../../src/modules/ai/report.js";

/**
 * AI Insights extras against the real ai schema: company topics (keywords and the hourly model batch), the prompt
 * library, the capability map, provider imports and the weekly report. Other services are stubs.
 */
const SECRET = "dev-internal-secret-change-me-32bytes!";
const DB = process.env.WX_TEST_DB ?? "workspace_test";
const admin = newId();
const staff = newId();
const other = newId();

class Scripted implements ModelProvider {
  readonly name = "scripted";
  calls: ModelRequest[] = [];
  reply = "{}";
  menu() {
    return [{ label: "Scripted" }];
  }
  async generate(req: ModelRequest): Promise<ModelResponse> {
    this.calls.push(req);
    return { text: this.reply, toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, model: "scripted" };
  }
}

const people = [
  { userId: admin, displayName: "Owner", department: "Ban giám đốc" },
  { userId: staff, displayName: "An Nguyễn", department: "Sales" },
  { userId: other, displayName: "Bình Trần", department: "Kho" },
];
const stub = (routes: Record<string, unknown>) =>
  ({
    request: async (_method: string, path: string, _body?: unknown, as?: Principal) => {
      const hit = Object.entries(routes).find(([k]) => path.startsWith(k));
      if (!hit) throw new Error(`no stub for ${path}`);
      return typeof hit[1] === "function" ? (hit[1] as (p?: Principal) => unknown)(as) : hit[1];
    },
  }) as unknown as ServiceClient;

const provider = new Scripted();
let pool: pg.Pool;
let app: INestApplication;
let url: string;
let deps: Deps;
const P = (id: string, grants: Principal["grants"] = []): Principal => ({ type: "user", id, teamIds: [], departmentId: null, grants });
const asAdmin = P(admin, [{ permission: "ai.policy.manage", scope: "WORKSPACE" }]);
const asStaff = P(staff);

async function call(p: Principal, method: string, path: string, body?: unknown) {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { "content-type": "application/json", [PRINCIPAL_HEADER]: await signInternalToken({ principal: p, requestId: newId() }, SECRET) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null };
}
const tx = <R>(fn: (c: pg.PoolClient) => Promise<R>) => withTransaction(pool, fn);

beforeAll(async () => {
  await migrate(`postgres://workspace_owner:owner_pw@localhost:5432/${DB}`, fileURLToPath(new URL("../../migrations/ai", import.meta.url)), "ai");
  pool = new pg.Pool({ connectionString: `postgres://workspace_ai:app_pw@localhost:5432/${DB}`, max: 4 });
  // Topics, keywords and the report switch are the workspace's, shared by every suite on the test database.
  for (const table of ["ai_topics", "ai_keywords", "ai_report_settings"]) await pool.query(`DELETE FROM ${table}`);
  deps = {
    pool,
    provider,
    identity: stub({
      "/members": { members: people.map((x) => ({ userId: x.userId, email: `${x.displayName.split(" ")[0]!.toLowerCase()}@example.com` })) },
      "/internal/holders/ai.policy.manage/emails": { emails: ["owner@example.com"] },
      "/internal/holders/ai.policy.manage": { userIds: [admin] },
      "/internal/holders": { userIds: [] },
      "/internal/resolve": () => asAdmin,
    }),
    platform: stub({ "/internal/workspace": { features: { aiAssistant: true, aiMonitoring: true } } }),
    services: {
      employee: stub({ "/employees": { employees: people }, "/me/reports": (p?: Principal) => ({ reports: p?.id === other ? [{ userId: staff }] : [] }) }),
      work: stub({ "/followup/outcomes": { withAi: { assisted: { done: 0, dated: 0, onTime: 0, cycleDays: null }, other: { done: 4, dated: 4, onTime: 3, cycleDays: 2 } } } }),
      chat: stub({}),
      ai: stub({}),
    },
  };
  app = await createAiApp(deps, SECRET);
  await app.listen(0);
  url = (await app.getUrl()).replace("[::1]", "127.0.0.1");
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe("company topics", () => {
  it("are classified by their keywords first, and by the company's model in the hourly batch", async () => {
    const created = await call(asAdmin, "POST", "/insights/topics", { labelVi: "Đấu thầu", labelEn: "Tenders", keywords: ["hồ sơ thầu"] });
    expect(created.status).toBe(201);
    expect(created.body.key).toBe("c_tenders");
    expect((await call(asStaff, "POST", "/insights/topics", { labelVi: "X" })).status).toBe(403);
    // Relabel a built-in one; "other" can never be archived.
    expect((await call(asAdmin, "PUT", "/insights/topics/code", { labelVi: "Phần mềm", labelEn: "Software" })).status).toBe(200);
    expect((await call(asAdmin, "PUT", "/insights/topics/other", { archived: true })).status).toBe(400);
    const list = (await call(asStaff, "GET", "/insights/topics")).body.topics as { key: string; labelVi: string }[];
    expect(list.find((t) => t.key === "code")?.labelVi).toBe("Phần mềm");

    const a = await tx((c) =>
      recordTurn(c, { userId: staff, source: "chatgpt", externalKey: `/c/${newId()}`, model: "", prompt: "Soạn email gửi kèm hồ sơ thầu cho dự án", response: null }),
    );
    const b = await tx((c) => recordTurn(c, { userId: staff, source: "chatgpt", externalKey: `/c/${newId()}`, model: "", prompt: "Soạn email cảm ơn đối tác", response: null }));
    const topicOf = (id: string) =>
      tx(async (c) => (await c.query<{ topic: string; topic_by: string }>("SELECT topic, topic_by FROM ai_conversations WHERE id = $1", [id])).rows[0]!);
    expect(await topicOf(a.id)).toEqual({ topic: "c_tenders", topic_by: "keywords" });
    expect((await topicOf(b.id)).topic).toBe("writing");

    // The batch sends redacted text, only picks keys from the list, and marks what it decided.
    provider.calls = [];
    provider.reply = JSON.stringify(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [String(i + 1), "sales"])));
    expect(await classifyTopicsBatch(deps)).toBeGreaterThanOrEqual(2);
    expect(provider.calls[0]!.system).toContain("c_tenders: Tenders");
    expect(await topicOf(b.id)).toEqual({ topic: "sales", topic_by: "model" });
    const usage = await tx(async (c) => (await c.query("SELECT 1 FROM ai_usage WHERE feature = 'ai_topics' AND user_id = 'ai-topics'")).rowCount);
    expect(usage).toBeGreaterThan(0);
  });
});

describe("prompt library", () => {
  it("shares a redacted prompt from my own conversation, searches it and counts uses", async () => {
    await tx((c) => c.query("INSERT INTO ai_keywords (id, term, created_by) VALUES ($1, 'Acme Corp', 'test') ON CONFLICT DO NOTHING", [newId()]));
    const conv = await tx((c) =>
      recordTurn(c, { userId: staff, source: "claude", externalKey: `/chat/${newId()}`, model: "", prompt: "Viết thư chào hàng cho Acme Corp, gửi an@acme.vn", response: null }),
    );
    expect((await call(P(other), "GET", `/insights/library/draft/${conv.id}`)).status).toBe(404);
    const draft = (await call(asStaff, "GET", `/insights/library/draft/${conv.id}`)).body;
    expect(draft.prompts[0]).not.toContain("Acme Corp");
    expect(draft.prompts[0]).not.toContain("an@acme.vn");
    // Whatever the browser sends, the server masks again.
    const shared = await call(asStaff, "POST", "/insights/library", {
      conversationId: conv.id,
      title: "Thư chào hàng mẫu",
      body: "Viết thư chào hàng cho Acme Corp",
      topic: "sales",
    });
    expect(shared.status).toBe(201);
    expect((await call(P(other), "POST", "/insights/library", { conversationId: conv.id, title: "x", body: "y" })).status).toBe(404);

    const found = (await call(P(other), "GET", "/insights/library?q=chào hàng")).body.prompts as { id: string; body: string; canDelete: boolean }[];
    const mine = found.find((x) => x.id === shared.body.id)!;
    expect(mine.body).toContain("[KEYWORD]");
    expect(mine.canDelete).toBe(false);
    expect((await call(P(other), "POST", `/insights/library/${mine.id}/use`)).body.uses).toBe(1);
    expect((await call(P(other), "DELETE", `/insights/library/${mine.id}`)).status).toBe(403);
    // The author keeps reading and editing their own words; colleagues keep the masked copy.
    const authored = async () =>
      ((await call(asStaff, "GET", "/insights/library?tab=mine")).body.prompts as { id: string; body: string; redacted?: boolean }[]).find((x) => x.id === mine.id)!;
    expect(await authored()).toMatchObject({ body: "Viết thư chào hàng cho Acme Corp", redacted: true });
    expect((await call(asStaff, "PATCH", `/insights/library/${mine.id}`, { title: "Thư chào hàng mới" })).status).toBe(200);
    expect((await authored()).body).toBe("Viết thư chào hàng cho Acme Corp");
    const seen = ((await call(P(other), "GET", "/insights/library?q=chào hàng")).body.prompts as { id: string; body: string }[]).find((x) => x.id === mine.id)!;
    expect(seen.body).toContain("[KEYWORD]");
    expect((await call(asStaff, "DELETE", `/insights/library/${mine.id}`)).status).toBe(200);
  });

  it("keeps company and personal prompts apart, with who may publish, see and approve", async () => {
    const sales = (id: string, grants: Principal["grants"] = []): Principal => ({ type: "user", id, teamIds: [], departmentId: "d_sales", grants });
    const mgr = sales(newId(), [{ permission: "ai.prompt.manage", scope: "DEPARTMENT" }]);
    const seller = sales(staff);
    const stranger: Principal = { type: "user", id: other, teamIds: [], departmentId: "d_kho", grants: [] };

    // Company prompts: staff cannot add one; a department manager only for their own department.
    expect((await call(seller, "POST", "/insights/library", { level: "company", title: "x", body: "y" })).status).toBe(403);
    expect((await call(mgr, "POST", "/insights/library", { level: "company", title: "x", body: "y" })).status).toBe(403);
    const forSales = await call(mgr, "POST", "/insights/library", { level: "company", title: "Báo giá chuẩn", body: "Soạn báo giá", audience: ["d_sales"] });
    expect(forSales.status).toBe(201);
    const company = await call(asAdmin, "POST", "/insights/library", { level: "company", title: "Tóm tắt họp", body: "Tóm tắt cuộc họp", pinned: true });
    const ids = async (p: Principal, tab: string) => ((await call(p, "GET", `/insights/library?tab=${tab}`)).body.prompts as { id: string }[]).map((x) => x.id);
    expect(await ids(seller, "company")).toEqual(expect.arrayContaining([forSales.body.id, company.body.id]));
    expect(await ids(stranger, "company")).not.toContain(forSales.body.id);
    expect((await call(stranger, "POST", `/insights/library/${forSales.body.id}/use`)).status).toBe(404);

    // A personal prompt written here starts private; shared with the department, the stranger still cannot see it.
    const own = await call(seller, "POST", "/insights/library", { title: "Email nhắc nợ", body: "Viết email nhắc nợ lịch sự" });
    expect(await ids(stranger, "team")).not.toContain(own.body.id);
    expect((await call(stranger, "PATCH", `/insights/library/${own.body.id}`, { title: "hack" })).status).toBe(404);
    expect((await call(seller, "PATCH", `/insights/library/${own.body.id}`, { visibility: "department" })).status).toBe(200);
    expect(await ids(mgr, "team")).toContain(own.body.id);
    expect(await ids(stranger, "team")).not.toContain(own.body.id);

    // Proposed to the department: the manager reviews it; it goes live for sales.
    const proposed = await call(seller, "POST", `/insights/library/${own.body.id}/propose`, { audience: "department" });
    expect(proposed.status).toBe(201);
    expect((await call(seller, "POST", `/insights/library/${own.body.id}/propose`, {})).status).toBe(409);
    expect(await ids(mgr, "review")).toContain(proposed.body.id);
    expect(await ids(seller, "review")).toEqual([]);
    expect((await call(mgr, "POST", `/insights/library/${proposed.body.id}/review`, { decision: "approve", audience: [] })).status).toBe(403);
    expect((await call(mgr, "POST", `/insights/library/${proposed.body.id}/review`, { decision: "approve" })).body.status).toBe("live");
    const mine = (await call(seller, "GET", "/insights/library?tab=mine")).body.prompts as { id: string; proposal: { status: string } | null }[];
    expect(mine.find((x) => x.id === own.body.id)?.proposal?.status).toBe("live");
    expect(await ids(seller, "company")).toContain(proposed.body.id);
  });
});

describe("capability map and weekly report", () => {
  it("is for managers and admins, counts ratings, recommends three steps", async () => {
    await tx(async (c) => {
      for (let i = 0; i < 4; i++) {
        const r = await recordTurn(c, { userId: staff, source: "chatgpt", externalKey: `/c/${newId()}`, model: "", prompt: "Phân tích doanh thu theo tháng", response: null });
        await c.query("UPDATE ai_conversations SET helpful = 'yes', messages = 4 WHERE id = $1", [r.id]);
      }
    });
    // Bình manages An; someone without reports sees nothing.
    expect((await call(P(newId()), "GET", "/insights/capability")).status).toBe(403);
    expect((await call(P(other), "GET", "/insights/capability")).body.departments.map((d: { name: string }) => d.name)).toEqual(["Sales"]);
    const map = (await call(asAdmin, "GET", "/insights/capability")).body;
    const sales = map.departments.find((d: { name: string }) => d.name === "Sales");
    expect(sales.top[0]).toMatchObject({ userId: staff, mentor: true });

    const report = (await call(asAdmin, "GET", "/insights/report?days=7")).body;
    expect(report.totals.people).toBe(3);
    expect(report.totals.helpful.yes).toBeGreaterThanOrEqual(4);
    expect(report.recommendations).toHaveLength(3);
    expect(report.work.other.done).toBe(4);
    // A manager sees their reporting line only.
    expect((await call(P(other), "GET", "/insights/report")).body.totals.people).toBe(1);
    expect((await call(P(newId()), "GET", "/insights/report")).status).toBe(403);

    expect((await call(asAdmin, "GET", "/insights/report/settings")).body.weeklyEmail).toBe(false);
    expect((await call(asAdmin, "PUT", "/insights/report/settings", { weeklyEmail: true })).body.weeklyEmail).toBe(true);
    expect((await call(asStaff, "PUT", "/insights/report/settings", { weeklyEmail: true })).status).toBe(403);
  });

  it("emails the AI admins once, Monday from 08:00 in the workspace's zone", async () => {
    const sent: Mail[] = [];
    const mailer = { send: async (m: Mail) => void sent.push(m) };
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-25T10:00:00Z")); // Sunday in Ho Chi Minh City
      await sendWeeklyReports(deps, mailer, "https://wx.example");
      expect(sent.filter((m) => m.to === "owner@example.com")).toHaveLength(0);
      vi.setSystemTime(new Date("2026-10-26T02:00:00Z")); // Monday 09:00
      await sendWeeklyReports(deps, mailer, "https://wx.example");
      await sendWeeklyReports(deps, mailer, "https://wx.example");
      const mine = sent.filter((m) => m.to === "owner@example.com");
      expect(mine).toHaveLength(1);
      expect(mine[0]!.text).toContain("https://wx.example/app/ai/adoption/report");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("first AI report", () => {
  it("goes once, 7 days after the install, even mid-week; then Monday as usual", async () => {
    const sent: Mail[] = [];
    const mailer = { send: async (m: Mail) => void sent.push(m) };
    await tx((c) => c.query("UPDATE ai_report_settings SET weekly_email = true, since = $1, first_sent_at = NULL, last_sent_week = NULL", [new Date("2026-10-20T00:00:00Z")]));
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-29T05:00:00Z")); // Thursday 12:00 in Ho Chi Minh City, day 9
      await sendWeeklyReports(deps, mailer, "https://wx.example");
      await sendWeeklyReports(deps, mailer, "https://wx.example");
      const mine = sent.filter((m) => m.to === "owner@example.com");
      expect(mine).toHaveLength(1);
      expect(mine[0]!.text).toMatch(/7 days|7 ngày/);
      // That week is covered; the next Monday brings the usual report.
      vi.setSystemTime(new Date("2026-11-02T02:00:00Z"));
      await sendWeeklyReports(deps, mailer, "https://wx.example");
      expect(sent.filter((m) => m.to === "owner@example.com")).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("provider import", () => {
  it("matches people by email, skips duplicates, unknown people and bad rows, and can be undone", async () => {
    const at = new Date(Date.now() - 2 * 86400_000).toISOString();
    const rows = [
      { email: "an@example.com", at, tool: "Claude for Work", title: "Tóm tắt hợp đồng", tokens: 1200, cost: 0.02 },
      { email: "AN@example.com", at, tool: "Chat assistant", model: "gpt-4o", prompt: "Viết email báo giá" },
      { email: "nobody@example.com", at, tool: "x" },
      { email: "an@example.com", at: "not a date" },
    ];
    const first = await call(asAdmin, "POST", "/insights/imports", { filename: "usage.csv", format: "csv", mapping: { email: "User" }, rows, total: rows.length });
    expect(first.body).toMatchObject({ imported: 2, duplicate: 0, unmatched: 1, invalid: 1 });
    const again = await call(asAdmin, "POST", "/insights/imports", { filename: "usage.csv", format: "csv", rows });
    expect(again.body).toMatchObject({ imported: 0, duplicate: 2 });
    const sources = await tx(async (c) =>
      (await c.query<{ source: string }>("SELECT source FROM ai_conversations WHERE import_id = $1 ORDER BY source", [first.body.importId])).rows.map((r) => r.source),
    );
    expect(sources).toEqual(["chatgpt", "claude"]);
    expect((await call(asStaff, "POST", "/insights/imports", { format: "csv", rows })).status).toBe(403);
    const log = (await call(asAdmin, "GET", "/insights/imports")).body.imports;
    expect(log.find((x: { id: string }) => x.id === first.body.importId)).toMatchObject({ imported: 2, unmatched: 1, invalid: 1 });
    expect((await call(asAdmin, "DELETE", `/insights/imports/${first.body.importId}`)).body.removed).toBe(2);
  });

  it("never keeps an imported prompt's text, counts messages and notes task codes", async () => {
    const at = new Date(Date.now() - 86400_000).toISOString();
    const rows = [{ email: "an@example.com", at, tool: "chatgpt", title: "Quote for T-062", prompt: "Draft the quote for T-062, Fennel Grocers", count: 3 }];
    const r = await call(asAdmin, "POST", "/insights/imports", { filename: "chatgpt-export.zip", format: "json", rows, total: 1 });
    expect(r.body.imported).toBe(1);
    const conv = (
      await tx((c) =>
        c.query<{ id: string; messages: number; hint_task_code: string | null }>("SELECT id, messages, hint_task_code FROM ai_conversations WHERE import_id = $1", [
          r.body.importId,
        ]),
      )
    ).rows[0]!;
    expect(conv).toMatchObject({ messages: 3, hint_task_code: "T-062" });
    expect((await tx((c) => c.query("SELECT 1 FROM ai_messages WHERE conversation_id = $1", [conv.id]))).rowCount).toBe(0);
    await call(asAdmin, "DELETE", `/insights/imports/${r.body.importId}`);
  });
});
