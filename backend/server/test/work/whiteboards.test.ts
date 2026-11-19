import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { INestApplication } from "@nestjs/common";
import pg from "pg";
import { checkEvent, type EventEnvelope } from "@workspace/contracts";
import { migrate, signInternalToken, PRINCIPAL_HEADER, S3Storage } from "@workspace/service-kit";
import { newId, runWithContext, withTransaction, type Grant, type Principal } from "@workspace/shared";
import { createWorkApp } from "../../src/modules/work/app.js";
import { toActions } from "../../src/modules/search/indexer.js";
import { resetTestDatabase } from "../test-db.js";

/**
 * Whiteboards (ADR 0024): boards and who may open, edit and manage them; snapshots merged per element so
 * concurrent saves never lose anything; sticky notes turned into tasks; what search and the other modules read.
 */
const SECRET = "dev-internal-secret-change-me-32bytes!";
const g = (scope: Grant["scope"], ...ps: string[]): Grant[] => ps.map((permission) => ({ permission, scope }));
// The default Employee and Admin roles, as far as whiteboards are concerned (identity/catalog.ts).
const EMPLOYEE = [
  ...g("WORKSPACE", "document.read", "document.create", "project.read", "project.create", "task.read", "task.create", "file.upload", "file.read"),
  ...g("SELF", "task.edit", "task.assign", "document.edit"),
];
const ADMIN = g(
  "WORKSPACE",
  "document.read",
  "document.create",
  "document.edit",
  "project.read",
  "project.create",
  "project.edit",
  "task.read",
  "task.create",
  "task.edit",
  "task.assign",
  "file.upload",
  "file.read",
);
const mk = (id: string, grants: Grant[]): Principal => ({ type: "user", id, teamIds: [], departmentId: null, grants });
const minh = mk("minh", EMPLOYEE);
const lan = mk("lan", EMPLOYEE);
const huy = mk("huy", EMPLOYEE);
const boss = mk("boss", ADMIN);
// A read-only role (e.g. an auditor): may look, may not draw.
const reader = mk("reader", g("WORKSPACE", "document.read", "project.read", "task.read", "file.read"));
const search: Principal = { type: "service", id: "search", teamIds: [], departmentId: null, grants: [{ permission: "search.reindex", scope: "PLATFORM" }] };

const storage = new S3Storage({
  endpoint: "http://localhost:8333",
  region: "auto",
  bucket: "workspace-files",
  accessKeyId: "workspace_dev_key",
  secretAccessKey: "workspace_dev_secret",
});
let app: INestApplication;
let base: string;
let pool: pg.Pool;

async function call(p: Principal, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", [PRINCIPAL_HEADER]: await signInternalToken({ principal: p, requestId: newId() }, SECRET), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null };
}
const db = <R>(fn: (c: pg.PoolClient) => Promise<R>) => runWithContext({ actorId: "test", requestId: newId() }, () => withTransaction(pool, fn));
const events = (type: string, id: string) =>
  db(async (c) =>
    (await c.query<{ payload: EventEnvelope }>("SELECT payload FROM outbox WHERE type = $1 AND aggregateid = $2 ORDER BY created_at", [type, id])).rows.map((r) => r.payload),
  );

let seq = 0;
/** An Excalidraw element as the editor sends it. */
const el = (id: string, version: number, extra: Record<string, unknown> = {}) => ({
  id,
  type: "rectangle",
  version,
  versionNonce: 1000 + version,
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  index: `a${seq++ % 10}`,
  ...extra,
});
const sticky = (id: string, text: string, version = 1, x = 0, y = 0) => [
  el(id, version, { backgroundColor: "#FEF3C7", customData: { sticky: true }, boundElements: [{ type: "text", id: `${id}-t` }], x, y }),
  el(`${id}-t`, version, { type: "text", text, originalText: text, containerId: id, x, y }),
];
const scene = (elements: unknown[]) => ({ elements, appState: { viewBackgroundColor: "#ffffff" }, files: {} });

beforeAll(async () => {
  await migrate("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test", fileURLToPath(new URL("../../migrations/work", import.meta.url)), "work");
  await resetTestDatabase();
  await storage.ensureBucket();
  pool = new pg.Pool({ connectionString: "postgres://workspace_work:app_pw@localhost:5432/workspace_test", max: 10 });
  app = await createWorkApp({ pool, storage, internalSecret: SECRET });
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "127.0.0.1");
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe("whiteboards", () => {
  it("creates boards from localized templates with W- codes, also for workspaces whose code formats predate them", async () => {
    // An installation set up before whiteboards: its stored formats have no "whiteboard" key.
    await db((c) =>
      c.query(`INSERT INTO workspace_settings (code_formats, version) VALUES ($1, 1) ON CONFLICT (singleton) DO UPDATE SET code_formats = EXCLUDED.code_formats`, [
        JSON.stringify({ task: "T-{seq3}", project: "P-{seq3}", document: "D-{seq3}", employee: "EMP-{seq6}", request: "YC-{seq3}", meeting: "H-{seq3}" }),
      ]),
    );
    const retro = await call(minh, "POST", "/whiteboards", { title: "Retro sprint 12", template: "retro" }, { "x-locale": "en" });
    expect(retro.status).toBe(201);
    expect(retro.body).toMatchObject({
      code: "W-001",
      title: "Retro sprint 12",
      visibility: "workspace",
      ownerId: "minh",
      template: "retro",
      canEdit: true,
      canManage: true,
      sceneVersion: 1,
      links: [],
    });
    expect(retro.body.scene.elements.filter((e: { type: string }) => e.type === "text").map((e: { text: string }) => e.text)).toEqual(["Went well", "To improve", "Actions"]);
    // No title: the template's name in the creator's language.
    const kanban = (await call(minh, "POST", "/whiteboards", { template: "kanban" })).body;
    expect(kanban).toMatchObject({ code: "W-002", title: "Kanban" });
    expect((await call(minh, "POST", "/whiteboards", { template: "swot" })).body.title).toBe("SWOT");
    expect((await call(minh, "POST", "/whiteboards", { template: "nope" })).status).toBe(400);
    // Openable by code, any case.
    expect((await call(lan, "GET", "/whiteboards/w-001")).body.id).toBe(retro.body.id);
    const templates = (await call(lan, "GET", "/whiteboards/templates", undefined, { "x-locale": "vi" })).body.templates;
    expect(templates.map((t: { key: string }) => t.key)).toEqual(["blank", "brainstorm", "retro", "kanban", "flowchart", "user-journey", "swot", "meeting"]);
    expect(templates.find((t: { key: string }) => t.key === "user-journey").name).toBe("Hành trình khách hàng");
    // Announced for search with the text on it.
    const [ev] = await events("work.whiteboard.created.v1", retro.body.id);
    expect(ev!.payload).toMatchObject({ code: "W-001", projectId: "workspace", text: "Went well\nTo improve\nActions" });
  });

  it("lets everyone edit workspace boards, project boards their project's people, private boards only the owner", async () => {
    const project = (await call(lan, "POST", "/projects", { name: "Website" })).body;
    const ws = (await call(minh, "POST", "/whiteboards", { title: "Ý tưởng chung" })).body;
    const pb = (await call(minh, "POST", "/whiteboards", { title: "Bảng dự án", projectId: project.id })).body;
    const mine = (await call(minh, "POST", "/whiteboards", { title: "Nháp riêng", visibility: "private" })).body;
    expect(pb).toMatchObject({ visibility: "project", projectId: project.id, projectName: "Website" });
    expect((await call(minh, "POST", "/whiteboards", { title: "x", visibility: "project" })).status).toBe(400);

    const access = async (p: Principal, id: string) => (await call(p, "GET", `/internal/whiteboards/${id}/access`)).body;
    expect(await access(huy, ws.id)).toEqual({ view: true, edit: true });
    expect(await access(reader, ws.id)).toEqual({ view: true, edit: false });
    // Project board: lan leads the project, huy only sees it until he works on one of its tasks.
    expect(await access(lan, pb.id)).toEqual({ view: true, edit: true });
    expect(await access(huy, pb.id)).toEqual({ view: true, edit: false });
    await call(lan, "POST", "/tasks", { title: "Thiết kế trang chủ", projectId: project.id, assigneeId: "huy" });
    expect(await access(huy, pb.id)).toEqual({ view: true, edit: true });
    expect(await access(lan, mine.id)).toEqual({ view: false, edit: false });
    expect(await access(boss, mine.id)).toEqual({ view: false, edit: false });
    expect(await access(huy, newId())).toEqual({ view: false, edit: false });
    expect((await call(lan, "GET", `/whiteboards/${mine.id}`)).status).toBe(404);

    // Lists show only what the caller can open; filters by owner, project and words.
    const titles = async (p: Principal, q = "") => (await call(p, "GET", `/whiteboards${q}`)).body.whiteboards.map((b: { title: string }) => b.title);
    expect(await titles(lan)).not.toContain("Nháp riêng");
    expect(await titles(minh)).toContain("Nháp riêng");
    expect(await titles(minh, `?scope=project&projectId=${project.id}`)).toEqual(["Bảng dự án"]);
    expect(await titles(lan, "?scope=mine")).toEqual([]);
    expect(await titles(lan, "?q=chung")).toEqual(["Ý tưởng chung"]);
    expect((await call(lan, "GET", "/whiteboards?scope=project")).status).toBe(400);
    const listed = (await call(huy, "GET", "/whiteboards")).body.whiteboards.find((b: { id: string }) => b.id === ws.id);
    expect(listed).toMatchObject({ code: ws.code, canEdit: true, canManage: false, thumbnail: null });

    // Managing: the owner and admins (and the project's editors for a project board), not other members.
    expect((await call(lan, "PATCH", `/whiteboards/${ws.id}`, { title: "Đổi tên" })).status).toBe(403);
    expect((await call(boss, "PATCH", `/whiteboards/${ws.id}`, { title: "Ý tưởng Q4" })).body).toMatchObject({ title: "Ý tưởng Q4", canManage: true });
    expect((await call(lan, "PATCH", `/whiteboards/${pb.id}`, { visibility: "workspace" })).body).toMatchObject({ visibility: "workspace", projectId: project.id });
    expect((await call(minh, "PATCH", `/whiteboards/${mine.id}`, { visibility: "project" })).status).toBe(400);
    expect((await call(huy, "DELETE", `/whiteboards/${ws.id}`)).status).toBe(403);
    expect((await call(minh, "DELETE", `/whiteboards/${ws.id}`)).status).toBe(204);
    expect((await call(minh, "GET", `/whiteboards/${ws.id}`)).status).toBe(404);
    expect(await titles(minh)).not.toContain("Ý tưởng Q4");
    expect(await events("work.whiteboard.deleted.v1", ws.id)).toHaveLength(1);
  });

  it("merges concurrent saves per element: nobody's notes are lost, deletions win by version", async () => {
    const b = (await call(minh, "POST", "/whiteboards", { title: "Động não" })).body;
    // Both start from version 1 and save at the same time with different notes.
    const [a, c] = await Promise.all([
      call(minh, "PUT", `/whiteboards/${b.id}/scene`, { baseVersion: 1, scene: scene(sticky("m1", "Giảm thời gian duyệt")) }),
      call(lan, "PUT", `/whiteboards/${b.id}/scene`, { baseVersion: 1, scene: scene(sticky("l1", "Thêm mẫu báo giá")) }),
    ]);
    expect([a.status, c.status]).toEqual([200, 200]);
    expect([a.body.sceneVersion, c.body.sceneVersion].sort()).toEqual([2, 3]);
    expect([a.body.merged, c.body.merged].sort()).toEqual([false, true]);
    let got = (await call(huy, "GET", `/whiteboards/${b.code}`)).body;
    expect(got.sceneVersion).toBe(3);
    expect(got.scene.elements.map((e: { id: string }) => e.id).sort()).toEqual(["l1", "l1-t", "m1", "m1-t"]);

    // An older copy does not overwrite a newer one; a deletion (isDeleted, higher version) merges like any edit.
    await call(minh, "PUT", `/whiteboards/${b.id}/scene`, { baseVersion: 3, scene: scene(sticky("l1", "bản cũ", 0)) });
    await call(lan, "PUT", `/whiteboards/${b.id}/scene`, {
      baseVersion: 3,
      scene: scene([
        { ...sticky("m1", "Giảm thời gian duyệt", 5)[0], isDeleted: true },
        { ...sticky("m1", "Giảm thời gian duyệt", 5)[1], isDeleted: true },
      ]),
    });
    got = (await call(huy, "GET", `/whiteboards/${b.id}`)).body;
    const byId = Object.fromEntries(got.scene.elements.map((e: { id: string }) => [e.id, e]));
    expect(byId["l1-t"].text).toBe("Thêm mẫu báo giá");
    expect(byId.m1.isDeleted).toBe(true);
    // The board's text is read from the merged scene (deleted notes gone), not taken from the client.
    await call(minh, "PUT", `/whiteboards/${b.id}/scene`, { baseVersion: got.sceneVersion, scene: scene([]), text: "client text is ignored" });
    expect((await db((c2) => c2.query<{ text: string }>("SELECT text FROM whiteboards WHERE id = $1", [b.id]))).rows[0]!.text).toBe("Thêm mẫu báo giá");
    const updated = await events("work.whiteboard.updated.v1", b.id);
    expect(updated.at(-1)!.payload).toMatchObject({ text: "Thêm mẫu báo giá" });

    // Saving the same scene again changes nothing (no version bump, no event).
    const v = (await call(huy, "GET", `/whiteboards/${b.id}`)).body.sceneVersion;
    expect((await call(minh, "PUT", `/whiteboards/${b.id}/scene`, { baseVersion: v, scene: scene(sticky("l1", "Thêm mẫu báo giá")) })).body).toEqual({
      sceneVersion: v,
      merged: false,
    });
    expect(await events("work.whiteboard.updated.v1", b.id)).toHaveLength(updated.length);
  });

  it("refuses edits from viewers, broken scenes, oversized scenes and active thumbnails", async () => {
    const b = (await call(minh, "POST", "/whiteboards", { title: "Giới hạn" })).body;
    expect((await call(reader, "PUT", `/whiteboards/${b.id}/scene`, { baseVersion: 1, scene: scene(sticky("r1", "x")) })).status).toBe(403);
    expect((await call(minh, "PUT", `/whiteboards/${b.id}/scene`, { baseVersion: 1, scene: { elements: [{ id: "x" }] } })).status).toBe(400);
    expect((await call(minh, "PUT", `/whiteboards/${b.id}/scene`, { baseVersion: 1, scene: scene(Array.from({ length: 5001 }, (_, i) => el(`e${i}`, 1))) })).status).toBe(400);
    const big = await call(minh, "PUT", `/whiteboards/${b.id}/scene`, { baseVersion: 1, scene: scene([el("big", 1, { text: "x".repeat(5_300_000) })]) });
    expect(big.status).toBe(400);
    expect(big.body.message).toMatch(/too large/);
    expect((await call(minh, "PUT", `/whiteboards/${b.id}/scene`, { baseVersion: 1, scene: scene([el("a", 1)]), thumbnail: "<svg><script>x</script></svg>" })).status).toBe(400);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
    expect((await call(minh, "PUT", `/whiteboards/${b.id}/scene`, { baseVersion: 1, scene: scene([el("a", 1)]), thumbnail: svg })).body.sceneVersion).toBe(2);
    expect((await call(lan, "GET", "/whiteboards")).body.whiteboards.find((x: { id: string }) => x.id === b.id).thumbnail).toBe(svg);
  });

  it("turns sticky notes into tasks linked back to the board, once per note", async () => {
    const project = (await call(minh, "POST", "/projects", { name: "Bán hàng" })).body;
    const b = (await call(minh, "POST", "/whiteboards", { title: "Retro bán hàng", projectId: project.id })).body;
    await call(minh, "PUT", `/whiteboards/${b.id}/scene`, { baseVersion: 1, scene: scene([...sticky("s1", "Gọi lại khách cũ"), ...sticky("s2", "Cập nhật bảng giá")]) });
    const r = await call(minh, "POST", `/whiteboards/${b.id}/tasks`, {
      items: [
        { elementId: "s1", title: "Gọi lại khách cũ" },
        { elementId: "s2", title: "Cập nhật bảng giá", description: "Từ buổi retro" },
      ],
      dueAt: "2026-11-20T10:00:00.000Z",
    });
    expect(r.status).toBe(200);
    expect(r.body.links.map((l: { elementId: string; status: string }) => [l.elementId, l.status])).toEqual([
      ["s1", "todo"],
      ["s2", "todo"],
    ]);
    const task = (await call(minh, "GET", `/tasks/${r.body.links[0].taskId}`)).body.task;
    // In the board's project, with the board as its source (code included so the task page can say "W-…").
    expect(task).toMatchObject({ projectId: project.id, source: { type: "whiteboard", whiteboardId: b.id, code: b.code, elementId: "s1" } });
    // Asking again for the same note makes no second task.
    const again = await call(minh, "POST", `/whiteboards/${b.id}/tasks`, { items: [{ elementId: "s1", title: "Gọi lại khách cũ" }] });
    expect(again.body.links).toHaveLength(1);
    expect(again.body.links[0].taskId).toBe(r.body.links[0].taskId);
    expect((await db((c) => c.query("SELECT count(*)::int AS n FROM tasks WHERE source->>'whiteboardId' = $1", [b.id]))).rows[0].n).toBe(2);

    // Badges follow the task; viewers who cannot edit cannot create; assigning someone else needs task.assign.
    await call(minh, "PATCH", `/tasks/${r.body.links[1].taskId}`, { expectedVersion: 1, status: "done" });
    expect((await call(lan, "GET", `/whiteboards/${b.id}/links`)).body.links.map((l: { status: string }) => l.status)).toEqual(["todo", "done"]);
    expect((await call(huy, "POST", `/whiteboards/${b.id}/tasks`, { items: [{ elementId: "s3", title: "x" }] })).status).toBe(403);
    expect((await call(minh, "POST", `/whiteboards/${b.id}/tasks`, { items: [{ elementId: "s3", title: "x" }], assigneeId: "lan" })).status).toBe(200);
    expect((await call(reader, "POST", `/whiteboards/${b.id}/tasks`, { items: [{ elementId: "s4", title: "x" }] })).status).toBe(403);
    // A deleted task takes its badge with it.
    await call(minh, "DELETE", `/tasks/${r.body.links[0].taskId}`);
    expect((await call(minh, "GET", `/whiteboards/${b.id}`)).body.links.map((l: { elementId: string }) => l.elementId)).toEqual(["s2", "s3"]);
  });

  it("gives the ai module a board's words and search a feed it can index", async () => {
    const b = (await call(minh, "POST", "/whiteboards", { title: "Retro", template: "retro" }, { "x-locale": "en" })).body;
    await call(minh, "PUT", `/whiteboards/${b.id}/scene`, { baseVersion: 1, scene: scene(sticky("n1", "Fast reviews", 1, 0, 100)) });
    const text = (await call(lan, "GET", `/internal/whiteboards/${b.id}/text`)).body;
    expect(text).toMatchObject({ id: b.id, code: b.code, title: "Retro", stickies: [{ elementId: "n1", text: "Fast reviews", x: 0, y: 100 }] });
    expect(text.labels.map((l: { text: string }) => l.text)).toEqual(["Went well", "To improve", "Actions"]);
    const priv = (await call(minh, "POST", "/whiteboards", { title: "Riêng", visibility: "private" })).body;
    expect((await call(lan, "GET", `/internal/whiteboards/${priv.id}/text`)).status).toBe(404);

    // The re-index feed: the same events live indexing understands, valid against the contract.
    expect((await call(minh, "GET", "/internal/search-feed/whiteboards")).status).toBe(403);
    const feed = (await call(search, "GET", "/internal/search-feed/whiteboards?limit=1000")).body;
    const docs = feed.events.flatMap((fe: Omit<EventEnvelope, "eventId" | "version" | "actorId">) =>
      toActions({ eventId: fe.aggregateId, version: 1, actorId: "test", ...fe, payload: checkEvent(fe) }),
    );
    const mineDoc = docs.find((a: { op: string; doc?: { entity_id: string } }) => a.doc?.entity_id === b.id).doc;
    expect(mineDoc).toMatchObject({ entity_type: "whiteboard", container_id: "workspace", url: `/app/work/whiteboards/${b.id}` });
    expect(mineDoc.body).toContain("Fast reviews");
    expect(docs.find((a: { doc?: { entity_id: string } }) => a.doc?.entity_id === priv.id).doc).toMatchObject({ container_id: `wb:${priv.id}`, acl_users: ["minh"] });
    // Search's recheck: only boards the caller can open.
    const readable = (await call(lan, "POST", "/internal/readable", { whiteboards: [b.id, priv.id, newId()] })).body;
    expect(readable.whiteboards).toEqual([b.id]);
  });

  it("attaches images to boards their editors can change, and serves them to their readers", async () => {
    const b = (await call(minh, "POST", "/whiteboards", { title: "Ảnh" })).body;
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const up = await call(lan, "POST", "/files/uploads", { name: "a.png", contentType: "image/png", size: bytes.length, attachTo: { type: "whiteboard", id: b.id } });
    expect(up.status).toBe(201);
    expect((await fetch(up.body.uploadUrl, { method: "PUT", headers: { "content-type": "image/png" }, body: bytes })).ok).toBe(true);
    expect((await call(lan, "POST", `/files/${up.body.fileId}/confirm`)).status).toBe(201);
    expect((await call(reader, "GET", `/files/${up.body.fileId}/download`)).status).toBe(200);
    expect((await call(reader, "POST", "/files/uploads", { name: "b.png", contentType: "image/png", size: 4, attachTo: { type: "whiteboard", id: b.id } })).status).toBe(403);
    const priv = (await call(minh, "POST", "/whiteboards", { title: "Riêng tư", visibility: "private" })).body;
    expect((await call(lan, "POST", "/files/uploads", { name: "c.png", contentType: "image/png", size: 4, attachTo: { type: "whiteboard", id: priv.id } })).status).toBe(404);
    // The scene names the uploaded file; the bytes never go into it.
    const saved = await call(lan, "PUT", `/whiteboards/${b.id}/scene`, {
      baseVersion: 1,
      scene: {
        elements: [el("img", 1, { type: "image", fileId: "f1" })],
        files: { f1: { id: "f1", mimeType: "image/png", fileId: up.body.fileId, dataURL: "data:image/png;base64,iVBO" } },
      },
    });
    expect(saved.status).toBe(200);
    expect((await call(minh, "GET", `/whiteboards/${b.id}`)).body.scene.files).toEqual({ f1: { id: "f1", mimeType: "image/png", fileId: up.body.fileId } });
  });
  it("organises boards in folders whose access boards inherit, override, and keep when the folder is deleted", async () => {
    const sara: Principal = { ...mk("sara", EMPLOYEE), departmentId: "D-SALES" };
    const access = async (p: Principal, id: string) => (await call(p, "GET", `/internal/whiteboards/${id}/access`)).body;
    const folderNames = async (p: Principal) => (await call(p, "GET", "/whiteboards/folders")).body.folders.map((f: { name: string }) => f.name);

    // A top-level folder starts open to the company (everyone edits); its manager narrows it to Sales + Huy (view).
    const sales = (await call(minh, "POST", "/whiteboards/folders", { name: "Kinh doanh" })).body;
    expect(sales).toMatchObject({ name: "Kinh doanh", parentId: null, visibility: "workspace", canManage: true });
    expect((await call(lan, "PUT", `/whiteboards/folders/${sales.id}/access`, { inherit: true, grants: [] })).status).toBe(403);
    const shared = await call(minh, "PUT", `/whiteboards/folders/${sales.id}/access`, {
      inherit: true,
      grants: [
        { subjectType: "department", subjectId: "D-SALES", role: "edit" },
        { subjectType: "user", subjectId: "huy", role: "view" },
      ],
    });
    expect(shared.status).toBe(200);
    expect(shared.body).toMatchObject({ visibility: "restricted", inherit: true });

    // A board made in it inherits: Sales edits, Huy views, Lan (neither) cannot list, open or find it; admins manage.
    const plan = (await call(sara, "POST", "/whiteboards", { title: "Kế hoạch Q1", folderId: sales.id })).body;
    expect(plan).toMatchObject({ folderId: sales.id, inherit: true, canManage: true, path: [{ id: sales.id, name: "Kinh doanh" }] });
    const deal = (await call(minh, "POST", "/whiteboards", { title: "Hợp đồng lớn", folderId: sales.id })).body;
    expect(await access(sara, deal.id)).toEqual({ view: true, edit: true });
    expect(await access(huy, deal.id)).toEqual({ view: true, edit: false });
    expect(await access(lan, deal.id)).toEqual({ view: false, edit: false });
    expect(await access(boss, deal.id)).toEqual({ view: true, edit: true });
    expect((await call(lan, "GET", `/whiteboards/${deal.id}`)).status).toBe(404);
    expect((await call(lan, "GET", "/whiteboards")).body.whiteboards.map((b: { id: string }) => b.id)).not.toContain(deal.id);
    expect(await folderNames(lan)).not.toContain("Kinh doanh");
    expect(await folderNames(huy)).toContain("Kinh doanh");
    const inFolder = (await call(sara, "GET", `/whiteboards?folderId=${sales.id}`)).body.whiteboards.map((b: { title: string }) => b.title);
    expect(inFolder.sort()).toEqual(["Hợp đồng lớn", "Kế hoạch Q1"]);
    expect((await call(minh, "GET", "/whiteboards?folderId=root")).body.whiteboards.map((b: { id: string }) => b.id)).not.toContain(deal.id);
    expect((await call(lan, "POST", "/whiteboards", { title: "x", folderId: sales.id })).status).toBe(404);
    expect((await call(huy, "POST", "/whiteboards", { title: "x", folderId: sales.id })).status).toBe(403);

    // View-only cannot save, attach or turn notes into tasks; no access cannot save either.
    expect((await call(huy, "PUT", `/whiteboards/${deal.id}/scene`, { baseVersion: 1, scene: scene(sticky("h1", "x")) })).status).toBe(403);
    expect((await call(lan, "PUT", `/whiteboards/${deal.id}/scene`, { baseVersion: 1, scene: scene(sticky("l1", "x")) })).status).toBe(404);
    expect((await call(huy, "POST", "/files/uploads", { name: "a.png", contentType: "image/png", size: 4, attachTo: { type: "whiteboard", id: deal.id } })).status).toBe(403);
    expect((await call(sara, "PUT", `/whiteboards/${deal.id}/scene`, { baseVersion: 1, scene: scene(sticky("s1", "Giá đặc biệt")) })).status).toBe(200);
    // Editing is not managing: Sara cannot move or share Minh's board.
    expect((await call(sara, "PATCH", `/whiteboards/${deal.id}`, { folderId: null })).status).toBe(403);
    expect((await call(sara, "PUT", `/whiteboards/${deal.id}/access`, { inherit: false, grants: [] })).status).toBe(403);

    // Search: restricted boards are their own container, listed only for the people who may open them.
    const scope = async (p: Principal) => (await call(p, "GET", "/internal/search-scope")).body.containerIds as string[];
    expect(await scope(sara)).toContain(`wb:${deal.id}`);
    expect(await scope(lan)).not.toContain(`wb:${deal.id}`);
    const [ev] = (await events("work.whiteboard.updated.v1", deal.id)).slice(-1);
    expect(ev!.payload).toMatchObject({ projectId: null });
    expect((await call(lan, "POST", "/internal/readable", { whiteboards: [deal.id] })).body.whiteboards).toEqual([]);

    // A board can stop inheriting: only Lan (edit) and its owner now.
    const own = await call(minh, "PUT", `/whiteboards/${deal.id}/access`, { inherit: false, grants: [{ subjectType: "user", subjectId: "lan", role: "edit" }] });
    expect(own.body).toMatchObject({ inherit: false, grants: [{ subjectType: "user", subjectId: "lan", role: "edit" }], inherited: [] });
    expect(await access(lan, deal.id)).toEqual({ view: true, edit: true });
    expect(await access(sara, deal.id)).toEqual({ view: false, edit: false });
    // What Lan can open in a folder she cannot see shows at her top level.
    expect((await call(lan, "GET", "/whiteboards?folderId=root")).body.whiteboards.map((b: { id: string }) => b.id)).toContain(deal.id);
    expect((await call(minh, "GET", `/whiteboards/${deal.id}/access`)).body.inherit).toBe(false);

    // Nested folders: Sara (edit) adds one; it cannot move into itself.
    const sub = (await call(sara, "POST", "/whiteboards/folders", { name: "Khách hàng", parentId: sales.id })).body;
    expect(sub).toMatchObject({ parentId: sales.id, visibility: "restricted" });
    expect((await call(minh, "PATCH", `/whiteboards/folders/${sales.id}`, { parentId: sub.id })).status).toBe(400);
    const nested = (await call(minh, "POST", "/whiteboards", { title: "Khách VIP", folderId: sub.id })).body;
    expect(await access(sara, nested.id)).toEqual({ view: true, edit: true });
    expect(await access(lan, nested.id)).toEqual({ view: false, edit: false });
    const inherited = (await call(minh, "GET", `/whiteboards/${nested.id}/access`)).body.inherited.map((g: { subjectId: string; fromName: string }) => [g.subjectId, g.fromName]);
    expect(inherited).toEqual([
      ["D-SALES", "Kinh doanh"],
      ["huy", "Kinh doanh"],
    ]);

    // Deleting a folder keeps every board: the contents move up and keep exactly the access they had.
    expect((await call(huy, "DELETE", `/whiteboards/folders/${sales.id}`)).status).toBe(403);
    expect((await call(minh, "DELETE", `/whiteboards/folders/${sales.id}`)).status).toBe(204);
    expect(await folderNames(minh)).not.toContain("Kinh doanh");
    const folders = (await call(minh, "GET", "/whiteboards/folders")).body.folders;
    expect(folders.find((f: { id: string }) => f.id === sub.id)).toMatchObject({ parentId: null });
    expect((await call(sara, "GET", `/whiteboards/${plan.id}`)).body).toMatchObject({ folderId: null, canEdit: true });
    expect(await access(sara, nested.id)).toEqual({ view: true, edit: true });
    expect(await access(huy, nested.id)).toEqual({ view: true, edit: false });
    expect(await access(lan, nested.id)).toEqual({ view: false, edit: false });
    expect(await access(lan, plan.id)).toEqual({ view: false, edit: false });
    expect(await access(lan, deal.id)).toEqual({ view: true, edit: true });

    // Moving a board into a folder: managers of the board who can edit the folder.
    expect((await call(minh, "PATCH", `/whiteboards/${deal.id}`, { folderId: sub.id })).body).toMatchObject({ folderId: sub.id });
  });

  it("sets a new folder's members in the same step it is created", async () => {
    const access = async (p: Principal, id: string) => (await call(p, "GET", `/internal/whiteboards/${id}/access`)).body;
    const team = (await call(minh, "POST", "/whiteboards/folders", { name: "Dự án mật", grants: [{ subjectType: "user", subjectId: "huy", role: "edit" }] })).body;
    expect(team).toMatchObject({ visibility: "restricted", canManage: true });
    expect((await call(minh, "GET", `/whiteboards/folders/${team.id}/access`)).body.grants).toEqual([{ subjectType: "user", subjectId: "huy", role: "edit" }]);
    const board = (await call(minh, "POST", "/whiteboards", { title: "Phác thảo", folderId: team.id })).body;
    expect(await access(huy, board.id)).toEqual({ view: true, edit: true });
    expect(await access(lan, board.id)).toEqual({ view: false, edit: false });
    // An empty list means only its creator (and admins).
    const solo = (await call(minh, "POST", "/whiteboards/folders", { name: "Nháp", grants: [] })).body;
    expect((await call(lan, "GET", "/whiteboards/folders")).body.folders.map((f: { id: string }) => f.id)).not.toContain(solo.id);
  });
});
