import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { newId, runWithContext, withTransaction } from "@workspace/shared";
import { EventBus, indexDocs, migrate, publishEvents, searchPool, type EventConsumer } from "@workspace/service-kit";
import { startIndexer } from "../../src/modules/search/indexer.js";
import { reindex, type FetchPage } from "../../src/modules/search/reindex.js";

const pool = searchPool("postgres://workspace_search:app_pw@localhost:5432/workspace_test");
const bus = new EventBus();
bus.start();
const until = async (pred: () => Promise<boolean>, ms = 60_000) => {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 300));
  }
};
const tx = <T>(fn: Parameters<typeof withTransaction<T>>[1]) => runWithContext({ actorId: "test", requestId: "t" }, () => withTransaction(pool, fn));
const exists = (type: string, id: string) =>
  tx(async (c) => (await c.query("SELECT 1 FROM search_documents WHERE entity_type = $1 AND entity_id = $2", [type, id])).rowCount === 1);

beforeAll(async () => {
  await migrate("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test", fileURLToPath(new URL("../../migrations/search", import.meta.url)), "search");
});

const task = (taskId: string, title: string) => ({
  taskId,
  code: "T-9",
  title,
  description: "",
  ownerId: "u1",
  assigneeId: null,
  projectId: null,
  status: "todo",
  priority: "normal",
  dueAt: null,
  labels: [],
  version: 1,
  blockedReason: null,
  source: null,
});

let running: EventConsumer | undefined;
afterAll(async () => {
  await running?.stop();
  await pool.end();
});

describe("search-indexer on the shared consumer loop", () => {
  it("indexes a task event delivered on the bus", async () => {
    running = await startIndexer(bus, pool, `e2e-indexer-${newId()}`);
    // Invalid payloads are covered on the probe topic in service-kit's events.e2e.test.ts.
    const good = newId();
    const envelope = (taskId: string, payload: unknown) =>
      JSON.stringify({
        eventId: newId(),
        eventType: "work.task.created.v1",
        version: 1,
        aggregateType: "work.task",
        aggregateId: taskId,
        actorId: "user:e2e",
        occurredAt: new Date().toISOString(),
        payload,
      });
    await publishEvents(bus, [{ topic: "workspace.work.task", event: envelope(good, task(good, "Gửi báo giá cho khách")) }]);
    await until(() => exists("task", good));
  });
});

describe("reindex", () => {
  it("rebuilds the index from the feeds: stale documents go, invalid rows are skipped", async () => {
    const stale = newId();
    await tx((c) =>
      indexDocs(c, [
        {
          entity_type: "task",
          entity_id: stale,
          container_id: "x",
          title: "deleted long ago",
          body: "",
          url: "/",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ]),
    );
    const [t1, t2, m1] = [newId(), newId(), newId()];
    const at = new Date().toISOString();
    const fetchPage: FetchPage = async (service, kind, after) => {
      if (service === "work" && kind === "tasks")
        return after === ""
          ? { events: [{ eventType: "work.task.updated.v1", aggregateType: "work.task", aggregateId: t1, occurredAt: at, payload: task(t1, "Một") }], next: t1 }
          : {
              events: [
                { eventType: "work.task.updated.v1", aggregateType: "work.task", aggregateId: t2, occurredAt: at, payload: task(t2, "Hai") },
                { eventType: "work.task.updated.v1", aggregateType: "work.task", aggregateId: "broken", occurredAt: at, payload: { taskId: "broken" } as never },
              ],
              next: null,
            };
      if (service === "chat" && kind === "messages")
        return {
          events: [
            {
              eventType: "chat.message.created.v1",
              aggregateType: "chat.message",
              aggregateId: m1,
              occurredAt: at,
              payload: {
                messageId: m1,
                channelId: "c1",
                channelKind: "public",
                channelName: "chung",
                seq: 1,
                threadRootId: null,
                authorId: "u1",
                authorType: "user",
                body: "hợp đồng",
                mentions: [],
                attachments: [{ fileId: "f1", name: "hop-dong.pdf", contentType: "application/pdf", size: 10 }],
                recipients: [],
                quiet: [],
                everyMessage: [],
              },
            },
          ],
          next: null,
        };
      return { events: [], next: null };
    };
    const r = await reindex({ pool, fetchPage });
    expect(r.indexed["work.tasks"]).toBe(2);
    expect(r.indexed["chat.messages"]).toBe(2); // the message and its file
    expect(r.skipped).toBe(1);
    expect(await exists("task", t1)).toBe(true);
    expect(await exists("task", t2)).toBe(true);
    expect(await exists("file", "f1")).toBe(true);
    expect(await exists("task", stale)).toBe(false);
  });
});
