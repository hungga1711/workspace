import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The connect program on a person's computer (frontend/web/public/runner/workspace-connect.mjs), imported as a module:
 * Claude Code answers with its web tools only when the workspace says the question needs the web, and never with its
 * file, shell or code tools; the web tools it used come back with the answer.
 */
const CONNECT = fileURLToPath(new URL("../../../../../frontend/web/public/runner/workspace-connect.mjs", import.meta.url));
type Agent = { id: string; answer?: (m: string, sys: string | null, web?: boolean) => string[] };
let mod: {
  AGENTS: Agent[];
  webToolsOf(line: string): { name: string; input: Record<string, unknown> }[];
  webPagesOf(line: string): { url: string; title: string }[];
  complete(target: string, opts: Record<string, unknown>, found: unknown[], cfg?: unknown): Promise<{ text: string; tools?: unknown[] }>;
};
let dir: string;
const PATH = process.env.PATH;

beforeAll(async () => {
  mod = await import(pathToFileURL(CONNECT).href);
  dir = mkdtempSync(join(tmpdir(), "connect-web-"));
  // A stand-in for Claude Code: records its arguments, then prints stream-json lines with a web search in them.
  writeFileSync(
    join(dir, "claude"),
    `#!/usr/bin/env node
require("fs").writeFileSync(${JSON.stringify(join(dir, "argv.json"))}, JSON.stringify(process.argv.slice(2)));
let input = ""; process.stdin.on("data", (d) => (input += d)); process.stdin.on("end", () => {
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
  out({ type: "assistant", message: { content: [{ type: "tool_use", name: "WebSearch", input: { query: "nextjs 15" } }, { type: "tool_use", name: "Bash", input: { command: "ls" } }] } });
  out({ type: "user", message: { content: [{ type: "tool_result", content: 'Web search results for query: "nextjs 15"\\n\\nLinks: [{"title":"Next.js 15","url":"https://nextjs.org/blog/next-15"},{"title":"x","url":"javascript:alert(1)"}]\\n\\nmore' }] } });
  out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Next.js 15 adds" } } });
  out({ type: "result", result: "Next.js 15 adds async request APIs." });
});
`,
  );
  chmodSync(join(dir, "claude"), 0o755);
  process.env.PATH = `${dir}:${PATH}`;
});
afterAll(() => {
  process.env.PATH = PATH;
  rmSync(dir, { recursive: true, force: true });
});

describe("the connect program's web tools", () => {
  it("offers Claude Code its web tools only for a question that needs the web, never its file or shell tools", () => {
    const claude = mod.AGENTS.find((a) => a.id === "claude-code")!;
    const plain = claude.answer!("", null, false);
    expect(plain.slice(0, 2)).toEqual(["--tools", ""]);
    expect(plain).not.toContain("--allowedTools");
    const web = claude.answer!("", null, true);
    expect(web.slice(0, 4)).toEqual(["--tools", "WebSearch,WebFetch", "--allowedTools", "WebSearch,WebFetch"]);
    expect(web.join(" ")).not.toMatch(/Bash|Read|Edit|Write|bypassPermissions|dangerously/);
    expect(web).toContain("--strict-mcp-config");
  });

  it("reads which web tools a line used, and nothing else", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "WebFetch", input: { url: "https://example.com", prompt: "x" } },
          { type: "tool_use", name: "Read", input: { file_path: "/etc/passwd" } },
        ],
      },
    });
    expect(mod.webToolsOf(line)).toEqual([{ name: "WebFetch", input: { url: "https://example.com" } }]);
    expect(mod.webToolsOf("not json")).toEqual([]);
  });

  it("answers with the web tools on and reports the searches it made", async () => {
    const found = [{ id: "claude-code", kind: "agent", name: "Claude Code" }];
    const out = await mod.complete("claude-code", { prompt: "What is new in Next.js 15?", answer: true, web: true, timeoutMs: 20_000 }, found);
    expect(out.text).toBe("Next.js 15 adds async request APIs.");
    expect(out.tools).toEqual([{ name: "WebSearch", input: { query: "nextjs 15" } }]);
    // The search's first results are cited; anything but a web address is not.
    expect((out as { pages?: unknown[] }).pages).toEqual([{ url: "https://nextjs.org/blog/next-15", title: "Next.js 15" }]);
    const argv = JSON.parse(readFileSync(join(dir, "argv.json"), "utf8")) as string[];
    expect(argv).toContain("WebSearch,WebFetch");
    expect(argv).toContain("stream-json");

    const plain = await mod.complete("claude-code", { prompt: "Hi", answer: true, timeoutMs: 20_000 }, found);
    expect(plain.tools ?? []).toEqual([]);
    const again = JSON.parse(readFileSync(join(dir, "argv.json"), "utf8")) as string[];
    expect(again[again.indexOf("--tools") + 1]).toBe("");
  });
});
