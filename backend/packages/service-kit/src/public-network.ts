import { lookup, type LookupAddress, type LookupOptions } from "node:dns";
import { request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { isIP, Socket } from "node:net";
import type { Duplex } from "node:stream";

/**
 * Outbound calls to URLs an admin configures (webhooks, MCP servers, AI endpoints) must not reach this server's own
 * network: loopback, private, link-local (cloud metadata), CGNAT, benchmarking, documentation, NAT64, multicast and
 * reserved addresses, in IPv4, IPv6 and IPv4-mapped form.
 */
export function isPrivateAddress(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (isIP(lower) === 6 && !lower.startsWith("::ffff:")) {
    return (
      lower === "::" ||
      lower === "::1" ||
      /^f[cd]/.test(lower) ||
      /^fe[89ab]/.test(lower) ||
      lower.startsWith("ff") ||
      lower.startsWith("64:ff9b:") ||
      lower.startsWith("2001:db8:")
    );
  }
  const v4 = lower.startsWith("::ffff:") ? lower.slice(7) : lower;
  // A mapped address written in hex (::ffff:7f00:1) is not worth decoding: refuse it.
  if (isIP(v4) !== 4) return lower.startsWith("::ffff:");
  const [a, b, c] = v4.split(".").map(Number) as [number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

/**
 * The connection's own DNS lookup, refusing private answers: a check made earlier could see a different answer than
 * the connection does (DNS rebinding), so the address connected to is the one checked.
 */
export function publicOnlyLookup(
  hostname: string,
  options: LookupOptions,
  cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
): void {
  lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err, "");
    if (!addrs.length || addrs.some((x) => isPrivateAddress(x.address))) return cb(privateError(), "");
    if (options.all) cb(null, addrs);
    else cb(null, addrs[0]!.address, addrs[0]!.family);
  });
}

/** The host as an IP address when it is written as one (`127.0.0.1`, `[::1]`), else null. */
function literalIp(host: string): string | null {
  const h = host.replace(/^\[|\]$/g, "");
  return isIP(h) ? h : null;
}

const privateError = () => Object.assign(new Error("URL resolves to a private address"), { code: "EPRIVATE" });

/**
 * For libraries that take an agent (jose's remote key sets). Node does not call `lookup` for a host written as an IP
 * address, so `publicOnlyLookup` alone would let `https://169.254.169.254/` through: the agent checks such hosts
 * itself before connecting. (`createConnection` exists at run time but is missing from Node's https.Agent types.)
 */
export const publicHttpsAgent = new HttpsAgent({ lookup: publicOnlyLookup });
type CreateConnection = (options: { host?: string | null; hostname?: string | null }, callback?: unknown) => Duplex;
const connect = publicHttpsAgent as unknown as { createConnection: CreateConnection };
const createConnection = connect.createConnection.bind(publicHttpsAgent);
connect.createConnection = (options, callback) => {
  const ip = literalIp(String(options.host ?? options.hostname ?? ""));
  if (ip && isPrivateAddress(ip)) {
    // A socket that fails at once: the request sees the error like any connection error.
    const socket = new Socket();
    process.nextTick(() => socket.destroy(privateError()));
    return socket;
  }
  return createConnection(options, callback);
};

/** Why a configured URL cannot be called (https only, no credentials, a public address), or null. */
export async function checkPublicUrl(raw: string, allowPrivate: boolean): Promise<string | null> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "invalid URL";
  }
  if (u.protocol !== "https:" && !(allowPrivate && u.protocol === "http:")) return "URL must use https";
  if (u.username || u.password) return "URL must not contain credentials";
  if (allowPrivate) return null;
  const addrs = await new Promise<LookupAddress[] | null>((resolve) => lookup(u.hostname, { all: true }, (err, a) => resolve(err ? null : a)));
  if (!addrs) return "host does not resolve";
  if (addrs.some((a) => isPrivateAddress(a.address))) return "URL resolves to a private address";
  return null;
}

export interface OutboundRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Default 10 s. */
  timeoutMs?: number;
  /** Development and tests: allow http and private addresses. */
  allowPrivate?: boolean;
}

const MAX_RESPONSE = 1024 * 1024;

/** One request to a configured URL: no redirects, a timeout, at most 1 MB read, private addresses refused at connect. */
export function requestPublic(url: string, opts: OutboundRequest = {}): Promise<{ status: number; text: string }> {
  const u = new URL(url);
  if (u.protocol !== "https:" && !(opts.allowPrivate && u.protocol === "http:")) return Promise.reject(new Error("URL must use https"));
  const ip = literalIp(u.hostname);
  if (!opts.allowPrivate && ip && isPrivateAddress(ip)) return Promise.reject(privateError());
  const send = u.protocol === "http:" ? httpRequest : httpsRequest;
  const timeout = opts.timeoutMs ?? 10_000;
  return new Promise((resolve, reject) => {
    const headers = { ...opts.headers, ...(opts.body !== undefined ? { "content-length": String(Buffer.byteLength(opts.body)) } : {}) };
    const req = send(u, { method: opts.method ?? "GET", headers, timeout, ...(opts.allowPrivate ? {} : { lookup: publicOnlyLookup }) }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_RESPONSE) req.destroy(new Error("response too large"));
        else chunks.push(c);
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`timed out after ${timeout / 1000} s`)));
    req.on("error", reject);
    req.end(opts.body);
  });
}
