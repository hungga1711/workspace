"use client";

import { connection } from "@/lib/connection";

/** One Server-Sent Event: its name and its JSON payload as text. */
export interface SseEvent {
  event: string;
  data: string;
}

/** Splits Server-Sent Events as their pieces arrive (a piece may end anywhere, even inside a line). */
export class SseParser {
  private buf = "";
  private event = "message";
  private data: string[] = [];

  push(text: string): SseEvent[] {
    this.buf += text;
    const out: SseEvent[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, "");
      this.buf = this.buf.slice(nl + 1);
      if (line === "") {
        if (this.data.length) out.push({ event: this.event, data: this.data.join("\n") });
        this.event = "message";
        this.data = [];
      } else if (line.startsWith("event:")) this.event = line.slice(6).trim();
      else if (line.startsWith("data:")) this.data.push(line.slice(5).replace(/^ /, ""));
      // ":" lines are the server's keep-alive comments.
    }
    return out;
  }
}

export interface StreamHandlers {
  /** The stream's id, for the stop button. */
  start?: (id: string) => void;
  delta: (text: string) => void;
  /** Drop what was shown: that model failed part-way and the next one starts over. */
  reset: () => void;
  /** A tool call starting or ending, worded by the server ("Reading overdue tasks…"); the same id updates in place. */
  step?: (s: { id: string; tool: string; text: string; state: "running" | "done" | "failed" }) => void;
}

const httpError = (status: number, body: { error?: string; message?: string; requestId?: string } | null, requestId: string) =>
  Object.assign(new Error(body?.message ?? body?.error ?? `HTTP ${status}`), { status, body, requestId: body?.requestId ?? requestId });

/**
 * Hỏi đáp's answer as it is written (the ai module's stream.ts): a POST through the same proxy as `api`, read as
 * Server-Sent Events. Resolves with the `done` payload, the same JSON the plain route returns; failures throw the same
 * errors `api` would, so callers handle both alike.
 */
export async function postStream<T>(path: string, body: unknown, on: StreamHandlers, signal?: AbortSignal): Promise<T> {
  const requestId = crypto.randomUUID();
  const res = await fetch(`/api/proxy/${path.replace(/^\//, "")}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream", "x-wos-csrf": "1", "x-request-id": requestId },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (!res.headers.get("content-type")?.startsWith("text/event-stream") || !res.body) {
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      if (res.ok) throw new Error(`HTTP ${res.status}: not JSON`);
    }
    if (res.status === 401) connection.sessionExpired();
    if (!res.ok) throw httpError(res.status, parsed, requestId);
    return parsed as T;
  }
  const parser = new SseParser();
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const e of parser.push(value)) {
      const data = JSON.parse(e.data) as Record<string, unknown>;
      if (e.event === "start") on.start?.(String(data.id));
      else if (e.event === "delta") on.delta(String(data.t ?? ""));
      else if (e.event === "reset") on.reset();
      else if (e.event === "step") on.step?.(data as unknown as Parameters<NonNullable<StreamHandlers["step"]>>[0]);
      else if (e.event === "done") {
        void reader.cancel().catch(() => undefined);
        return data as T;
      } else if (e.event === "error") {
        const { status, ...rest } = data as { status?: number };
        throw httpError(typeof status === "number" ? status : 500, rest, requestId);
      }
    }
  }
  throw Object.assign(new Error("the answer stopped part-way"), { status: 502, requestId });
}
