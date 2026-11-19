import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, Patch, Post, Req } from "@nestjs/common";
import { assertAllowed, parse, requirePrincipal } from "@workspace/service-kit";
import { newId, withTransaction } from "@workspace/shared";
import type { Request } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { CONNECTORS } from "../task-sync/connectors/index.js";
import { credentialsOf, encryptToken, runConnection, type ConnectionRow, type SyncDeps } from "../task-sync/sync.js";
import { PROVIDERS, SyncApiError, type Credentials, type Provider } from "../task-sync/types.js";
import { POOL, TASK_SYNC } from "./common.js";

const provider = z.enum(PROVIDERS as [Provider, ...Provider[]]);
const creds = { token: z.string().trim().min(8).max(500), site: z.string().trim().max(200).nullish(), email: z.string().trim().email().max(320).nullish() };

/**
 * Admin › Integrations › Task sync: connect Asana, ClickUp, Linear or Jira Cloud with a token, choose what to read,
 * watch it run. Tokens are encrypted and never sent back. Workspace configuration permission only.
 */
@Controller()
export class TaskSyncController {
  constructor(
    @Inject(POOL) private readonly pool: Pool,
    @Inject(TASK_SYNC) private readonly deps: SyncDeps,
  ) {}

  private admin(req: Request) {
    const p = requirePrincipal(req);
    assertAllowed(p, "workspace.configure");
    return p;
  }

  @Get("task-sync")
  async list(@Req() req: Request) {
    this.admin(req);
    const rows = (
      await this.pool.query<ConnectionRow & { last_run_at: Date | null; last_ok_at: Date | null; last_error: string | null; stats: Record<string, number>; created_at: Date }>(
        "SELECT * FROM sync_connections ORDER BY created_at",
      )
    ).rows;
    const projects = (await this.pool.query<{ connection_id: string; external_id: string; project_id: string; name: string }>("SELECT * FROM sync_projects")).rows;
    return {
      connections: rows.map((r) => ({
        id: r.id,
        provider: r.provider,
        name: r.name,
        site: r.site,
        accountEmail: r.account_email,
        scope: r.scope,
        enabled: r.enabled,
        createdAt: r.created_at,
        lastRunAt: r.last_run_at,
        lastOkAt: r.last_ok_at,
        lastError: r.last_error,
        stats: r.stats,
        projects: projects.filter((p) => p.connection_id === r.id).map((p) => ({ externalId: p.external_id, projectId: p.project_id, name: p.name })),
      })),
    };
  }

  /** Checks a token and lists what it can read (nothing is saved). */
  @Post("task-sync/test")
  @HttpCode(200)
  async test(@Req() req: Request, @Body() body: unknown) {
    this.admin(req);
    const b = parse(z.object({ provider, ...creds }), body);
    return this.projectsFor(b.provider, { token: b.token, site: b.site ?? null, email: b.email ?? null });
  }

  /** What a saved connection's token can read, to change the selection. */
  @Get("task-sync/:id/projects")
  async projects(@Req() req: Request, @Param("id") id: string) {
    this.admin(req);
    const row = await this.row(id);
    return this.projectsFor(row.provider, credentialsOf(row));
  }

  @Post("task-sync")
  async create(@Req() req: Request, @Body() body: unknown) {
    const p = this.admin(req);
    const b = parse(z.object({ provider, name: z.string().trim().max(120).optional(), scope: z.array(z.string().min(1).max(100)).max(200).default([]), ...creds }), body);
    const id = newId();
    await withTransaction(this.pool, (c) =>
      c.query("INSERT INTO sync_connections (id, provider, name, site, account_email, secret_enc, scope, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [
        id,
        b.provider,
        b.name || defaultName(b.provider, b.site),
        b.site ?? null,
        b.email ?? null,
        encryptToken(b.token),
        b.scope,
        p.id,
      ]),
    );
    // The first run can take a while on a big workspace: it continues after the answer.
    void runConnection(this.deps, id);
    return { id };
  }

  @Patch("task-sync/:id")
  async update(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    this.admin(req);
    const b = parse(
      z.object({
        name: z.string().trim().min(1).max(120).optional(),
        scope: z.array(z.string().min(1).max(100)).max(200).optional(),
        enabled: z.boolean().optional(),
        token: creds.token.optional(),
        site: creds.site,
        email: creds.email,
      }),
      body,
    );
    const row = await this.row(id);
    await this.pool.query(
      `UPDATE sync_connections SET name = coalesce($2, name), scope = coalesce($3, scope), enabled = coalesce($4, enabled),
              secret_enc = coalesce($5, secret_enc), site = CASE WHEN $6::boolean THEN $7 ELSE site END,
              account_email = CASE WHEN $8::boolean THEN $9 ELSE account_email END,
              -- New projects in the selection are read from the start.
              cursor_at = CASE WHEN $3::text[] IS NOT NULL AND NOT ($3::text[] <@ scope) THEN NULL ELSE cursor_at END,
              updated_at = now()
        WHERE id = $1`,
      [
        id,
        b.name ?? null,
        b.scope ?? null,
        b.enabled ?? null,
        b.token ? encryptToken(b.token) : null,
        b.site !== undefined,
        b.site ?? null,
        b.email !== undefined,
        b.email ?? null,
      ],
    );
    if (b.enabled !== false && (b.scope || b.token) && row) void runConnection(this.deps, id);
    return { ok: true };
  }

  /** "Sync now": runs and answers with what it did. */
  @Post("task-sync/:id/run")
  @HttpCode(200)
  async run(@Req() req: Request, @Param("id") id: string) {
    this.admin(req);
    await this.row(id);
    return runConnection(this.deps, id);
  }

  /** Disconnects. The synced tasks stay and become ordinary, editable tasks (their source link is kept). */
  @Delete("task-sync/:id")
  @HttpCode(204)
  async remove(@Req() req: Request, @Param("id") id: string) {
    this.admin(req);
    await this.row(id);
    await withTransaction(this.pool, async (c) => {
      await c.query(`UPDATE tasks SET source = jsonb_set(source, '{type}', '"import"') WHERE id IN (SELECT task_id FROM sync_items WHERE connection_id = $1)`, [id]);
      await c.query("DELETE FROM sync_connections WHERE id = $1", [id]);
    });
  }

  private async row(id: string): Promise<ConnectionRow> {
    const r = (await this.pool.query<ConnectionRow>("SELECT * FROM sync_connections WHERE id = $1", [id])).rows[0];
    if (!r) throw new NotFoundException("connection not found");
    return r;
  }

  private async projectsFor(p: Provider, cred: Credentials) {
    try {
      return { projects: await CONNECTORS[p].listProjects(cred, this.deps.fetch) };
    } catch (e) {
      if (e instanceof SyncApiError) throw new BadRequestException({ error: "sync_api", message: e.message, status: e.status });
      throw new BadRequestException({ error: "sync_api", message: e instanceof Error ? e.message : "could not reach the service" });
    }
  }
}

function defaultName(p: Provider, site: string | null | undefined): string {
  const label = { asana: "Asana", clickup: "ClickUp", linear: "Linear", jira: "Jira" }[p];
  if (p === "jira" && site) return `${label} · ${site.replace(/^https?:\/\//, "").replace(/\/.*$/, "")}`.slice(0, 120);
  return label;
}
