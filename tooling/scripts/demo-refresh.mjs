#!/usr/bin/env node
/**
 * Moves the demo company's data forward to today (platform.demo_refresh(), migrations/platform/004_demo_clock.sql):
 * every date the seed wrote shifts by the whole days since the demo was last true, attendance is drawn again for the
 * last four weeks, real activity after that moment is left alone. Safe to run any time; a no-op the same day.
 *
 *   pnpm demo:refresh                       # the database in SEED_DATABASE_URL / MIGRATE_DATABASE_URL (owner role)
 *   pnpm demo:refresh --anchor 2026-10-28T18:00:00Z
 *       a database seeded before the demo clock existed: say when the seed ran (once); the next runs remember it.
 *   pnpm demo:refresh --balance
 *       also brings lateness back to a story (seed-demo-balance.mjs): two late projects, about a dozen late tasks.
 */
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { join } from "node:path";
import { balanceSql } from "./seed-demo-balance.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const URL_ = process.env.SEED_DATABASE_URL ?? process.env.MIGRATE_DATABASE_URL ?? "postgres://workspace_owner:owner_pw@localhost:5432/workspace";
const i = process.argv.indexOf("--anchor");
const anchor = i > 0 ? process.argv[i + 1] : null;
if (anchor !== null && Number.isNaN(Date.parse(anchor ?? ""))) {
  console.error("--anchor needs a date and time, e.g. 2026-10-28T18:00:00Z");
  process.exit(1);
}

const pg = createRequire(join(ROOT, "backend/server/package.json"))("pg");
const client = new pg.Client({ connectionString: URL_ });
await client.connect();
try {
  if (anchor) await client.query("INSERT INTO platform.demo_clock (anchor) VALUES ($1) ON CONFLICT (singleton) DO UPDATE SET anchor = EXCLUDED.anchor", [anchor]);
  if (process.argv.includes("--balance")) {
    await client.query(balanceSql);
    console.log("Lateness balanced: two projects past their date, one at risk, about a dozen late tasks.");
  }
  const t = Date.now();
  const { rows } = await client.query("SELECT platform.demo_refresh() AS r");
  const r = rows[0].r;
  if (!r.shifted)
    console.log(
      r.reason === "no_anchor" ? "No demo clock: this database was not made by the demo seed (pass --anchor <when it was seeded> once)." : "Already today: nothing to move.",
    );
  else
    console.log(
      `Moved the demo forward ${r.days} days (calendar and leave ${r.weeks}): ${r.rows} rows in ${r.tables} tables, ${r.attendance} check-ins drawn again` +
        `${r.skipped.length ? `; left as they were: ${r.skipped.join(", ")}` : ""} (${((Date.now() - t) / 1000).toFixed(1)}s).`,
    );
} finally {
  await client.end();
}
