import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { INestApplication } from "@nestjs/common";
import pg from "pg";
import {
  EventBus,
  migrate,
  S3Storage,
  SEARCH_REINDEX_PERMISSION,
  searchPool,
  signInternalToken,
  startOutboxRelay,
  PRINCIPAL_HEADER,
  type FeedPage,
  type OutboxRelay,
} from "@workspace/service-kit";
import { newId, type Grant, type Principal } from "@workspace/shared";
import { createChatApp, depsFromEnv } from "../../src/modules/chat/app.js";
import { startIndexer, type FetchKnowledge } from "../../src/modules/search/indexer.js";
import { reindex } from "../../src/modules/search/reindex.js";
import { createWorkApp } from "../../src/modules/work/app.js";
import { readFileTexts } from "../../src/modules/work/knowledge.js";
import { resetTestDatabase } from "../test-db.js";

/**
 * Passages for AI retrieval, end to end: work writes → its outbox → the event bus → the search indexer, which reads
 * each changed thing's text back from work → the passages table → chat's `GET /search/passages`, as the reader, with
 * the recheck against work. What a company asks about (a clause deep in a page, a meeting's minutes, a comment on a
 * task, the words of a file, a request) is found by whoever may read it, and by nobody else.
 */
const SECRET = "dev-internal-secret-change-me-32bytes!";
const T = (...ps: string[]): Grant[] => ps.map((permission) => ({ permission, scope: "WORKSPACE" }));
const S = (...ps: string[]): Grant[] => ps.map((permission) => ({ permission, scope: "SELF" }));
const EMPLOYEE = [
  ...T(
    "channel.read",
    "message.read",
    "message.post",
    "project.read",
    "task.read",
    "task.create",
    "document.read",
    "document.create",
    "file.read",
    "file.upload",
    "approval.request",
    "task.assign",
  ),
  ...S("task.edit", "calendar.read", "calendar.edit"),
];
const who = (id: string): Principal => ({ type: "user", id, teamIds: [], departmentId: null, grants: EMPLOYEE });
const minh = who("minh");
const lan = who("lan");
const huy = who("huy");
const service: Principal = { type: "service", id: "search", teamIds: [], departmentId: null, grants: [{ permission: SEARCH_REINDEX_PERMISSION, scope: "PLATFORM" }] };

const tag = newId().slice(-6).toLowerCase();
const bus = new EventBus();
let work: INestApplication;
let workUrl: string;
let chatUrl: string;
let closeChat: () => Promise<void>;
let workPool: pg.Pool;
let search: pg.Pool;
let storage: S3Storage;
let indexer: Awaited<ReturnType<typeof startIndexer>> | undefined;
const relays: OutboxRelay[] = [];

async function http(base: string, p: Principal, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", [PRINCIPAL_HEADER]: await signInternalToken({ principal: p, requestId: newId() }, SECRET) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null };
}
const w = (p: Principal, method: string, path: string, body?: unknown) => http(workUrl, p, method, path, body);
type Hit = { entity_type: string; entity_id: string; title: string; heading: string; text: string; seq: number; url: string; score: number };
const ask = async (p: Principal, q: string, more = "") => ((await http(chatUrl, p, "GET", `/search/passages?q=${encodeURIComponent(q)}${more}`)).body?.passages ?? []) as Hit[];
const eventually = async (fn: () => Promise<boolean>, what: string, ms = 30_000) => {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 300));
  }
};
const has = (hits: Hit[], type: string, id: string) => hits.some((h) => h.entity_type === type && h.entity_id === id);

beforeAll(async () => {
  await resetTestDatabase();
  const owner = "postgres://workspace_owner:owner_pw@localhost:5432/workspace_test";
  for (const m of ["work", "chat", "search"]) await migrate(owner, fileURLToPath(new URL(`../../migrations/${m}`, import.meta.url)), m);
  workPool = new pg.Pool({ connectionString: "postgres://workspace_work:app_pw@localhost:5432/workspace_test", max: 5 });
  storage = new S3Storage({
    endpoint: "http://localhost:8333",
    region: "auto",
    bucket: "workspace-files",
    accessKeyId: "workspace_dev_key",
    secretAccessKey: "workspace_dev_secret",
  });
  work = await createWorkApp({ pool: workPool, storage, internalSecret: SECRET, meet: null });
  await work.listen(0);
  workUrl = (await work.getUrl()).replace("[::1]", "127.0.0.1");
  const chatDeps = { ...depsFromEnv(), workUrl };
  const chat = await createChatApp(chatDeps);
  chatUrl = `http://127.0.0.1:${await chat.listen(0)}`;
  closeChat = () => chat.app.close();
  relays.push(startOutboxRelay({ pool: workPool, bus }), startOutboxRelay({ pool: chatDeps.pool, bus }));
  search = searchPool("postgres://workspace_search:app_pw@localhost:5432/workspace_test");
  // The indexer reads each changed thing's text back from work, as the search module does in the server.
  const fetchKnowledge: FetchKnowledge = async (items) => (await http(workUrl, service, "POST", "/internal/knowledge", { items })).body;
  indexer = await startIndexer(bus, search, `knowledge-${tag}`, fetchKnowledge);
  bus.start();
}, 120_000);

afterAll(async () => {
  await indexer?.stop();
  for (const r of relays) await r.stop();
  await closeChat?.();
  await work?.close();
  await workPool?.end();
  await search?.end();
});

describe("passages for AI retrieval", () => {
  it("finds the paragraph deep in a long page, with its heading, and its neighbours on request", async () => {
    const filler = Array.from(
      { length: 40 },
      (_, i) => `Paragraph ${i + 1} of the handbook explains an ordinary rule about office life in some detail, so that the page is long.`,
    ).join("\n\n");
    const content = `# Handbook ${tag}\n\n## Working hours\n\n${filler}\n\n## Refunds\n\n### After thirty days\n\nA customer who returns a ${tag}lamp after thirty days gets store credit, never cash. The shift lead signs it off.\n\n## Travel\n\n${filler}`;
    const doc = (await w(minh, "POST", "/docs", { title: `Handbook ${tag}`, content, projectId: null, visibility: "workspace" })).body;
    expect(doc.id, JSON.stringify(doc)).toBeTruthy();
    await eventually(async () => has(await ask(lan, `${tag}lamp store credit`), "document", doc.id), "the page's passage");
    const hit = (await ask(lan, `${tag}lamp store credit`)).find((h) => h.entity_id === doc.id)!;
    // Far beyond what the page's search document ranks on (its first thousand characters).
    expect(hit.seq).toBeGreaterThan(3);
    expect(hit.heading).toBe(`Handbook ${tag} › Refunds › After thirty days`);
    expect(hit.text).toContain("gets store credit, never cash");
    expect(hit.text.length).toBeLessThan(1400);
    expect(hit.url).toBe(`/app/work/docs/${doc.id}`);
    // At most two passages of one page in an answer, however many match.
    expect((await ask(lan, "handbook office life rule", "&limit=12")).filter((h) => h.entity_id === doc.id).length).toBeLessThanOrEqual(2);
    // "Read more of this": the passages around it, for someone who may read the page.
    const around = (await http(chatUrl, lan, "GET", `/search/passages/around?type=document&id=${doc.id}&seq=${hit.seq}&radius=1`)).body.passages as Hit[];
    expect(around.map((p) => p.seq)).toEqual([hit.seq - 1, hit.seq, hit.seq + 1]);

    // Made private: gone for the others at once (the recheck), and from the index when the event lands.
    const page = (await w(minh, "GET", `/docs/${doc.id}`)).body;
    expect((await w(minh, "PUT", `/docs/${doc.id}/sharing`, { userIds: [], visibility: "private" })).status, JSON.stringify(page).slice(0, 80)).toBeLessThan(300);
    expect(has(await ask(lan, `${tag}lamp store credit`), "document", doc.id)).toBe(false);
    expect((await http(chatUrl, lan, "GET", `/search/passages/around?type=document&id=${doc.id}&seq=${hit.seq}`)).body.passages).toEqual([]);
    expect(has(await ask(minh, `${tag}lamp store credit`), "document", doc.id)).toBe(true);
    // Deleted: its passages go.
    expect((await w(minh, "DELETE", `/docs/${doc.id}`)).status).toBeLessThan(300);
    await eventually(async () => !has(await ask(minh, `${tag}lamp store credit`), "document", doc.id), "the deleted page's passages to go");
  });

  it("finds a meeting's minutes and a calendar entry for the people invited, nobody else", async () => {
    const at = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
    const made = (
      await w(minh, "POST", "/calendar/events", {
        title: `Launch review ${tag}`,
        kind: "meeting",
        startsAt: at(24),
        endsAt: at(25),
        attendeeIds: ["lan"],
        location: "Room 4",
        projectId: null,
      })
    ).body;
    const id = (made.id ?? made.ids?.[0] ?? made.events?.[0]?.id) as string;
    expect(id, JSON.stringify(made)).toBeTruthy();
    const meeting = (await w(minh, "GET", `/meetings/${id}`)).body;
    // An attendee writes the minutes; that alone must reach the index.
    expect(
      (await w(lan, "PATCH", `/meetings/${id}`, { expectedVersion: meeting.event.version, notes: `We agreed to move the ${tag}launch to the fourteenth of March.` })).status,
    ).toBe(200);
    await eventually(async () => has(await ask(lan, `${tag}launch fourteenth March`), "meeting", id), "the minutes");
    const hit = (await ask(minh, `${tag}launch fourteenth March`)).find((h) => h.entity_id === id)!;
    expect(hit).toMatchObject({ entity_type: "meeting", url: `/app/work/meetings/${id}` });
    expect(hit.text).toContain("Where: Room 4");
    expect(hit.text).toContain("## Minutes\nWe agreed to move");
    // Huy was not invited.
    expect(has(await ask(huy, `${tag}launch fourteenth March`), "meeting", id)).toBe(false);
    expect(await ask(lan, `${tag}launch`, "&types=task,document")).toEqual([]);

    const other = (
      await w(minh, "POST", "/calendar/events", { title: `Dentist ${tag}`, kind: "event", startsAt: at(48), endsAt: at(49), attendeeIds: [], location: "", projectId: null })
    ).body;
    const eid = (other.id ?? other.ids?.[0] ?? other.events?.[0]?.id) as string;
    await eventually(async () => has(await ask(minh, `dentist ${tag}`), "event", eid), "the calendar entry");
    expect(has(await ask(lan, `dentist ${tag}`), "event", eid)).toBe(false);

    // Cancelled: its passages go.
    expect((await w(minh, "DELETE", `/calendar/events/${id}`)).status).toBeLessThan(300);
    await eventually(async () => !has(await ask(lan, `${tag}launch fourteenth March`), "meeting", id), "the cancelled meeting's passages to go");
  });

  it("finds a comment on a task and a request, each by who may read it", async () => {
    const task = (await w(minh, "POST", "/tasks", { title: `Renew the office lease ${tag}`, description: "Talk to the landlord.", assigneeId: "lan" })).body;
    expect(task.id, JSON.stringify(task)).toBeTruthy();
    const said = await w(lan, "POST", `/tasks/${task.id}/comments`, { body: `The landlord offered ${tag}rent of 4200 euros a month for three years.` });
    expect(said.status, JSON.stringify(said.body)).toBeLessThan(300);
    await eventually(async () => has(await ask(minh, `${tag}rent 4200 euros`), "task", task.id), "the comment");
    const hit = (await ask(lan, `${tag}rent 4200 euros`)).find((h) => h.entity_id === task.id)!;
    expect(hit.text).toContain("Status: todo");
    expect(hit.text).toContain("4200 euros a month");
    // A personal task: its owner and its assignee only.
    expect(has(await ask(huy, `${tag}rent 4200 euros`), "task", task.id)).toBe(false);

    const req = (
      await w(minh, "POST", "/approvals", { title: `Standing desks ${tag}`, details: `Six ${tag}desks for the support team, delivered in May.`, approverId: "lan", kind: "other" })
    ).body;
    expect(req.id, JSON.stringify(req)).toBeTruthy();
    await eventually(async () => has(await ask(lan, `${tag}desks support team`), "approval", req.id), "the request");
    expect(has(await ask(minh, `${tag}desks support team`), "approval", req.id)).toBe(true);
    expect(has(await ask(huy, `${tag}desks support team`), "approval", req.id)).toBe(false);
  }, 90_000);

  it("reads the words of files in the background: a shared Drive file is found, a private one only by its owner", async () => {
    const put = async (name: string, body: string, share: boolean) => {
      const up = (await w(minh, "POST", "/drive/uploads", { name, contentType: "text/plain", size: body.length })).body;
      await fetch(up.uploadUrl, { method: "PUT", headers: { "content-type": "text/plain" }, body });
      expect((await w(minh, "POST", `/files/${up.fileId}/confirm`)).status).toBeLessThan(300);
      expect((await w(minh, "POST", `/drive/items/${up.itemId}/finish`)).status).toBe(200);
      if (share) expect((await w(minh, "PUT", `/drive/items/${up.itemId}/sharing`, { visibility: "workspace", viewers: [], editors: [] })).status).toBeLessThan(300);
      return up as { fileId: string; itemId: string };
    };
    const shared = await put(`warranty-${tag}.txt`, `Warranty: every ${tag}lamp is covered for twenty-four months on parts.`, true);
    const secret = await put(`margins-${tag}.txt`, `Our ${tag}margin on lamps is sixty-one percent.`, false);
    // Nothing is read when the file is uploaded; the job reads a few files a run.
    expect(has(await ask(lan, `${tag}lamp twenty-four months`), "file", shared.fileId)).toBe(false);
    let readNow = 0;
    for (let i = 0; i < 5; i++) {
      const n = await readFileTexts(workPool, storage);
      readNow += n;
      if (!n) break;
    }
    expect(readNow).toBeGreaterThanOrEqual(2);
    await eventually(async () => has(await ask(lan, `${tag}lamp twenty-four months`), "file", shared.fileId), "the shared file's words");
    expect((await ask(lan, `${tag}lamp twenty-four months`)).find((h) => h.entity_id === shared.fileId)).toMatchObject({
      title: `warranty-${tag}.txt`,
      url: `/app/files/${shared.fileId}`,
    });
    await eventually(async () => has(await ask(minh, `${tag}margin sixty-one percent`), "file", secret.fileId), "the private file's words");
    expect(has(await ask(lan, `${tag}margin sixty-one percent`), "file", secret.fileId)).toBe(false);
    // In the trash: gone for everyone.
    expect((await w(minh, "POST", `/drive/items/${shared.itemId}/trash`, { trashed: true })).status).toBeLessThan(300);
    await eventually(async () => !has(await ask(lan, `${tag}lamp twenty-four months`), "file", shared.fileId), "the trashed file's passages to go");
    // A file with no words is marked once and not tried again.
    expect(await readFileTexts(workPool, storage)).toBe(0);
  }, 90_000);

  it("a file attached to a task is found by someone given the task afterwards, without the file changing", async () => {
    const task = (await w(minh, "POST", "/tasks", { title: `Supplier contract ${tag}`, description: "", assigneeId: "minh" })).body;
    const text = `Clause nine: the ${tag}supplier pays a penalty of two percent per late week.`;
    const up = (await w(minh, "POST", "/files/uploads", { name: `contract-${tag}.txt`, contentType: "text/plain", size: text.length, attachTo: { type: "task", id: task.id } }))
      .body;
    expect(up.fileId, JSON.stringify(up)).toBeTruthy();
    await fetch(up.uploadUrl, { method: "PUT", headers: { "content-type": "text/plain" }, body: text });
    expect((await w(minh, "POST", `/files/${up.fileId}/confirm`)).status).toBeLessThan(300);
    for (let i = 0; i < 5 && (await readFileTexts(workPool, storage)); i++);
    await eventually(async () => has(await ask(minh, `${tag}supplier penalty two percent`), "file", up.fileId), "the attachment's words");
    // A personal task: Lan neither reads it nor finds its file.
    expect(has(await ask(lan, `${tag}supplier penalty two percent`), "file", up.fileId)).toBe(false);
    const before = (await search.query("SELECT updated_at FROM search.search_passages WHERE entity_type = 'file' AND entity_id = $1", [up.fileId])).rows[0];
    // The task goes to Lan: the file itself does not change, its readers do.
    const cur = (await w(minh, "GET", `/tasks/${task.id}`)).body.task;
    expect((await w(minh, "PATCH", `/tasks/${task.id}`, { expectedVersion: cur.version, assigneeId: "lan" })).status).toBeLessThan(300);
    await eventually(async () => has(await ask(lan, `${tag}supplier penalty two percent`), "file", up.fileId), "the attachment to follow its task's readers");
    expect((await search.query("SELECT updated_at FROM search.search_passages WHERE entity_type = 'file' AND entity_id = $1", [up.fileId])).rows[0]).toEqual(before);
    expect(has(await ask(huy, `${tag}supplier penalty two percent`), "file", up.fileId)).toBe(false);
  }, 90_000);

  it("whoever decides requests for the whole company finds a request they are not named on", async () => {
    const req = (await w(minh, "POST", "/approvals", { title: `Team offsite ${tag}`, details: `Two nights in ${tag}dalat for twelve people.`, approverId: "lan", kind: "other" }))
      .body;
    expect(req.id, JSON.stringify(req)).toBeTruthy();
    const director: Principal = { ...who("director"), grants: [...EMPLOYEE, ...T("approval.decide")] };
    await eventually(async () => has(await ask(director, `${tag}dalat twelve people`), "approval", req.id), "the request, for a decider");
    expect(has(await ask(huy, `${tag}dalat twelve people`), "approval", req.id)).toBe(false);
  }, 60_000);

  it("a full reindex rebuilds the passages from the work module's feeds", async () => {
    const task = (await w(minh, "POST", "/tasks", { title: `Order ${tag}toner`, description: "", assigneeId: "minh" })).body;
    await w(minh, "POST", `/tasks/${task.id}/comments`, { body: `Supplier says the ${tag}toner arrives on Friday.` });
    await eventually(async () => has(await ask(minh, `${tag}toner arrives Friday`), "task", task.id), "the comment");
    // The task's own events can still be in flight and write their passage back after a single delete.
    await eventually(async () => {
      await search.query("DELETE FROM search.search_passages");
      await new Promise((r) => setTimeout(r, 500));
      return (await ask(minh, `${tag}toner arrives Friday`)).length === 0;
    }, "the passages to stay deleted");
    const fetchPage = async (service: string, kind: string, after: string): Promise<FeedPage> =>
      service === "work"
        ? (await http(workUrl, service === "work" ? serviceP : serviceP, "GET", `/internal/search-feed/${kind}?after=${encodeURIComponent(after)}&limit=500`)).body
        : { events: [], next: null };
    const serviceP = service;
    const result = await reindex({ pool: search, fetchPage });
    expect(result.skipped).toBe(0);
    expect(result.indexed["work.knowledge-tasks"]).toBeGreaterThanOrEqual(2);
    expect(result.indexed["work.knowledge-approvals"]).toBe(2);
    const hit = (await ask(minh, `${tag}toner arrives Friday`)).find((h) => h.entity_id === task.id);
    expect(hit?.text).toContain("arrives on Friday");
  });
});
