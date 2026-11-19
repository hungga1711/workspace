import type { Pool } from "pg";
import { kv } from "@workspace/service-kit";

/** The gateway caches resolved OAuth tokens under this prefix; a revocation drops them at once (same process). */
export const OAUTH_CACHE_PREFIX = "oauth:";
export const dropCached = () => kv().delPrefix(OAUTH_CACHE_PREFIX);

/** Housekeeping for auth-prune: spent codes and tokens, connections ended long ago, apps nobody approved, old activity. */
export async function pruneOAuth(pool: Pool): Promise<void> {
  await pool.query("DELETE FROM oauth_codes WHERE expires_at < now() - interval '1 day'");
  await pool.query("DELETE FROM oauth_tokens WHERE expires_at < now() - interval '1 day' OR (used_at IS NOT NULL AND used_at < now() - interval '1 day')");
  await pool.query("DELETE FROM oauth_grants WHERE revoked_at < now() - interval '90 days'");
  await pool.query("DELETE FROM oauth_clients c WHERE created_at < now() - interval '30 days' AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = c.id)");
  await pool.query("DELETE FROM mcp_calls WHERE at < now() - interval '180 days'");
}

/** When a person's sign-in may be in someone else's hands (logout everywhere, reset, disabled): their apps go too. */
export async function revokeUserGrants(pool: Pool, userId: string): Promise<void> {
  const r = await pool.query<{ id: string }>("UPDATE oauth_grants SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL RETURNING id", [userId]);
  if (r.rowCount) {
    await pool.query("DELETE FROM oauth_tokens WHERE grant_id = ANY($1)", [r.rows.map((x) => x.id)]);
    dropCached();
  }
}
