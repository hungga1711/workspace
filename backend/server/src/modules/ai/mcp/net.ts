import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { isPrivateAddress, publicOnlyLookup } from "@workspace/service-kit";

/**
 * Outbound HTTP to external MCP servers and their OAuth endpoints. An admin types these URLs, so by default they must
 * be https and on the public internet: loopback, private, link-local (cloud metadata) and other reserved addresses are
 * refused at connect time (the connection's own DNS answer is checked, so a rebinding host cannot slip through).
 *
 * A self-hosted company often runs its own MCP servers inside its network: MCP_ALLOW_PRIVATE_HOSTS lists the hosts
 * (exact names, `*.internal.example` suffixes or IP addresses; `*` for any) that may be private and may use http.
 */
export function privateAllowed(host: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const list = (env.MCP_ALLOW_PRIVATE_HOSTS ?? "")
    .split(/[,\s]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return list.some((x) => x === "*" || x === h || (x.startsWith("*.") && h.endsWith(x.slice(1))));
}

/** Why a server URL cannot be used, or null. Checked when it is saved and again before every request. */
export function urlProblem(raw: string, env: NodeJS.ProcessEnv = process.env): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "invalid URL";
  }
  if (u.username || u.password) return "URL must not contain credentials";
  const allowed = privateAllowed(u.hostname, env);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && allowed)) return "URL must use https (or be listed in MCP_ALLOW_PRIVATE_HOSTS)";
  const ip = u.hostname.replace(/^\[|\]$/g, "");
  if (!allowed && (isIP(ip) ? isPrivateAddress(ip) : /^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(ip)))
    return "private address: add the host to MCP_ALLOW_PRIVATE_HOSTS to use an internal server";
  return null;
}

export class NetError extends Error {
  constructor(
    message: string,
    readonly code: "private" | "timeout" | "too_large" | "network",
  ) {
    super(message);
  }
}

export interface NetInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  /** Time to the response headers; the body is bounded by the caller's own reads. Default 15 s. */
  timeoutMs?: number;
}

const NO_BODY = new Set([101, 204, 205, 304]);

/**
 * fetch() for admin-configured URLs: no redirects (an OAuth or MCP endpoint never needs one, and a redirect could point
 * inside), the SSRF guard above, a timeout. Returns a WHATWG Response whose body streams (SSE answers).
 */
export function mcpFetch(url: string, init: NetInit = {}, env: NodeJS.ProcessEnv = process.env): Promise<Response> {
  const problem = urlProblem(url, env);
  if (problem) return Promise.reject(new NetError(problem, "private"));
  const u = new URL(url);
  const allowed = privateAllowed(u.hostname, env);
  const send = u.protocol === "http:" ? httpRequest : httpsRequest;
  const timeout = init.timeoutMs ?? 15_000;
  return new Promise((resolve, reject) => {
    const headers = { ...init.headers, ...(init.body !== undefined ? { "content-length": String(Buffer.byteLength(init.body)) } : {}) };
    const req = send(u, { method: init.method ?? "GET", headers, timeout, ...(allowed ? {} : { lookup: publicOnlyLookup }) }, (res: IncomingMessage) => {
      clearTimeout(timer);
      const status = res.statusCode ?? 0;
      const h = new Headers();
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(", ") : v);
      if (NO_BODY.has(status)) {
        res.resume();
        resolve(new Response(null, { status, headers: h }));
        return;
      }
      resolve(new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, { status, headers: h }));
    });
    const timer = setTimeout(() => req.destroy(new NetError(`no answer in ${Math.round(timeout / 1000)} s`, "timeout")), timeout);
    const abort = () => req.destroy(new NetError("aborted", "timeout"));
    if (init.signal) {
      if (init.signal.aborted) abort();
      else init.signal.addEventListener("abort", abort, { once: true });
    }
    req.on("timeout", () => req.destroy(new NetError(`no answer in ${Math.round(timeout / 1000)} s`, "timeout")));
    req.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(e instanceof NetError ? e : e.code === "EPRIVATE" ? new NetError("the host resolves to a private address", "private") : e);
    });
    req.end(init.body);
  });
}

/** A response body as text, at most `max` bytes (a misbehaving server cannot fill the memory). */
export async function readText(res: Response, max = 1024 * 1024): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new NetError("response too large", "too_large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function readJson<T>(res: Response, max?: number): Promise<T> {
  return JSON.parse(await readText(res, max)) as T;
}
