#!/usr/bin/env node
// stdio ↔ HTTP bridge for MCP clients that only start local commands: reads JSON-RPC messages (one per line)
// from stdin, posts each to workspace's /api/mcp with the API key, and writes the answers to stdout.
// No dependencies; Node 18+.
//
//   WORKSPACE_URL=https://api.example.com WORKSPACE_API_KEY=wos_… node mcp-stdio.mjs
import { createInterface } from "node:readline";

const base = (process.env.WORKSPACE_URL ?? "").replace(/\/$/, "");
const key = process.env.WORKSPACE_API_KEY ?? "";
if (!base || !key.startsWith("wos_")) {
  process.stderr.write("Set WORKSPACE_URL (e.g. https://api.example.com) and WORKSPACE_API_KEY (wos_…).\n");
  process.exit(1);
}

const write = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

async function forward(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  try {
    const res = await fetch(`${base}/api/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(msg),
    });
    const text = await res.text();
    // Notifications get 202 and no body; anything else with a body is the answer (or a batch of answers).
    if (!text) return;
    const out = JSON.parse(text);
    for (const m of Array.isArray(out) ? out : [out]) write(m);
  } catch (e) {
    if (msg && msg.id !== undefined) write({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: `workspace unreachable: ${e.message}` } });
  }
}

// One at a time, in order: MCP clients expect answers to follow their requests.
let chain = Promise.resolve();
createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim()) chain = chain.then(() => forward(line));
});
