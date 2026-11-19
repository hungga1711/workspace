import { join } from "node:path";
import { watchRuns } from "./workflows.js";
import { runTriggers } from "./workflow-triggers.js";
import type { RequestListener } from "node:http";
import type { Pool } from "pg";
import { featureDisabled } from "@workspace/shared";
import { envInt, logger, migrate, watchPool, scheduleJob, scheduleProcessedEventsPrune, startConsumer, startEvents, type ModuleContext } from "@workspace/service-kit";
import { createWorkApp, depsFromEnv, workflowEngine } from "./app.js";
import { sweepPendingFiles } from "./files.js";
import { readFileTexts } from "./knowledge.js";
import { sweepRecordings } from "./rooms.js";
import { applySettingsEvent } from "./settings.js";
import { applyTeamEvent, TEAM_TOPICS } from "./teams.js";
import { applyAiUsageEvent } from "./ai-assists.js";
import { syncDeps } from "./task-sync/deps.js";
import { runAll as runTaskSync } from "./task-sync/sync.js";
import { hubDeps, scanRepos } from "./integrations/hub.js";

/** Work: tasks, projects, goals, follow-up and outcomes, docs, drive, calendar, meetings, approvals (schema `work`). */
export async function startWork(ctx: ModuleContext): Promise<RequestListener> {
  await migrate(ctx.ownerUrl, join(ctx.migrations, "work"), "work");
  const deps = depsFromEnv();
  watchPool(deps.pool, "work");
  // Object storage may come up after this service (behind the reverse proxy on the files domain): keep trying
  // in the background instead of failing the start; only file uploads and downloads wait for it.
  const ensureBucket = (): void =>
    void deps.storage.ensureBucket().catch((err: unknown) => {
      logger.warn({ err }, "object storage not reachable yet; retrying in 10 s");
      setTimeout(ensureBucket, 10_000).unref();
    });
  ensureBucket();
  const app = await createWorkApp(deps);
  await app.init();
  const bus = ctx.bus;
  await startEvents({ pool: deps.pool, bus, listenUrl: ctx.ownerUrl, retentionDays: envInt("EVENT_RETENTION_DAYS", 3) });
  await startConsumer({ bus, groupId: "work-settings", topics: ["workspace.platform.workspace"], pool: deps.pool, handle: applySettingsEvent });
  await startConsumer({ bus, groupId: "work-teams", topics: TEAM_TOPICS, pool: deps.pool, handle: applyTeamEvent });
  // Tasks the company AI helped with, for Công việc › AI's with/without-AI comparison (ADR 0011).
  await startConsumer({ bus, groupId: "work-ai-assists", topics: ["workspace.ai.usage"], pool: deps.pool, handle: applyAiUsageEvent });
  scheduleJob("file-sweep", envInt("FILE_SWEEP_INTERVAL_MS", 10 * 60_000), () => sweepPendingFiles(deps.pool, deps.storage), { pool: deps.pool });
  // Meeting recordings are deleted after the retention period (daily check).
  scheduleJob(
    "recording-retention",
    envInt("RECORDING_SWEEP_INTERVAL_MS", 24 * 3600_000),
    () => sweepRecordings(deps.pool, deps.storage, envInt("MEET_RECORDING_RETENTION_DAYS", 365)),
    { pool: deps.pool },
  );
  // Agent runs in flight (workflows.ts watchRuns): a server run nobody drives (this process restarted) is picked up
  // again as the person who started it; a run whose runner went away goes back in the queue. Shortly after start (the
  // identity module must be up to resolve the starter), then every minute.
  // Workflows are part of AI: an installation without it (DISABLED_FEATURES=ai) runs neither job.
  if (!featureDisabled("ai")) {
    const engine = workflowEngine(deps);
    scheduleJob("agent-runs-watch", envInt("AGENT_RUNS_WATCH_INTERVAL_MS", 60_000), () => watchRuns(engine), { pool: deps.pool, firstRunMs: 20_000 });
    // Workflows that start by themselves (workflow-triggers.ts): what is waiting to start is started within a few
    // seconds; schedules are looked at once a minute. Idle, a turn is one read through a partial index.
    scheduleJob("workflow-triggers", envInt("WORKFLOW_TRIGGERS_INTERVAL_MS", 10_000), () => runTriggers(engine), { pool: deps.pool, firstRunMs: 25_000 });
  }
  // Task/doc history older than a year goes (daily, batched; TASK_ACTIVITY_RETENTION_DAYS overrides).
  const activityDays = envInt("TASK_ACTIVITY_RETENTION_DAYS", 365);
  scheduleJob(
    "work-activity-retention",
    24 * 3600_000,
    async () => {
      const deleted = await pruneActivity(deps.pool, activityDays);
      if (deleted) logger.info({ deleted }, "work activity retention");
    },
    { pool: deps.pool, firstRunMs: 5 * 60_000 },
  );
  // Task sync (Asana, ClickUp, Linear, Jira): every 15 minutes by default; a connection with nothing new is two cheap calls.
  scheduleJob("task-sync", envInt("TASK_SYNC_INTERVAL_MS", 15 * 60_000), () => runTaskSync(syncDeps(deps.pool, deps.internalSecret)), { pool: deps.pool, firstRunMs: 2 * 60_000 });
  // The integrations hub (integrations/hub.ts): pull and merge requests that name a task's code, in the repositories
  // the admin picked. Nothing is asked of anyone while no connection lists a repository.
  scheduleJob("integration-scan", envInt("INTEGRATION_SCAN_INTERVAL_MS", 10 * 60_000), () => scanRepos(hubDeps(deps.pool)), { pool: deps.pool, firstRunMs: 3 * 60_000 });
  // The words of Drive files and attachments, for search and AI retrieval (knowledge.ts): a few files a minute,
  // never while someone waits.
  scheduleJob("file-texts", envInt("FILE_TEXT_INTERVAL_MS", 60_000), () => readFileTexts(deps.pool, deps.storage), { pool: deps.pool, firstRunMs: 45_000 });
  scheduleProcessedEventsPrune(deps.pool, envInt("PROCESSED_EVENTS_RETENTION_DAYS", 30));
  return app.getHttpAdapter().getInstance() as RequestListener;
}

/**
 * Deletes activity rows older than `days` through work_activity_prune. Batches of 5,000, at most `maxBatches` per
 * run, so one run never holds a long transaction and still clears far more than a day's inserts.
 */
export async function pruneActivity(pool: Pool, days: number, maxBatches = 20): Promise<number> {
  let total = 0;
  for (let i = 0; i < maxBatches; i++) {
    const r = await pool.query<{ n: number }>("SELECT work_activity_prune($1, 5000) AS n", [days]);
    const n = r.rows[0]?.n ?? 0;
    total += n;
    if (n < 5000) break;
  }
  return total;
}
