import { describe, expect, it } from "vitest";
import { sseData, untilStopped, visibleText } from "./stream.js";
import type { ModelStream } from "./providers.js";

/** A body that arrives in the given pieces, as a network would cut it. */
const body = (...pieces: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const p of pieces) c.enqueue(new TextEncoder().encode(p));
      c.close();
    },
  });
const all = async (b: ReadableStream<Uint8Array>) => {
  const out: string[] = [];
  for await (const d of sseData(b)) out.push(d);
  return out;
};

describe("sseData", () => {
  it("reads data payloads cut anywhere, with CRLF, comments and [DONE]", async () => {
    expect(await all(body('data: {"a":', '1}\r\n\r\n: keep-alive\n\ndata: {"b":2}\n', "\ndata: [DONE]\n\n"))).toEqual(['{"a":1}', '{"b":2}']);
  });
  it("keeps a last event that has no blank line after it", async () => {
    expect(await all(body("data: one\n\ndata: two"))).toEqual(["one", "two"]);
  });
  it("joins multi-line data", async () => {
    expect(await all(body("data: a\ndata: b\n\n"))).toEqual(["a\nb"]);
  });
});

describe("visibleText", () => {
  it("leaves out reasoning, finished or still being written", () => {
    expect(visibleText("<think>plan</think>\n\nHello")).toBe("Hello");
    expect(visibleText("<think>still thinking")).toBe("");
    expect(visibleText("Hello <thi")).toBe("Hello ");
    expect(visibleText("a < b")).toBe("a < b");
  });
});

describe("untilStopped", () => {
  const live = () => {
    const stop = new AbortController();
    const stream: ModelStream = { text: () => undefined, reset: () => undefined, signal: stop.signal };
    return { stop, streamed: { live: stream, written: { text: "Half an ans" } } };
  };

  it("passes the answer through when nobody stops it", async () => {
    const { streamed } = live();
    expect(await untilStopped(Promise.resolve({ text: "done", model: "m" }), streamed)).toEqual({ text: "done", model: "m" });
  });

  it("takes the model's own stopped answer when it ends in time", async () => {
    const { stop, streamed } = live();
    const work = new Promise<{ text: string; model: string; stopped?: boolean }>((resolve) =>
      streamed.live.signal.addEventListener("abort", () => setTimeout(() => resolve({ text: "Half an ans", model: "m", stopped: true }), 5)),
    );
    const r = untilStopped(work, streamed, 1_000);
    stop.abort();
    expect(await r).toEqual({ text: "Half an ans", model: "m", stopped: true });
  });

  it("keeps what was written when the work does not stop (an answer that was not streamed)", async () => {
    const { stop, streamed } = live();
    const r = untilStopped(new Promise<{ text: string; model: string }>(() => undefined), streamed, 10);
    stop.abort();
    expect(await r).toEqual({ text: "Half an ans", model: "", stopped: true });
  });
});
