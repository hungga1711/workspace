import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migrate } from "@workspace/service-kit";
import { newId } from "@workspace/shared";
import { pruneRetention } from "../../src/modules/platform/retention.js";

// The job runs as the app role through SECURITY DEFINER prune functions. Rows are written by the app role, aged by
// the owner, and tagged with this run's id so other suites' rows on the test database are left alone.
const OWNER = "postgres://workspace_owner:owner_pw@localhost:5432/workspace_test";
const pool = new pg.Pool({ connectionString: "postgres://workspace_platform:app_pw@localhost:5432/workspace_test", max: 2 });
const owner = new pg.Client({ connectionString: `${OWNER}?options=-c%20search_path%3Dplatform` });
const tag = newId();
const hook = `h-${newId()}`;

beforeAll(async () => {
  await migrate(OWNER, fileURLToPath(new URL("../../migrations/platform", import.meta.url)), "platform");
  await owner.connect();
  for (const age of ["old", "new"])
    await pool.query("INSERT INTO audit_log (id, actor, action, resource, resource_id, source) VALUES ($1, 'u1', 'test', 'thing', $2, 'test')", [`${age}-${tag}`, age]);
  for (const [id, status] of [
    ["old-ok", "succeeded"],
    ["old-failed", "failed"],
    ["old-pending", "pending"],
    ["newest", "succeeded"],
  ])
    await pool.query("INSERT INTO webhook_deliveries (id, webhook_id, event_id, event_type, body, status) VALUES ($1, $2, $3, 'test', '{}', $4)", [
      `${id}-${tag}`,
      hook,
      `e-${id}-${tag}`,
      status,
    ]);
  for (const age of ["old", "new"])
    await pool.query("INSERT INTO client_errors (id, code, kind, message, group_key) VALUES ($1, $2, 'boundary', 'test', 'g')", [
      `ce-${age}-${tag}`,
      `C-${age.toUpperCase()}${tag.slice(-6)}`,
    ]);
  await owner.query("UPDATE client_errors SET created_at = now() - interval '40 days' WHERE id = $1", [`ce-old-${tag}`]);
  await owner.query("UPDATE audit_log SET at = now() - interval '800 days' WHERE id = $1", [`old-${tag}`]);
  await owner.query("UPDATE webhook_deliveries SET created_at = now() - interval '40 days' WHERE webhook_id = $1 AND id <> $2", [hook, `newest-${tag}`]);
});

afterAll(async () => {
  await owner.query("DELETE FROM audit_log WHERE id LIKE $1", [`%-${tag}`]);
  await owner.query("DELETE FROM webhook_deliveries WHERE id LIKE $1", [`%-${tag}`]);
  await owner.query("DELETE FROM client_errors WHERE id LIKE $1", [`%-${tag}`]);
  await owner.end();
  await pool.end();
});

describe("platform retention", () => {
  it("removes old audit entries and settled deliveries, keeps recent and pending ones and each webhook's newest", async () => {
    const r = await pruneRetention(pool, { auditLog: 730, webhookDeliveries: 30 });
    expect(r.auditLog).toBeGreaterThanOrEqual(1);
    expect(r.webhookDeliveries).toBeGreaterThanOrEqual(2);
    const audit = (await owner.query<{ id: string }>("SELECT id FROM audit_log WHERE id LIKE $1", [`%-${tag}`])).rows.map((x) => x.id);
    expect(audit).toEqual([`new-${tag}`]);
    const left = (await owner.query<{ id: string }>("SELECT id FROM webhook_deliveries WHERE webhook_id = $1 ORDER BY id", [hook])).rows.map((x) => x.id);
    expect(left).toEqual([`newest-${tag}`, `old-pending-${tag}`]);
    expect(r.clientErrors).toBeGreaterThanOrEqual(1);
    const errors = (await owner.query<{ id: string }>("SELECT id FROM client_errors WHERE id LIKE $1", [`ce-%-${tag}`])).rows.map((x) => x.id);
    expect(errors).toEqual([`ce-new-${tag}`]);
  });

  it("keeps a webhook's only delivery however old it is", async () => {
    const lonely = `h2-${newId()}`;
    await pool.query("INSERT INTO webhook_deliveries (id, webhook_id, event_id, event_type, body, status) VALUES ($1, $2, $3, 'test', '{}', 'failed')", [
      `lonely-${tag}`,
      lonely,
      `e-lonely-${tag}`,
    ]);
    await owner.query("UPDATE webhook_deliveries SET created_at = now() - interval '400 days' WHERE id = $1", [`lonely-${tag}`]);
    await pruneRetention(pool, { auditLog: 730, webhookDeliveries: 30 });
    expect((await owner.query("SELECT 1 FROM webhook_deliveries WHERE id = $1", [`lonely-${tag}`])).rowCount).toBe(1);
  });
});
