import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { INestApplication } from "@nestjs/common";
import pg from "pg";
import { migrate, signInternalToken, PRINCIPAL_HEADER, S3Storage } from "@workspace/service-kit";
import { newId, type Grant, type Principal } from "@workspace/shared";
import { createWorkApp } from "../../src/modules/work/app.js";
import { resetTestDatabase } from "../test-db.js";

const SECRET = "dev-internal-secret-change-me-32bytes!";
const T = (...ps: string[]): Grant[] => ps.map((permission) => ({ permission, scope: "WORKSPACE" }));
const EMP = T("file.upload", "file.read", "document.read");
const mk = (id: string): Principal => ({ type: "user", id, teamIds: [], departmentId: null, grants: EMP });
const minh = mk("minh");
const lan = mk("lan");
const storage = new S3Storage({
  endpoint: "http://localhost:8333",
  region: "auto",
  bucket: "workspace-files",
  accessKeyId: "workspace_dev_key",
  secretAccessKey: "workspace_dev_secret",
});
let app: INestApplication;
let base: string;

async function call(p: Principal, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", [PRINCIPAL_HEADER]: await signInternalToken({ principal: p, requestId: newId() }, SECRET), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null };
}
async function upload(p: Principal, name: string, parentId: string | null, text = "xin chào") {
  const bytes = new TextEncoder().encode(text);
  const u = (await call(p, "POST", "/drive/uploads", { name, contentType: "text/plain", size: bytes.length, parentId })).body;
  expect((await fetch(u.uploadUrl, { method: "PUT", headers: { "content-type": "text/plain" }, body: bytes })).ok).toBe(true);
  expect((await call(p, "POST", `/files/${u.fileId}/confirm`)).status).toBe(201);
  expect((await call(p, "POST", `/drive/items/${u.itemId}/finish`)).status).toBe(200);
  return u as { itemId: string; fileId: string };
}

beforeAll(async () => {
  await migrate("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test", fileURLToPath(new URL("../../migrations/work", import.meta.url)), "work");
  // Each suite starts from an empty installation: counts and codes below assume only its own rows.
  await resetTestDatabase();
  await storage.ensureBucket();
  const pool = new pg.Pool({ connectionString: "postgres://workspace_work:app_pw@localhost:5432/workspace_test", max: 10 });
  app = await createWorkApp({ pool, storage, internalSecret: SECRET });
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "127.0.0.1");
});
afterAll(async () => {
  await app?.close();
});

describe("drive", () => {
  it("folders and uploads; sharing a folder shares what is inside; trash and restore", async () => {
    const folder = (await call(minh, "POST", "/drive/folders", { name: "Hợp đồng" })).body;
    const f = await upload(minh, "hop-dong-abc.txt", folder.id);
    const mine = (await call(minh, "GET", `/drive?folder=${folder.id}`)).body;
    expect(mine.items.map((x: { name: string }) => x.name)).toEqual(["hop-dong-abc.txt"]);
    expect(mine.path.map((x: { name: string }) => x.name)).toEqual(["Hợp đồng"]);
    expect(mine.usedBytes).toBeGreaterThan(0);
    expect((await call(minh, "GET", "/drive")).body.items.map((x: { name: string }) => x.name)).toContain("Hợp đồng");

    // Lan cannot see it until the folder is shared with her; then she can download the file inside.
    expect((await call(lan, "GET", `/drive?folder=${folder.id}`)).status).toBe(404);
    expect((await call(lan, "GET", `/files/${f.fileId}/download`)).status).toBe(404);
    await call(minh, "PUT", `/drive/items/${folder.id}/sharing`, { visibility: "private", viewers: ["lan"] });
    expect((await call(lan, "GET", "/drive?section=shared")).body.items.map((x: { name: string }) => x.name)).toEqual(["Hợp đồng"]);
    expect((await call(lan, "GET", `/files/${f.fileId}/download`)).status).toBe(200);
    // Viewers cannot rename or upload into it.
    expect((await call(lan, "PATCH", `/drive/items/${f.itemId}`, { name: "x" })).status).toBe(403);
    expect((await call(lan, "POST", "/drive/folders", { name: "con", parentId: folder.id })).status).toBe(403);

    await call(minh, "PATCH", `/drive/items/${f.itemId}`, { starred: true, name: "hop-dong-2026.txt" });
    expect((await call(minh, "GET", "/drive?section=starred")).body.items.map((x: { name: string }) => x.name)).toEqual(["hop-dong-2026.txt"]);
    expect((await call(minh, "GET", "/drive?q=2026")).body.items).toHaveLength(1);
    await call(minh, "POST", `/drive/items/${f.itemId}/trash`, { trashed: true });
    expect((await call(minh, "GET", `/drive?folder=${folder.id}`)).body.items).toHaveLength(0);
    expect((await call(minh, "GET", "/drive?section=trash")).body.items.map((x: { id: string }) => x.id)).toContain(f.itemId);
    expect((await call(minh, "DELETE", `/drive/items/${f.itemId}`)).status).toBe(200);
    expect((await call(minh, "GET", `/files/${f.fileId}/download`)).status).toBe(404);
  });

  it("has no storage quota (a quota header is ignored); a folder cannot move into itself", async () => {
    const big = await call(
      minh,
      "POST",
      "/drive/uploads",
      { name: "video.mp4", contentType: "video/mp4", size: 400 * 1024 * 1024, parentId: null },
      { "x-drive-quota-gb": "0.0001" },
    );
    expect(big.status).toBe(201);
    // Any kind of file but programs and scripts: an HTML export is fine (it only ever comes back as a download).
    expect((await call(minh, "POST", "/drive/uploads", { name: "x.html", contentType: "text/html", size: 10, parentId: null })).status).toBe(201);
    expect((await call(minh, "POST", "/drive/uploads", { name: "setup.exe", contentType: "application/octet-stream", size: 10, parentId: null })).status).toBe(400);
    expect((await call(minh, "POST", "/drive/uploads", { name: "photo.png", contentType: "application/x-msdownload", size: 10, parentId: null })).status).toBe(400);
    const a = (await call(minh, "POST", "/drive/folders", { name: "A" })).body;
    const b = (await call(minh, "POST", "/drive/folders", { name: "B", parentId: a.id })).body;
    expect((await call(minh, "PATCH", `/drive/items/${a.id}`, { parentId: b.id })).status).toBe(400);
  });
});
