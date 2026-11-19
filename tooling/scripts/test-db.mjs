// The test installation: its own database (`workspace_test`), never the development one. An installation holds one
// workspace (ADR 0005), so a suite that needs a fresh one empties this database first (resetTestDatabase) and goes
// through first-run setup again; the server refuses to start on a database with more than one.
//   node tooling/scripts/test-db.mjs           create the database if missing and migrate it
//   node tooling/scripts/test-db.mjs --reset   drop and recreate it first
//   node tooling/scripts/test-db.mjs --serve   empty it, then run the server on it (:4100 public, :4101 modules)
// PG_ADMIN_URL: a superuser on the local Postgres (default the infra/local one); TEST_DATABASE: the database name;
// TEST_PORT / TEST_INTERNAL_PORT: other ports (give the suites the same TEST_INTERNAL_PORT).
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
// pg comes with service-kit (the root package has no runtime dependencies).
const pg = createRequire(join(root, "backend/packages/service-kit/package.json"))("pg");
const MODULES = ["identity", "platform", "chat", "work", "home", "employee", "ai", "search", "web"];
// The server's own state, not the workspace's: identity's token signing keys (a running server caches them, and
// would refuse every token signed after a reset rotated them).
const SERVER_TABLES = new Set(["identity.auth_keys"]);

export const TEST_DATABASE = process.env.TEST_DATABASE ?? "workspace_test";
const url = (role, password) => `postgres://${role}:${password}@localhost:5432/${TEST_DATABASE}`;

// A superuser on the test database itself (owner of the schemas it creates; empties every module's tables).
const adminUrl = () => (process.env.PG_ADMIN_URL ? process.env.PG_ADMIN_URL.replace(/\/[^/?]*(\?|$)/, `/${TEST_DATABASE}$1`) : url("postgres", "postgres"));

/** The environment that points the server, the migrations and the test suites at the test installation. */
export function testDatabaseEnv() {
  // Module APIs (<MODULE>_URL) on the test server's internal port, so a suite never reaches the development server.
  const internal = process.env.TEST_INTERNAL_URL ?? `http://localhost:${process.env.TEST_INTERNAL_PORT ?? "4101"}`;
  const env = { OWNER_DATABASE_URL: url("workspace_owner", "owner_pw"), MIGRATE_DATABASE_URL: url("workspace_owner", "owner_pw"), TEST_FIXTURES: "1" };
  for (const m of MODULES) {
    env[`${m.toUpperCase()}_DATABASE_URL`] = url(`workspace_${m}`, "app_pw");
    if (m !== "web" && m !== "search") env[`${m.toUpperCase()}_URL`] = `${internal}/${m}`;
  }
  env.CHAT_SEARCH_DATABASE_URL = env.CHAT_DATABASE_URL;
  return env;
}

/** Creates (or with `reset`, recreates) the test database with the grants infra/local/postgres/init.sql gives `workspace`, then migrates it. */
export async function ensureTestDatabase({ reset = false } = {}) {
  if (!/^workspace_[a-z0-9_]+$/.test(TEST_DATABASE) || TEST_DATABASE === "workspace") throw new Error(`refusing to use ${TEST_DATABASE} as the test database`);
  const admin = new pg.Client(process.env.PG_ADMIN_URL ?? "postgres://postgres:postgres@localhost:5432/postgres");
  await admin.connect();
  let fresh = false;
  try {
    if (reset) await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE} WITH (FORCE)`);
    const exists = (await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [TEST_DATABASE])).rowCount;
    if (!exists) {
      fresh = true;
      await admin.query(`CREATE DATABASE ${TEST_DATABASE} OWNER workspace_owner`);
      for (const r of [...MODULES, "app"]) await admin.query(`GRANT CONNECT ON DATABASE ${TEST_DATABASE} TO workspace_${r}`);
      const db = new pg.Client(adminUrl());
      await db.connect();
      try {
        await db.query("ALTER SCHEMA public OWNER TO workspace_owner; REVOKE CREATE ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO workspace_app");
      } finally {
        await db.end();
      }
    }
  } finally {
    await admin.end();
  }
  const { migrate } = await import(join(root, "backend/packages/service-kit/dist/index.js"));
  let applied = 0;
  for (const schema of MODULES) applied += (await migrate(url("workspace_owner", "owner_pw"), join(root, "backend/server/migrations", schema), schema)).length;
  // A new migration on a used database: start over, so the snapshot below is what a fresh installation holds.
  if (applied && !fresh) return ensureTestDatabase({ reset: true });
  if (fresh) await snapshotSeed();
}

/** The module tables (not the migration ledgers) and their writable columns. */
async function moduleTables(db) {
  const r = await db.query(
    `SELECT table_schema s, table_name t, array_agg(quote_ident(column_name::text) ORDER BY ordinal_position) cols
       FROM information_schema.columns
      WHERE table_schema = ANY($1) AND table_name <> 'schema_migrations' AND is_generated = 'NEVER'
        AND (table_schema, table_name) IN (SELECT table_schema, table_name FROM information_schema.tables WHERE table_type = 'BASE TABLE')
      GROUP BY 1, 2`,
    [MODULES],
  );
  return r.rows;
}

/** Keeps a copy (schema test_seed) of the rows a freshly migrated database holds: what resetTestDatabase restores. */
async function snapshotSeed() {
  const db = new pg.Client(adminUrl());
  await db.connect();
  try {
    await db.query("DROP SCHEMA IF EXISTS test_seed CASCADE; CREATE SCHEMA test_seed");
    for (const { s, t, cols } of await moduleTables(db)) {
      const n = (await db.query(`SELECT count(*)::int AS n FROM "${s}"."${t}"`)).rows[0].n;
      if (n) await db.query(`CREATE TABLE test_seed."${s}.${t}" AS SELECT ${cols.join(", ")} FROM "${s}"."${t}"`);
    }
  } finally {
    await db.end();
  }
}

/**
 * Empties the test installation back to a freshly migrated one: no workspace, no accounts, only what the
 * migrations wrote (the test_seed snapshot). The server may keep running: it finds no workspace, and the next
 * first-run setup creates the only one.
 */
export async function resetTestDatabase() {
  const db = new pg.Client(adminUrl());
  await db.connect();
  try {
    const tables = await moduleTables(db);
    const seeded = new Set((await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'test_seed'")).rows.map((r) => r.table_name));
    // Row by row, one table per statement, outside one transaction: TRUNCATE's table locks queue behind a running
    // server's outbox relay, which waits on consumers that queue behind TRUNCATE (a cycle Postgres cannot see).
    // Foreign keys are not checked while emptying (everything they point at goes too).
    await db.query("SET session_replication_role = replica");
    for (const { s, t, cols } of tables) {
      if (SERVER_TABLES.has(`${s}.${t}`)) continue;
      await db.query(`DELETE FROM "${s}"."${t}"`);
      if (seeded.has(`${s}.${t}`)) await db.query(`INSERT INTO "${s}"."${t}" (${cols.join(", ")}) SELECT ${cols.join(", ")} FROM test_seed."${s}.${t}"`);
    }
  } finally {
    await db.end();
  }
}

if (process.argv[1] === import.meta.filename) {
  await ensureTestDatabase({ reset: process.argv.includes("--reset") });
  console.log(`${TEST_DATABASE}: ready`);
  if (process.argv.includes("--serve")) {
    await resetTestDatabase();
    const env = {
      ...process.env,
      ...testDatabaseEnv(),
      TEST_SERVER: "1",
      // E2E specs drive one account through dozens of pages a minute; the production per-person limit (600/min) is
      // tested by the gateway's own tests, not here.
      RATE_USER_PER_MIN: process.env.RATE_USER_PER_MIN ?? "6000",
      PORT: process.env.TEST_PORT ?? "4100",
      INTERNAL_PORT: process.env.TEST_INTERNAL_PORT ?? "4101",
      WATCH: process.env.WATCH ?? "0",
    };
    const child = spawn(process.execPath, [join(root, "tooling/scripts/dev-server.mjs")], { env, stdio: "inherit" });
    child.on("exit", (code) => process.exit(code ?? 0));
  }
}
