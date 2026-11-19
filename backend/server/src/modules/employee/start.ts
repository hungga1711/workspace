import { join } from "node:path";
import type { RequestListener } from "node:http";
import {
  envInt,
  migrate,
  moduleUrl,
  watchPool,
  scheduleJob,
  scheduleProcessedEventsPrune,
  ServiceClient,
  startConsumer,
  startEvents,
  type ModuleContext,
} from "@workspace/service-kit";
import { featureDisabled } from "@workspace/shared";
import { grantYearlyLeave } from "./leave-grant.js";
import { resyncMasterData } from "./masterdata.js";
import { createEmployeeApp, depsFromEnv } from "./app.js";
import { ensureProfile, PROFILE_TOPICS } from "./profiles.js";
import { DELEGATION_TOPICS, handleDelegation } from "./delegations.js";

/** Employee: directory, departments, reporting lines, attendance, leave (schema `employee`). */
export async function startEmployee(ctx: ModuleContext): Promise<RequestListener> {
  await migrate(ctx.ownerUrl, join(ctx.migrations, "employee"), "employee");
  const deps = depsFromEnv();
  watchPool(deps.pool, "employee");
  const app = await createEmployeeApp(deps);
  await app.init();
  const bus = ctx.bus;
  await startEvents({ pool: deps.pool, bus, listenUrl: ctx.ownerUrl, retentionDays: envInt("EVENT_RETENTION_DAYS", 3) });
  await startConsumer({ bus, groupId: "employee-profiles", topics: PROFILE_TOPICS, pool: deps.pool, handle: ensureProfile });
  await startConsumer({ bus, groupId: "employee-delegations", topics: DELEGATION_TOPICS, pool: deps.pool, handle: handleDelegation });
  // Master data ships with the platform module's migrations and only changes on upgrade, which restarts the
  // server: a resync at boot is all it needs (no event exists for it).
  await resyncMasterData(deps.pool, new ServiceClient(moduleUrl("platform"), deps.internalSecret, "employee", []));
  scheduleProcessedEventsPrune(deps.pool, envInt("PROCESSED_EVENTS_RETENTION_DAYS", 30));
  // Start-of-year leave: a few checks a day are plenty; the grant itself is idempotent per year.
  // Not without Time (DISABLED_FEATURES=time): switched back on, the first run grants the year (idempotent).
  if (!featureDisabled("time")) scheduleJob("leave-yearly-grant", 6 * 3600_000, () => grantYearlyLeave(deps.pool), { pool: deps.pool });
  return app.getHttpAdapter().getInstance() as RequestListener;
}
