import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migrate } from "@workspace/service-kit";
import { newId } from "@workspace/shared";
import { runHomeRetention } from "../../src/modules/home/retention.js";

/** The retention job, run as the module role: old rows go, recent ones stay, and a backlog drains in batches. */
// Its own person: other suites leave Home rows in the shared test database.
const LAN = `lan-${newId()}`;
let owner: pg.Client;
let service: pg.Pool;

const OLD = "now() - interval '400 days'";
const NEW = "now() - interval '1 day'";

async function seed() {
  for (const [id, readAt, at] of [
    ["read-old", OLD, OLD],
    ["unread-old", "NULL", OLD],
    ["read-new", NEW, NEW],
    ["unread-new", "NULL", NEW],
  ])
    await owner.query(
      `INSERT INTO notifications (user_id, id, grp, kind, title, url, read_at, created_at) VALUES ($1, $2, 'action', 'task.assigned', 't', '/x', ${readAt}, ${at})`,
      [LAN, id],
    );
  for (const [ref, resolvedAt] of [
    ["done-old", OLD],
    ["done-new", NEW],
    ["open", "NULL"],
  ])
    await owner.query(`INSERT INTO home_items (user_id, kind, ref_id, title, url, needs_action, resolved_at) VALUES ($1, 'task', $2, 't', '/x', true, ${resolvedAt})`, [LAN, ref]);
  for (const [key, at] of [
    ["old", OLD],
    ["new", NEW],
  ]) {
    await owner.query(`INSERT INTO activity (user_id, key, kind, title, url, actor_id, created_at) VALUES ($1, $2, 'task_done', 't', '/x', 'minh', ${at})`, [LAN, key]);
    await owner.query(`INSERT INTO push_recent (user_id, key, at) VALUES ($1, $2, ${at})`, [LAN, key]);
  }
}

const ids = async (sql: string): Promise<string[]> => (await owner.query<{ id: string }>(sql, [LAN])).rows.map((r) => r.id).sort();

beforeAll(async () => {
  await migrate("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test", fileURLToPath(new URL("../../migrations/home", import.meta.url)), "home");
  owner = new pg.Client("postgres://workspace_owner:owner_pw@localhost:5432/workspace_test?options=-c%20search_path%3Dhome");
  await owner.connect();
  service = new pg.Pool({ connectionString: "postgres://workspace_home:app_pw@localhost:5432/workspace_test", max: 2 });
  await seed();
});

afterAll(async () => {
  await owner.end();
  await service.end();
});

describe("home retention", () => {
  it("prunes old rows through the prune functions and keeps recent ones", async () => {
    const deleted = await runHomeRetention(service, { notificationsRead: 90, notificationsUnread: 180, homeItems: 180, activity: 365, pushRecent: 30 }, 1000);
    // Two notifications, one home item, one activity row, one push_recent row.
    expect(deleted).toBeGreaterThanOrEqual(5);
    expect(await ids("SELECT id FROM notifications WHERE user_id = $1")).toEqual(["read-new", "unread-new"]);
    expect(await ids("SELECT ref_id AS id FROM home_items WHERE user_id = $1")).toEqual(["done-new", "open"]);
    expect(await ids("SELECT key AS id FROM activity WHERE user_id = $1")).toEqual(["new"]);
    expect(await ids("SELECT key AS id FROM push_recent WHERE user_id = $1")).toEqual(["new"]);
  });

  it("drains a backlog in batches instead of one statement", async () => {
    for (let i = 0; i < 7; i++)
      await owner.query(`INSERT INTO activity (user_id, key, kind, title, url, actor_id, created_at) VALUES ($1, $2, 'task_done', 't', '/x', 'minh', ${OLD})`, [
        LAN,
        `backlog-${i}`,
      ]);
    // Batches of 2, at most 3 batches: 6 go now, the seventh waits for the next run.
    expect(await runHomeRetention(service, { notificationsRead: 90, notificationsUnread: 180, homeItems: 180, activity: 365, pushRecent: 30 }, 2, 3)).toBe(6);
    expect((await ids("SELECT key AS id FROM activity WHERE user_id = $1 AND key LIKE 'backlog-%'")).length).toBe(1);
  });
});
