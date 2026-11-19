import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { INestApplication } from "@nestjs/common";
import pg from "pg";
import { migrate, signInternalToken, PRINCIPAL_HEADER, S3Storage } from "@workspace/service-kit";
import { newId, type Grant, type Principal } from "@workspace/shared";
import { createWorkApp } from "../../src/modules/work/app.js";
import { resetTestDatabase } from "../test-db.js";

/**
 * "Liên quan" on a task (work/related.ts): the no-AI view and the AI brief's source. Full-text search only; every
 * part is read as the caller, so a private document or task they cannot open never shows. Chat's search is a fake
 * here that records what it was asked (the real one is covered by chat's own tests).
 */
const SECRET = "dev-internal-secret-change-me-32bytes!";
const T = (...ps: string[]): Grant[] => ps.map((permission) => ({ permission, scope: "WORKSPACE" }));
const S = (...ps: string[]): Grant[] => ps.map((permission) => ({ permission, scope: "SELF" }));
const EMPLOYEE = [...T("project.read", "project.create", "task.read", "task.create", "document.read", "document.create", "message.read"), ...S("task.edit", "document.edit")];
const mk = (id: string, grants: Grant[]): Principal => ({ type: "user", id, teamIds: [], departmentId: null, grants });
const lan = mk("lan", EMPLOYEE);
const huy = mk("huy", EMPLOYEE);
const guest = mk("guest", T("task.read"));

const asked: { path: string; as: string }[] = [];
const fakeChat = {
  async request<R>(_m: string, path: string, _b?: unknown, as?: Principal): Promise<R> {
    asked.push({ path, as: as?.id ?? "" });
    const q = new URL(`http://x${path}`).searchParams;
    if (q.get("types") === "message")
      return {
        hits: [
          { entity_type: "message", entity_id: "m1", title: "web", body: `${q.get("q")} keeps failing on Safari`, url: "/app/chat/m/m1", created_at: "2026-11-03T00:00:00.000Z" },
          // Names a longer code: not about this task.
          { entity_type: "message", entity_id: "m2", title: "web", body: `${q.get("q")}0 is another task`, url: "/app/chat/m/m2", created_at: "2026-11-02T00:00:00.000Z" },
        ],
      } as R;
    return {
      hits: [
        { entity_type: "document", entity_id: "doc-search", title: "Safari cookie notes", body: "The login page needs SameSite=None and Secure", url: "/app/work/docs/doc-search" },
      ],
    } as R;
  },
};

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
  await resetTestDatabase();
  const pool = new pg.Pool({ connectionString: "postgres://workspace_work:app_pw@localhost:5432/workspace_test", max: 5 });
  app = await createWorkApp({ pool, storage, internalSecret: SECRET, chat: fakeChat });
  await app.listen(0);
  base = (await app.getUrl()).replace("[::1]", "127.0.0.1");
});

afterAll(async () => {
  await app?.close();
});

describe("task related view", () => {
  let task: { id: string; code: string };
  let old: { id: string; code: string };

  it("lists project documents, similar finished tasks with who did them, and messages naming the code", async () => {
    const project = (await call(lan, "POST", "/projects", { name: "Website" })).body;
    const runbook = (await call(lan, "POST", "/docs", { title: "Auth runbook", content: "Cookies", projectId: project.id, visibility: "project" })).body;
    // Huy's private notes in the same project: not Lan's to read.
    await call(huy, "POST", "/docs", { title: "Huy private notes", content: "x", projectId: project.id, visibility: "private" });
    old = (await call(huy, "POST", "/tasks", { title: "Fix login page on Firefox", projectId: project.id, assigneeId: "huy" })).body;
    await call(huy, "POST", `/tasks/${old.id}/comments`, { body: "It was the SameSite cookie flag; set Secure too." });
    const v = (await call(huy, "GET", `/tasks/${old.id}`)).body.task.version;
    expect((await call(huy, "PATCH", `/tasks/${old.id}`, { expectedVersion: v, status: "done" })).status).toBe(200);
    // Same words but not finished: not "done before".
    await call(huy, "POST", "/tasks", { title: "Fix login page on Edge", projectId: project.id });
    task = (await call(lan, "POST", "/tasks", { title: "Fix the login page on Safari", projectId: project.id, assigneeId: "lan", description: `See ${runbook.code ?? ""}` })).body;

    const r = await call(lan, "GET", `/tasks/${task.code}/related`);
    expect(r.status).toBe(200);
    expect(r.body.keywords).toEqual(["login", "page", "safari"]);
    expect(r.body.project.name).toBe("Website");
    expect(r.body.docs.map((d: { title: string }) => d.title)).toEqual(["Auth runbook", "Safari cookie notes"]);
    expect(r.body.docs[0].why).toBe("mentioned");
    expect(r.body.similar).toHaveLength(1);
    expect(r.body.similar[0]).toMatchObject({ code: old.code, assigneeId: "huy", how: "It was the SameSite cookie flag; set Secure too." });
    expect(r.body.messages.map((m: { id: string }) => m.id)).toEqual(["m1"]);
    expect(r.body.partial).toBe(false);
    // Chat was asked as Lan: its search applies her access, not the work module's.
    expect(asked.every((a) => a.as === "lan")).toBe(true);
  });

  it("refuses a task the caller cannot open, and leaves out what they cannot read", async () => {
    const mine = (await call(huy, "POST", "/tasks", { title: "Private to-do about login page" })).body;
    expect((await call(lan, "GET", `/tasks/${mine.id}/related`)).status).toBe(404);
    // Someone without project access sees the task's own data only where they can read it.
    const r = await call(guest, "GET", `/tasks/${task.id}/related`);
    expect(r.status).toBe(200);
    expect(r.body.project).toBeNull();
    expect(r.body.docs.map((d: { title: string }) => d.title)).not.toContain("Huy private notes");
  });
});
