import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { INestApplication } from "@nestjs/common";
import pg from "pg";
import { migrate, signInternalToken, PRINCIPAL_HEADER, S3Storage } from "@workspace/service-kit";
import { newId, type Grant, type Principal } from "@workspace/shared";
import { createWorkApp } from "../../src/modules/work/app.js";
import { docText, readableHtml, sanitizeDoc } from "../../src/modules/work/documents.js";
import { resetTestDatabase } from "../test-db.js";

const SECRET = "dev-internal-secret-change-me-32bytes!";
const T = (...ps: string[]): Grant[] => ps.map((permission) => ({ permission, scope: "WORKSPACE" }));
const S = (...ps: string[]): Grant[] => ps.map((permission) => ({ permission, scope: "SELF" }));
const EMPLOYEE = [...T("document.read", "document.create", "file.upload", "file.read"), ...S("document.edit", "document.share")];
const GUEST = T("document.read");
const mk = (id: string, grants: Grant[]): Principal => ({ type: "user", id, teamIds: [], departmentId: null, grants });
const minh = mk("minh", EMPLOYEE);
const lan = mk("lan", EMPLOYEE);
const guest = mk("khach", GUEST);
const run = newId()
  .slice(-5)
  .replace(/[^A-Z0-9]/g, "X");

const storage = new S3Storage({
  endpoint: "http://localhost:8333",
  region: "auto",
  bucket: "workspace-files",
  accessKeyId: "workspace_dev_key",
  secretAccessKey: "workspace_dev_secret",
});
let app: INestApplication;
let base: string;

async function call(p: Principal, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", [PRINCIPAL_HEADER]: await signInternalToken({ principal: p, requestId: newId() }, SECRET) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null };
}

beforeAll(async () => {
  await migrate("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test", fileURLToPath(new URL("../../migrations/work", import.meta.url)), "work");
  // Each suite starts from an empty installation: counts and codes below assume only its own rows.
  await resetTestDatabase();
  const pool = new pg.Pool({ connectionString: "postgres://workspace_work:app_pw@localhost:5432/workspace_test", max: 10 });
  app = await createWorkApp({ pool, storage, internalSecret: SECRET });
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "127.0.0.1");
});
afterAll(async () => {
  await app?.close();
});

describe("rich text", () => {
  it("hands pages to readers as clean HTML, older Markdown pages included", () => {
    expect(readableHtml("# Kế hoạch\n\n- [x] xong\n\n<script>alert(1)</script>", "markdown")).toMatch(/^<h1>Kế hoạch<\/h1>/);
    expect(readableHtml("# A\n\n<script>alert(1)</script><img src=x onerror=alert(1)>", "markdown")).not.toMatch(/script|onerror/);
    expect(readableHtml('<p onclick="x()">Hi <a href="javascript:alert(1)">a</a></p><div data-toggle=""><p>T</p></div>', "html")).toBe(
      '<p>Hi <a rel="noopener noreferrer">a</a></p><div data-toggle><p>T</p></div>',
    );
  });

  it("keeps what the editor makes and drops scripts, handlers and javascript: links", () => {
    const html = sanitizeDoc(
      `<h2>Kế hoạch</h2><p onclick="x()">Xin <strong>chào</strong><script>alert(1)</script></p><a href="javascript:alert(1)">x</a>` +
        `<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>Xong</p></li></ul><div data-callout="warning"><p>Chú ý</p></div>` +
        `<table><tbody><tr><td colspan="2">ô</td></tr></tbody></table><span data-type="mention" data-id="lan" data-label="Lan">@Lan</span>`,
    );
    expect(html).not.toMatch(/script|onclick|javascript:/);
    expect(html).toContain('data-type="taskList"');
    expect(html).toContain('data-callout="warning"');
    expect(html).toContain('colspan="2"');
    expect(html).toContain('data-id="lan"');
    expect(docText(html, "html")).toContain("Kế hoạch\nXin chào");
  });
});

describe("spaces and the page tree", () => {
  let eng: { id: string; key: string; homeId: string };
  let page: { id: string };
  let child: { id: string };

  it("a space comes with a home page, and everyone in the workspace can read and edit its pages", async () => {
    const r = await call(minh, "POST", "/spaces", { key: `E${run}`, name: "Kỹ thuật", description: "Tài liệu kỹ thuật", icon: "⚙️" });
    expect(r.status).toBe(201);
    eng = r.body;
    expect(eng.homeId).toBeTruthy();
    expect((await call(lan, "POST", "/spaces", { key: `E${run}`, name: "Trùng" })).status).toBe(409);
    expect((await call(lan, "POST", "/spaces", { key: "1x", name: "Sai" })).status).toBe(400);

    page = (
      await call(lan, "POST", "/docs", { title: "Kiến trúc", content: "<p>Tổng quan<script>x</script></p>", format: "html", spaceId: eng.id, labels: ["Kiến trúc", "backend"] })
    ).body;
    child = (await call(lan, "POST", "/docs", { title: "API", content: "<p>REST</p>", format: "html", parentId: page.id })).body;
    const tree = (await call(minh, "GET", `/spaces/${eng.key}`)).body;
    expect(tree.pages.map((x: { title: string }) => x.title)).toEqual(expect.arrayContaining(["Kỹ thuật", "Kiến trúc", "API"]));
    expect(tree.pages.find((x: { id: string }) => x.id === child.id).parentId).toBe(page.id);

    const doc = (await call(minh, "GET", `/docs/${child.id}`)).body;
    expect(doc.format).toBe("html");
    expect(doc.context).toMatchObject({ space: { key: eng.key }, ancestors: [{ title: "Kiến trúc" }], canEdit: true, readers: 1 });
    const saved = await call(minh, "PUT", `/docs/${page.id}`, { content: "<p>Bản mới</p>", baseVersion: 1, format: "html" });
    expect(saved.status).toBe(200);
    expect((await call(guest, "PUT", `/docs/${page.id}`, { content: "<p>x</p>", baseVersion: 2, format: "html" })).status).toBe(403);
    expect((await call(guest, "GET", `/docs/${page.id}`)).body.content).toBe("<p>Bản mới</p>");
    expect((await call(minh, "GET", `/docs?label=backend`)).body.documents.map((d: { id: string }) => d.id)).toContain(page.id);
  });

  it("pages move in the tree, never under themselves, and deleting one keeps its children", async () => {
    expect((await call(lan, "POST", `/docs/${page.id}/move`, { parentId: child.id })).status).toBe(400);
    expect((await call(lan, "POST", `/docs/${child.id}/move`, { parentId: null, beforeId: page.id })).status).toBe(200);
    const top = (await call(lan, "GET", `/spaces/${eng.key}`)).body.pages.filter((x: { parentId: string | null }) => !x.parentId).map((x: { id: string }) => x.id);
    expect(top.indexOf(child.id)).toBeLessThan(top.indexOf(page.id));
    const grand = (await call(lan, "POST", "/docs", { title: "Cháu", content: "<p>c</p>", format: "html", parentId: page.id })).body;
    expect((await call(lan, "DELETE", `/docs/${page.id}`)).status).toBe(200);
    expect((await call(lan, "GET", `/docs/${grand.id}`)).body.context.ancestors).toEqual([]);
    expect((await call(lan, "DELETE", `/docs/${eng.homeId}`)).status).toBe(403);
  });

  it("a restricted space is invisible to people outside it, in lists and by id", async () => {
    const hr = (await call(minh, "POST", "/spaces", { key: `H${run}`, name: "Nhân sự", visibility: "restricted", members: ["minh"] })).body;
    const salary = (await call(minh, "POST", "/docs", { title: "Bảng lương", content: "<p>bí mật</p>", format: "html", spaceId: hr.id })).body;
    expect((await call(lan, "GET", `/spaces/${hr.key}`)).status).toBe(404);
    expect((await call(lan, "GET", `/docs/${salary.id}`)).status).toBe(404);
    expect((await call(lan, "GET", "/spaces")).body.spaces.map((s: { key: string }) => s.key)).not.toContain(hr.key);
    expect((await call(lan, "GET", "/docs")).body.documents.map((d: { id: string }) => d.id)).not.toContain(salary.id);
    // Live editing asks the same question: no room for Lan, and a guest may read but not edit.
    expect((await call(lan, "GET", `/docs/${salary.id}/collab`)).status).toBe(404);
    expect((await call(minh, "GET", `/docs/${salary.id}/collab`)).body).toEqual({ canEdit: true, version: 1 });
    await call(minh, "PATCH", `/spaces/${hr.key}`, { members: ["minh", "lan"] });
    expect((await call(lan, "GET", `/docs/${salary.id}`)).status).toBe(200);
    expect((await call(lan, "GET", `/docs/${salary.id}/collab`)).body.canEdit).toBe(true);
    expect((await call(guest, "GET", `/docs/${eng.homeId}/collab`)).body).toMatchObject({ canEdit: false });
  });

  it("comments (with replies and resolving), stars and the docs home", async () => {
    const c1 = (await call(lan, "POST", `/docs/${child.id}/comments`, { body: "Thiếu phần xác thực", quote: "REST" })).body;
    await call(minh, "POST", `/docs/${child.id}/comments`, { body: "Mình bổ sung", parentId: c1.id });
    expect((await call(minh, "POST", `/docs/${child.id}/comments/${c1.id}/resolve`, { resolved: true })).status).toBe(200);
    const list = (await call(lan, "GET", `/docs/${child.id}/comments`)).body.comments;
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ quote: "REST", resolvedBy: "minh" });
    expect((await call(minh, "DELETE", `/docs/${child.id}/comments/${c1.id}`)).status).toBe(403);

    await call(lan, "PUT", `/docs/${child.id}/star`);
    const home = (await call(lan, "GET", "/docs-home")).body;
    expect(home.starred.map((d: { id: string }) => d.id)).toContain(child.id);
    expect(home.recent.map((d: { id: string }) => d.id)).toContain(child.id);
    expect(home.spaces.map((s: { key: string }) => s.key)).toContain(eng.key);
    await call(lan, "DELETE", `/docs/${child.id}/star`);
    expect((await call(lan, "GET", "/docs-home")).body.starred.map((d: { id: string }) => d.id)).not.toContain(child.id);
  });
});
