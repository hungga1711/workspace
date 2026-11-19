import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { newId } from "../src/ids.js";
import { runWithContext } from "../src/context.js";
import { withTransaction } from "../src/transaction.js";
import { appendToOutbox, MissingRequestIdError } from "../src/outbox.js";
import { appPool, resetSchema, SUPER_URL } from "./db.js";

let pool: pg.Pool;
let sup: pg.Client;

// A registered event (the pipeline probe), so only the behaviour under test can fail.
const event = () => ({
  eventId: newId(),
  eventType: "ops.probe.sent.v1" as const,
  version: 1,
  aggregateType: "ops.probe",
  aggregateId: newId(),
  actorId: "user:test",
  occurredAt: new Date().toISOString(),
  payload: { n: 1 },
});
const inRequest = (fn: (c: pg.PoolClient) => Promise<void>) => runWithContext({ actorId: "user:test", requestId: newId() }, () => withTransaction(pool, fn));

/** No request context at all: the outbox must refuse before writing. */
async function withoutRequest() {
  const c = await pool.connect();
  try {
    await appendToOutbox(c, event());
  } finally {
    c.release();
  }
}

/** Outbox rows written since the last read, as the relay will see them (read as superuser). */
async function newOutboxRows(): Promise<string[]> {
  const { rows } = await sup.query<{ payload: unknown }>("DELETE FROM outbox RETURNING payload");
  return rows.map((r) => JSON.stringify(r.payload));
}

beforeAll(async () => {
  await resetSchema();
  pool = appPool(1);
  sup = new pg.Client({ connectionString: SUPER_URL });
  await sup.connect();
});

beforeEach(async () => {
  await newOutboxRows(); // drain
});

afterAll(async () => {
  await sup?.end();
  await pool?.end();
});

describe("appendToOutbox", () => {
  it("keeps the committed event in the outbox, unpublished, for the relay", async () => {
    const e = event();
    await runWithContext({ actorId: "user:test", requestId: newId() }, () => withTransaction(pool, (c) => appendToOutbox(c, e)));
    const { rows } = await sup.query<{ id: string; published_at: Date | null; type: string }>("SELECT id, published_at, type FROM outbox");
    expect(rows).toEqual([{ id: e.eventId, published_at: null, type: "ops.probe.sent.v1" }]);
    const out = await newOutboxRows();
    expect(out).toHaveLength(1);
    expect(out[0]).toContain(e.eventId);
  });

  it("stamps the event with the request id of the current request", async () => {
    const e = event();
    const requestId = newId();
    await runWithContext({ actorId: "user:test", requestId }, () => withTransaction(pool, (c) => appendToOutbox(c, e)));
    const out = await newOutboxRows();
    expect(out[0]).toMatch(new RegExp(`"requestId": ?"${requestId}"`));
  });

  it("emits nothing when the business transaction rolls back", async () => {
    await expect(
      runWithContext({ actorId: "user:test", requestId: newId() }, () =>
        withTransaction(pool, async (c) => {
          await appendToOutbox(c, event());
          throw new Error("business rule failed");
        }),
      ),
    ).rejects.toThrow("business rule failed");
    expect(await newOutboxRows()).toEqual([]);
  });

  it("refuses to publish an event without a request id", async () => {
    await expect(withoutRequest()).rejects.toThrow(MissingRequestIdError);
  });

  it("rejects an unregistered event type before touching the database", async () => {
    const bad = { ...event(), eventType: "task.created" as "ops.probe.sent.v1" };
    await expect(inRequest((c) => appendToOutbox(c, bad))).rejects.toThrow(/not registered in @workspace\/contracts/);
    expect(await newOutboxRows()).toEqual([]);
  });

  it("rejects a payload that does not match the event's schema, naming the field", async () => {
    const bad = { ...event(), payload: { n: "one" } as unknown as { n: number } };
    await expect(inRequest((c) => appendToOutbox(c, bad))).rejects.toThrow(/ops\.probe\.sent\.v1: n:/);
  });

  it("rejects an event routed to another topic than its registered one", async () => {
    await expect(inRequest((c) => appendToOutbox(c, { ...event(), aggregateType: "work.task" }))).rejects.toThrow(/aggregateType must be ops.probe/);
  });
});
