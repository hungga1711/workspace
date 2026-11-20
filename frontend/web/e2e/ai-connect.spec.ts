import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { setupWorkspace } from "./helpers";

/**
 * AI › Kết nối: a person connects the AI on their computer with one pasted line, and the four things it is for come
 * alive. The "computer" here is the real connect program (public/runner/workspace-connect.mjs) started by the test
 * with a stand-in `claude` on its PATH, its own home folder and its own Claude settings, so nothing of the machine
 * running the suite is touched:
 *
 *   - the page shows the computer and the AI found on it, without anything being picked or typed;
 *   - workflows are ready, token counts are being sent, the safety-net hook is installed for Claude Code;
 *   - the owner uses that AI for the assistant in one click, and a question is answered on the "computer";
 *   - the company's rule (block) stops a card number typed into Claude Code, counted without its text;
 *   - disconnecting revokes the key and the program stops.
 */
const run = Date.now().toString(36);
const CONNECT = fileURLToPath(new URL("../public/runner/workspace-connect.mjs", import.meta.url));
const api = (p: Page, path: string, method = "GET", data?: unknown) =>
  p.request.fetch(`/api/proxy/${path}`, { method, headers: { "x-wos-csrf": "1" }, ...(data === undefined ? {} : { data }) });
const SHOTS = process.env.CONNECT_SHOTS;
const shot = async (p: Page, name: string) => {
  if (SHOTS) await p.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
};

test("AI connect: one line connects a computer; workflows, answers, tokens and the safety net follow", async ({ browser, baseURL }) => {
  test.setTimeout(240_000);
  const home = mkdtempSync(join(tmpdir(), "wx-connect-"));
  const bin = join(home, "bin");
  const claudeCfg = join(home, "claude");
  mkdirSync(bin);
  mkdirSync(claudeCfg);
  // The stand-in agent: answers whatever it is asked, the way `claude -p` prints an answer.
  writeFileSync(join(bin, "claude"), '#!/bin/sh\ncat > /dev/null\necho "Trả lời từ Claude Code trên máy của Hưng."\n');
  chmodSync(join(bin, "claude"), 0o755);
  const env = { ...process.env, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, WORKSPACE_AI_HOME: join(home, "wai"), CLAUDE_CONFIG_DIR: claudeCfg, HOME: home };
  let program: ChildProcess | undefined;
  let log = "";
  try {
    const owner = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
    await setupWorkspace(owner, { company: `Kết nối ${run}`, name: "Trần Minh Hưng", email: `connect-${run}@example.com` });
    // Both AI switches on (Admin › AI).
    const ws = await (await api(owner, "platform/workspace")).json();
    const put = await api(owner, "platform/workspace/config", "PUT", {
      version: ws.configVersion,
      config: { ...ws.config, features: { ...(ws.config.features ?? {}), ai: { assistant: true, monitoring: true } } },
    });
    expect(put.status()).toBe(200);

    // Nothing connected: four cards, none ready.
    await owner.goto("/app/ai/connect");
    await expect(owner.getByRole("heading", { name: "Kết nối AI trong máy của bạn" })).toBeVisible();
    for (const id of ["connect-workflow", "connect-ask", "connect-usage", "connect-guard"]) await expect(owner.getByTestId(id)).toBeVisible();
    await expect(owner.getByTestId("connect-workflow").getByText("Chưa kết nối")).toBeVisible();
    // No extension yet: how to load the downloaded zip, step by step.
    const how = owner.getByTestId("ext-how");
    await expect(how.getByText("Cách cài vào Chrome hoặc Edge")).toBeVisible();
    await expect(how.getByRole("listitem")).toHaveCount(4);
    await expect(how.getByText(/chrome:\/\/extensions/)).toBeVisible();
    await shot(owner, "1-empty");

    // One button, one line.
    await owner.getByTestId("connect-start").click();
    const line = (await owner.getByTestId("connect-line").innerText()).trim();
    expect(line).toContain("/runner/workspace-connect.mjs");
    // Starting with the computer is the person's choice, off by default.
    expect(line).not.toContain("--install");
    await owner.getByLabel("Tự chạy khi mở máy").check();
    await expect(owner.getByTestId("connect-line")).toContainText("--install");
    await owner.getByLabel("Tự chạy khi mở máy").uncheck();
    const code = /"(https?:\/\/[^"#]+#wos_[A-Za-z0-9_-]+)"/.exec(line)?.[1];
    expect(code).toBeTruthy();
    await expect(owner.getByText("Đang chờ máy kết nối…")).toBeVisible();
    await shot(owner, "2-command");

    // "Paste it": the program runs as it would on the person's computer (in this window, not as a login item).
    program = spawn(process.execPath, [CONNECT, code!.replace(/^https?:\/\/[^#]+/, baseURL!), "--dir", home], { env, stdio: ["ignore", "pipe", "pipe"] });
    program.stdout!.on("data", (b) => (log += b));
    program.stderr!.on("data", (b) => (log += b));

    // No polling: once the program says it is connected, the person checks.
    await expect.poll(() => log, { timeout: 30_000 }).toContain("Connected");
    await owner.getByTestId("connect-check").click();
    const device = owner.getByTestId("connect-device");
    await expect(device).toBeVisible({ timeout: 30_000 });
    await expect(device.getByText("Đang kết nối")).toBeVisible();
    // The chip names the agent and how many of its models were found ("Claude Code · 3 model").
    await expect(device.getByText(/^Claude Code\b/)).toBeVisible();
    await expect(owner.getByTestId("connect-command")).toBeHidden();
    await owner.reload();
    await expect(owner.getByTestId("connect-workflow").getByText("Sẵn sàng")).toBeVisible();
    await expect(owner.getByTestId("connect-workflow").getByText(/Chạy bằng Claude Code trên/)).toBeVisible();
    await expect(owner.getByTestId("connect-usage").getByText("Sẵn sàng")).toBeVisible();
    await expect(owner.getByTestId("connect-guard").getByText(/Claude Code trên .* đã được bảo vệ/)).toBeVisible();
    // The hook went into the stand-in Claude settings, and only there.
    const settings = JSON.parse(readFileSync(join(claudeCfg, "settings.json"), "utf8"));
    expect(JSON.stringify(settings.hooks.UserPromptSubmit)).toContain("--guard claude-code");
    await shot(owner, "3-connected");

    // Workflows: a task's workflow, started with Run, is done by the AI on that computer.
    const { employees } = (await (await api(owner, "employee/employees")).json()) as { employees: { userId: string }[] };
    const task = await (await api(owner, "work/tasks", "POST", { title: "Soạn thư chào khách hàng mới", assigneeId: employees[0]!.userId })).json();
    const wf = await (
      await api(owner, "work/workflows", "POST", {
        name: `Soạn thư ${run}`,
        runner: "local",
        steps: [{ title: "Viết nháp", kind: "ai", prompt: "Viết nháp cho việc này:\n{{task}}" }],
      })
    ).json();
    expect((await api(owner, `work/tasks/${task.id}/workflow`, "PUT", { workflowId: wf.id })).status()).toBe(200);
    expect((await api(owner, `work/tasks/${task.id}/runs`, "POST")).status()).toBe(201);
    await expect
      .poll(async () => ((await (await api(owner, `work/tasks/${task.id}/runs`)).json()) as { runs: { status: string }[] }).runs[0]?.status, { timeout: 60_000 })
      .toBe("done");
    const ran = ((await (await api(owner, `work/tasks/${task.id}/runs`)).json()) as { runs: { steps: { output?: string }[] }[] }).runs[0]!;
    expect(ran.steps[0]!.output).toContain("Trả lời từ Claude Code trên máy của Hưng.");

    // Ask: the owner's own computer may answer for the company, in one click.
    await owner.getByTestId("connect-ask").getByRole("button", { name: "Dùng Claude Code để trả lời cho cả công ty" }).click();
    await expect(owner.getByTestId("connect-ask").getByText(/Đang trả lời: AI trên máy/)).toBeVisible();
    await expect(owner.getByTestId("connect-ask").getByText("Sẵn sàng")).toBeVisible();
    const sent = await api(owner, "ai/assistant/messages", "POST", { content: "Tuần này đội mình cần làm gì trước?" });
    expect(sent.status()).toBe(201);
    expect(JSON.stringify(await sent.json())).toContain("Trả lời từ Claude Code trên máy của Hưng.");
    await shot(owner, "4-answering");

    // Admin › AI names it too: found, in use, and the staff computers in numbers.
    await owner.goto("/admin/workspace/ai");
    const local = owner.getByTestId("ai-local");
    await expect(local.getByTestId("local-device-ai").filter({ hasText: "Claude Code" }).getByText("Đang dùng")).toBeVisible();
    await expect(local.getByText(/1 người đã kết nối · 1 máy đang bật/)).toBeVisible();
    await shot(owner, "5-admin");

    // The safety net: the company blocks, and a card number typed into Claude Code does not leave.
    const policy = await (await api(owner, "ai/policy")).json();
    expect((await api(owner, "ai/policy", "PUT", { ...policy.policy, sensitiveMode: "block" })).status()).toBe(200);
    const hook = spawnSync(process.execPath, [join(home, "wai", "workspace-connect.mjs"), "--guard", "claude-code"], {
      env,
      input: JSON.stringify({ prompt: "Thanh toán bằng thẻ 4111 1111 1111 1111 giúp tôi" }),
      encoding: "utf8",
    });
    expect(hook.status).toBe(2);
    expect(hook.stderr).toContain("a card number");
    const clean = spawnSync(process.execPath, [join(home, "wai", "workspace-connect.mjs"), "--guard", "claude-code"], {
      env,
      input: JSON.stringify({ prompt: "Viết lời chào khách hàng" }),
      encoding: "utf8",
    });
    expect(clean.status).toBe(0);
    const safety = await (await api(owner, "ai/oversight/safety?days=7")).json();
    expect(safety.total.block).toBe(1);
    await owner.goto("/app/ai/connect");
    await expect(owner.getByTestId("connect-guard").getByText("Quy định công ty: chặn tin nhắn")).toBeVisible();

    // Phones: the page fits 390px without sideways scroll.
    await owner.setViewportSize({ width: 390, height: 844 });
    expect(await owner.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await shot(owner, "6-phone");
    await owner.setViewportSize({ width: 768, height: 1000 });
    expect(await owner.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await shot(owner, "7-tablet");
    await owner.setViewportSize({ width: 1440, height: 1000 });

    // Disconnect: the computer goes, its key is revoked, its AI no longer answers, and the program stops by itself.
    owner.once("dialog", (d) => void d.accept());
    const exited = new Promise<number | null>((r) => program!.once("exit", r));
    await owner.getByTestId("connect-device").getByRole("button", { name: "Ngắt kết nối" }).click();
    await expect(owner.getByTestId("connect-device")).toHaveCount(0);
    expect((await (await api(owner, "ai/connections")).json()).connections).toHaveLength(0);
    expect(await exited).toBe(1);
    expect(log).toContain("refused this connection code");
    program = undefined;
  } finally {
    program?.kill("SIGTERM");
    if (process.env.CONNECT_KEEP_LOG) console.log(log);
    rmSync(home, { recursive: true, force: true });
    expect(existsSync(home)).toBe(false);
  }
});
