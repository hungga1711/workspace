import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { appendToOutbox, currentRequestId, getRequestContext, newId, runWithContext, withTransaction } from "@workspace/shared";
import type { EventEnvelope } from "@workspace/contracts";
import { CONSUMER_GROUPS } from "@workspace/contracts";
import { consumeEvents, EventBus, publishEvents, startConsumer, type EventConsumer } from "../src/events.js";
import { replayRequestedDeadLetters } from "../src/dead-letters.js";
import { migrate } from "../src/migrate.js";
import { pruneOutbox, startOutboxRelay, type OutboxRelay } from "../src/outbox-relay.js";
import { replayFromOutbox } from "../src/ops/dlq.js";

/**
 * The event pipeline against the dev stack's Postgres, delivered in this process (EventBus). It uses its own
 * schema, a copy of ai's (outbox, processed_events, dead_events, the relay functions), reached as ai's role, so no
 * other relay (a running dev server) delivers its outbox. Each run uses new consumer groups and ignores events it
 * did not make (what earlier runs left there).
 */
const SCHEMA = "events_e2e";
const path = `?options=-c%20search_path%3D${SCHEMA}%2Cpublic`;
const APP = `postgres://workspace_ai:app_pw@localhost:5432/workspace${path}`;
const OWNER = `postgres://workspace_owner:owner_pw@localhost:5432/workspace${path}`;
const SUPER = `postgres://postgres:postgres@localhost:5432/workspace${path}`;

/** Creates the test schema once: ai's baseline under another name (baselines are schema-agnostic). */
async function setUpDatabase() {
  await migrate("postgres://workspace_owner:owner_pw@localhost:5432/workspace", fileURLToPath(new URL("../../../server/migrations/ai", import.meta.url)), SCHEMA);
}
const aggType = "ops.probe";
const topic = `workspace.${aggType}`;
const run = newId().toLowerCase().slice(-8);
/** Events this run made: the handlers ignore the rest. */
const ours = new Set<string>();
const group = `e2e-probe-${run}`;
let pool: pg.Pool;
let sup: pg.Client;
const bus = new EventBus();
bus.start();
let consumer: EventConsumer;
let relay: OutboxRelay;
const handled: { event: EventEnvelope; actorInContext: string; requestIdInContext: string | undefined }[] = [];

const until = async (pred: () => boolean | Promise<boolean>, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
};

const ev = (payload: Record<string, unknown>, eventType = "ops.probe.sent.v1"): EventEnvelope & { eventType: "ops.probe.sent.v1" } => {
  const eventId = newId();
  ours.add(eventId);
  return {
    eventId,
    eventType: eventType as "ops.probe.sent.v1",
    version: 1,
    aggregateType: aggType,
    aggregateId: newId(),
    actorId: "user:e2e",
    occurredAt: new Date().toISOString(),
    payload: payload as { n?: number },
  };
};
const commit = (e: EventEnvelope, requestId = newId()) =>
  runWithContext({ actorId: "user:e2e", requestId }, () => withTransaction(pool, (c) => appendToOutbox(c, e as EventEnvelope & { eventType: "ops.probe.sent.v1" })));
const publishedAt = async (id: string) => (await sup.query<{ published_at: Date | null }>("SELECT published_at FROM outbox WHERE id = $1", [id])).rows[0]?.published_at ?? null;
const deadFor = async (g: string) =>
  (await sup.query<{ reason: string; event_id: string | null; event: string }>("SELECT reason, event_id, event FROM dead_events WHERE consumer = $1 ORDER BY id", [g])).rows;

beforeAll(async () => {
  await setUpDatabase();
  pool = new pg.Pool({ connectionString: APP, max: 4 });
  sup = new pg.Client({ connectionString: SUPER });
  await sup.connect();
  consumer = await startConsumer({
    bus,
    groupId: group,
    topics: [topic],
    pool,
    maxAttempts: 2,
    handle: async (event) => {
      if (!ours.has(event.eventId)) return;
      handled.push({ event, actorInContext: getRequestContext().actorId, requestIdInContext: currentRequestId() });
      if (event.payload.fail) throw new Error("handler failure");
    },
  });
  relay = startOutboxRelay({ pool, bus, listenUrl: OWNER });
});

afterAll(async () => {
  await consumer?.stop();
  await relay?.stop();
  await sup?.query("DELETE FROM dead_events WHERE consumer LIKE $1", [`%${run}%`]);
  await sup?.end();
  await pool?.end();
});

describe("outbox → relay → event bus → consumer", () => {
  it("delivers a committed outbox event with its actor bound, and marks the row published", async () => {
    const e = ev({ n: 1 });
    await commit(e);
    await until(() => handled.some((h) => h.event.eventId === e.eventId));
    const h = handled.find((x) => x.event.eventId === e.eventId)!;
    expect(h.actorInContext).toBe("user:e2e");
    expect(h.event.payload).toEqual({ n: 1 });
    await until(async () => (await publishedAt(e.eventId)) !== null);
  });

  it("is woken by NOTIFY: an event arrives well inside the 1 s fallback poll", async () => {
    const e = ev({ n: 12 });
    const t0 = Date.now();
    await commit(e);
    await until(() => handled.some((h) => h.event.eventId === e.eventId));
    expect(Date.now() - t0).toBeLessThan(900);
  });

  it("carries the producing request id to the consumer and handles the event under it", async () => {
    const e = ev({ n: 10 });
    const requestId = newId();
    await commit(e, requestId);
    await until(() => handled.some((h) => h.event.eventId === e.eventId));
    const h = handled.find((x) => x.event.eventId === e.eventId)!;
    expect(h.event.requestId).toBe(requestId);
    expect(h.requestIdInContext).toBe(requestId);
  });

  it("falls back to the event id for events published before requestId existed", async () => {
    const legacy = ev({ n: 11 });
    await publishEvents(bus, [{ topic, event: legacy }]);
    expect(handled.find((x) => x.event.eventId === legacy.eventId)!.requestIdInContext).toBe(legacy.eventId);
  });

  it("handles a duplicate delivery once", async () => {
    const e = ev({ n: 2 });
    await commit(e);
    await until(() => handled.some((h) => h.event.eventId === e.eventId));
    await publishEvents(bus, [{ topic, event: e }]);
    expect(handled.filter((h) => h.event.eventId === e.eventId)).toHaveLength(1);
  });

  it("dead-letters malformed, invalid and repeatedly failing events into dead_events without blocking", async () => {
    const failing = ev({ fail: true });
    const invalid = ev({ n: "four" });
    const after = ev({ n: 4 });
    await publishEvents(bus, [
      { topic, event: `{not json ${run}` },
      { topic, event: failing },
      { topic, event: invalid },
      { topic, event: after },
    ]);
    expect(handled.some((h) => h.event.eventId === after.eventId)).toBe(true);
    const dead = (await deadFor(group)).filter((r) => r.event.includes(run) || r.event_id === failing.eventId || r.event_id === invalid.eventId);
    expect(dead.some((r) => r.reason.startsWith("malformed") && r.event.includes(run))).toBe(true);
    expect(dead.some((r) => r.reason === "handler failure" && r.event_id === failing.eventId)).toBe(true);
    expect(dead.some((r) => r.reason.startsWith("invalid: ops.probe.sent.v1: n:") && r.event_id === invalid.eventId)).toBe(true);
    expect(handled.some((h) => h.event.eventId === invalid.eventId)).toBe(false);
  });

  it("hands over event types this build does not know (a newer producer mid-upgrade)", async () => {
    const future = ev({ n: 5 }, "ops.probe.sent.v2");
    await publishEvents(bus, [{ topic, event: { ...future, version: 2 } }]);
    expect(handled.some((h) => h.event.eventId === future.eventId)).toBe(true);
  });
});

describe("concurrency", () => {
  it("handles a group's events one at a time, in order", async () => {
    const g = `e2e-order-${run}`;
    let running = 0;
    let maxRunning = 0;
    const done: string[] = [];
    const c = await consumeEvents({
      bus,
      groupId: g,
      topics: [topic],
      handle: async (event) => {
        if (!ours.has(event.eventId)) return;
        maxRunning = Math.max(maxRunning, ++running);
        await new Promise((r) => setTimeout(r, 20));
        running--;
        done.push(event.eventId);
      },
    });
    try {
      const evs = Array.from({ length: 8 }, () => ev({ n: 60 }));
      await publishEvents(
        bus,
        evs.map((e) => ({ topic, event: e })),
      );
      expect(maxRunning).toBe(1);
      expect(done).toEqual(evs.map((e) => e.eventId));
    } finally {
      await c.stop();
    }
  });
});

describe("delivery guarantees", () => {
  it("marks an outbox row only once every group reading it has handled it", async () => {
    const g = `e2e-slow-${run}`;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = ev({ n: 30 });
    const seen: string[] = [];
    const c = await consumeEvents({
      bus,
      groupId: g,
      topics: [topic],
      handle: async (event) => {
        if (event.eventId !== slow.eventId) return;
        seen.push(event.eventId);
        await gate;
      },
    });
    try {
      await commit(slow);
      await until(() => seen.includes(slow.eventId) && handled.some((h) => h.event.eventId === slow.eventId));
      await new Promise((r) => setTimeout(r, 300));
      expect(await publishedAt(slow.eventId)).toBeNull();
      release();
      await until(async () => (await publishedAt(slow.eventId)) !== null);
    } finally {
      release();
      await c.stop();
    }
  });

  it("delivers nothing before the bus's start gate opens, then everything waiting", async () => {
    await relay.stop(); // the started bus's relay would take the row first
    const gated = new EventBus();
    const got: string[] = [];
    const c = await consumeEvents({
      bus: gated,
      groupId: `e2e-gate-${run}`,
      topics: [topic],
      handle: async (event) => void got.push(event.eventId),
    });
    const r = startOutboxRelay({ pool, bus: gated, listenUrl: OWNER, pollMs: 100 });
    try {
      const e = ev({ n: 31 });
      await commit(e);
      await new Promise((res) => setTimeout(res, 500));
      expect(got).not.toContain(e.eventId);
      expect(await publishedAt(e.eventId)).toBeNull();
      gated.start();
      await until(() => got.includes(e.eventId));
      await until(async () => (await publishedAt(e.eventId)) !== null);
    } finally {
      await r.stop();
      await c.stop();
      relay = startOutboxRelay({ pool, bus, listenUrl: OWNER });
    }
  });

  it("refuses to start the server's bus while a registered consumer group has no handler", () => {
    const strict = new EventBus();
    expect(() => strict.start({ requireAllGroups: true })).toThrow(/without a handler/);
    const any = Object.keys(CONSUMER_GROUPS)[0]!;
    expect(() => strict.start({ requireAllGroups: true })).toThrow(new RegExp(any));
  });

  it("a relay stopped before the gate opened stops at once", async () => {
    const never = new EventBus();
    const r = startOutboxRelay({ pool, bus: never, pollMs: 100 });
    await r.stop();
  });
});

describe("retention and replay", () => {
  it("prunes published outbox rows past the retention and keeps unpublished ones", async () => {
    const old = ev({ n: 40 });
    await commit(old);
    await until(async () => (await publishedAt(old.eventId)) !== null);
    await relay.stop(); // or it would deliver (mark) the unpublished row below
    const stuck = newId();
    await sup.query(
      `INSERT INTO outbox (id, aggregatetype, aggregateid, type, payload, created_at) VALUES ($1, 'ops.prune-test', 'x', 'ops.probe.sent.v1', '{}', now() - interval '10 days')`,
      [stuck],
    );
    await sup.query("UPDATE outbox SET created_at = now() - interval '10 days' WHERE id = $1", [old.eventId]);
    expect(await pruneOutbox(pool, 3)).toBeGreaterThanOrEqual(1);
    expect((await sup.query("SELECT 1 FROM outbox WHERE id = $1", [old.eventId])).rowCount).toBe(0);
    expect((await sup.query("SELECT 1 FROM outbox WHERE id = $1", [stuck])).rowCount).toBe(1);
    await sup.query("DELETE FROM outbox WHERE id = $1", [stuck]);
    relay = startOutboxRelay({ pool, bus, listenUrl: OWNER });
  });

  it("replays kept outbox events to one group only, through a request the server performs", async () => {
    const e = ev({ n: 50 });
    await commit(e);
    await until(() => handled.some((h) => h.event.eventId === e.eventId));
    const other = `e2e-replay-${run}`;
    const seenByOther: string[] = [];
    const c = await consumeEvents({
      bus,
      groupId: other,
      topics: [topic],
      handle: async (event) => {
        if (ours.has(event.eventId)) seenByOther.push(event.eventId);
      },
    });
    const owner = new pg.Pool({ connectionString: OWNER, max: 2 });
    try {
      const before = handled.filter((h) => h.event.eventId === e.eventId).length;
      const filter = { schema: SCHEMA, group: other, types: ["ops.probe.sent.v1"], since: new Date(Date.now() - 60_000) };
      const n = await replayFromOutbox({ ...filter, dryRun: true });
      expect(n).toBeGreaterThanOrEqual(1);
      expect(await replayFromOutbox(filter)).toBe(n);
      expect(seenByOther).not.toContain(e.eventId); // only requested so far
      expect(await replayRequestedDeadLetters(bus, owner, [SCHEMA])).toBeGreaterThanOrEqual(n);
      expect(seenByOther).toContain(e.eventId);
      // The main group skipped the replay addressed to `other`, and nothing is left requested.
      expect(handled.filter((h) => h.event.eventId === e.eventId)).toHaveLength(before);
      expect(await replayRequestedDeadLetters(bus, owner, [SCHEMA])).toBe(0);
    } finally {
      await owner.end();
      await c.stop();
    }
  });
});
