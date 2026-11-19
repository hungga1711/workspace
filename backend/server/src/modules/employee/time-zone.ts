import { withTransaction, workspaceTimeZone } from "@workspace/shared";
import type { Pool } from "pg";

const cache = new WeakMap<Pool, { tz: string; at: number }>();

/**
 * The workspace's time zone (its workspace_settings projection), kept a minute so the "today" of check-in, leave
 * years and reports costs no extra query on most requests.
 */
export async function workspaceTz(pool: Pool): Promise<string> {
  const hit = cache.get(pool);
  if (hit && Date.now() - hit.at < 60_000) return hit.tz;
  const tz = await withTransaction(pool, workspaceTimeZone);
  cache.set(pool, { tz, at: Date.now() });
  return tz;
}
