import { beforeAll, describe, expect, it } from "vitest";
import { newId } from "@workspace/shared";
import { objectKey, S3Storage } from "../src/storage.js";

const storage = new S3Storage({
  endpoint: "http://localhost:8333",
  region: "auto",
  bucket: "workspace-test",
  accessKeyId: "workspace_dev_key",
  secretAccessKey: "workspace_dev_secret",
});

beforeAll(async () => {
  await storage.ensureBucket();
});

describe("S3Storage (R2 abstraction)", () => {
  it("builds keys from ULIDs only", () => {
    const id = newId();
    expect(objectKey("documents", id)).toBe(`documents/${id}`);
    expect(() => objectKey("documents", "../../chat/secret")).toThrow();
  });

  it("uploads through a presigned PUT and downloads through a presigned GET", async () => {
    const key = objectKey("documents", newId());
    const body = "xin chào";
    const put = await storage.presignPut(key, "text/plain", Buffer.byteLength(body), 60);
    const up = await fetch(put, { method: "PUT", headers: { "content-type": "text/plain" }, body });
    expect(up.status).toBe(200);
    expect(await storage.head(key)).toMatchObject({ size: Buffer.byteLength(body) });
    const get = await storage.presignGet(key, 60, "chào.txt");
    const down = await fetch(get);
    expect(await down.text()).toBe(body);
  });

  it("rejects an upload whose size differs from the signed size", async () => {
    const key = objectKey("documents", newId());
    const put = await storage.presignPut(key, "text/plain", 5, 60);
    const up = await fetch(put, { method: "PUT", headers: { "content-type": "text/plain" }, body: "much longer than five bytes" });
    expect(up.status).toBeGreaterThanOrEqual(400);
    expect(await storage.head(key)).toBeNull();
  });

  it("rejects an expired presigned URL", async () => {
    const key = objectKey("documents", newId());
    const put = await storage.presignPut(key, "text/plain", 2, 1);
    await new Promise((r) => setTimeout(r, 2100));
    const up = await fetch(put, { method: "PUT", headers: { "content-type": "text/plain" }, body: "hi" });
    expect(up.status).toBe(403);
  });

  it("rejects a tampered signature", async () => {
    const key = objectKey("documents", newId());
    const put = await storage.presignPut(key, "text/plain", 2, 60);
    const tampered = put.replace(key, objectKey("chat", newId()));
    const up = await fetch(tampered, { method: "PUT", headers: { "content-type": "text/plain" }, body: "hi" });
    expect(up.status).toBe(403);
  });

  it("deletes objects", async () => {
    const key = objectKey("documents", newId());
    const put = await storage.presignPut(key, "text/plain", 2, 60);
    await fetch(put, { method: "PUT", headers: { "content-type": "text/plain" }, body: "hi" });
    await storage.delete(key);
    expect(await storage.head(key)).toBeNull();
  });
});
