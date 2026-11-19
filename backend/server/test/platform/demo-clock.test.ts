import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { newId } from "@workspace/shared";

// Demo data that stays "today" (platform.demo_refresh, migrations/platform/004_demo_clock.sql). Everything runs in one
// transaction that is rolled back: the refresh moves every table's demo rows, and other test files share this database.
const OWNER = "postgres://workspace_owner:owner_pw@localhost:5432/workspace_test";
const sql = (schema: string, file: string) => readFileSync(fileURLToPath(new URL(`../../migrations/${schema}/${file}`, import.meta.url)), "utf8");
const db = new pg.Client({ connectionString: OWNER });
const DAY = 86_400_000;

beforeAll(async () => {
  await db.connect();
  // Re-apply the definitions so this file tests the current function even on a database migrated earlier.
  await db.query(`SET search_path = ai; ${sql("ai", "008_demo_data.sql")}`);
  await db.query(`SET search_path = platform; ${sql("platform", "004_demo_clock.sql")}`);
  await db.query("RESET search_path");
});
afterAll(async () => {
  await db.end();
});

describe("demo_refresh", () => {
  it("moves demo rows forward by whole days, leaves later activity alone and redraws attendance", async () => {
    const tag = newId().slice(-8);
    const user = `demo-${tag}`;
    const now = Date.now();
    const anchor = new Date(now - 10 * DAY - 3 * 3600_000);
    const demoAt = new Date(anchor.getTime() - DAY);
    const realAt = new Date(now - 3600_000);
    await db.query("BEGIN");
    try {
      await db.query("INSERT INTO platform.demo_clock (anchor) VALUES ($1) ON CONFLICT (singleton) DO UPDATE SET anchor = EXCLUDED.anchor", [anchor]);
      await db.query(
        `INSERT INTO ai.ai_usage (id, user_id, feature, model, input_tokens, output_tokens, at) VALUES ($1, $3, 'summarize', 'm', 1, 1, $4), ($2, $3, 'summarize', 'm', 1, 1, $5)`,
        [`d${tag}`, `r${tag}`, user, demoAt, realAt],
      );
      const oldDay = new Date(anchor.getTime() - 2 * DAY).toISOString().slice(0, 10);
      await db.query(
        `INSERT INTO employee.attendance (id, user_id, day, check_in, check_out, source, late_minutes) VALUES ($1, $2, $3::date, $3::date + time '09:00', $3::date + time '17:30', 'web', 0)`,
        [`seed${tag}`.padEnd(26, "0"), user, oldDay],
      );

      const r = (await db.query<{ r: { shifted: boolean; days: number; skipped: string[] } }>("SELECT platform.demo_refresh() AS r")).rows[0]!.r;
      expect(r.shifted).toBe(true);
      expect(r.days).toBe(10);
      expect(r.skipped).toEqual([]);

      const at = Object.fromEntries(
        (await db.query<{ id: string; at: Date }>("SELECT id, at FROM ai.ai_usage WHERE id = ANY($1)", [[`d${tag}`, `r${tag}`]])).rows.map((x) => [x.id, x.at.getTime()]),
      );
      expect(at[`d${tag}`]).toBe(demoAt.getTime() + 10 * DAY);
      expect(at[`r${tag}`]).toBe(realAt.getTime());

      const days = (
        await db.query<{ id: string; day: string; dow: number; open: boolean; check_in: Date }>(
          "SELECT id, to_char(day, 'YYYY-MM-DD') AS day, extract(isodow FROM day)::int AS dow, check_out IS NULL AS open, check_in FROM employee.attendance WHERE user_id = $1 ORDER BY day",
          [user],
        )
      ).rows;
      expect(days.length).toBeGreaterThan(10);
      // Drawn again, not moved: the seeded row is gone, four weeks of weekdays (less the odd missed day) are there.
      expect(days.some((d) => d.id === `seed${tag}`.padEnd(26, "0"))).toBe(false);
      expect(days.length).toBeLessThanOrEqual(20);
      expect(days.every((d) => d.dow < 6)).toBe(true);
      expect(days.every((d) => d.check_in.getTime() <= Date.now())).toBe(true);
      // Only today's check-in can still be open.
      expect(days.filter((d) => d.open).length).toBeLessThanOrEqual(1);

      const clock = (await db.query<{ anchor: Date }>("SELECT anchor FROM platform.demo_clock")).rows[0]!;
      expect(clock.anchor.getTime()).toBe(anchor.getTime() + 10 * DAY);
      expect((await db.query<{ demo_data: boolean }>("SELECT demo_data FROM ai.workspace_settings")).rows.every((x) => x.demo_data)).toBe(true);

      // Same day again: nothing to move.
      const again = (await db.query<{ r: { shifted: boolean; reason: string } }>("SELECT platform.demo_refresh() AS r")).rows[0]!.r;
      expect(again).toMatchObject({ shifted: false, reason: "fresh" });
    } finally {
      await db.query("ROLLBACK");
    }
  });

  it("does nothing on a workspace the demo seed did not make", async () => {
    await db.query("BEGIN");
    try {
      await db.query("DELETE FROM platform.demo_clock");
      const r = (await db.query<{ r: { shifted: boolean; reason: string } }>("SELECT platform.demo_refresh() AS r")).rows[0]!.r;
      expect(r).toMatchObject({ shifted: false, reason: "no_anchor" });
    } finally {
      await db.query("ROLLBACK");
    }
  });

  it("moves calendar items by whole weeks and never touches credentials or real computers' logs", async () => {
    const plan = (await db.query<{ t: string; weekly: boolean }>("SELECT schema_name || '.' || table_name AS t, weekly FROM platform.demo_shift_plan()")).rows;
    const byName = new Map(plan.map((x) => [x.t, x.weekly]));
    expect(byName.get("work.calendar_events")).toBe(true);
    expect(byName.get("employee.leave_requests")).toBe(true);
    expect(byName.get("work.tasks")).toBe(false);
    for (const t of ["identity.auth_sessions", "identity.api_keys", "ai.ai_local_usage", "employee.holidays", "work.outbox", "employee.attendance"])
      expect(byName.has(t)).toBe(false);
  });
});
