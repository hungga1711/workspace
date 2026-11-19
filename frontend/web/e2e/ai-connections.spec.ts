import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, type Page } from "@playwright/test";
import { setupWorkspace } from "./helpers";

/**
 * Admin › Kết nối AI, the company's AI gateway: an owner connects a self-hosted model (a stand-in for Ollama
 * serving the OpenAI-compatible API on the same machine), tests it, saves it as the default, and the assistant
 * answers through it. Công việc › AI then shows that use under "AI của công ty dùng cho" next to the
 * "AI có giúp làm việc tốt hơn?" comparison. A stored key is never sent to a different address.
 *
 * Cost and budgets: the owner prices the model, Công việc › AI shows what it cost; a person's monthly budget
 * stops their AI with a message saying so. A task the AI helped with, once done, counts as "Có AI hỗ trợ".
 */
const run = Date.now().toString(36);
const api = (p: Page, path: string, method = "GET", data?: unknown) =>
  p.request.fetch(`/api/proxy/${path}`, { method, headers: { "x-wos-csrf": "1" }, ...(data === undefined ? {} : { data }) });

/** A tiny OpenAI-compatible server: /v1/models and /v1/chat/completions, recording what it was asked. */
function fakeOllama(): Promise<{ url: string; asked: string[]; close: () => void }> {
  const asked: string[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/models") return res.end(JSON.stringify({ data: [{ id: "llama3.2" }, { id: "qwen3:8b" }] }));
      if (req.url === "/v1/chat/completions") {
        const b = JSON.parse(body || "{}") as { model: string; messages: { role: string; content: string }[] };
        asked.push(b.messages.at(-1)?.content ?? "");
        // Task helpers ask for JSON ({"summary": string}); everything else gets a sentence.
        const json = b.messages[0]?.content.includes('{"summary": string}');
        const content = json ? JSON.stringify({ summary: "Tóm tắt từ Ollama nội bộ." }) : "Xin chào từ Ollama nội bộ.";
        return res.end(JSON.stringify({ model: b.model, choices: [{ message: { content } }], usage: { prompt_tokens: 42, completion_tokens: 7 } }));
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, asked, close: () => server.close() })),
  );
}

test("AI connections: self-hosted model tested, saved as default, used by the assistant, visible to the boss", async ({ browser }) => {
  test.setTimeout(180_000);
  const llm = await fakeOllama();
  try {
    const owner = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
    await setupWorkspace(owner, { company: `AIC ${run}`, name: "Trần Minh Hưng", email: `aic-owner-${run}@example.com` });

    // Three ways in; pick the self-hosted one.
    await owner.goto("/admin/workspace/ai");
    await expect(owner.getByRole("heading", { name: "Kết nối AI" })).toBeVisible();
    for (const mode of ["API key", "LLM API", "Tự chạy (self-host)"]) await expect(owner.getByRole("button", { name: new RegExp(mode.replace(/[()]/g, "\\$&")) })).toBeVisible();
    await owner.getByRole("button", { name: /Tự chạy \(self-host\)/ }).click();
    const dialog = owner.getByRole("dialog");
    await dialog.getByLabel("Địa chỉ (base URL)").fill(llm.url);
    await dialog.getByRole("button", { name: "Kiểm tra" }).click();
    await expect(dialog.getByText(/Kết nối được: llama3\.2 trả lời sau \d+ ms/)).toBeVisible();
    await expect(dialog.getByText("Tìm thấy 2 model")).toBeVisible();
    await expect(dialog.getByLabel(/^Model(?! cho)/)).toHaveValue("llama3.2");
    await dialog.getByRole("button", { name: "Lưu" }).click();
    await expect(dialog).toBeHidden();

    const card = owner.getByRole("listitem").filter({ hasText: "Self-host (127.0.0.1" });
    await expect(card.getByText("Mặc định")).toBeVisible();
    await expect(card.getByText(`${llm.url}/v1`)).toBeVisible();
    await card.getByRole("button", { name: "Kiểm tra" }).click();
    await expect(card.getByText(/Hoạt động tốt/)).toBeVisible();

    // The assistant offers it and answers through it.
    const models = await (await api(owner, "ai/assistant/models")).json();
    expect(models.models.map((m: { label: string }) => m.label)).toContain(`Self-host (${new URL(llm.url).host})`);
    const sent = await api(owner, "ai/assistant/messages", "POST", { content: "Tóm tắt giúp tôi kế hoạch tuần này" });
    expect(sent.status()).toBe(201);
    expect(JSON.stringify(await sent.json())).toContain("Xin chào từ Ollama nội bộ.");
    expect(llm.asked.some((q) => q.includes("kế hoạch tuần này"))).toBe(true);

    // The boss sees what the company AI is used for, and the effectiveness comparison.
    await owner.goto("/app/ai/adoption/usage?days=7");
    await expect(owner.getByRole("heading", { name: "AI và kết quả" })).toBeVisible();
    const used = owner.getByRole("region", { name: "AI của công ty dùng cho" });
    await expect(used.getByText("Trợ lý AI")).toBeVisible();

    // Prices: the owner prices the self-hosted model (normally free); Công việc › AI shows the cost.
    await owner.goto("/admin/workspace/ai/cost");
    const spend = owner.locator("#spend");
    await spend.getByLabel(/^Đầu vào .*llama3\.2$/).fill("1000");
    await spend.getByLabel(/^Đầu ra .*llama3\.2$/).fill("2000");
    await spend.getByRole("button", { name: /^Lưu giá .*llama3\.2$/ }).click();
    await expect(spend.getByRole("button", { name: /llama3\.2$/ }).filter({ hasText: "Đã lưu" })).toBeVisible();
    // Each call is 42 input + 7 output tokens: $0.056 at $1000 / $2000 per 1M (the assistant's turn, and its summary).
    const cost = (await (await api(owner, "ai/oversight?days=7")).json()).totals.cost as number;
    expect(Math.round(cost * 1000) % 56).toBe(0);
    expect(cost).toBeGreaterThan(0);
    await owner.goto("/app/ai/adoption/usage?days=7");
    // The cost tile shows the short amount (lib/money: "$0.11"); the exact one is behind its ⓘ.
    // Money reads in the viewer's language (Vietnamese here: "0,11 US$").
    const usd = new Intl.NumberFormat("vi-VN", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cost);
    await expect(owner.getByRole("region", { name: "Số liệu dùng AI" })).toContainText(usd.replace(/\s+/g, " ").split(" ")[0]!);

    // With / without AI: a task the AI summarised, then finished, counts as done with AI help.
    const before = (await (await api(owner, "work/followup/outcomes?days=7")).json()).withAi;
    const project = await (await api(owner, "work/projects", "POST", { name: `AI ${run}` })).json();
    const { employees } = (await (await api(owner, "employee/employees")).json()) as { employees: { userId: string; displayName: string }[] };
    const me = employees.find((e) => e.displayName === "Trần Minh Hưng")!.userId;
    const task = await (await api(owner, "work/tasks", "POST", { title: "Chuẩn bị báo giá", projectId: project.id, assigneeId: me })).json();
    const helped = await api(owner, `ai/tasks/${task.id}/assist`, "POST", { action: "summarize" });
    expect(helped.status()).toBe(201);
    expect((await helped.json()).summary).toBe("Tóm tắt từ Ollama nội bộ.");
    const t1 = await (await api(owner, `work/tasks/${task.id}`)).json();
    expect((await api(owner, `work/tasks/${task.id}`, "PATCH", { expectedVersion: t1.task.version, status: "done" })).status()).toBe(200);
    await expect(async () => {
      const now = (await (await api(owner, "work/followup/outcomes?days=7")).json()).withAi;
      expect(now.assisted.done).toBe(before.assisted.done + 1);
    }).toPass({ timeout: 60_000 });
    await owner.goto("/app/ai/adoption/usage?days=7");
    // The side-by-side comparison only shows with 20+ tasks per side; the counts are always there.
    await expect(owner.getByTestId("with-ai-yes")).toContainText("1 việc");

    // Budget: a 10-token monthly limit for the owner stops their next question, with a message saying whose limit.
    await owner.goto("/admin/workspace/ai/cost");
    await spend.getByRole("button", { name: "Áp dụng cho" }).click();
    await spend.getByRole("option", { name: "Một người" }).click();
    await spend.getByRole("button", { name: /^Một người:/ }).click();
    await spend.getByRole("option", { name: "Trần Minh Hưng" }).click();
    await spend.getByLabel("Token mỗi tháng").fill("10");
    await spend.getByRole("button", { name: "Đặt hạn mức" }).click();
    const budget = spend.getByRole("listitem").filter({ hasText: "Trần Minh Hưng" });
    await expect(budget).toContainText("Hạn mức: 10 token");
    const blocked = await api(owner, "ai/assistant/messages", "POST", { content: "Thêm một câu nữa" });
    expect(blocked.status()).toBe(429);
    expect(await blocked.json()).toMatchObject({ error: "ai_budget_exceeded", scope: "person" });
    await owner.goto("/app/ai/ask");
    await expect(owner.getByText("Bạn đã dùng hết hạn mức AI của mình tháng này.", { exact: false })).toBeVisible();
    await owner.goto("/admin/workspace/ai/cost");
    await budget.getByRole("button", { name: "Bỏ" }).click();
    // The app's own confirmation, not the browser's.
    await owner.getByRole("button", { name: "Xác nhận" }).click();
    await expect(spend.getByText("Chưa đặt hạn mức: AI không bị giới hạn.")).toBeVisible();

    // A stored key never follows an edit to another address: the edit needs the key again.
    const created = await (
      await api(owner, "ai/connections", "POST", { mode: "api", baseUrl: "https://llm.example.com/v1", apiKey: "sk-test-1234567890", modelSmart: "m" })
    ).json();
    expect(created.connection.keyHint).toBe("…7890");
    expect(JSON.stringify(created)).not.toContain("sk-test-1234567890");
    const moved = await api(owner, `ai/connections/${created.connection.id}`, "PATCH", { mode: "api", baseUrl: "https://elsewhere.example.com/v1", modelSmart: "m" });
    expect(moved.status()).toBe(400);
    expect((await api(owner, `ai/connections/${created.connection.id}`, "DELETE")).status()).toBe(200);

    // Removing the self-hosted one leaves no connection.
    await owner.goto("/admin/workspace/ai");
    await owner.getByRole("listitem").filter({ hasText: "Self-host (127.0.0.1" }).getByRole("button", { name: "Xoá" }).click();
    // The app's own confirmation, not the browser's.
    await owner.getByRole("button", { name: "Xác nhận" }).click();
    await expect(owner.getByText("Chưa có AI. Chọn cách kết nối:")).toBeVisible();
  } finally {
    llm.close();
  }
});
