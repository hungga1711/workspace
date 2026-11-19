import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { dirname, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { inlineSafe } from "@workspace/shared";
import type { ObjectStorage } from "./storage.js";

/**
 * Files on this server's disk instead of S3 (`STORAGE_DRIVER=local`), for installations that do not want to run
 * an object store. It keeps the S3 contract the modules are written against: the backend authorizes and hands
 * out short-lived signed URLs, the browser PUTs and GETs the bytes directly. The URLs carry an HMAC-signed
 * token (key, method, size and type for uploads, disposition for downloads, expiry) and are served by
 * `localFilesHandler` at `/storage/<token>` on the server's public port. The signing key is derived from
 * INTERNAL_TOKEN_SECRET.
 */

export interface LocalStorageConfig {
  dir: string;
  /** Origin (and optional path) browsers reach `/storage/` on, e.g. the app URL behind the reverse proxy. */
  publicUrl: string;
  secret: string;
}

interface Grant {
  k: string;
  m: "PUT" | "GET";
  exp: number;
  /** Upload: the declared type and exact size, as S3 signs content-type and content-length. */
  ct?: string;
  len?: number;
  /** Download: the Content-Disposition S3 would return (ResponseContentDisposition). */
  d?: string;
}

interface Meta {
  contentType: string;
  size: number;
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export class LocalStorage implements ObjectStorage {
  private readonly root: string;
  private readonly key: Buffer;

  constructor(private readonly cfg: LocalStorageConfig) {
    this.root = resolve(cfg.dir);
    this.key = createHmac("sha256", cfg.secret).update("workspace-local-files-v1").digest();
  }

  /** Same name as S3Storage's, so start-up code needs no branch: here it only makes sure the directory exists. */
  async ensureBucket(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  async presignPut(key: string, contentType: string, contentLength: number, ttlSeconds: number): Promise<string> {
    return this.url({ k: this.checkKey(key), m: "PUT", ct: contentType, len: contentLength, exp: this.expiry(ttlSeconds) });
  }

  async presignGet(key: string, ttlSeconds: number, downloadName: string, inline = false): Promise<string> {
    return this.url({ k: this.checkKey(key), m: "GET", d: contentDisposition(downloadName, inline), exp: this.expiry(ttlSeconds) });
  }

  async head(key: string): Promise<{ size: number; contentType: string } | null> {
    const meta = await this.meta(key);
    if (!meta) return null;
    const st = await stat(this.path(key)).catch(() => null);
    return st ? { size: st.size, contentType: meta.contentType } : null;
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
    await rm(`${this.path(key)}.meta.json`, { force: true });
  }

  /** Verifies a token from a URL this storage signed; null when forged, altered or expired. */
  verify(token: string, now = Date.now()): Grant | null {
    const [body, sig] = token.split(".");
    if (!body || !sig) return null;
    const want = this.sign(body);
    const got = Buffer.from(sig, "base64url");
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    let g: Grant;
    try {
      g = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Grant;
    } catch {
      return null;
    }
    if (typeof g.exp !== "number" || g.exp * 1000 < now) return null;
    try {
      this.checkKey(g.k);
    } catch {
      return null;
    }
    return g;
  }

  /** Writes an upload: to a temporary file first, so a broken upload never leaves a half file under the key. */
  async write(key: string, body: NodeJS.ReadableStream, contentType: string, maxBytes: number): Promise<number> {
    const target = this.path(key);
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.${randomBytes(6).toString("hex")}.part`;
    let size = 0;
    try {
      await pipeline(
        body,
        async function* (source: AsyncIterable<Buffer | string>) {
          for await (const chunk of source) {
            size += chunk.length;
            if (size > maxBytes) throw new TooLarge();
            yield chunk;
          }
        },
        createWriteStream(tmp, { mode: 0o640, flags: "wx" }),
      );
      await rename(tmp, target);
      await writeFile(`${target}.meta.json`, JSON.stringify({ contentType, size } satisfies Meta));
      return size;
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  }

  async meta(key: string): Promise<Meta | null> {
    const raw = await readFile(`${this.path(key)}.meta.json`, "utf8").catch(() => null);
    return raw ? (JSON.parse(raw) as Meta) : null;
  }

  path(key: string): string {
    const p = resolve(this.root, this.checkKey(key));
    if (!p.startsWith(this.root + sep)) throw new Error("object key escapes the storage directory");
    return p;
  }

  private checkKey(key: string): string {
    // Keys come from objectKey() (<kind>/<ulid>) or the recordings layout; never a client path.
    if (!/^[A-Za-z0-9][A-Za-z0-9/_.-]{0,500}$/.test(key) || key.includes("..") || key.includes("//")) throw new Error("invalid object key");
    return key;
  }

  private expiry(ttlSeconds: number) {
    return Math.floor(Date.now() / 1000) + ttlSeconds;
  }

  private sign(body: string): Buffer {
    return createHmac("sha256", this.key).update(body).digest();
  }

  private url(g: Grant): string {
    const body = b64(JSON.stringify(g));
    return `${this.cfg.publicUrl.replace(/\/+$/, "")}/storage/${body}.${b64(this.sign(body))}`;
  }
}

class TooLarge extends Error {}

/** ASCII fallback plus RFC 5987 UTF-8 name, so "Báo cáo quý 3.pdf" keeps its Vietnamese name (as S3Storage). */
export function contentDisposition(downloadName: string, inline: boolean): string {
  const ascii = downloadName
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
}

function send(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff", ...headers }).end(message);
}

/** One `bytes=a-b` range (what browsers send for audio and video); null = whole file, false = unsatisfiable. */
function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | false {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return null;
  let start: number;
  let end: number;
  if (!m[1]) {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (start > end || start >= size) return false;
  return { start, end };
}

/**
 * Serves `/storage/<token>` for LocalStorage: PUT (upload, exact type and size as signed), GET and HEAD
 * (download with the signed disposition, single byte ranges). `corsOrigin`: the web app's origin when it is
 * not the same as this URL's (development: web on :3000, the server on :4000); behind the reverse proxy both share the app domain.
 */
export function localFilesHandler(storage: LocalStorage, corsOrigin?: string): RequestListener {
  return (req: IncomingMessage, res: ServerResponse) => {
    void handle(storage, req, res, corsOrigin).catch((e: unknown) => {
      if (res.headersSent) return void res.destroy();
      if (e instanceof TooLarge) return send(res, 413, "too large");
      send(res, 500, "storage error");
    });
  };
}

async function handle(storage: LocalStorage, req: IncomingMessage, res: ServerResponse, corsOrigin?: string) {
  const cors: Record<string, string> = corsOrigin ? { "access-control-allow-origin": corsOrigin, vary: "origin" } : {};
  if (req.method === "OPTIONS") {
    return void res
      .writeHead(204, { ...cors, "access-control-allow-methods": "GET, HEAD, PUT", "access-control-allow-headers": "content-type, range", "access-control-max-age": "600" })
      .end();
  }
  const token = (req.url ?? "").split("?")[0]!.replace(/^\/(storage\/)?/, "");
  const g = storage.verify(token);
  if (!g) return send(res, 403, "link expired or invalid", cors);

  if (req.method === "PUT") {
    if (g.m !== "PUT") return send(res, 403, "not an upload link", cors);
    const type = (req.headers["content-type"] ?? "").split(";")[0]!.trim();
    if (g.ct && type !== g.ct.split(";")[0]!.trim()) return send(res, 403, "content-type does not match the upload link", cors);
    const declared = req.headers["content-length"];
    if (declared !== undefined && Number(declared) !== g.len) return send(res, 403, "content-length does not match the upload link", cors);
    const size = await storage.write(g.k, req, g.ct ?? "application/octet-stream", g.len ?? 0);
    if (size !== g.len) {
      await storage.delete(g.k);
      return send(res, 400, "incomplete upload", cors);
    }
    return void res.writeHead(200, { ...cors, etag: `"${size}"` }).end();
  }

  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "method not allowed", { ...cors, allow: "GET, HEAD, PUT" });
  if (g.m !== "GET") return send(res, 403, "not a download link", cors);
  const meta = await storage.meta(g.k);
  const st = meta ? await stat(storage.path(g.k)).catch(() => null) : null;
  if (!meta || !st) return send(res, 404, "not found", cors);
  // Storage answers on the app's own address: a file a browser would run (HTML, SVG, XML, a script) is only ever a
  // download, in a sandbox with no scripts should a browser show it anyway, whatever the link asked for.
  const active = !inlineSafe(meta.contentType);
  const disposition = active ? (g.d ?? "attachment").replace(/^inline\b/, "attachment") : g.d;
  const headers: Record<string, string> = {
    ...cors,
    "content-type": meta.contentType,
    "x-content-type-options": "nosniff",
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=60",
    ...(disposition ? { "content-disposition": disposition } : {}),
    ...(active ? { "content-security-policy": "sandbox; default-src 'none'" } : {}),
  };
  const range = parseRange(req.headers.range, st.size);
  if (range === false) return void res.writeHead(416, { ...headers, "content-range": `bytes */${st.size}` }).end();
  if (range) {
    res.writeHead(206, { ...headers, "content-range": `bytes ${range.start}-${range.end}/${st.size}`, "content-length": String(range.end - range.start + 1) });
    if (req.method === "HEAD") return void res.end();
    return pipeline(createReadStream(storage.path(g.k), { start: range.start, end: range.end }), res);
  }
  res.writeHead(200, { ...headers, "content-length": String(st.size) });
  if (req.method === "HEAD") return void res.end();
  await pipeline(createReadStream(storage.path(g.k)), res);
}
