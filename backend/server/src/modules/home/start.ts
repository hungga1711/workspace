import { join } from "node:path";
import type { RequestListener } from "node:http";
import {
  env,
  envInt,
  logger,
  migrate,
  moduleUrl,
  watchPool,
  scheduleJob,
  scheduleProcessedEventsPrune,
  ServiceClient,
  appMailer,
  startConsumer,
  type ModuleContext,
} from "@workspace/service-kit";
import type { Principal } from "@workspace/shared";
import { sendDigests, type MeLoader, type TeamLoader, type TeamSummary } from "./digest.js";
import { sendDueReminders, sendPersonalReminders } from "./reminders.js";
import { createHomeApp, depsFromEnv } from "./app.js";
import { HOME_TOPICS, project } from "./projector.js";
import { sendInstantPushes, sendMorningPushes, webPushSender, type QuickLoader } from "./push.js";
import { DEFAULT_RETENTION, runHomeRetention } from "./retention.js";

/** Home: notifications, the Home feed and brief, reminders, push and email digests (schema `home`). */
export async function startHome(ctx: ModuleContext): Promise<RequestListener> {
  await migrate(ctx.ownerUrl, join(ctx.migrations, "home"), "home");
  const deps = depsFromEnv();
  watchPool(deps.pool, "home");
  const app = await createHomeApp(deps);
  await app.init();
  await startConsumer({ bus: ctx.bus, groupId: "home-projector", topics: HOME_TOPICS, pool: deps.pool, handle: project });
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    const sender = webPushSender({
      subject: env("VAPID_SUBJECT", "mailto:ops@workspace.local"),
      publicKey: process.env.VAPID_PUBLIC_KEY,
      privateKey: process.env.VAPID_PRIVATE_KEY,
    });
    scheduleJob("morning-push", 5 * 60_000, () => sendMorningPushes(deps.pool, sender), { pool: deps.pool });
    // A push about a waiting agent run may carry buttons: the work module makes them, for people who allow it.
    const quickWork = new ServiceClient(moduleUrl("work"), env("INTERNAL_TOKEN_SECRET", "dev-internal-secret-change-me-32bytes!"), "home", [
      { permission: "run.quick_action", scope: "PLATFORM" },
    ]);
    const quick: QuickLoader = (userId, ref) => quickWork.request("POST", "/internal/quick-actions", { userId, ...ref });
    scheduleJob("instant-push", 15_000, () => sendInstantPushes(deps.pool, sender, 500, quick), { pool: deps.pool });
  } else {
    logger.warn("VAPID keys not set: push disabled (the inbox still receives the brief and every notice)");
    // No web push: queued notices are just drained.
    scheduleJob("instant-push", 60_000, () => sendInstantPushes(deps.pool, { send: async () => ({ statusCode: 0 }) }), { pool: deps.pool });
  }
  // Daily email digest (fallback channel): checked every 5 minutes, sent once per local day.
  const mailer = appMailer();
  // Monday digests carry a manager's team: the Follow-up view, read with that manager's own permissions.
  const secret = env("INTERNAL_TOKEN_SECRET", "dev-internal-secret-change-me-32bytes!");
  const identity = new ServiceClient(moduleUrl("identity"), secret, "home", [{ permission: "principal.resolve", scope: "PLATFORM" }]);
  const work = new ServiceClient(moduleUrl("work"), secret, "home", []);
  const loadTeam: TeamLoader = async (userId) => {
    const principal = await identity.request<Principal>("POST", "/internal/resolve", { userId });
    const team = await work.request<TeamSummary & { scope: string }>("GET", "/followup/team", undefined, principal);
    return team.scope === "none" ? null : team;
  };
  const loadMe: MeLoader = async (userId) => {
    const principal = await identity.request<Principal>("POST", "/internal/resolve", { userId });
    return (await work.request<{ me: { done7: number; inProgress: number; overdue: number } | null }>("GET", "/followup/me", undefined, principal)).me;
  };
  // Without email the digest has nowhere to go: the job skips its run, and starts working as soon as an admin saves
  // SMTP settings in the app (no restart).
  scheduleJob("email-digest", 5 * 60_000, () => sendDigests(deps.pool, mailer, env("APP_URL", "http://localhost:3000"), 500, loadTeam, undefined, loadMe), {
    pool: deps.pool,
    when: () => mailer.configured !== false,
  });
  // Due-soon reminders: checked every 5 minutes; each task is reminded once per due date.
  scheduleJob("due-reminders", 5 * 60_000, () => sendDueReminders(deps.pool), { pool: deps.pool });
  // "Nhắc tôi": checked every 30 seconds so a reminder lands within half a minute of the time picked.
  scheduleJob("personal-reminders", 30_000, () => sendPersonalReminders(deps.pool), { pool: deps.pool });
  scheduleProcessedEventsPrune(deps.pool, envInt("PROCESSED_EVENTS_RETENTION_DAYS", 30));
  // Retention (daily, batched): read notifications go after 90 days, unread ones after 180, resolved home items
  // after 180, activity after 365 (all overridable). The deletes run through SECURITY DEFINER functions: as the
  // module role they would see no rows at all.
  const retention = {
    notificationsRead: envInt("NOTIFICATIONS_READ_RETENTION_DAYS", DEFAULT_RETENTION.notificationsRead),
    notificationsUnread: envInt("NOTIFICATIONS_UNREAD_RETENTION_DAYS", DEFAULT_RETENTION.notificationsUnread),
    homeItems: envInt("HOME_ITEMS_RETENTION_DAYS", DEFAULT_RETENTION.homeItems),
    activity: envInt("ACTIVITY_RETENTION_DAYS", DEFAULT_RETENTION.activity),
    pushRecent: envInt("PUSH_RECENT_RETENTION_DAYS", DEFAULT_RETENTION.pushRecent),
  };
  scheduleJob("home-retention", 24 * 3600_000, () => runHomeRetention(deps.pool, retention), { pool: deps.pool, firstRunMs: 5 * 60_000 });
  return app.getHttpAdapter().getInstance() as RequestListener;
}
