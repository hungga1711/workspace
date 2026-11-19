import "reflect-metadata";
import { MiddlewareConsumer, Module, NestModule, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import pg from "pg";
import { moduleUrl, env, principalMiddleware, ErrorFilter, ServiceClient } from "@workspace/service-kit";
import { AI, HomeController, POOL } from "./home.controller.js";

export interface HomeDeps {
  pool: pg.Pool;
  ai: ServiceClient | null;
  internalSecret: string;
}

export async function createHomeApp(deps: HomeDeps): Promise<INestApplication> {
  const Principal = principalMiddleware(deps.internalSecret);
  @Module({
    controllers: [HomeController],
    providers: [
      { provide: POOL, useValue: deps.pool },
      { provide: AI, useValue: deps.ai },
    ],
  })
  class HomeModule implements NestModule {
    configure(consumer: MiddlewareConsumer) {
      consumer.apply(Principal).forRoutes("*");
    }
  }
  const app = await NestFactory.create(HomeModule, { logger: ["error", "warn"] });
  app.useGlobalFilters(new ErrorFilter());
  return app;
}

export function depsFromEnv(): HomeDeps {
  const secret = env("INTERNAL_TOKEN_SECRET", "dev-internal-secret-change-me-32bytes!");
  return {
    pool: new pg.Pool({ connectionString: env("HOME_DATABASE_URL", "postgres://workspace_home:app_pw@localhost:5432/workspace"), max: 10 }),
    ai: new ServiceClient(moduleUrl("ai"), secret, "home", [], { timeoutMs: 40_000 }),
    internalSecret: secret,
  };
}
