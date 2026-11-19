import type { Pool, PoolClient } from "pg";
import { logger, type ServiceClient } from "@workspace/service-kit";

/** Kinds the employee module uses (leave types, job levels, department types). */
const MASTER_KINDS = ["leave_type", "job_level", "department_type"];
interface Item {
  code: string;
  label: Record<string, string>;
  active: boolean;
}

/** Applies a full-state snapshot if it is newer than what we hold. Returns whether it applied. */
export async function applySnapshot(c: Pick<PoolClient, "query">, kind: string, version: number, items: Item[]): Promise<boolean> {
  const cur = (await c.query<{ version: number }>("SELECT version FROM master_data_versions WHERE kind = $1 FOR UPDATE", [kind])).rows[0]?.version ?? 0;
  if (version <= cur) return false;
  await c.query("DELETE FROM master_data WHERE kind = $1", [kind]);
  for (const i of items) await c.query("INSERT INTO master_data (kind, code, label, active) VALUES ($1,$2,$3,$4)", [kind, i.code, JSON.stringify(i.label), i.active]);
  await c.query(`INSERT INTO master_data_versions (kind, version) VALUES ($1,$2) ON CONFLICT (kind) DO UPDATE SET version = EXCLUDED.version, synced_at = now()`, [kind, version]);
  if (version > cur + 1 && cur > 0) logger.info({ kind, from: cur, to: version }, "master data version gap healed from full snapshot");
  return true;
}

/** Startup resync: fetches each kind from the platform module, so a fresh or long-stopped installation is current. */
export async function resyncMasterData(pool: Pool, platform: ServiceClient): Promise<void> {
  for (const kind of MASTER_KINDS) {
    try {
      const r = await platform.request<{ kind: string; version: number; items: Item[] }>("GET", `/master-data/${kind}`);
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await applySnapshot(c, kind, r.version, r.items);
        await c.query("COMMIT");
      } catch (err) {
        await c.query("ROLLBACK");
        throw err;
      } finally {
        c.release();
      }
    } catch (err) {
      if ((err as { status?: number }).status === 404) continue; // the platform has not published this kind yet
      logger.warn({ err, kind }, "master data resync failed; will use the last known version");
    }
  }
}
