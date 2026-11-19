import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Post, Put, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { DEFAULT_TIME_ZONE, featureDisabled, getRequestContext, isTimeZone, newId, passwordProblem, runWithContext, withTransaction } from "@workspace/shared";
import { assertAllowed, parse, requirePrincipal, type ServiceClient } from "@workspace/service-kit";
import { WORKSPACE_NAME_MAX, defaultConfig, effectiveFeatures, meetEnabledFromEnv, readWorkspaceConfig, withCodeDefaults, workspaceConfigSchema } from "./config.js";
import { POOL, IDENTITY, isPlatform, audit, configChanges, emit } from "./common.js";
import { setupToken, setupTokenMatches, setupTokenRequired } from "./setup-token.js";

@Controller()
export class PlatformController {
  constructor(
    @Inject(POOL) private readonly pool: Pool,
    @Inject(IDENTITY) private readonly identity: ServiceClient,
  ) {}

  @Get("health")
  health() {
    return { ok: true };
  }

  /**
   * Whether the one workspace of this installation exists yet (the web shows first-run setup until it does), its
   * time zone and language (the web formats every date in the zone and falls back to the language for anyone
   * without a personal choice), and whether this server has video meetings. Public: none of it says anything
   * about the company's data.
   */
  @Get("setup")
  async setupStatus() {
    const config = (await this.pool.query<{ config: { timezone?: string; locale?: string; branding?: { logoUrl?: string | null } } }>("SELECT config FROM workspace_config"))
      .rows[0]?.config;
    const meet = meetEnabledFromEnv();
    // `tokenRequired`: the setup form asks for the first-run token (printed in the server log, or SETUP_TOKEN).
    return config
      ? // `logoUrl`: the sign-in page shows the company's logo (public, like the name on any email it sends).
        {
          setUp: true,
          timezone: config.timezone ?? DEFAULT_TIME_ZONE,
          locale: (["en", "vi", "zh", "es"] as const).find((l) => l === config.locale) ?? "en",
          meet,
          logoUrl: config.branding?.logoUrl ?? null,
        }
      : // `ai`: first-run setup offers no AI choices on a deployment without AI (DISABLED_FEATURES).
        { setUp: false, meet, tokenRequired: setupTokenRequired(), ai: !featureDisabled("ai") };
  }

  private async isSetUp(): Promise<boolean> {
    return ((await this.pool.query("SELECT 1 FROM workspace")).rowCount ?? 0) > 0;
  }

  /**
   * First-run setup: creates the installation's only workspace and its owner. A self-hosted
   * workspace holds exactly one workspace, so this refuses once one exists; everyone else joins by invitation.
   * The gateway calls this as a service principal after rate limiting.
   */
  @Post("signup")
  async signup(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    if (p.type !== "service" || !isPlatform(p, "workspace.signup")) throw new ForbiddenException("signup goes through the gateway");
    const b = parse(
      z.object({
        companyName: z.string().trim().min(2).max(WORKSPACE_NAME_MAX),
        ownerEmail: z.string().email(),
        ownerName: z.string().trim().min(1).max(80),
        password: z.string().min(8).max(128),
        teamType: z.enum(["product", "sales", "ops"]).default("product"),
        locale: z.enum(["en", "vi", "zh", "es"]).default("en"),
        timezone: z.string().refine(isTimeZone, "unknown time zone").default(DEFAULT_TIME_ZONE),
        // Where the company works (ISO 3166): holidays, default leave and currency follow it.
        country: z
          .string()
          .regex(/^[A-Z]{2}$/)
          .optional(),
        setupToken: z.string().max(200).optional(),
        // The two AI switches from the setup form. Absent (API callers, tests): off, except under
        // TEST_FIXTURES=1 (test installations), where the AI suites need them on without changing every fixture.
        aiAssistant: z.boolean().optional(),
        aiMonitoring: z.boolean().optional(),
        mode: z.enum(["full", "insights"]).optional(),
      }),
      body,
    );
    if (await this.isSetUp()) throw new ConflictException({ error: "already_set_up", message: "this installation already has its workspace" });
    // Whoever reaches /setup first owns the installation: in production that needs the operator's token.
    if (setupTokenRequired() && !setupTokenMatches(b.setupToken, await setupToken()))
      throw new ForbiddenException({ error: "setup_token", message: "the first-run setup token is missing or wrong" });
    // The owner's password follows the same rule as everyone else's (activation and reset already check it).
    const problem = passwordProblem(b.password);
    if (problem) throw new BadRequestException({ error: "weak_password", ...problem });
    const { exists } = await this.identity.request<{ exists: boolean }>("POST", "/internal/accounts/lookup", { email: b.ownerEmail });
    if (exists) throw new ConflictException({ error: "email_exists", message: "email already has an account" });
    return this.createWorkspace(req, b);
  }

  private async createWorkspace(
    req: Request,
    b: {
      companyName: string;
      ownerEmail: string;
      ownerName: string;
      password?: string | undefined;
      teamType: string;
      locale: "en" | "vi" | "zh" | "es";
      timezone?: string | undefined;
      country?: string | undefined;
      aiAssistant?: boolean | undefined;
      aiMonitoring?: boolean | undefined;
      mode?: "full" | "insights" | undefined;
    },
  ) {
    const testMode = process.env.TEST_FIXTURES === "1";
    // AI Insights only is pointless without the extension's records: choosing it turns monitoring on.
    const insights = b.mode === "insights";
    const ai = { assistant: b.aiAssistant ?? testMode, monitoring: insights || (b.aiMonitoring ?? testMode) };
    const config = defaultConfig(b.companyName, b.locale, b.timezone, ai, b.country ?? null, b.mode ?? "full");
    const actor = `signup:${b.ownerEmail}`;
    const ctx = { actorId: actor, requestId: req.requestId ?? newId() };
    await runWithContext(ctx, () =>
      withTransaction(this.pool, async (c) => {
        // The primary key is the constant `singleton`: two setups racing cannot both create a workspace.
        const r = await c.query("INSERT INTO workspace (name, status) VALUES ($1, 'provisioning') ON CONFLICT DO NOTHING", [b.companyName]);
        if (!r.rowCount) throw new ConflictException({ error: "already_set_up", message: "this installation already has its workspace" });
        await c.query("INSERT INTO workspace_config (version, config) VALUES (1, $1)", [JSON.stringify(config)]);
        await audit(c, actor, "workspace.create", "workspace", "workspace", {});
      }),
    );
    const { ownerUserId } = await this.identity.request<{ ownerUserId: string }>("POST", "/internal/workspace/bootstrap", {
      name: b.companyName,
      owner: { email: b.ownerEmail, displayName: b.ownerName, ...(b.password ? { password: b.password } : {}) },
    });
    await runWithContext(ctx, () =>
      withTransaction(this.pool, async (c) => {
        await c.query("UPDATE workspace SET status = 'active'");
        await emit(c, actor, "platform.workspace.created.v1", {
          name: b.companyName,
          timezone: config.timezone,
          // The chat module provisions #general, the welcome thread and starter channels from these.
          ownerUserId,
          ownerName: b.ownerName,
          teamType: b.teamType,
          locale: b.locale,
          // The welcome thread only mentions @AI when the company turned the assistant on.
          ai,
        });
      }),
    );
    return { ownerUserId };
  }

  @Get("workspace")
  async workspace(@Req() req: Request) {
    const p = requirePrincipal(req);
    assertAllowed(p, "workspace.read");
    return withTransaction(this.pool, async (c) => {
      const w = await c.query<{ name: string; status: string; created_at: Date }>("SELECT name, status, created_at FROM workspace");
      const cfg = await c.query<{ version: number; config: unknown }>("SELECT version, config FROM workspace_config");
      const workspace = w.rows[0];
      const conf = cfg.rows[0];
      if (!workspace || !conf) throw new NotFoundException("workspace not found");
      const config = readWorkspaceConfig(conf.config);
      return { workspace, configVersion: conf.version, config, features: effectiveFeatures(config) };
    });
  }

  /**
   * Workspace-scoped audit: configuration and module changes made here. Same filters as identity's audit: `before`,
   * `from`, `to`, `action` prefix, `limit` (≤ 1000).
   */
  @Get("workspace/audit")
  async workspaceAudit(@Req() req: Request, @Query() query: Record<string, string>) {
    const p = requirePrincipal(req);
    assertAllowed(p, "audit.read");
    const q = parse(auditQuery, query);
    return {
      entries: (
        await this.pool.query(
          `SELECT id, actor, action, resource, resource_id AS "resourceId", source, metadata, at FROM audit_log
          WHERE ($1::timestamptz IS NULL OR at < $1) AND ($2::timestamptz IS NULL OR at >= $2) AND ($3::timestamptz IS NULL OR at < $3)
            AND ($4::text IS NULL OR action LIKE $4 || '%')
          ORDER BY at DESC LIMIT $5`,
          [q.before ?? null, q.from ?? null, q.to ?? null, q.action ?? null, q.limit],
        )
      ).rows,
    };
  }

  /** Optimistic concurrency: the caller sends the version it edited. */
  @Put("workspace/config")
  async updateConfig(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "workspace.configure");
    const b = parse(z.object({ version: z.number().int().positive(), config: z.preprocess(withCodeDefaults, workspaceConfigSchema) }), body);
    return withTransaction(this.pool, async (c) => {
      // The logo has its own endpoints (logo.ts): a settings form loaded before an upload must not put the old URL back.
      const stored = (await c.query<{ config: unknown }>("SELECT config FROM workspace_config")).rows[0];
      if (stored) b.config.branding.logoUrl = readWorkspaceConfig(stored.config).branding.logoUrl;
      const changes = stored ? configChanges(readWorkspaceConfig(stored.config), b.config) : {};
      const r = await c.query("UPDATE workspace_config SET config = $1, version = version + 1, updated_at = now() WHERE version = $2 RETURNING version", [
        JSON.stringify(b.config),
        b.version,
      ]);
      if (!r.rowCount) throw new ConflictException("config changed since you loaded it; reload and retry");
      const { actorId } = getRequestContext();
      await audit(c, actorId, "workspace.config_update", "workspace", "workspace", { version: r.rows[0].version }, { changes });
      await emit(c, actorId, "platform.workspace.config_changed.v1", { version: r.rows[0].version, config: b.config });
      return { version: r.rows[0].version as number };
    });
  }

  @Get("master-data/:kind")
  async masterData(@Param("kind") kind: string) {
    const v = await this.pool.query<{ version: number }>("SELECT version FROM master_data_versions WHERE kind = $1", [kind]);
    if (!v.rowCount) throw new NotFoundException("unknown master data kind");
    const r = await this.pool.query("SELECT code, label, active FROM master_data WHERE kind = $1 ORDER BY code", [kind]);
    return { kind, version: v.rows[0]!.version, items: r.rows };
  }

  /**
   * The installation's workspace for other modules (the gateway: status and module switches on every request; the ai
   * module: language). 404 `not_set_up` until first-run setup.
   */
  @Get("internal/workspace")
  async internalWorkspace(@Req() req: Request) {
    const p = requirePrincipal(req);
    if (!isPlatform(p, "principal.resolve")) throw new ForbiddenException("platform service only");
    const w = (
      await this.pool.query<{ name: string; status: string; config: unknown }>("SELECT w.name, w.status, c.config FROM workspace w JOIN workspace_config c USING (singleton)")
    ).rows[0];
    if (!w) throw new NotFoundException({ error: "not_set_up", message: "this installation has no workspace yet" });
    const config = readWorkspaceConfig(w.config);
    return { name: w.name, status: w.status, features: effectiveFeatures(config), timezone: config.timezone, locale: config.locale };
  }
}

const auditQuery = z.object({
  before: z.string().datetime({ offset: true }).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  action: z
    .string()
    .regex(/^[a-z_.]{1,40}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});
