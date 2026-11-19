import "reflect-metadata";
import { MiddlewareConsumer, Module, NestModule, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import pg from "pg";
import { moduleUrl, env, principalMiddleware, ErrorFilter, ServiceClient } from "@workspace/service-kit";
import { IDENTITY, POOL } from "./common.js";
import { PlatformController } from "./platform.controller.js";
import { AttentionController } from "./attention.js";
import { WebhooksController, type WebhookOptions } from "./webhooks.js";
import { LogoController } from "./logo.js";
import { AuditController } from "./audit/audit.controller.js";
import { ClientErrorsController } from "./client-errors.js";

export interface PlatformDeps {
  pool: pg.Pool;
  identity: ServiceClient;
  internalSecret: string;
  webhooks?: WebhookOptions;
}

export async function createPlatformApp(deps: PlatformDeps): Promise<INestApplication> {
  // `/logo`: the workspace logo is shown on the sign-in page, before anyone has a principal.
  const Principal = principalMiddleware(deps.internalSecret, ["/health", "/setup", "/logo"]);
  @Module({
    controllers: [AttentionController, WebhooksController, PlatformController, LogoController, AuditController, ClientErrorsController],
    providers: [
      { provide: POOL, useValue: deps.pool },
      { provide: IDENTITY, useValue: deps.identity },
      { provide: "WEBHOOK_OPTIONS", useValue: deps.webhooks ?? { allowPrivate: false } },
    ],
  })
  class PlatformModule implements NestModule {
    configure(consumer: MiddlewareConsumer) {
      consumer.apply(Principal).forRoutes("*");
    }
  }
  const app = await NestFactory.create<NestExpressApplication>(PlatformModule, { logger: ["error", "warn"] });
  // A logo upload is up to 256 KB of image as base64 (about 350 KB of JSON), over Nest's 100 KB default.
  app.useBodyParser("json", { limit: "1mb" });
  app.useGlobalFilters(new ErrorFilter());
  return app;
}

export function depsFromEnv(): PlatformDeps {
  const secret = env("INTERNAL_TOKEN_SECRET", "dev-internal-secret-change-me-32bytes!");
  return {
    pool: new pg.Pool({ connectionString: env("PLATFORM_DATABASE_URL", "postgres://workspace_platform:app_pw@localhost:5432/workspace"), max: 10 }),
    identity: new ServiceClient(moduleUrl("identity"), secret, "platform", [
      { permission: "workspace.provision", scope: "PLATFORM" },
      { permission: "principal.resolve", scope: "PLATFORM" },
    ]),
    internalSecret: secret,
    // Only for local development and tests: lets webhooks target http:// and private addresses.
    webhooks: { allowPrivate: process.env.WEBHOOK_ALLOW_PRIVATE === "1" },
  };
}
