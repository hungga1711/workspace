import "reflect-metadata";
import { MiddlewareConsumer, Module, NestModule, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import pg from "pg";
import { env, ErrorFilter, principalMiddleware } from "@workspace/service-kit";
import { EMPLOYEE_CONTROLLERS, POOL } from "./http/index.js";
import { AnnouncementsController } from "./announcements.js";
import { PeopleController } from "./people.js";

export async function createEmployeeApp(deps: { pool: pg.Pool; internalSecret: string }): Promise<INestApplication> {
  const Principal = principalMiddleware(deps.internalSecret);
  @Module({
    controllers: [PeopleController, ...EMPLOYEE_CONTROLLERS, AnnouncementsController],
    providers: [{ provide: POOL, useValue: deps.pool }],
  })
  class EmployeeModule implements NestModule {
    configure(consumer: MiddlewareConsumer) {
      consumer.apply(Principal).forRoutes("*");
    }
  }
  const app = await NestFactory.create(EmployeeModule, { logger: ["error", "warn"] });
  app.useGlobalFilters(new ErrorFilter());
  return app;
}

export function depsFromEnv() {
  return {
    pool: new pg.Pool({ connectionString: env("EMPLOYEE_DATABASE_URL", "postgres://workspace_employee:app_pw@localhost:5432/workspace"), max: 10 }),
    internalSecret: env("INTERNAL_TOKEN_SECRET", "dev-internal-secret-change-me-32bytes!"),
  };
}
