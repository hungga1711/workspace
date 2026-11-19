import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { newId } from "@workspace/shared";
import { runExclusive, useJobLocks } from "../src/jobs.js";

// The server's setup: job locks on one direct owner connection, the module's pool left to the jobs.
const DIRECT = "postgres://workspace_owner:owner_pw@localhost:5432/workspace?options=-c%20search_path%3Dhome";
const pool = new pg.Pool({ connectionString: "postgres://workspace_home:app_pw@localhost:5432/workspace", max: 2 });
useJobLocks(DIRECT);
afterAll(() => pool.end());

// Locks are named per schema (all modules share one database): the home role's pool locks under "home".
const key = (name: string, schema = "home") => [`workspace.job:${schema}:${name}`];

describe("runExclusive with a direct lock connection", () => {
  it("skips while another replica (another session) holds the job, and runs once it lets go", async () => {
    const name = `test-${newId()}`;
    const other = new pg.Client({ connectionString: DIRECT });
    await other.connect();
    try {
      await other.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", key(name));
      let ran = 0;
      expect(await runExclusive(pool, name, async () => void ran++)).toBe(false);
      await other.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", key(name));
      expect(await runExclusive(pool, name, async () => void ran++)).toBe(true);
      expect(ran).toBe(1);
    } finally {
      await other.end();
    }
  });

  it("a job of the same name in another module's schema does not block this one", async () => {
    const name = `test-${newId()}`;
    const other = new pg.Client({ connectionString: DIRECT });
    await other.connect();
    try {
      await other.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", key(name, "work"));
      expect(await runExclusive(pool, name, async () => undefined)).toBe(true);
    } finally {
      await other.end();
    }
  });

  it("does not let the same process run a job twice at once (session locks are re-entrant)", async () => {
    const name = `test-${newId()}`;
    let release!: () => void;
    const first = runExclusive(pool, name, () => new Promise<void>((r) => (release = r)));
    await new Promise((r) => setTimeout(r, 50));
    expect(await runExclusive(pool, name, async () => undefined)).toBe(false);
    release();
    expect(await first).toBe(true);
  });

  it("runs a job of the same name for two modules at once (one process hosts every module)", async () => {
    const name = `test-${newId()}`;
    const work = new pg.Pool({ connectionString: "postgres://workspace_work:app_pw@localhost:5432/workspace", max: 1 });
    try {
      let release!: () => void;
      const home = runExclusive(pool, name, () => new Promise<void>((r) => (release = r)));
      await new Promise((r) => setTimeout(r, 50));
      expect(await runExclusive(work, name, async () => undefined)).toBe(true);
      release();
      expect(await home).toBe(true);
    } finally {
      await work.end();
    }
  });

  it("holds no pool connection while a job runs, so the job can use the whole pool", async () => {
    const name = `test-${newId()}`;
    const ran = await runExclusive(pool, name, async () => {
      // max: 2. A transaction-level lock would hold one of them for the whole run.
      await Promise.all([pool.query("SELECT pg_sleep(0.05)"), pool.query("SELECT pg_sleep(0.05)")]);
      expect(pool.totalCount - pool.idleCount).toBe(0);
    });
    expect(ran).toBe(true);
  });

  it("releases the lock when the job throws", async () => {
    const name = `test-${newId()}`;
    await expect(runExclusive(pool, name, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await runExclusive(pool, name, async () => undefined)).toBe(true);
  });
});
