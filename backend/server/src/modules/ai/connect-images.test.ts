import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { askDevice, claimJob, finishJob, imagesOfQuestion, resetDeviceHub } from "./device-hub.js";
import { imagesRefused } from "./providers.js";

/**
 * Images attached in Hỏi đáp reach the AI on a connected computer, not
 * dropped on the way. Claude Code takes them as content blocks of one JSON input line;
 * an agent that reads only text says so, in words the workspace recognises as "cannot read images".
 */
const CONNECT = fileURLToPath(new URL("../../../../../frontend/web/public/runner/workspace-connect.mjs", import.meta.url));
let mod: {
  imageInput(text: string, images: { mediaType: string; data: string }[]): string;
  complete(target: string, opts: Record<string, unknown>, found: unknown[], cfg?: unknown): Promise<{ text: string }>;
};
let dir: string;
const PATH = process.env.PATH;
const PNG = { mediaType: "image/png", data: "iVBORw0KGgo=" };

beforeAll(async () => {
  mod = await import(pathToFileURL(CONNECT).href);
  dir = mkdtempSync(join(tmpdir(), "connect-images-"));
  // A stand-in for Claude Code: records its arguments and stdin, then answers in stream-json lines.
  writeFileSync(
    join(dir, "claude"),
    `#!/usr/bin/env node
let input = ""; process.stdin.on("data", (d) => (input += d)); process.stdin.on("end", () => {
  require("fs").writeFileSync(${JSON.stringify(join(dir, "call.json"))}, JSON.stringify({ argv: process.argv.slice(2), input }));
  process.stdout.write(JSON.stringify({ type: "result", result: "Red" }) + "\\n");
});
`,
  );
  // A stand-in for Codex, which only reads text.
  writeFileSync(join(dir, "codex"), `#!/usr/bin/env node\nprocess.stdout.write("text only");\n`);
  chmodSync(join(dir, "claude"), 0o755);
  chmodSync(join(dir, "codex"), 0o755);
  process.env.PATH = `${dir}:${PATH}`;
});
afterAll(() => {
  process.env.PATH = PATH;
  rmSync(dir, { recursive: true, force: true });
});

describe("images on a connected computer", () => {
  it("hands Claude Code the question and its images as one JSON input line", async () => {
    const found = [{ id: "claude-code", kind: "agent", name: "Claude Code" }];
    const out = await mod.complete("claude-code", { prompt: "What colour is it?", answer: true, images: [PNG], timeoutMs: 20_000 }, found);
    expect(out.text).toBe("Red");
    const call = JSON.parse(readFileSync(join(dir, "call.json"), "utf8")) as { argv: string[]; input: string };
    expect(call.argv.join(" ")).toContain("--input-format stream-json");
    expect(call.argv.join(" ")).toContain("--output-format stream-json");
    // Still no file or shell tools for an answer.
    expect(call.argv.slice(call.argv.indexOf("--tools"), call.argv.indexOf("--tools") + 2)).toEqual(["--tools", ""]);
    const line = JSON.parse(call.input.trim());
    expect(line.message.content).toEqual([
      { type: "text", text: "What colour is it?" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG.data } },
    ]);
  });

  it("asks without images exactly as before", async () => {
    const found = [{ id: "claude-code", kind: "agent", name: "Claude Code" }];
    await mod.complete("claude-code", { prompt: "Hi", answer: true, timeoutMs: 20_000 }, found);
    const call = JSON.parse(readFileSync(join(dir, "call.json"), "utf8")) as { argv: string[]; input: string };
    expect(call.argv).not.toContain("--input-format");
    expect(call.input).toBe("Hi");
  });

  it("says an agent that reads only text cannot read images, in words the workspace recognises", async () => {
    const found = [{ id: "codex", kind: "agent", name: "Codex" }];
    const failed = await mod.complete("codex", { prompt: "What is this?", answer: true, images: [PNG], timeoutMs: 20_000 }, found).catch((e: Error) => e);
    expect(failed).toBeInstanceOf(Error);
    expect(imagesRefused(failed)).toBe(true);
  });

  it("sends the question's own images, also when tool results follow it as user turns", () => {
    expect(
      imagesOfQuestion({
        messages: [
          { role: "user", content: "earlier [image: a.png]" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "this one", images: [PNG] },
          // A model without tool calling: what the tools read, then the nudge to answer (mcp/loop.ts).
          { role: "user", content: "Result of list_my_tasks: …" },
          { role: "user", content: "Answer the original question now from the results above. Do not call tools." },
        ],
      }),
    ).toEqual([PNG]);
    expect(imagesOfQuestion({ messages: [{ role: "user", content: "no images" }] })).toEqual([]);
  });

  it("hands a computer that is already waiting the whole question, images included", async () => {
    resetDeviceHub();
    const key = "u1\nmac";
    // The connect program's long poll is open before the question comes (the usual case).
    const claimed = claimJob(key, 5_000);
    const answer = askDevice(key, { target: "claude-code", system: "", prompt: "What colour?", maxTokens: 100, images: [PNG] }, 5_000);
    const job = await claimed;
    expect(job?.images).toEqual([PNG]);
    finishJob(job!.id, { text: "Red" });
    expect((await answer).text).toBe("Red");
    // And one that polls after the question was queued.
    const queued = askDevice(key, { target: "claude-code", system: "", prompt: "Again?", maxTokens: 100, images: [PNG] }, 5_000);
    const later = await claimJob(key, 5_000);
    expect(later?.images).toEqual([PNG]);
    finishJob(later!.id, { text: "Red" });
    await queued;
    resetDeviceHub();
  });

  it("builds the JSON input line", () => {
    expect(JSON.parse(mod.imageInput("Hi", [PNG])).type).toBe("user");
  });
});
