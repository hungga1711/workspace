import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { newId, withTransaction } from "@workspace/shared";
import { pruneDeadEvents, pruneProcessedEvents, runExclusive, scheduleJob } from "../src/jobs.js";

// Without useJobLocks(): transaction-level locks on the module pool, the path that stays safe behind PgBouncer.
const pool = new pg.Pool({ connectionString: "postgres://workspace_home:app_pw@localhost:5432/workspace", max: 4 });
afterAll(() => pool.end());

describe("runExclusive", () => {
  it("lets one replica run a job while another skips it", async () => {
    const name = `test-${newId()}`;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let ran = 0;
    const first = runExclusive(pool, name, async () => {
      ran++;
      await held;
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(await runExclusive(pool, name, async () => void ran++)).toBe(false);
    release();
    expect(await first).toBe(true);
    // Free again once the first run committed.
    expect(await runExclusive(pool, name, async () => void ran++)).toBe(true);
    expect(ran).toBe(2);
  });

  it("releases the lock when the job throws", async () => {
    const name = `test-${newId()}`;
    await expect(runExclusive(pool, name, () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await runExclusive(pool, name, async () => undefined)).toBe(true);
  });
});

describe("scheduleJob", () => {
  it("runs on its interval, skips ticks while `when` is false, and stops", async () => {
    let runs = 0;
    let open = false;
    const stop = scheduleJob(`test-${newId()}`, 50, async () => void runs++, { pool, firstRunMs: 0, when: () => open });
    await new Promise((r) => setTimeout(r, 150));
    expect(runs).toBe(0);
    open = true;
    await new Promise((r) => setTimeout(r, 200));
    stop();
    const seen = runs;
    expect(seen).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 150));
    expect(runs).toBe(seen);
  });
});

describe("pruneProcessedEvents", () => {
  it("deletes ledger rows past retention and keeps recent ones", async () => {
    const owner = new pg.Client({ connectionString: "postgres://workspace_owner:owner_pw@localhost:5432/workspace?options=-c%20search_path%3Dhome" });
    await owner.connect();
    const consumer = `test-prune-${newId()}`;
    const [t1, t2] = [newId(), newId()];
    // Written by the module role, then aged by the owner.
    for (const t of [t1, t2])
      await withTransaction(pool, (c) => c.query("INSERT INTO processed_events (consumer, event_id) VALUES ($1, $2), ($1, $3)", [consumer, `old-${t}`, `new-${t}`]));
    try {
      // A shared test database collects old ledger rows from earlier runs; clear them first so the one-row batches
      // below (at most 20) reach this test's rows.
      await pruneProcessedEvents(pool, 1);
      await owner.query("UPDATE processed_events SET processed_at = now() - interval '40 days' WHERE consumer = $1 AND event_id LIKE 'old-%'", [consumer]);
      // Asking for less than the redelivery window still keeps 8 days.
      await owner.query("UPDATE processed_events SET processed_at = now() - interval '5 days' WHERE consumer = $1 AND event_id LIKE 'new-%'", [consumer]);
      expect(await pruneProcessedEvents(pool, 1, 1)).toBeGreaterThanOrEqual(2);
      const left = (await owner.query<{ event_id: string }>("SELECT event_id FROM processed_events WHERE consumer = $1 ORDER BY event_id", [consumer])).rows.map((r) => r.event_id);
      expect(left).toEqual([`new-${t1}`, `new-${t2}`].sort());
      await owner.query("DELETE FROM processed_events WHERE consumer = $1", [consumer]);
    } finally {
      await owner.end();
    }
  });
});

describe("pruneDeadEvents", () => {
  it("drops dead letters older than the retention, through the owner connection as the maintenance role", async () => {
    const OWNER = "postgres://workspace_owner:owner_pw@localhost:5432/workspace";
    const owner = new pg.Client({ connectionString: `${OWNER}?options=-c%20search_path%3Dhome` });
    await owner.connect();
    const consumer = `test-dead-${newId()}`;
    try {
      // The app role may only insert (as the consumer does when a handler gives up).
      for (const age of ["old", "new"])
        await pool.query("INSERT INTO dead_events (consumer, stream, entry_id, event_type, reason, event) VALUES ($1, 's', $2, 'x', 'test', '{}')", [
          consumer,
          `${age}-${newId()}`,
        ]);
      await owner.query("UPDATE dead_events SET failed_at = now() - interval '100 days' WHERE consumer = $1 AND entry_id LIKE 'old-%'", [consumer]);
      expect(await pruneDeadEvents(pool, OWNER, 90, 1)).toBeGreaterThanOrEqual(1);
      const left = (await owner.query<{ entry_id: string }>("SELECT entry_id FROM dead_events WHERE consumer = $1", [consumer])).rows.map((r) => r.entry_id);
      expect(left).toHaveLength(1);
      expect(left[0]).toMatch(/^new-/);
    } finally {
      await owner.query("DELETE FROM dead_events WHERE consumer = $1", [consumer]);
      await owner.end();
    }
  });
});
