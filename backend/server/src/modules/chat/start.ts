import { join } from "node:path";
import type { RequestListener, Server as HttpServer } from "node:http";
import { payloadOf } from "@workspace/contracts";
import { envInt, logger, migrate, watchPool, scheduleJob, scheduleProcessedEventsPrune, startConsumer, startEvents, type ModuleContext } from "@workspace/service-kit";
import { sweepChatFiles } from "./files.js";
import { pruneCollabDrafts } from "./collab.js";
import { pruneWhiteboardDrafts } from "./whiteboard-collab.js";
import { sendScheduled } from "./scheduled.js";
import { createChatApp, depsFromEnv } from "./app.js";
import { handleOnboardingEvent, ONBOARDING_TOPICS } from "./onboarding.js";
import { handleUnfurlEvent, pruneLinkPreviews, UNFURL_TOPICS } from "./unfurl.js";

/**
 * Chat: channels, messages, threads, calls, and Socket.IO on the shared HTTP server (schema `chat`).
 * Returns the HTTP handler and a shutdown that closes the sockets.
 */
export async function startChat(ctx: ModuleContext, http: HttpServer): Promise<{ handler: RequestListener; close: () => Promise<void> }> {
  await migrate(ctx.ownerUrl, join(ctx.migrations, "chat"), "chat");
  const deps = depsFromEnv();
  watchPool(deps.pool, "chat");
  const { handler, realtime } = await createChatApp(deps, { http });
  const bus = ctx.bus;
  await startEvents({ pool: deps.pool, bus, listenUrl: ctx.ownerUrl, retentionDays: envInt("EVENT_RETENTION_DAYS", 3) });
  await startConsumer({
    bus,
    groupId: "chat-onboarding",
    topics: ONBOARDING_TOPICS,
    pool: deps.pool,
    handle: async (e, c) => {
      await handleOnboardingEvent(e, c);
      if (e.eventType === "identity.member.disabled.v1") realtime.disconnectUser(payloadOf(e, "identity.member.disabled.v1").userId);
    },
  });
  // Link previews, after the message is posted (unfurl.ts): the fetch never holds up sending.
  await startConsumer({
    bus,
    groupId: "chat-unfurl",
    topics: UNFURL_TOPICS,
    pool: deps.pool,
    handle: (e, c) => handleUnfurlEvent(e, c, (channelId, data) => realtime.toChannel(channelId, "message.previews", data)),
  });
  scheduleJob("link-previews-prune", 24 * 3600_000, () => pruneLinkPreviews(deps.pool), { pool: deps.pool, firstRunMs: 10 * 60_000 });
  scheduleJob("chat-file-sweep", 15 * 60_000, () => sweepChatFiles(deps.pool, deps.storage), { pool: deps.pool });
  // Docs and whiteboard drafts nobody reopened within a day (collab.ts, whiteboard-collab.ts); those still open are
  // renewed first.
  scheduleJob(
    "collab-prune",
    3600_000,
    async () => {
      await realtime.collab?.renewOpen();
      await realtime.whiteboards?.renewOpen();
      return (await pruneCollabDrafts(deps.pool)) + (await pruneWhiteboardDrafts(deps.pool));
    },
    { pool: deps.pool, firstRunMs: 5 * 60_000 },
  );
  // "Gửi sau": scheduled messages go out within 20 seconds of their time.
  scheduleJob("scheduled-messages", 20_000, () => sendScheduled(deps.pool, (channelId, m) => realtime.toChannel(channelId, "message.created", m)), {
    pool: deps.pool,
  });
  scheduleProcessedEventsPrune(deps.pool, envInt("PROCESSED_EVENTS_RETENTION_DAYS", 30));
  return {
    handler: handler as unknown as RequestListener,
    close: () =>
      new Promise((resolve) => {
        logger.info("closing sockets");
        realtime.io.close(() => resolve());
      }),
  };
}
