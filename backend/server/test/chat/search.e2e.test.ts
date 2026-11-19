import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { INestApplication } from "@nestjs/common";
import pg from "pg";
import { EventBus, migrate, S3Storage, searchPool, signInternalToken, startOutboxRelay, PRINCIPAL_HEADER, type OutboxRelay } from "@workspace/service-kit";
import { newId, type Principal } from "@workspace/shared";
import { startIndexer } from "../../src/modules/search/indexer.js";
import { createChatApp, depsFromEnv } from "../../src/modules/chat/app.js";
import { createWorkApp } from "../../src/modules/work/app.js";
import { resetTestDatabase } from "../test-db.js";

const SECRET = "dev-internal-secret-change-me-32bytes!";
const A = newId();
const EMP = ["channel.create", "channel.read", "message.post", "message.read"].map((permission) => ({ permission, scope: "WORKSPACE" as const }));
const p = (id: string): Principal => ({ type: "user", id, teamIds: [], departmentId: null, grants: EMP });
let close: () => Promise<void>;
let url: string;
let indexer: Awaited<ReturnType<typeof startIndexer>> | undefined;
const relays: OutboxRelay[] = [];
let work: INestApplication | undefined;
let workUrl: string;
let workPool: pg.Pool | undefined;
const bus = new EventBus();

async function call(who: Principal, method: string, path: string, body?: unknown) {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { "content-type": "application/json", [PRINCIPAL_HEADER]: await signInternalToken({ principal: who, requestId: newId() }, SECRET) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null };
}

beforeAll(async () => {
  // Hit counts below assume no earlier messages say the same words.
  await resetTestDatabase();
  for (const m of ["work", "chat"])
    await migrate("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test", fileURLToPath(new URL(`../../migrations/${m}`, import.meta.url)), m);
  // The work module is part of this test (its tasks are searched, chat asks it what the reader may still read): it
  // runs here on the test database, as chat does, so no running server is needed.
  workPool = new pg.Pool({ connectionString: "postgres://workspace_work:app_pw@localhost:5432/workspace_test", max: 5 });
  work = await createWorkApp({
    pool: workPool,
    storage: new S3Storage({
      endpoint: "http://localhost:8333",
      region: "auto",
      bucket: "workspace-files",
      accessKeyId: "workspace_dev_key",
      secretAccessKey: "workspace_dev_secret",
    }),
    internalSecret: SECRET,
    meet: null,
  });
  await work.listen(0);
  workUrl = (await work.getUrl()).replace("[::1]", "127.0.0.1");
  const deps = { ...depsFromEnv(), workUrl };
  const { app, listen } = await createChatApp(deps);
  // Messages and tasks reach the indexer through their modules' outboxes: relayed here.
  relays.push(startOutboxRelay({ pool: deps.pool, bus }), startOutboxRelay({ pool: workPool, bus }));
  url = `http://127.0.0.1:${await listen(0)}`;
  close = () => app.close();
  await migrate("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test", fileURLToPath(new URL("../../migrations/search", import.meta.url)), "search");
  indexer = await startIndexer(bus, searchPool("postgres://workspace_search:app_pw@localhost:5432/workspace_test"), `idx-test-${A}`);
  bus.start();
});

afterAll(async () => {
  await indexer?.stop();
  for (const r of relays) await r.stop();
  await close?.();
  await work?.close();
  await workPool?.end();
});

const eventually = async (fn: () => Promise<boolean>, ms = 60_000) => {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 500));
  }
};

describe("chat search end-to-end (chat → event bus → search-indexer → Postgres search)", () => {
  it("finds messages the user can read, not private ones, and drops deleted ones", async () => {
    const pub = (await call(p("minh"), "POST", "/channels", { kind: "public", name: `search-${A.slice(-6)}` })).body.id;
    const priv = (await call(p("minh"), "POST", "/channels", { kind: "private", name: `hr-${A.slice(-6)}` })).body.id;
    const visible = (await call(p("minh"), "POST", `/channels/${pub}/messages`, { body: "Ngân sách chiến dịch quý 4" })).body;
    await call(p("minh"), "POST", `/channels/${priv}/messages`, { body: "Ngân sách lương bí mật" });
    await eventually(async () => (await call(p("minh"), "GET", "/search?q=ngan sach")).body.hits.length === 2);
    // Within one conversation: only its messages, and nothing from a conversation the caller cannot read.
    expect((await call(p("minh"), "GET", `/search?q=ngan sach&channelId=${pub}`)).body.hits.map((h: { entity_id: string }) => h.entity_id)).toEqual([visible.id]);
    expect((await call(p("lan"), "GET", `/search?q=ngan sach&channelId=${priv}`)).body.hits).toEqual([]);
    const lan = await call(p("lan"), "GET", "/search?q=ngan sach");
    expect(lan.body.hits.map((h: { entity_id: string }) => h.entity_id)).toEqual([visible.id]);
    await call(p("minh"), "DELETE", `/messages/${visible.id}`);
    await eventually(async () => (await call(p("lan"), "GET", "/search?q=ngan sach")).body.hits.length === 0);
  });

  it("one search covers channels, files and tasks, each under its own permission rules", async () => {
    const tag = A.slice(-6).toLowerCase();
    const WORK = (id: string): Principal => ({
      ...p(id),
      grants: [
        ...EMP,
        ...["task.read", "task.create", "project.read", "document.read", "file.upload"].map((permission) => ({ permission, scope: "WORKSPACE" as const })),
        { permission: "task.edit", scope: "SELF" as const },
      ],
    });
    const pub = (await call(WORK("minh"), "POST", "/channels", { kind: "public", name: `hopdong-${tag}`, topic: "Hợp đồng khách hàng" })).body.id;
    const priv = (await call(WORK("minh"), "POST", "/channels", { kind: "private", name: `luong-${tag}` })).body.id;
    const up = (await call(WORK("minh"), "POST", `/channels/${pub}/files`, { name: `hopdong-${tag}.pdf`, contentType: "application/pdf", size: 4 })).body;
    await fetch(up.uploadUrl, { method: "PUT", headers: { "content-type": "application/pdf" }, body: "%PDF" });
    await call(WORK("minh"), "POST", `/files/${up.fileId}/confirm`);
    await call(WORK("minh"), "POST", `/channels/${pub}/messages`, { body: "bản ký", attachments: [up.fileId] });
    // A personal task: only its owner may find it.
    const task = await fetch(workUrl + "/tasks", {
      method: "POST",
      headers: { "content-type": "application/json", [PRINCIPAL_HEADER]: await signInternalToken({ principal: WORK("minh"), requestId: newId() }, SECRET) },
      body: JSON.stringify({ title: `Gia hạn hopdong-${tag}` }),
    }).then((r) => r.json());
    const types = async (who: Principal, q: string) => (await call(who, "GET", `/search?q=${q}`)).body.hits as { entity_type: string; entity_id: string }[];
    await eventually(async () => {
      const h = await types(WORK("minh"), `hopdong-${tag}`);
      return ["channel", "file", "task"].every((t) => h.some((x) => x.entity_type === t));
    });
    const lan = await types(WORK("lan"), `hopdong-${tag}`);
    expect(lan.some((x) => x.entity_type === "channel" && x.entity_id === pub)).toBe(true);
    expect(lan.some((x) => x.entity_type === "file" && x.entity_id === up.fileId)).toBe(true);
    expect(lan.some((x) => x.entity_type === "task" && x.entity_id === task.id)).toBe(false);
    await eventually(async () => (await types(WORK("minh"), `luong-${tag}`)).some((x) => x.entity_id === priv));
    expect((await types(WORK("lan"), `luong-${tag}`)).some((x) => x.entity_id === priv)).toBe(false);
    expect((await call(WORK("minh"), "GET", `/search?q=hopdong-${tag}&types=file`)).body.hits.every((x: { entity_type: string }) => x.entity_type === "file")).toBe(true);
  });
});
