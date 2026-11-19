import { createServer, type Server } from "node:http";
import { createHmac } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { setupWorkspace } from "./helpers";

/** Admin › Tích hợp: an API key works against the public API; a webhook receives signed events. */
const run = Date.now().toString(36);
const OWNER = { company: `Int ${run}`, email: `int-owner-${run}@example.com`, name: "Hồ Quang" };
const GATEWAY = process.env.GATEWAY_URL ?? "http://localhost:4000";

test.describe.serial("Integrations", () => {
  let owner: Page;
  let server: Server;
  const got: { headers: Record<string, unknown>; body: string }[] = [];
  let hookUrl = "";

  test.beforeAll(async () => {
    server = createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        got.push({ headers: req.headers, body: b });
        res.end("ok");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    hookUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/workspace`;
  });
  test.afterAll(() => {
    server?.close();
  });

  test("an admin creates an API key and an external system uses it", async ({ browser }) => {
    owner = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
    await setupWorkspace(owner, OWNER);
    await owner.goto("/admin/workspace/integrations");
    await owner.getByRole("button", { name: "Tạo khoá", exact: true }).click();
    const dlg = owner.getByRole("dialog", { name: "Tạo khoá API" });
    await dlg.getByLabel("Tên khoá").fill("Đồng bộ ERP");
    await dlg.getByLabel(/Xem việc/).check();
    await dlg.getByLabel(/Tạo việc/).check();
    await dlg.getByRole("button", { name: "Tạo khoá" }).click();
    const key = await owner.getByRole("textbox", { name: "Khoá API mới" }).inputValue();
    expect(key).toMatch(/^wos_/);
    await owner.getByRole("button", { name: "Tôi đã lưu" }).click();
    const created = await owner.request.post(`${GATEWAY}/api/work/tasks`, { headers: { authorization: `Bearer ${key}` }, data: { title: "Đơn hàng #1024 từ ERP" } });
    expect(created.status()).toBe(201);
    expect((await owner.request.get(`${GATEWAY}/api/identity/members`, { headers: { authorization: `Bearer ${key}` } })).status()).toBe(403);
    await owner.reload();
    // The key's row says when it was last used (the hub's tiles above also hold the words "Dùng … trước").
    await expect(owner.getByText(/^Dùng (vừa xong|.* trước) · tạo bởi/)).toBeVisible();
  });

  test("a webhook receives signed task events; the delivery log shows it", async () => {
    await owner.getByRole("button", { name: "Thêm webhook" }).click();
    const dlg = owner.getByRole("dialog", { name: "Thêm webhook" });
    await dlg.getByLabel("Địa chỉ nhận (URL)").fill(hookUrl);
    await dlg.getByLabel("Việc được tạo").check();
    await dlg.getByRole("button", { name: "Thêm" }).click();
    const secret = await owner.getByRole("textbox", { name: "Khoá ký webhook" }).inputValue();
    await owner.getByRole("button", { name: "Tôi đã lưu" }).click();
    const r = await owner.request.fetch("/api/proxy/work/tasks", {
      method: "POST",
      headers: { "content-type": "application/json", "x-wos-csrf": "1" },
      data: { title: "Việc cho webhook" },
    });
    expect(r.status()).toBe(201);
    await expect.poll(() => got.find((g) => g.body.includes("Việc cho webhook")), { timeout: 30_000 }).toBeTruthy();
    const hit = got.find((g) => g.body.includes("Việc cho webhook"))!;
    const [t, v] = String(hit.headers["x-workspace-signature"]).split(",");
    expect(v!.slice(3)).toBe(
      createHmac("sha256", secret)
        .update(`${t!.slice(2)}.${hit.body}`)
        .digest("hex"),
    );
    await owner.reload();
    await owner.getByRole("button", { name: new RegExp(`^${hookUrl}`) }).click();
    await expect(owner.getByRole("dialog", { name: "Lịch sử gửi webhook" }).getByText("Thành công").first()).toBeVisible();
    await owner.screenshot({ path: process.env.SHOTS ? `${process.env.SHOTS}/integrations.png` : "test-results/integrations.png" });
  });
});
