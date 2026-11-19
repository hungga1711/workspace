import { moduleUrl, ServiceClient } from "@workspace/service-kit";
import type { Pool } from "pg";
import type { SyncDeps } from "./sync.js";

/** The real network and the identity module's member lookup. */
export function syncDeps(pool: Pool, internalSecret: string): SyncDeps {
  const identity = new ServiceClient(moduleUrl("identity"), internalSecret, "work", [{ permission: "principal.resolve", scope: "PLATFORM" }]);
  return {
    pool,
    fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(30_000) }),
    members: async (emails) => {
      const r = await identity.request<{ members: { email: string; userId: string }[] }>("POST", "/internal/members/by-email", { emails });
      return new Map(r.members.map((m) => [m.email.toLowerCase(), m.userId]));
    },
  };
}
