import { afterAll, describe, expect, it } from "vitest";
import express from "express";
import { clearInProcess, serveInProcess, serviceFetch } from "@workspace/service-kit";

/**
 * Module calls inside the one process (in-process.ts) for a response that streams: Server-Sent Events (Hỏi đáp's
 * answer as it is written) reach the gateway piece by piece, not once the module ends them, and the module sees the
 * caller leave.
 */
const BASE = "http://in-process-stream.test";
let closedEarly = false;
const app = express();
app.get("/plain", (_req, res) => void res.json({ ok: true }));
app.get("/events", (_req, res) => {
  res.setHeader("content-type", "text/event-stream");
  res.flushHeaders();
  res.write("data: one\n\n");
  setTimeout(() => res.write("data: two\n\n"), 30);
  setTimeout(() => res.end("data: three\n\n"), 60);
});
app.get("/forever", (_req, res) => {
  res.setHeader("content-type", "text/event-stream");
  res.flushHeaders();
  res.write("data: first\n\n");
  res.on("close", () => (closedEarly = !res.writableEnded));
});
serveInProcess(BASE, app);
afterAll(() => clearInProcess());

describe("serviceFetch, in process", () => {
  it("still returns a plain response whole", async () => {
    const r = await serviceFetch(`${BASE}/plain`);
    expect(await r.json()).toEqual({ ok: true });
  });

  it("passes an event stream on as it is written", async () => {
    const started = Date.now();
    const r = await serviceFetch(`${BASE}/events`);
    expect(r.headers.get("content-type")).toBe("text/event-stream");
    const seen: { at: number; text: string }[] = [];
    const decoder = new TextDecoder();
    for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) seen.push({ at: Date.now() - started, text: decoder.decode(chunk) });
    expect(seen.map((s) => s.text).join("")).toBe("data: one\n\ndata: two\n\ndata: three\n\n");
    // The first piece came before the module ended the response.
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[0]!.at).toBeLessThan(seen.at(-1)!.at);
  });

  it("tells the module when the caller leaves", async () => {
    const stop = new AbortController();
    const r = await serviceFetch(`${BASE}/forever`, { signal: stop.signal });
    const reader = r.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: first\n\n");
    stop.abort();
    await expect(reader.read()).rejects.toBeTruthy();
    expect(closedEarly).toBe(true);
  });
});
