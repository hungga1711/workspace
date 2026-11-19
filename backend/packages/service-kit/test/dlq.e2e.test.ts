import { describe, expect, it } from "vitest";
import pg from "pg";
import { newId } from "@workspace/shared";
import { consumeEvents, EventBus } from "../src/events.js";
import { replayRequestedDeadLetters } from "../src/dead-letters.js";
import { listDlq, readDlq, replayDlq } from "../src/ops/dlq.js";

/** The `dlq` tool over ai's dead_events table (dev stack), and the server's job that performs its replays. */
const SUPER = "postgres://postgres:postgres@localhost:5432/workspace?options=-c%20search_path%3Dai";
const OWNER = "postgres://workspace_owner:owner_pw@localhost:5432/workspace";
const stream = "workspace.ops.probe";

describe("DLQ tool", () => {
  it("lists what is waiting, shows why, and replays it to the failing group only, once", async () => {
    const group = `e2e-dlq-${newId().toLowerCase()}`;
    const eventId = newId();
    const sup = new pg.Client({ connectionString: SUPER });
    await sup.connect();
    const owner = new pg.Pool({ connectionString: OWNER, max: 2 });
    const bus = new EventBus();
    bus.start();
    const got: string[] = [];
    const bystander: string[] = [];
    const c = await consumeEvents({ bus, groupId: group, topics: [stream], handle: async (e) => void got.push(e.eventId) });
    const other = await consumeEvents({ bus, groupId: `${group}-other`, topics: [stream], handle: async (e) => void bystander.push(e.eventId) });
    try {
      const event = JSON.stringify({
        eventId,
        eventType: "ops.probe.sent.v1",
        version: 1,
        aggregateType: "ops.probe",
        aggregateId: newId(),
        actorId: "user:e2e",
        occurredAt: new Date().toISOString(),
        payload: { n: 1 },
      });
      await sup.query("INSERT INTO dead_events (consumer, stream, entry_id, event_id, event_type, reason, event) VALUES ($1, $2, '1-1', $3, 'ops.probe.sent.v1', 'db down', $4)", [
        group,
        stream,
        eventId,
        event,
      ]);

      expect((await listDlq(["ai"])).find((r) => r.consumer === group)).toMatchObject({ schema: "ai", stream, waiting: 1, total: 1 });
      const waiting = await readDlq({ schemas: ["ai"], consumer: group });
      expect(waiting).toHaveLength(1);
      expect(waiting[0]).toMatchObject({ reason: "db down", eventId, eventType: "ops.probe.sent.v1", replayedAt: null });

      expect(await replayDlq(group, { schemas: ["ai"], dryRun: true })).toBe(1);
      expect(await replayDlq(group, { schemas: ["ai"] })).toBe(1);
      expect(await replayDlq(group, { schemas: ["ai"] })).toBe(0); // already requested
      expect(got).toHaveLength(0); // the CLI only requests; the server delivers

      expect(await replayRequestedDeadLetters(bus, owner, ["ai"])).toBeGreaterThanOrEqual(1);
      expect(got).toEqual([eventId]);
      expect(bystander).toHaveLength(0);
      expect((await listDlq(["ai"])).find((r) => r.consumer === group)?.waiting).toBe(0);
      expect(await replayDlq(group, { schemas: ["ai"] })).toBe(0);
    } finally {
      await c.stop();
      await other.stop();
      await sup.query("DELETE FROM dead_events WHERE consumer = $1", [group]);
      await sup.end();
      await owner.end();
    }
  });
});
