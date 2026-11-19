import { IncomingMessage, ServerResponse, type OutgoingHttpHeaders, type RequestListener } from "node:http";
import { Socket } from "node:net";

/**
 * Modules that share a process (ADR 0021). Each module keeps its own HTTP API, its own schema and its own
 * signed-principal check; a module this process hosts is registered here under the base URL other modules use for
 * it (IDENTITY_URL, EMPLOYEE_URL, …). `serviceFetch` hands a request for that URL straight to the module's request
 * handler instead of opening a connection: same middleware, same principal token, same authorization, no network
 * hop. Any other URL goes out over HTTP, so a module can move to a process of its own by configuration alone.
 */
const local = new Map<string, RequestListener>();

const trimSlash = (url: string) => url.replace(/\/+$/, "");

/** Serves `baseUrl` from this process: requests under it go to `handler` with the base path removed. */
export function serveInProcess(baseUrl: string, handler: RequestListener): void {
  local.set(trimSlash(baseUrl), handler);
}

/** Forgets every in-process module (tests that build several layouts in one run). */
export function clearInProcess(): void {
  local.clear();
}

function localTarget(url: string): { handler: RequestListener; path: string } | null {
  for (const [base, handler] of local) {
    if (url === base) return { handler, path: "/" };
    const rest = url.slice(base.length);
    if (url.startsWith(base) && (rest.startsWith("/") || rest.startsWith("?"))) return { handler, path: rest.startsWith("?") ? `/${rest}` : rest };
  }
  return null;
}

/** HTTP statuses whose response may not carry a body (the Response constructor refuses one). */
const NO_BODY = new Set([101, 204, 205, 304]);

/** `fetch` for module-to-module calls: in-process when this process hosts the target module, HTTP otherwise. */
export async function serviceFetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal } = {}): Promise<Response> {
  const target = localTarget(url);
  if (!target) return fetch(url, init);
  const call = dispatch(target.handler, init.method ?? "GET", target.path, init.headers ?? {}, init.body, init.signal);
  const out = await (init.signal ? abortable(call, init.signal) : call);
  const headers = new Headers();
  for (const [k, v] of Object.entries(out.headers)) {
    if (v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [String(v)]) headers.append(k, one);
  }
  return new Response(NO_BODY.has(out.status) ? null : out.body, { status: out.status, headers });
}

/**
 * Runs one request through a Node request listener in memory. The request is a real `IncomingMessage` whose
 * body is already buffered, and the response a real `ServerResponse` whose output is captured instead of
 * written to a socket, so Express/Nest handle it exactly as a request off the wire (and nothing shared, like
 * Express's request prototype, is touched).
 *
 * A response that flushes its headers before it ends (Server-Sent Events: Hỏi đáp's answer as it is written) is
 * passed on at once with a body that streams what follows. When the caller stops reading, or its signal aborts, the
 * response sees "close" as it would when a client disconnects.
 */
function dispatch(
  handler: RequestListener,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
  signal?: AbortSignal,
): Promise<{ status: number; headers: OutgoingHttpHeaders; body: Buffer | ReadableStream<Uint8Array> }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(body);
    const req = new IncomingMessage(new Socket());
    req.method = method.toUpperCase();
    req.url = path;
    req.httpVersion = "1.1";
    req.httpVersionMajor = 1;
    req.httpVersionMinor = 1;
    const lower: Record<string, string> = { host: "in-process" };
    for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
    if (payload) lower["content-length"] = String(payload.length);
    req.headers = lower;
    req.rawHeaders = Object.entries(lower).flat();
    if (payload) req.push(payload);
    req.push(null);
    req.complete = true;

    const res = new ServerResponse(req);
    const chunks: Buffer[] = [];
    // Set once the response flushed its headers early: what it writes from then on goes straight to the reader.
    let live: ReadableStreamDefaultController<Uint8Array> | null = null;
    const take = (chunk: unknown, encoding?: unknown) => {
      if (chunk === undefined || chunk === null || typeof chunk === "function") return;
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string, typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8");
      if (!live) chunks.push(b);
      else
        try {
          live.enqueue(new Uint8Array(b));
        } catch {
          // The reader is gone: nothing to deliver to.
        }
    };
    const callback = (...args: unknown[]) => args.find((a): a is () => void => typeof a === "function");
    let done = false;
    const gone = () => {
      if (!done) res.emit("close");
    };
    // Captured on the instance: Express sets the prototype of req/res to its own, instance methods still win.
    Object.assign(res, {
      writeHead(this: ServerResponse, status: number, ...rest: unknown[]) {
        this.statusCode = status;
        const headerArg = rest.find((r) => r && typeof r === "object") as Record<string, string | number | string[]> | undefined;
        if (typeof rest[0] === "string") this.statusMessage = rest[0];
        if (headerArg && !Array.isArray(headerArg)) for (const [k, v] of Object.entries(headerArg)) this.setHeader(k, v);
        return this;
      },
      write(chunk: unknown, encoding?: unknown, cb?: unknown) {
        take(chunk, encoding);
        callback(encoding, cb)?.();
        return true;
      },
      flushHeaders(this: ServerResponse) {
        if (live || done) return;
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            live = c;
            for (const b of chunks.splice(0)) c.enqueue(new Uint8Array(b));
          },
          cancel: gone,
        });
        signal?.addEventListener(
          "abort",
          () => {
            gone();
            try {
              live?.error(signal.reason);
            } catch {
              // Already closed.
            }
          },
          { once: true },
        );
        resolve({ status: this.statusCode, headers: this.getHeaders(), body: stream });
      },
      end(this: ServerResponse, chunk?: unknown, encoding?: unknown, cb?: unknown) {
        if (done) return this;
        done = true;
        take(chunk, encoding);
        // Lets on-finished and friends see a finished response.
        (this as unknown as { finished: boolean }).finished = true;
        if (live)
          try {
            live.close();
          } catch {
            // The reader cancelled first.
          }
        else resolve({ status: this.statusCode, headers: this.getHeaders(), body: Buffer.concat(chunks) });
        callback(chunk, encoding, cb)?.();
        this.emit("finish");
        this.emit("close");
        return this;
      },
    });
    try {
      handler(req, res);
    } catch (err) {
      reject(err);
    }
  });
}

function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
