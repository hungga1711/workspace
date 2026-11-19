import "reflect-metadata";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { MiddlewareConsumer, Module, NestModule, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { createServer, type Server as HttpServer } from "node:http";
import pg from "pg";
import express from "express";
import { ExpressAdapter } from "@nestjs/platform-express";
import { moduleUrl, env, type ObjectStorage, principalMiddleware, ErrorFilter, searchPool, storageFromEnv } from "@workspace/service-kit";
import { CFG, CHAT_CONTROLLERS, POOL, REALTIME, SEARCH, STORAGE } from "./http/index.js";
import { Realtime } from "./realtime.js";
import { CALLS_DEPS, CallsController } from "./calls.js";
import { SearchFeedController } from "./search-feed.js";

export interface ChatDeps {
  pool: pg.Pool;
  /** The search database, read-only here (the search module writes it). */
  searchPool: pg.Pool;
  internalSecret: string;
  corsOrigin: string[];
  storage: ObjectStorage;
  workUrl: string;
}

/**
 * The chat module. Socket.IO attaches to `opts.http`, the server's shared HTTP server; without it the module gets
 * a server of its own (tests).
 */
export async function createChatApp(
  deps: ChatDeps,
  opts: { http?: HttpServer } = {},
): Promise<{ app: INestApplication; realtime: Realtime; handler: express.Express; listen: (port: number) => Promise<number> }> {
  const server = express();
  const http = opts.http ?? createServer(server);
  const realtime = new Realtime(http, deps.pool, deps.internalSecret, deps.corsOrigin, { workUrl: deps.workUrl, internalSecret: deps.internalSecret });
  const Principal = principalMiddleware(deps.internalSecret);
  @Module({
    controllers: [...CHAT_CONTROLLERS, CallsController, SearchFeedController],
    providers: [
      { provide: POOL, useValue: deps.pool },
      { provide: REALTIME, useValue: realtime },
      { provide: SEARCH, useValue: deps.searchPool },
      { provide: STORAGE, useValue: deps.storage },
      { provide: CFG, useValue: { workUrl: deps.workUrl, internalSecret: deps.internalSecret } },
      { provide: CALLS_DEPS, useValue: { pool: deps.pool, rt: realtime, workUrl: deps.workUrl, internalSecret: deps.internalSecret } },
    ],
  })
  class ChatModule implements NestModule {
    configure(consumer: MiddlewareConsumer) {
      consumer.apply(Principal).forRoutes("*");
    }
  }
  const app = await NestFactory.create<NestExpressApplication>(ChatModule, new ExpressAdapter(server), { logger: ["error", "warn"] });
  // Slack history imports arrive in one request per channel; the gateway caps every other route at 1 MB.
  app.useBodyParser("json", { limit: "25mb" });
  app.useGlobalFilters(new ErrorFilter());
  await app.init();
  return {
    app,
    realtime,
    handler: server,
    listen: (port) => new Promise((resolve) => http.listen(port, () => resolve((http.address() as { port: number }).port))),
  };
}

export function depsFromEnv(): ChatDeps {
  return {
    pool: new pg.Pool({ connectionString: env("CHAT_DATABASE_URL", "postgres://workspace_chat:app_pw@localhost:5432/workspace"), max: 15 }),
    searchPool: searchPool(env("CHAT_SEARCH_DATABASE_URL", "postgres://workspace_chat:app_pw@localhost:5432/workspace"), 10),
    internalSecret: env("INTERNAL_TOKEN_SECRET", "dev-internal-secret-change-me-32bytes!"),
    corsOrigin: env("WEB_ORIGIN", "http://localhost:3000").split(","),
    storage: storageFromEnv(env),
    workUrl: moduleUrl("work"),
  };
}
