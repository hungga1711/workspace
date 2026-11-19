import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newId } from "@workspace/shared";
import { LocalStorage, localFilesHandler } from "../src/local-storage.js";
import { objectKey, storageDriver } from "../src/storage.js";

let dir: string;
let server: Server;
let base: string;
let storage: LocalStorage;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "wx-files-"));
  server = createServer((req, res) => (req.url?.startsWith("/storage/") ? handler(req, res) : res.writeHead(404).end()));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  storage = new LocalStorage({ dir, publicUrl: base, secret: "test-internal-secret-at-least-32-characters" });
  await storage.ensureBucket();
});
const handler = (req: Parameters<ReturnType<typeof localFilesHandler>>[0], res: Parameters<ReturnType<typeof localFilesHandler>>[1]) =>
  localFilesHandler(storage, "http://web.test")(req, res);

afterAll(async () => {
  await new Promise((r) => server.close(r));
  await rm(dir, { recursive: true, force: true });
});

describe("LocalStorage (STORAGE_DRIVER=local)", () => {
  it("uploads through a signed PUT and downloads through a signed GET, like S3", async () => {
    const key = objectKey("documents", newId());
    const body = "xin chào";
    const put = await storage.presignPut(key, "text/plain", Buffer.byteLength(body), 60);
    expect(put.startsWith(`${base}/storage/`)).toBe(true);
    const up = await fetch(put, { method: "PUT", headers: { "content-type": "text/plain" }, body });
    expect(up.status).toBe(200);
    expect(up.headers.get("access-control-allow-origin")).toBe("http://web.test");

    expect(await storage.head(key)).toEqual({ size: Buffer.byteLength(body), contentType: "text/plain" });
    const get = await storage.presignGet(key, 60, "Báo cáo quý 3.txt");
    const down = await fetch(get);
    expect(down.status).toBe(200);
    expect(await down.text()).toBe(body);
    expect(down.headers.get("content-type")).toBe("text/plain");
    expect(down.headers.get("x-content-type-options")).toBe("nosniff");
    expect(down.headers.get("content-disposition")).toBe(`attachment; filename="Bao cao quy 3.txt"; filename*=UTF-8''${encodeURIComponent("Báo cáo quý 3.txt")}`);

    const inline = await fetch(await storage.presignGet(key, 60, "a.txt", true));
    expect(inline.headers.get("content-disposition")).toMatch(/^inline;/);

    await storage.delete(key);
    expect(await storage.head(key)).toBeNull();
    expect((await fetch(get)).status).toBe(404);
  });

  it("hands back a file a browser would run as a download, even through an inline link", async () => {
    for (const [type, body] of [
      ["text/html", "<script>alert(1)</script>"],
      ["image/svg+xml", "<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>"],
    ] as const) {
      const key = objectKey("documents", newId());
      await fetch(await storage.presignPut(key, type, Buffer.byteLength(body), 60), { method: "PUT", headers: { "content-type": type }, body });
      const res = await fetch(await storage.presignGet(key, 60, "page", true));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
      expect(res.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });

  it("serves single byte ranges for audio and video", async () => {
    const key = objectKey("chat", newId());
    const body = "0123456789";
    await fetch(await storage.presignPut(key, "video/mp4", body.length, 60), { method: "PUT", headers: { "content-type": "video/mp4" }, body });
    const url = await storage.presignGet(key, 60, "v.mp4", true);
    const part = await fetch(url, { headers: { range: "bytes=2-5" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await part.text()).toBe("2345");
    const tail = await fetch(url, { headers: { range: "bytes=-3" } });
    expect(await tail.text()).toBe("789");
    expect((await fetch(url, { headers: { range: "bytes=20-" } })).status).toBe(416);
    expect((await fetch(url, { method: "HEAD" })).headers.get("content-length")).toBe("10");
  });

  it("refuses an upload whose type or size differs from what was signed", async () => {
    const key = objectKey("documents", newId());
    const put = await storage.presignPut(key, "image/png", 4, 60);
    expect((await fetch(put, { method: "PUT", headers: { "content-type": "text/html" }, body: "abcd" })).status).toBe(403);
    expect((await fetch(put, { method: "PUT", headers: { "content-type": "image/png" }, body: "abcdef" })).status).toBe(403);
    expect(await storage.head(key)).toBeNull();
  });

  it("refuses altered, swapped, expired and foreign tokens", async () => {
    const key = objectKey("documents", newId());
    await fetch(await storage.presignPut(key, "text/plain", 2, 60), { method: "PUT", headers: { "content-type": "text/plain" }, body: "hi" });
    const get = await storage.presignGet(key, 60, "a.txt");
    const [body, sig] = get.split("/storage/")[1]!.split(".");
    // Same signature, another key: the body is signed, so the swap fails.
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, "base64url").toString()), k: objectKey("chat", newId()) })).toString("base64url");
    expect((await fetch(`${base}/storage/${forged}.${sig}`)).status).toBe(403);
    // A download link cannot upload.
    expect((await fetch(get, { method: "PUT", headers: { "content-type": "text/plain" }, body: "xx" })).status).toBe(403);
    // Expired.
    const old = await storage.presignGet(key, -5, "a.txt");
    expect((await fetch(old)).status).toBe(403);
    // Signed with another installation's secret.
    const other = new LocalStorage({ dir, publicUrl: base, secret: "another-installation-secret-32-characters!" });
    expect((await fetch(await other.presignGet(key, 60, "a.txt"))).status).toBe(403);
  });

  it("never maps a key outside its directory", async () => {
    await expect(storage.presignPut("../etc/passwd", "text/plain", 1, 60)).rejects.toThrow();
    expect(() => storage.path("documents/../../x")).toThrow();
  });
});

describe("storageDriver", () => {
  it("is explicit when STORAGE_DRIVER is set, else S3 with an endpoint or in development, local in production", () => {
    expect(storageDriver({ STORAGE_DRIVER: "local", S3_ENDPOINT: "http://s3" })).toBe("local");
    expect(storageDriver({ STORAGE_DRIVER: "s3", NODE_ENV: "production" })).toBe("s3");
    expect(storageDriver({ S3_ENDPOINT: "https://files.example.com", NODE_ENV: "production" })).toBe("s3");
    expect(storageDriver({ NODE_ENV: "production" })).toBe("local");
    expect(storageDriver({ NODE_ENV: "development" })).toBe("s3");
    expect(() => storageDriver({ STORAGE_DRIVER: "disk" })).toThrow();
  });
});
