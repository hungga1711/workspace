import { join } from "node:path";
import type { RequestListener } from "node:http";
import { envInt, logger, migrate, watchPool, scheduleJob, scheduleProcessedEventsPrune, smtpMailer, startConsumer, startEvents, type ModuleContext } from "@workspace/service-kit";
import { featureDisabled, projectWorkspaceTimeZone, recordAudit, withTransaction } from "@workspace/shared";
import { forgetAiFlags } from "./status.js";
import { clearOnChanges } from "./tool-cache.js";
import { createAiApp, depsFromEnv } from "./app.js";
import { classifyTopicsBatch } from "./topics.js";
import { sendWeeklyReports } from "./report.js";

/** AI: the company AI gateway and connections, assistant, metering, costs and budgets, AI oversight (schema `ai`). */
export async function startAi(ctx: ModuleContext): Promise<RequestListener> {
  await migrate(ctx.ownerUrl, join(ctx.migrations, "ai"), "ai");
  const { deps, secret } = depsFromEnv();
  watchPool(deps.pool, "ai");
  const app = await createAiApp(deps, secret);
  await app.init();
  const bus = ctx.bus;
  await startEvents({ pool: deps.pool, bus, listenUrl: ctx.ownerUrl, retentionDays: envInt("EVENT_RETENTION_DAYS", 3) });
  // The workspace's time zone (workspace_settings) for Công việc › AI's days and weeks and dates in AI answers.
  await startConsumer({
    bus,
    groupId: "ai-settings",
    topics: ["workspace.platform.workspace"],
    pool: deps.pool,
    handle: async (event, c) => {
      await projectWorkspaceTimeZone(event, c);
      // Admin › AI switched something: answer the next status with the new switches, not the cached ones.
      if (event.eventType === "platform.workspace.config_changed.v1") forgetAiFlags();
    },
  });
  // Any change in the workspace clears the AI's recent tool results (a task moved in the UI is never answered from before).
  await clearOnChanges(bus);
  // Retention of AI activity (Công việc › AI › Chính sách): hourly, 5,000 conversations a run.
  scheduleJob(
    "ai-retention",
    3600_000,
    async () => {
      const n = (await deps.pool.query<{ n: number }>("SELECT ai_prune_expired(5000) AS n")).rows[0]?.n ?? 0;
      if (n) logger.info({ deleted: n }, "ai retention");
      // Deleting people's AI records by policy is on the audit trail too (ADR 0025): how many, never which.
      if (n) await withTransaction(deps.pool, (c) => recordAudit(c, { action: "ai.retention.pruned", targetType: "ai_policy", targetId: "workspace", meta: { conversations: n } }));
    },
    { pool: deps.pool, firstRunMs: 60_000 },
  );
  // Who viewed what, safety events and the agent audit: daily, batches of 5,000 until a batch comes
  // back short (at most 20 a run, so a long backlog drains over a few days without one huge delete).
  const sweeps: [string, string, number][] = [
    ["ai_prune_views", "AI_VIEWS_RETENTION_DAYS", 365],
    ["ai_prune_safety", "AI_SAFETY_RETENTION_DAYS", 365],
    ["ai_prune_audit", "AI_AUDIT_RETENTION_DAYS", 365],
  ];
  scheduleJob(
    "ai-retention-daily",
    24 * 3600_000,
    async () => {
      for (const [fn, variable, fallback] of sweeps) {
        const days = envInt(variable, fallback);
        let total = 0;
        for (let i = 0; i < 20; i++) {
          const n = (await deps.pool.query<{ n: number }>(`SELECT ${fn}($1, 5000) AS n`, [days])).rows[0]?.n ?? 0;
          total += n;
          if (n < 5000) break;
        }
        if (total) logger.info({ deleted: total, days }, fn);
      }
      // External MCP tool calls follow the agent audit's retention; unanswered confirm cards go after a day.
      await deps.pool.query("DELETE FROM mcp_calls WHERE ctid IN (SELECT ctid FROM mcp_calls WHERE at < now() - make_interval(days => $1) LIMIT 50000)", [
        envInt("AI_AUDIT_RETENTION_DAYS", 365),
      ]);
      await deps.pool.query("DELETE FROM mcp_pending WHERE created_at < now() - interval '1 day'");
    },
    { pool: deps.pool, firstRunMs: 5 * 60_000 },
  );
  // Left out at deploy time (DISABLED_FEATURES=ai): nothing classifies or emails. The retention jobs above keep
  // running, so what was recorded before still expires on the company's schedule.
  if (!featureDisabled("ai")) {
    // AI Insights: topics from the company's model (only where AI Insights, the assistant and a model are all on) and
    // the owner's Monday email (only where switched on). Both are one cheap query when there is nothing to do.
    scheduleJob(
      "ai-topics",
      3600_000,
      async () => {
        const n = await classifyTopicsBatch(deps);
        if (n) logger.info({ classified: n }, "ai topics");
      },
      { pool: deps.pool, firstRunMs: 5 * 60_000 },
    );
    const mailer = smtpMailer();
    scheduleJob("ai-weekly-report", 3600_000, () => sendWeeklyReports(deps, mailer), { pool: deps.pool, firstRunMs: 10 * 60_000 });
  }
  scheduleProcessedEventsPrune(deps.pool, envInt("PROCESSED_EVENTS_RETENTION_DAYS", 30));
  logger.info({ provider: deps.provider.name }, "ai module started");
  return app.getHttpAdapter().getInstance() as RequestListener;
}
