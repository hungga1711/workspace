import { HttpException } from "@nestjs/common";
import type { Response } from "express";
import { newId } from "@workspace/shared";
import type { ModelStream } from "./providers.js";

/**
 * Hỏi đáp's answer as it is written, instead of all at once after the model finished: a model on someone's
 * own computer can take a minute for a long answer, and watching it come is better than a spinner.
 *
 * The browser asks with `POST …/stream` and reads Server-Sent Events from the same request; the gateway and the web
 * proxy pass them through unbuffered (`cache-control: no-transform` also keeps compression away). Events:
 *
 *   start  { id }                 the stream's id, for the stop button (`POST assistant/streams/:id/stop`)
 *   delta  { t }                  more text
 *   reset  {}                     drop what was shown: that model failed part-way and the next one starts over
 *   step   { id, tool, text, state, n? }  a tool call starting or ending (progress.ts), in the answer's language
 *   done   { …the plain answer }  the same JSON the non-streaming route returns; its `answer` is what was stored
 *   error  { status, error, … }   what the plain route would have answered with that HTTP status
 *
 * A failure before anything was sent is an ordinary HTTP error. Backends that cannot stream simply send no deltas.
 */

/** Open streams by id: the stop button reaches the model call through here. One process (ADR 0021), so a map is enough. */
const open = new Map<string, { userId: string; stop: AbortController }>();

/** The stop button: ends that person's stream with the text written so far. False when it is not theirs or already over. */
export function stopStream(id: string, userId: string): boolean {
  const s = open.get(id);
  if (!s || s.userId !== userId) return false;
  s.stop.abort();
  return true;
}

/** Text written since the last reset, so a stop keeps exactly what the person saw. */
export interface Written {
  readonly text: string;
}

export async function streamAnswer(
  res: Response,
  userId: string,
  run: (stream: ModelStream, written: Written) => Promise<Record<string, unknown>>,
  log: (line: Record<string, unknown>) => void = (l) => console.log(JSON.stringify(l)),
): Promise<void> {
  const id = newId();
  const stop = new AbortController();
  open.set(id, { userId, stop });
  // The person left (closed the tab, lost the connection): nobody reads on, so the model stops writing too.
  res.on("close", () => {
    if (!res.writableEnded) stop.abort();
  });
  let started = false;
  const begin = () => {
    if (started) return;
    started = true;
    res.status(200);
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("x-accel-buffering", "no");
    res.flushHeaders();
    write("start", { id });
  };
  const write = (event: string, data: unknown) => {
    if (!res.writableEnded && !res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  let text = "";
  const stream: ModelStream = {
    text: (delta) => {
      if (!delta) return;
      begin();
      text += delta;
      write("delta", { t: delta });
    },
    reset: () => {
      if (!text) return;
      text = "";
      write("reset", {});
    },
    step: (s) => {
      begin();
      write("step", s);
    },
    signal: stop.signal,
  };
  // A model that thinks first, or a computer that wakes up, may say nothing for a while: the stream opens after two
  // seconds anyway (so the stop button works) and a comment every 15 s keeps proxies from closing a quiet connection.
  const opener = setTimeout(begin, 2_000);
  const ping = setInterval(() => started && !res.writableEnded && res.write(": ping\n\n"), 15_000);
  try {
    const result = await run(stream, {
      get text() {
        return text;
      },
    });
    begin();
    write("done", result);
  } catch (e) {
    if (!started) throw e;
    const status = e instanceof HttpException ? e.getStatus() : 500;
    const body = e instanceof HttpException ? e.getResponse() : { error: "internal" };
    if (status >= 500) log({ msg: "ai.stream.failed", error: (e as Error).message?.slice(0, 300) });
    write("error", { status, ...(typeof body === "string" ? { error: body } : (body as object)) });
  } finally {
    clearTimeout(opener);
    clearInterval(ping);
    open.delete(id);
    if (started && !res.writableEnded) res.end();
  }
}

/**
 * The answer, or where it was when the person pressed stop. A streamed model ends at once with what it wrote (its
 * usage is kept); an answer that is not streamed (workspace data, outside tools) keeps going in the background, and
 * since its words never reached the person, nothing of it is kept.
 */
export async function untilStopped<T extends { text: string; model: string; stopped?: boolean }>(
  work: Promise<T>,
  streamed: { live: ModelStream; written: Written } | undefined,
  graceMs = 3_000,
): Promise<T> {
  if (!streamed) return work;
  const { signal } = streamed.live;
  const stop = new Promise<null>((resolve) => (signal.aborted ? resolve(null) : signal.addEventListener("abort", () => resolve(null), { once: true })));
  const first = await Promise.race([work, stop]);
  if (first) return first;
  const late = await Promise.race([work.catch(() => null), new Promise<null>((resolve) => setTimeout(resolve, graceMs, null))]);
  if (late?.stopped) return late;
  work.catch(() => undefined);
  // T's other fields (tools used, a confirm card) are optional: a stopped answer has none.
  return { text: streamed.written.text, model: late?.model ?? "", stopped: true } as T;
}

/** Server-Sent Events from a vendor (OpenAI-compatible, Gemini): each `data:` payload, "[DONE]" left out. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buf = "";
  let data: string[] = [];
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (line === "") {
        if (data.length) {
          const payload = data.join("\n");
          data = [];
          if (payload !== "[DONE]") yield payload;
        }
      } else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
  }
  buf += decoder.decode();
  if (buf.startsWith("data:")) data.push(buf.slice(5).replace(/^ /, ""));
  if (data.length && data.join("\n") !== "[DONE]") yield data.join("\n");
}

/**
 * What the person should see of a streamed answer so far: reasoning models write `<think>…</think>` first, and a tag
 * that is still being written ("<thi") is held back until it is clear whether it is one.
 */
export function visibleText(raw: string): string {
  let t = raw.replace(/<think>[\s\S]*?<\/think>/g, "");
  const open = t.indexOf("<think>");
  if (open >= 0) t = t.slice(0, open);
  const tail = /<[a-z/]*$/i.exec(t);
  if (tail && "<think>".startsWith(tail[0])) t = t.slice(0, tail.index);
  return t.replace(/^\s+/, "");
}
