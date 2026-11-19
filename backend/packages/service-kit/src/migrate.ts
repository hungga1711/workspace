import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";

/**
 * Applies numbered .sql files once, in order, as the owning role, into one schema of the shared database.
 * Each file runs in its own transaction; a failure leaves earlier files applied and stops.
 *
 * The schema is created if missing and each file runs with `search_path = <schema>, public, pg_temp`, so
 * migrations use unqualified names (public only holds extensions; pg_temp last so temporary objects never
 * shadow real ones). SECURITY DEFINER functions pin that path with `SET search_path FROM CURRENT`.
 * Applied files are recorded in `<schema>.schema_migrations`.
 */
export async function migrate(ownerUrl: string, dir: string, schema: string): Promise<string[]> {
  if (!/^[a-z][a-z0-9_]*$/.test(schema)) throw new Error(`Invalid schema name: ${schema}`);
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await client.query(`SET search_path TO ${schema}, public, pg_temp`);
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const done = new Set((await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = await readFile(join(dir, f), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
        await client.query("COMMIT");
        applied.push(f);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${schema}/${f} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
  return applied;
}
