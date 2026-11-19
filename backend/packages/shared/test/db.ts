import pg from "pg";

// Dev-only credentials from infra/local (postgres/init.sql).
const OWNER_URL = process.env.WORKSPACE_OWNER_URL ?? "postgres://workspace_owner:owner_pw@localhost:5432/workspace";
const APP_URL = process.env.WORKSPACE_APP_URL ?? "postgres://workspace_app:app_pw@localhost:5432/workspace";
export const SUPER_URL = process.env.WORKSPACE_SUPER_URL ?? "postgres://postgres:postgres@localhost:5432/workspace";

/** Fixture schema: one plain table plus the outbox (the columns appendToOutbox writes). */
export async function resetSchema(): Promise<void> {
  const owner = new pg.Client({ connectionString: OWNER_URL });
  await owner.connect();
  try {
    await owner.query("DROP TABLE IF EXISTS test_tasks, outbox CASCADE");
    await owner.query(`CREATE TABLE test_tasks (id text PRIMARY KEY, title text NOT NULL)`);
    await owner.query(`CREATE TABLE outbox (
      id text PRIMARY KEY, aggregatetype text NOT NULL, aggregateid text NOT NULL,
      type text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz)`);
    await owner.query("GRANT SELECT, INSERT, UPDATE, DELETE ON test_tasks, outbox TO workspace_app");
  } finally {
    await owner.end();
  }
}

/** A pool as a module's app role. */
export function appPool(max = 1): pg.Pool {
  return new pg.Pool({ connectionString: APP_URL, max });
}
