import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { newId } from "../src/ids.js";
import { getRequestContext, MissingRequestContextError, runWithContext } from "../src/context.js";
import { withTransaction } from "../src/transaction.js";
import { appPool, resetSchema } from "./db.js";

let pool: pg.Pool;

beforeAll(async () => {
  await resetSchema();
  pool = appPool(1);
  await withTransaction(pool, (c) => c.query("INSERT INTO test_tasks (id, title) VALUES ($1, 'A1')", [newId()]));
});

afterAll(async () => {
  await pool?.end();
});

const titles = () => withTransaction(pool, async (c) => (await c.query<{ title: string }>("SELECT title FROM test_tasks ORDER BY title")).rows.map((r) => r.title));

describe("withTransaction", () => {
  it("commits what fn wrote", async () => {
    expect(await titles()).toEqual(["A1"]);
  });

  it("rolls back the whole transaction when fn throws", async () => {
    await expect(
      withTransaction(pool, async (c) => {
        await c.query("INSERT INTO test_tasks (id, title) VALUES ($1, 'A2')", [newId()]);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await titles()).toEqual(["A1"]);
  });

  it("returns the connection to the pool after a failure", async () => {
    await expect(withTransaction(pool, () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(await titles()).toEqual(["A1"]);
  });
});

describe("request context", () => {
  it("is bound for the duration of fn", () => {
    const requestId = newId();
    expect(runWithContext({ actorId: "user:test", requestId }, () => getRequestContext())).toEqual({ actorId: "user:test", requestId });
  });

  it("is missing outside runWithContext", () => {
    expect(() => getRequestContext()).toThrow(MissingRequestContextError);
  });
});
