import { MentionController } from "./mention.js";
import "reflect-metadata";
import { MiddlewareConsumer, Module, NestModule, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import pg from "pg";
import { env, ErrorFilter, moduleUrl, principalMiddleware, ServiceClient, type ModuleName } from "@workspace/service-kit";
import { AiController, DEPS } from "./ai.controller.js";
import { AssistController } from "./assist.js";
import { ActivityController } from "./activity.js";
import { MeInsightsController } from "./me-insights.js";
import { MonitorIntakeController } from "./monitor-intake.js";
import { SafetyController } from "./safety.controller.js";
import type { ModelProvider } from "./providers.js";
import { WorkspaceGateway } from "./workspace-gateway.js";
import { ConnectionsController } from "./connections.controller.js";
import { SpendController } from "./spend.controller.js";
import { TopicsController } from "./topics.js";
import { LibraryController } from "./library.js";
import { CapabilityController } from "./capability.js";
import { AttentionController } from "./attention.js";
import { ImportsController } from "./imports.js";
import { ReportController } from "./report.js";
import { WhiteboardAiController } from "./whiteboard.js";
import { ProgressBriefController } from "./progress-brief.js";
import { AdoptionController } from "./adoption.js";
import { AdoptionPeopleController } from "./adoption-people.js";
import { SpendModelsController } from "./spend-models.js";
import { McpController } from "./mcp/controller.js";
import { TaskChatController } from "./task-chat.js";
import { TaskWriteController } from "./task-write.js";
import { LocalUsageController } from "./local-usage.js";
import { LocalConnectController } from "./local-connect.js";
import type { Deps } from "./runtime.js";
import { requireAiConfigured } from "./status.js";
import { personalAiMiddleware } from "./personal-ai.js";

export async function createAiApp(deps: Deps, internalSecret: string): Promise<INestApplication> {
  const Principal = principalMiddleware(internalSecret);
  @Module({
    controllers: [
      AiController,
      MentionController,
      AssistController,
      ActivityController,
      MeInsightsController,
      MonitorIntakeController,
      SafetyController,
      ConnectionsController,
      SpendController,
      TopicsController,
      LibraryController,
      CapabilityController,
      AttentionController,
      ImportsController,
      ReportController,
      WhiteboardAiController,
      ProgressBriefController,
      AdoptionController,
      AdoptionPeopleController,
      SpendModelsController,
      McpController,
      TaskChatController,
      TaskWriteController,
      LocalUsageController,
      LocalConnectController,
    ],
    providers: [{ provide: DEPS, useValue: deps }],
  })
  class AiModule implements NestModule {
    configure(consumer: MiddlewareConsumer) {
      consumer.apply(Principal).forRoutes("*");
      // A person's own AI, when they chose one and that computer is on: for their own request only.
      consumer.apply(personalAiMiddleware(deps.pool)).forRoutes("*");
      // Generation endpoints refuse cleanly without a provider; monitoring and oversight never do.
      consumer.apply(requireAiConfigured(deps.provider)).forRoutes("*");
    }
  }
  const app = await NestFactory.create<NestExpressApplication>(AiModule, { logger: ["error", "warn"] });
  app.useGlobalFilters(new ErrorFilter());
  // Hỏi đáp's questions carry images and files (the gateway still caps every other route at 1 MB).
  app.useBodyParser("json", { limit: "12mb" });
  return app;
}

/** Without an injected provider, the workspace gateway: env vendors plus the connections set in Admin › AI. */
export function depsFromEnv(provider?: ModelProvider): { deps: Deps; secret: string } {
  const secret = env("INTERNAL_TOKEN_SECRET", "dev-internal-secret-change-me-32bytes!");
  const pool = new pg.Pool({ connectionString: env("AI_DATABASE_URL", "postgres://workspace_ai:app_pw@localhost:5432/workspace"), max: 10 });
  const svc = (name: ModuleName, grants: { permission: string; scope: "PLATFORM" }[] = []) => new ServiceClient(moduleUrl(name), secret, "ai", grants);
  return {
    secret,
    deps: {
      pool,
      provider: provider ?? new WorkspaceGateway(pool),
      identity: svc("identity", [{ permission: "principal.resolve", scope: "PLATFORM" }]),
      platform: svc("platform", [{ permission: "principal.resolve", scope: "PLATFORM" }]),
      home: svc("home", [{ permission: "principal.resolve", scope: "PLATFORM" }]),
      services: {
        chat: svc("chat", [{ permission: "agent.post", scope: "PLATFORM" }]),
        // agent.post: the assistant's answer to an @AI in a task's comments is posted there marked "AI".
        work: svc("work", [{ permission: "agent.post", scope: "PLATFORM" }]),
        employee: svc("employee"),
        // The ai module itself (in-process), so tools read AI oversight with the asker's own scope (team_ai_usage).
        ai: svc("ai"),
        // The home module: "remind me" reminders the assistant sets (schedule_reminder).
        home: svc("home"),
        // The members' emails (the directory has none): an import matches its people by email first.
        identity: svc("identity"),
      },
    },
  };
}
