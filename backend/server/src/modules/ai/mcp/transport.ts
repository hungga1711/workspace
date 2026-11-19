import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { mcpFetch, NetError, readText } from "./net.js";

/** The server refused our credentials (HTTP 401/403): the token needs refreshing, or the admin must connect again. */
export class McpAuthError extends Error {
  constructor(
    readonly status: number,
    readonly resourceMetadata: string | null,
  ) {
    super(`the server refused the credentials (HTTP ${status})`);
  }
}

export class McpHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The most an MCP answer may weigh before it is dropped (a tool result is capped far lower for the model). */
const MAX_BODY = 4 * 1024 * 1024;

/**
 * Streamable HTTP (MCP 2025-03-26 and later) for the SDK's Client, over the guarded fetch in net.ts instead of the
 * global fetch the SDK's own transport uses: every request goes through the SSRF check, a timeout and a size cap.
 * Only what a tool-calling client needs: each message is a POST answered with JSON or a short SSE stream; no
 * standalone GET stream (servers may push notifications there, which we do not use) and no resumption.
 */
export class GuardedHttpTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  sessionId?: string;
  private protocolVersion?: string;
  private closed = false;

  constructor(
    private readonly url: string,
    private readonly authHeaders: () => Record<string, string>,
    private readonly timeoutMs = 20_000,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async start(): Promise<void> {}

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "user-agent": "workspace-mcp-client",
      ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      ...(this.protocolVersion ? { "mcp-protocol-version": this.protocolVersion } : {}),
      ...this.authHeaders(),
    };
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) throw new Error("transport closed");
    const res = await mcpFetch(this.url, { method: "POST", headers: this.headers(), body: JSON.stringify(message), timeoutMs: this.timeoutMs }, this.env);
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => undefined);
      const www = res.headers.get("www-authenticate") ?? "";
      throw new McpAuthError(res.status, /resource_metadata="([^"]+)"/.exec(www)?.[1] ?? null);
    }
    if (res.status === 202) {
      await res.body?.cancel().catch(() => undefined);
      return;
    }
    if (res.status === 404 && this.sessionId) {
      delete this.sessionId;
      throw new McpHttpError(404, "the server ended the session");
    }
    if (res.status < 200 || res.status >= 300) {
      const text = await readText(res, 2000).catch(() => "");
      throw new McpHttpError(res.status, `HTTP ${res.status}${text ? `: ${text.replace(/\s+/g, " ").slice(0, 200)}` : ""}`);
    }
    const type = res.headers.get("content-type") ?? "";
    if (type.includes("text/event-stream")) {
      await this.readSse(res);
      return;
    }
    const text = await readText(res, MAX_BODY);
    if (!text.trim()) return;
    const body = JSON.parse(text) as JSONRPCMessage | JSONRPCMessage[];
    for (const m of Array.isArray(body) ? body : [body]) this.deliver(m);
  }

  private deliver(m: JSONRPCMessage) {
    // The version agreed at initialize goes on every later request (MCP 2025-06-18 asks for the header).
    const r = (m as { result?: { protocolVersion?: unknown } }).result;
    if (r && typeof r.protocolVersion === "string") this.protocolVersion = r.protocolVersion;
    this.onmessage?.(m);
  }

  /** Server-sent events: `data:` lines of `message` events, each one JSON-RPC message, until the server ends the stream. */
  private async readSse(res: Response) {
    if (!res.body) return;
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    let size = 0;
    const flush = (block: string) => {
      let event = "message";
      const data: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (event !== "message" || !data.length) return;
      try {
        this.deliver(JSON.parse(data.join("\n")) as JSONRPCMessage);
      } catch (e) {
        this.onerror?.(e as Error);
      }
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BODY) {
        await reader.cancel().catch(() => undefined);
        throw new NetError("response too large", "too_large");
      }
      buf += value;
      let i: number;
      while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i).replace(/^\r?\n\r?\n/, "");
        flush(block);
      }
    }
    if (buf.trim()) flush(buf);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Ending the session is a courtesy: a server that keeps it lets it expire on its own.
    if (this.sessionId)
      await mcpFetch(this.url, { method: "DELETE", headers: this.headers(), timeoutMs: 3000 }, this.env)
        .then((r) => r.body?.cancel())
        .catch(() => undefined);
    this.onclose?.();
  }
}
