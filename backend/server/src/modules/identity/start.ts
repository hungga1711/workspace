import { join } from "node:path";
import type { RequestListener } from "node:http";
import { envInt, migrate, watchPool, scheduleJob, scheduleProcessedEventsPrune, startConsumer, startEvents, type ModuleContext } from "@workspace/service-kit";
import { mirrorDepartment, ORG_TOPICS } from "./org-mirror.js";
import { createIdentityApp, depsFromEnv } from "./app.js";
import { pruneOAuth } from "./oauth-store.js";
import { loadMailSettings } from "./mail-settings.js";

/** Identity: members, roles, own authentication, API keys, audit (schema `identity`). */
export async function startIdentity(ctx: ModuleContext): Promise<RequestListener> {
  await migrate(ctx.ownerUrl, join(ctx.migrations, "identity"), "identity");
  const deps = depsFromEnv();
  watchPool(deps.pool, "identity");
  // The first signing key exists before the first sign-in (and rotation is checked at every start).
  await deps.keys.signer();
  // Email settings saved in the app (Admin › Settings › Email) win over SMTP_URL; reread every minute so a second
  // process, or a change made with SQL, is picked up without a restart.
  await loadMailSettings(deps.pool);
  scheduleJob("mail-settings", 60_000, () => loadMailSettings(deps.pool), { firstRunMs: 60_000 });
  const app = await createIdentityApp(deps);
  await app.init();
  // Publishes the member and role events other modules project; reads only the org chart (departments).
  await startEvents({ pool: deps.pool, bus: ctx.bus, listenUrl: ctx.ownerUrl, retentionDays: envInt("EVENT_RETENTION_DAYS", 3) });
  await startConsumer({ bus: ctx.bus, groupId: "identity-org", topics: ORG_TOPICS, pool: deps.pool, handle: mirrorDepartment });
  scheduleProcessedEventsPrune(deps.pool, envInt("PROCESSED_EVENTS_RETENTION_DAYS", 30));
  // Sign-in history (90 days), spent challenges and ended sessions; spent OAuth codes and tokens, MCP activity (180 days).
  scheduleJob(
    "auth-prune",
    6 * 3600_000,
    async () => {
      await deps.auth.prune();
      await pruneOAuth(deps.pool);
    },
    { pool: deps.pool, firstRunMs: 60_000 },
  );
  return app.getHttpAdapter().getInstance() as RequestListener;
}
