import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { newId } from "@workspace/shared";

/** AI activity retention: the company's days (default 180), messages with their conversations. */
const owner = new pg.Pool({ connectionString: "postgres://workspace_owner:owner_pw@localhost:5432/workspace_test?options=-c%20search_path%3Dai", max: 2 });
const app = new pg.Pool({ connectionString: "postgres://workspace_ai:app_pw@localhost:5432/workspace_test", max: 2 });
afterAll(async () => {
  await owner.end();
  await app.end();
});

async function seed(daysAgo: number) {
  const id = newId();
  const at = new Date(Date.now() - daysAgo * 86400_000);
  await owner.query("INSERT INTO ai_conversations (id, user_id, source, started_at, last_at) VALUES ($1,'u','company',$2,$2)", [id, at]);
  await owner.query("INSERT INTO ai_messages (id, conversation_id, role, content, at) VALUES ($1,$2,'user','x',$3)", [newId(), id, at]);
  return id;
}

async function ids(table: "ai_conversations" | "ai_messages", column: string, among: string[]) {
  return (await owner.query(`SELECT ${column} AS id FROM ${table} WHERE ${column} = ANY($1)`, [among])).rows.map((x) => x.id as string);
}

async function seedSide(daysAgo: number) {
  const at = new Date(Date.now() - daysAgo * 86400_000);
  const id = newId();
  await owner.query("INSERT INTO ai_content_views (id, viewer_id, user_id, conversation_id, at) VALUES ($1,'v','u','c',$2)", [id, at]);
  await owner.query("INSERT INTO ai_safety_events (id, user_id, source, action, kinds, count, at) VALUES ($1,'u','chatgpt','warn','{card}',1,$2)", [id, at]);
  await owner.query("INSERT INTO ai_audit (id, actor_id, tool, allowed, input, at) VALUES ($1,'u','t',true,'{}',$2)", [id, at]);
  return id;
}

describe("ai_prune_views / ai_prune_safety / ai_prune_audit", () => {
  it("delete rows older than the days given, in batches of lim, and leave the rest", async () => {
    const old1 = await seedSide(400);
    const old2 = await seedSide(380);
    const young = await seedSide(10);
    // Old rows of earlier test runs go too: only the batch size and the end are fixed.
    for (const fn of ["ai_prune_views", "ai_prune_safety", "ai_prune_audit"]) {
      expect((await app.query(`SELECT ${fn}(365, 1) AS n`)).rows[0].n).toBe(1);
      let n = 0;
      for (let i = 0; i < 50 && (i === 0 || n > 0); i++) n = (await app.query(`SELECT ${fn}(365, 1000) AS n`)).rows[0].n;
      expect(n).toBe(0);
    }
    for (const table of ["ai_content_views", "ai_safety_events", "ai_audit"])
      expect((await owner.query(`SELECT id FROM ${table} WHERE id = ANY($1)`, [[old1, old2, young]])).rows.map((r) => r.id)).toEqual([young]);
  });
});

describe("ai_prune_expired", () => {
  it("keeps 180 days until the company sets its own retention, then keeps that", async () => {
    await owner.query("DELETE FROM ai_policy");
    const mid = await seed(40);
    const old = await seed(200);
    await app.query("SELECT ai_prune_expired(10000)");
    expect(await ids("ai_conversations", "id", [mid, old])).toEqual([mid]);
    expect(await ids("ai_messages", "conversation_id", [old])).toEqual([]);

    await owner.query("INSERT INTO ai_policy (retention_days) VALUES (30) ON CONFLICT (singleton) DO UPDATE SET retention_days = 30");
    const young = await seed(10);
    await app.query("SELECT ai_prune_expired(10000)");
    expect(await ids("ai_conversations", "id", [mid, young])).toEqual([young]);
    expect(await ids("ai_messages", "conversation_id", [mid])).toEqual([]);
    await owner.query("DELETE FROM ai_policy");
  });
});
