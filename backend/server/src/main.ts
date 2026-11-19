import { createServer, type RequestListener } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertProductionSecrets,
  drain,
  env,
  envInt,
  eventBus,
  LocalStorage,
  localFilesHandler,
  logger,
  migrate,
  moduleRouter,
  moduleUrl,
  scheduleDeadLetterReplays,
  type ModuleName,
  serveInProcess,
  storageDriver,
  storageFromEnv,
  useJobLocks,
} from "@workspace/service-kit";
import { DISABLED_FEATURES_ENV, parseDisabledFeatures } from "@workspace/shared";
import { startAi } from "./modules/ai/start.js";
import { startChat } from "./modules/chat/start.js";
import { startEmployee } from "./modules/employee/start.js";
import { startGateway } from "./modules/gateway/start.js";
import { startHome } from "./modules/home/start.js";
import { startIdentity } from "./modules/identity/start.js";
import { startPlatform } from "./modules/platform/start.js";
import { startSearch } from "./modules/search/start.js";
import { startWork } from "./modules/work/start.js";

/**
 * The backend (ADR 0021): one process hosting every module. This file only composes them; each module keeps its
 * folder, schema, Postgres role, migrations, Nest app, events, jobs and HTTP API, and reaches the others through
 * `ServiceClient` (in memory, `serviceFetch`) or events, never by importing their code.
 *
 * One public port (PORT): Socket.IO at `/socket.io`, local files at `/storage/`, everything else through the
 * gateway (`/api/…`). The modules' own APIs (`/<module>/…`) are not public: they listen on INTERNAL_PORT, on
 * the loopback interface only, for tools and tests (requests still need a signed principal).
 */
// Development secrets never reach a production process; LiveKit and S3 keys only matter once configured.
assertProductionSecrets([
  { name: "LIVEKIT_API_SECRET", devDefault: "workspace-dev-livekit-secret-change-me-32b", minLength: 32, when: !!process.env.LIVEKIT_URL },
  { name: "S3_SECRET_ACCESS_KEY", devDefault: "workspace_dev_secret", when: storageDriver() === "s3" },
]);
// Features this deployment runs without (ADR 0026). A name nobody knows is a typo to fix, never a reason to stop.
{
  const { disabled, unknown } = parseDisabledFeatures(process.env[DISABLED_FEATURES_ENV]);
  if (unknown.length) logger.warn({ unknown, variable: DISABLED_FEATURES_ENV }, "unknown feature names are ignored (chat and tasks cannot be switched off)");
  if (disabled.size) logger.info({ disabled: [...disabled] }, "features left out of this deployment");
}
const ownerUrl = env("OWNER_DATABASE_URL", "postgres://workspace_owner:owner_pw@localhost:5432/workspace");
useJobLocks(ownerUrl);
// migrations/ (one sub-directory per module schema): src/main.ts, dist/main.js and the production bundle all sit
// one level below it.
const ctx = { ownerUrl, bus: eventBus(), migrations: fileURLToPath(new URL("../migrations", import.meta.url)) };
// The web app's session store (schema `web`, reached only by the web app's own role): no module owns it, so it is
// migrated here with the modules' schemas.
await migrate(ownerUrl, join(ctx.migrations, "web"), "web");

// Socket.IO wraps the server's request listener when it attaches, so the listener exists before the modules start
// and forwards once the gateway is built.
let route: RequestListener = (_req, res) => void res.writeHead(503).end();
const server = createServer((req, res) => route(req, res));

// Each module is reachable in memory as soon as it has started, since a later one may call it while starting:
// identity and platform first (every module resolves principals through them), employee before work.
const hosted = async <H extends RequestListener>(name: ModuleName, start: Promise<H>): Promise<H> => {
  const handler = await start;
  serveInProcess(moduleUrl(name), handler);
  return handler;
};
const identity = await hosted("identity", startIdentity(ctx));
const platform = await hosted("platform", startPlatform(ctx));
await startSearch(ctx);
const chat = await startChat(ctx, server);
serveInProcess(moduleUrl("chat"), chat.handler);
const home = await hosted("home", startHome(ctx));
const employee = await hosted("employee", startEmployee(ctx));
const work = await hosted("work", startWork(ctx));
const ai = await hosted("ai", startAi(ctx));
// Every consumer group has subscribed: the outbox relays may deliver now (the server refuses to run if a group
// listed in @workspace/contracts has no handler). Replays the dlq CLI requests are delivered from here too.
ctx.bus.start({ requireAllGroups: true });
scheduleDeadLetterReplays(ctx.bus, ownerUrl);
const internal = moduleRouter([
  { name: "identity", handler: identity },
  { name: "platform", handler: platform },
  { name: "chat", handler: chat.handler },
  { name: "home", handler: home },
  { name: "employee", handler: employee },
  { name: "work", handler: work },
  { name: "ai", handler: ai },
]);

// Files on local disk (STORAGE_DRIVER=local): the signed /storage/<token> URLs every module hands out. CORS covers
// development, where the web app (:3000) and this server (:4000) are different origins.
const storage = storageFromEnv(env);
const files = storage instanceof LocalStorage ? localFilesHandler(storage, env("WEB_ORIGIN", process.env.APP_URL || "http://localhost:3000")) : null;
const gateway = startGateway();
route = (req, res) => (files && req.url?.startsWith("/storage/") ? files(req, res) : gateway(req, res));

const port = envInt("PORT", 4000);
const internalPort = envInt("INTERNAL_PORT", 4001);
await new Promise<void>((resolve) => server.listen(port, resolve));
const internalServer = createServer(internal);
await new Promise<void>((resolve) => internalServer.listen(internalPort, "127.0.0.1", resolve));
logger.info({ port, internalPort }, "workspace server listening");

// Restarts and deploys (`docker stop` waits 10 s): stop taking requests, close the sockets (clients reconnect), let
// the events, handlers and jobs in hand finish (service-kit lifecycle), then exit. Long-lived connections never end
// on their own, so the deadline is hard.
for (const sig of ["SIGTERM", "SIGINT"] as const)
  process.once(sig, () => {
    logger.info({ sig }, "workspace server shutting down");
    setTimeout(() => process.exit(0), 9000).unref();
    server.close();
    internalServer.close();
    void chat
      .close()
      .catch(() => undefined)
      .then(() => drain(8000))
      .then((complete) => {
        if (!complete) logger.warn("shutdown deadline reached; unfinished work is delivered again after the restart");
        process.exit(0);
      });
  });
