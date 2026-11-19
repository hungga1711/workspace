import { join } from "node:path";
import type { RequestListener } from "node:http";
import { envInt, migrate, watchPool, scheduleJob, scheduleProcessedEventsPrune, startConsumer, startEvents, type ModuleContext } from "@workspace/service-kit";
import { createPlatformApp, depsFromEnv } from "./app.js";
import { deliverDue, enqueueWebhookDeliveries, WEBHOOK_TOPICS } from "./webhooks.js";
import { announceSetupToken } from "./setup-token.js";
import { scheduleRetention } from "./retention.js";
import { startAuditConsumer } from "./audit/trail.js";
import { CONSUMER_GROUPS } from "@workspace/contracts";

/** Platform: the workspace, first-run setup, settings, modules, outbound webhooks (schema `platform`). */
export async function startPlatform(ctx: ModuleContext): Promise<RequestListener> {
  await migrate(ctx.ownerUrl, join(ctx.migrations, "platform"), "platform");
  const deps = depsFromEnv();
  watchPool(deps.pool, "platform");
  const app = await createPlatformApp(deps);
  await app.init();
  // While the workspace does not exist, /setup needs the first-run token: print it where the operator looks (the log).
  await announceSetupToken(((await deps.pool.query("SELECT 1 FROM workspace")).rowCount ?? 0) > 0);
  await startEvents({ pool: deps.pool, bus: ctx.bus, listenUrl: ctx.ownerUrl, retentionDays: envInt("EVENT_RETENTION_DAYS", 3) });
  await startConsumer({ bus: ctx.bus, groupId: "platform-webhooks", topics: WEBHOOK_TOPICS, pool: deps.pool, handle: enqueueWebhookDeliveries });
  // The audit trail (ADR 0025): domain events and audit entries from every module become rows of audit_trail.
  await startAuditConsumer(ctx.bus, deps.pool, CONSUMER_GROUPS["platform-audit"]);
  scheduleJob("webhook-delivery", 5_000, () => deliverDue(deps.pool, deps.webhooks!), { pool: deps.pool });
  scheduleProcessedEventsPrune(deps.pool, envInt("PROCESSED_EVENTS_RETENTION_DAYS", 30));
  scheduleRetention(deps.pool, {
    auditLog: envInt("AUDIT_LOG_RETENTION_DAYS", 730),
    auditTrail: envInt("AUDIT_TRAIL_RETENTION_DAYS", 365),
    webhookDeliveries: envInt("WEBHOOK_DELIVERIES_RETENTION_DAYS", 30),
    clientErrors: envInt("CLIENT_ERRORS_RETENTION_DAYS", 30),
  });
  return app.getHttpAdapter().getInstance() as RequestListener;
}
