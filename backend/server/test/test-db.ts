import { kv } from "@workspace/service-kit";
// @ts-expect-error a plain .mjs tooling script, typed by use
import { resetTestDatabase as reset } from "../../../tooling/scripts/test-db.mjs";

/**
 * Empties the test installation (tooling/scripts/test-db.mjs) and this process's in-memory caches (the gateway's
 * workspace state, MFA policy and principals describe the installation that was just emptied).
 */
export async function resetTestDatabase(): Promise<void> {
  await (reset as () => Promise<void>)();
  kv().clear();
}
