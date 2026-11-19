import "reflect-metadata";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { MiddlewareConsumer, Module, NestModule, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import pg from "pg";
import { moduleUrl, env, type ObjectStorage, principalMiddleware, ErrorFilter, ServiceClient, storageFromEnv } from "@workspace/service-kit";
import { AI, AI_STEPS, CHAT, EMPLOYEE, HUB, MEET, POOL, STORAGE, TASK_SYNC, WORKFLOWS, WORK_CONTROLLERS } from "./http/index.js";
import { hubDeps, type HubDeps } from "./integrations/hub.js";
import type { Principal } from "@workspace/shared";
import type { Engine } from "./workflows.js";
import { syncDeps } from "./task-sync/deps.js";
import type { SyncDeps } from "./task-sync/sync.js";
import { GOALS_POOL, GoalsController } from "./goals.js";
import { SearchFeedController } from "./search-feed.js";
import { meetConfigFromEnv, type MeetConfig } from "./rooms.js";

export interface WorkDeps {
  pool: pg.Pool;
  storage: ObjectStorage;
  internalSecret: string;
  /** null: no LiveKit on this server (meetConfigFromEnv). */
  meet?: MeetConfig | null;
  /** The employee module, asked as the caller for their reporting line (follow-up views). */
  employee?: ServiceClient;
  /** The ai module, asked as the caller for the weekly report's AI section. */
  ai?: ServiceClient;
  /** The chat module, asked as the caller for search (a task's related documents and messages). */
  chat?: Pick<ServiceClient, "request">;
  /** Task sync: fetch and the identity lookup (tests pass recorded responses). */
  taskSync?: SyncDeps;
  /** The integrations hub: the fenced request and preview fetch (tests pass recorded answers). */
  hub?: Pick<HubDeps, "request" | "image">;
  /** A member's principal by id, for agent runs that go on with nobody's request at hand (default: the identity module). */
  resolvePrincipal?: (userId: string) => Promise<Principal>;
}

/**
 * What the agent workflow engine works with (workflows.ts). The ai module is asked with a long timeout: a step on a
 * self-hosted model can take minutes, and each step's own time limit is enforced by the engine.
 */
export function workflowEngine(deps: WorkDeps): Engine {
  const identity = new ServiceClient(moduleUrl("identity"), deps.internalSecret, "work", [{ permission: "principal.resolve", scope: "PLATFORM" }]);
  return {
    pool: deps.pool,
    ai: deps.ai ?? new ServiceClient(moduleUrl("ai"), deps.internalSecret, "work", [], { timeoutMs: 30 * 60_000 }),
    storage: deps.storage,
    resolve: deps.resolvePrincipal ?? ((userId) => identity.request<Principal>("POST", "/internal/resolve", { userId })),
  };
}

export async function createWorkApp(deps: WorkDeps): Promise<INestApplication> {
  const Principal = principalMiddleware(deps.internalSecret);
  @Module({
    controllers: [...WORK_CONTROLLERS, GoalsController, SearchFeedController],
    providers: [
      { provide: POOL, useValue: deps.pool },
      { provide: GOALS_POOL, useValue: deps.pool },
      { provide: STORAGE, useValue: deps.storage },
      { provide: MEET, useValue: deps.meet === undefined ? meetConfigFromEnv(env) : deps.meet },
      { provide: EMPLOYEE, useValue: deps.employee ?? new ServiceClient(moduleUrl("employee"), deps.internalSecret, "work", []) },
      { provide: AI, useValue: deps.ai ?? new ServiceClient(moduleUrl("ai"), deps.internalSecret, "work", []) },
      { provide: CHAT, useValue: deps.chat ?? new ServiceClient(moduleUrl("chat"), deps.internalSecret, "work", [], { timeoutMs: 5_000 }) },
      // An agent workflow's AI step can take minutes on a self-hosted model; only those calls wait that long.
      { provide: TASK_SYNC, useValue: deps.taskSync ?? syncDeps(deps.pool, deps.internalSecret) },
      { provide: HUB, useValue: { ...hubDeps(deps.pool), ...deps.hub } },
      { provide: AI_STEPS, useValue: deps.ai ?? new ServiceClient(moduleUrl("ai"), deps.internalSecret, "work", [], { timeoutMs: 5 * 60_000 }) },
      { provide: WORKFLOWS, useValue: workflowEngine(deps) },
    ],
  })
  class WorkModule implements NestModule {
    configure(consumer: MiddlewareConsumer) {
      consumer.apply(Principal).forRoutes("*");
    }
  }
  const app = await NestFactory.create<NestExpressApplication>(WorkModule, { logger: ["error", "warn"] });
  // Task imports (Jira, Trello, CSV) can exceed Nest's 100 kB default; the gateway caps every other route at 1 MB.
  app.useBodyParser("json", { limit: "25mb" });
  app.useGlobalFilters(new ErrorFilter());
  return app;
}

export function depsFromEnv(): WorkDeps & { storage: ReturnType<typeof storageFromEnv> } {
  return {
    pool: new pg.Pool({ connectionString: env("WORK_DATABASE_URL", "postgres://workspace_work:app_pw@localhost:5432/workspace"), max: 15 }),
    storage: storageFromEnv(env),
    internalSecret: env("INTERNAL_TOKEN_SECRET", "dev-internal-secret-change-me-32bytes!"),
    meet: meetConfigFromEnv(env),
  };
}
