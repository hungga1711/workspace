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
const S = (...ps: string[]): Grant[] => ps.map((permission) => ({ permission, scope: "SELF" }));
const mk = (id: string, grants: Grant[]): Principal => ({ type: "user", id, teamIds: [], departmentId: null, grants });
const lead = mk("lead", [...T("project.read", "project.create", "task.read", "task.create", "task.assign"), ...S("task.edit")]);
const intern = mk("intern", [...T("project.read", "task.read", "task.create")]);
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
  app = await createWorkApp({ pool: new pg.Pool({ connectionString: "postgres://workspace_work:app_pw@localhost:5432/workspace_test", max: 5 }), storage, internalSecret: SECRET });
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "127.0.0.1");
});
afterAll(async () => {
  await app?.close();
});

describe("importing tasks from another tool", () => {
  it("keeps status, priority, due date, labels and the old key; done tasks count as done", async () => {
    const project = (await call(lead, "POST", "/projects", { name: "Từ Jira" })).body;
    const r = await call(lead, "POST", `/projects/${project.id}/import`, {
      system: "jira",
      tasks: [
        { title: "Thiết kế trang giá", status: "done", priority: "high", key: "WEB-1", labels: ["web"] },
        { title: "Viết API thanh toán", status: "in_progress", assigneeId: "dev1", dueAt: "2030-01-15T10:00:00+07:00", key: "WEB-2" },
        { title: "Kiểm thử", key: "WEB-3" },
      ],
    });
    expect(r).toMatchObject({ status: 201, body: { created: 3, unassigned: 0 } });
    const board = (await call(lead, "GET", `/projects/${project.id}/board`)).body as { columns: { tasks: unknown[] }[] };
    const tasks = board.columns.flatMap((c) => c.tasks) as {
      title: string;
      status: string;
      priority: string;
      completedAt: string | null;
      source: { key: string } | null;
      assigneeId: string | null;
    }[];
    const byTitle = Object.fromEntries(tasks.map((t) => [t.title, t]));
    expect(byTitle["Thiết kế trang giá"]).toMatchObject({ status: "done", priority: "high", source: { type: "import", system: "jira", key: "WEB-1" } });
    expect(byTitle["Thiết kế trang giá"]!.completedAt).not.toBeNull();
    expect(byTitle["Viết API thanh toán"]).toMatchObject({ status: "in_progress", assigneeId: "dev1" });
    expect(byTitle["Kiểm thử"]).toMatchObject({ status: "todo", priority: "medium" });
    // Each imported task sits in the column of its status, so the board and every report agree.
    const cols = board.columns as unknown as { status: string; tasks: { status: string }[] }[];
    for (const c of cols) for (const t of c.tasks) expect(t.status).toBe(c.status);
  });

  it("someone who may not assign others imports those tasks unassigned instead of failing", async () => {
    const project = (await call(lead, "POST", "/projects", { name: "Từ Trello" })).body;
    const r = await call(intern, "POST", `/projects/${project.id}/import`, {
      system: "trello",
      tasks: [{ title: "Thẻ của Lan", assigneeId: "lan" }, { title: "Thẻ không ai nhận" }],
    });
    expect(r.body).toEqual({ created: 2, unassigned: 1 });
  });

  it("takes a full 1000-task import in one request (larger than the 100 kB default body limit)", async () => {
    const project = (await call(lead, "POST", "/projects", { name: "Lớn" })).body;
    const tasks = Array.from({ length: 1000 }, (_, i) => ({ title: `Việc số ${i + 1}`, description: "Mô tả chi tiết ".repeat(25), key: `BIG-${i + 1}` }));
    const r = await call(lead, "POST", `/projects/${project.id}/import`, { system: "csv", tasks });
    expect(r).toMatchObject({ status: 201, body: { created: 1000 } });
  });

  it("brings ClickUp subtasks under their parent, whatever order they arrive in", async () => {
    const project = (await call(lead, "POST", "/projects", { name: "Từ ClickUp" })).body;
    const r = await call(lead, "POST", `/projects/${project.id}/import`, {
      system: "clickup",
      tasks: [
        { title: "Viết nội dung", key: "86a2", parentKey: "86a1" },
        { title: "Thiết kế trang giá", key: "86a1" },
        { title: "Mồ côi", key: "86a9", parentKey: "not-in-this-import" },
      ],
    });
    expect(r).toMatchObject({ status: 201, body: { created: 3 } });
    const board = (await call(lead, "GET", `/projects/${project.id}/board`)).body as { columns: { tasks: { id: string; title: string; parentId: string | null }[] }[] };
    const all = board.columns.flatMap((c) => c.tasks);
    const parent = all.find((t) => t.title === "Thiết kế trang giá")!;
    const tasks = (await call(lead, "GET", `/tasks/${parent.id}`)).body as { subtasks?: { title: string }[] };
    expect((tasks.subtasks ?? []).map((s) => s.title)).toEqual(["Viết nội dung"]);
    expect(all.find((t) => t.title === "Mồ côi")?.parentId ?? null).toBeNull();
  });

  it("validates the payload and needs task.create", async () => {
    const project = (await call(lead, "POST", "/projects", { name: "Rỗng" })).body;
    expect((await call(lead, "POST", `/projects/${project.id}/import`, { tasks: [] })).status).toBe(400);
    expect((await call(lead, "POST", `/projects/${project.id}/import`, { tasks: [{ title: "x", status: "weird" }] })).status).toBe(400);
    expect((await call(mk("viewer", T("task.read")), "POST", `/projects/${project.id}/import`, { tasks: [{ title: "x" }] })).status).toBe(403);
  });
});
