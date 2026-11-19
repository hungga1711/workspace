import "reflect-metadata";
import { MiddlewareConsumer, Module, NestModule, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import pg from "pg";
import { env, ErrorFilter, principalMiddleware, appMailer, type Mailer } from "@workspace/service-kit";
import { AttentionController } from "./attention.js";
import { ApiKeysController } from "./apikeys.js";
import { OAuthController } from "./oauth.js";
import { SecurityController } from "./security.js";
import { IdentityController, POOL, USERS } from "./identity.controller.js";
import { ACCOUNTS, AccountsController } from "./accounts.controller.js";
import { AdminAccountsController } from "./admin-accounts.js";
import { SearchFeedController } from "./search-feed.js";
import { MembersSummaryController } from "./members-summary.controller.js";
import { ProfileController } from "./profile.controller.js";
import { AUTH, AuthController } from "./auth/auth.controller.js";
import { SigningKeys } from "./auth/keys.js";
import { AuthService } from "./auth/sessions.js";
import { UserDirectory } from "./auth/users.js";

export interface IdentityDeps {
  pool: pg.Pool;
  users: UserDirectory;
  auth: AuthService;
  keys: SigningKeys;
  internalSecret: string;
  mailer: Mailer;
  appUrl: string;
}

export async function createIdentityApp(deps: IdentityDeps): Promise<INestApplication> {
  // The public keys are public: the gateway fetches them without a principal.
  const Principal = principalMiddleware(deps.internalSecret, ["/health", "/internal/auth/jwks"]);
  @Module({
    controllers: [
      AuthController,
      ApiKeysController,
      AttentionController,
      OAuthController,
      SecurityController,
      MembersSummaryController,
      ProfileController,
      IdentityController,
      AccountsController,
      AdminAccountsController,
      SearchFeedController,
    ],
    providers: [
      { provide: POOL, useValue: deps.pool },
      { provide: USERS, useValue: deps.users },
      { provide: AUTH, useValue: { pool: deps.pool, auth: deps.auth, keys: deps.keys } },
      { provide: ACCOUNTS, useValue: { pool: deps.pool, users: deps.users, mailer: deps.mailer, appUrl: deps.appUrl } },
    ],
  })
  class IdentityModule implements NestModule {
    configure(consumer: MiddlewareConsumer) {
      consumer.apply(Principal).forRoutes("*");
    }
  }
  const app = await NestFactory.create(IdentityModule, { logger: ["error", "warn"] });
  app.useGlobalFilters(new ErrorFilter());
  return app;
}

export function depsFromEnv(): IdentityDeps {
  const pool = new pg.Pool({ connectionString: env("IDENTITY_DATABASE_URL", "postgres://workspace_identity:app_pw@localhost:5432/workspace"), max: 10 });
  const users = new UserDirectory(pool);
  const keys = new SigningKeys(pool);
  return {
    pool,
    users,
    keys,
    auth: new AuthService(pool, keys, users),
    internalSecret: env("INTERNAL_TOKEN_SECRET", "dev-internal-secret-change-me-32bytes!"),
    mailer: appMailer(),
    appUrl: env("APP_URL", "http://localhost:3000"),
  };
}
