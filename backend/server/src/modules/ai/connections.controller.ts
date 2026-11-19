import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, Patch, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { appendToOutbox, newId, withTransaction, type Principal } from "@workspace/shared";
import { assertAllowed, requirePrincipal } from "@workspace/service-kit";
import { DEPS } from "./ai.controller.js";
import type { Deps } from "./runtime.js";
import {
  CONNECTION_COLS,
  ConnectionInput,
  connectionDto,
  decryptSecret,
  encryptSecret,
  keyHint,
  InvalidConnection,
  sameEndpoint,
  listModels,
  friendlyError,
  resolve,
  testConnection,
  probeTools,
  type ConnectionRow,
  type Draft,
} from "./connections.js";
import { WorkspaceGateway } from "./workspace-gateway.js";

/** resolve() with its field errors as 400s. */
function resolved(...args: Parameters<typeof resolve>) {
  try {
    return resolve(...args);
  } catch (e) {
    if (e instanceof InvalidConnection) throw new BadRequestException({ error: "invalid", issues: [{ path: e.path, message: e.message }] });
    throw e;
  }
}

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const r = schema.safeParse(body);
  if (!r.success) throw new BadRequestException({ error: "invalid", issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
  return r.data;
}

/**
 * Admin › AI: the company's own AI connections (connections.ts). Only people who manage AI see or change
 * them; keys never leave the server. Every change is written to the audit log (outbox) and reloads the
 * gateway for this workspace at once.
 */
@Controller()
export class ConnectionsController {
  constructor(@Inject(DEPS) private readonly d: Deps) {}

  private admin(req: Request): Principal {
    const p = requirePrincipal(req);
    assertAllowed(p, "ai.agent.manage");
    return p;
  }

  private changed(p: Principal, action: "created" | "updated" | "deleted" | "default", row: Pick<ConnectionRow, "id" | "mode" | "vendor" | "name">) {
    if (this.d.provider instanceof WorkspaceGateway) this.d.provider.invalidate();
    return {
      eventId: newId(),
      eventType: `ai.connection.${action}.v1` as const,
      version: 1,
      aggregateType: "ai.connection",
      aggregateId: row.id,
      actorId: `user:${p.id}`,
      occurredAt: new Date().toISOString(),
      payload: { id: row.id, mode: row.mode, vendor: row.vendor, name: row.name },
    };
  }

  @Get("connections")
  async list(@Req() req: Request) {
    this.admin(req);
    const gw = this.d.provider as { providers?: () => string[] };
    const envVendors = (gw.providers?.() ?? []).filter((x) => !x.startsWith("c_"));
    return withTransaction(this.d.pool, async (c) => ({
      connections: (await c.query<ConnectionRow>(`SELECT ${CONNECTION_COLS} FROM ai_connections ORDER BY is_default DESC, created_at`)).rows.map(connectionDto),
      // Vendors switched on in the server's env (.env): shown read-only, so admins know where answers come from.
      env: envVendors,
    }));
  }

  @Post("connections")
  async create(@Req() req: Request, @Body() body: unknown) {
    const p = this.admin(req);
    const b = parse(ConnectionInput, body);
    const r = resolved(b);
    if (r.mode !== "selfhost" && !b.apiKey) throw new BadRequestException({ error: "invalid", issues: [{ path: "apiKey", message: "API key is required" }] });
    return withTransaction(this.d.pool, async (c) => {
      const first = !(await c.query("SELECT 1 FROM ai_connections LIMIT 1")).rowCount;
      const row = (
        await c.query<ConnectionRow>(
          `INSERT INTO ai_connections (id, mode, vendor, name, base_url, api_key_enc, key_hint, model_fast, model_smart, is_default, enabled, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING ${CONNECTION_COLS}`,
          [
            newId(),
            r.mode,
            r.vendor,
            r.name,
            r.baseUrl,
            b.apiKey ? encryptSecret(b.apiKey) : null,
            b.apiKey ? keyHint(b.apiKey) : null,
            r.modelFast,
            r.modelSmart,
            first,
            b.enabled ?? true,
            p.id,
          ],
        )
      ).rows[0]!;
      await appendToOutbox(c, this.changed(p, "created", row));
      return { connection: connectionDto(row) };
    });
  }

  @Patch("connections/:id")
  async update(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = this.admin(req);
    const b = parse(ConnectionInput, body);
    return withTransaction(this.d.pool, async (c) => {
      const prev = await this.row(c, id);
      const r = resolved(b, prev);
      // A key left empty keeps the stored one, but only for the same vendor and address (sameEndpoint).
      const keepKey = !b.apiKey && !!prev.api_key_enc && sameEndpoint(prev, r);
      if (r.mode !== "selfhost" && !b.apiKey && !keepKey) throw new BadRequestException({ error: "invalid", issues: [{ path: "apiKey", message: "API key is required" }] });
      const row = (
        await c.query<ConnectionRow>(
          `UPDATE ai_connections SET mode = $2, vendor = $3, name = $4, base_url = $5, api_key_enc = $6, key_hint = $7, model_fast = $8, model_smart = $9,
                  enabled = $10, updated_at = now(), tested_at = NULL, test_ok = NULL, test_error = NULL, tools_ok = NULL
            WHERE id = $1 RETURNING ${CONNECTION_COLS}`,
          [
            id,
            r.mode,
            r.vendor,
            r.name,
            r.baseUrl,
            b.apiKey ? encryptSecret(b.apiKey) : keepKey ? prev.api_key_enc : null,
            b.apiKey ? keyHint(b.apiKey) : keepKey ? prev.key_hint : null,
            r.modelFast,
            r.modelSmart,
            b.enabled ?? prev.enabled,
          ],
        )
      ).rows[0]!;
      await appendToOutbox(c, this.changed(p, "updated", row));
      return { connection: connectionDto(row) };
    });
  }

  @Delete("connections/:id")
  @HttpCode(200)
  async remove(@Req() req: Request, @Param("id") id: string) {
    const p = this.admin(req);
    return withTransaction(this.d.pool, async (c) => {
      const prev = await this.row(c, id);
      await c.query("DELETE FROM ai_connections WHERE id = $1", [id]);
      // The default went: the oldest remaining connection takes over, so AI keeps working.
      if (prev.is_default) await c.query("UPDATE ai_connections SET is_default = true WHERE id = (SELECT id FROM ai_connections WHERE enabled ORDER BY created_at LIMIT 1)");
      await appendToOutbox(c, this.changed(p, "deleted", prev));
      return { ok: true };
    });
  }

  /** The connection's own web tools on or off (search, reading linked pages, its code sandbox), without editing the rest. */
  @Post("connections/:id/web")
  @HttpCode(200)
  async setWeb(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = this.admin(req);
    const b = parse(z.object({ on: z.boolean() }), body);
    return withTransaction(this.d.pool, async (c) => {
      await this.row(c, id);
      const row = (await c.query<ConnectionRow>(`UPDATE ai_connections SET web_tools = $2, updated_at = now() WHERE id = $1 RETURNING ${CONNECTION_COLS}`, [id, b.on])).rows[0]!;
      await appendToOutbox(c, this.changed(p, "updated", row));
      return { connection: connectionDto(row) };
    });
  }

  @Post("connections/:id/default")
  @HttpCode(200)
  async makeDefault(@Req() req: Request, @Param("id") id: string) {
    const p = this.admin(req);
    return withTransaction(this.d.pool, async (c) => {
      const prev = await this.row(c, id);
      await c.query("UPDATE ai_connections SET is_default = false, updated_at = now() WHERE is_default AND id <> $1", [id]);
      await c.query("UPDATE ai_connections SET is_default = true, enabled = true, updated_at = now() WHERE id = $1", [id]);
      await appendToOutbox(c, this.changed(p, "default", prev));
      return { ok: true };
    });
  }

  /** Tests a saved connection with one tiny call and keeps the result (shown on the card). */
  @Post("connections/:id/test")
  @HttpCode(200)
  async test(@Req() req: Request, @Param("id") id: string) {
    this.admin(req);
    const row = await withTransaction(this.d.pool, (c) => this.row(c, id));
    const draft = this.draftOf(row);
    const r = draft ? await testConnection(draft, row.model_fast) : { ok: false, ms: 0, error: "key: the stored key cannot be read (server secret changed); enter it again" };
    // The assistant's model (smart) is also asked to call a tool once, so small models that cannot are used without tools.
    const tools = r.ok && draft ? await probeTools(draft, row.model_smart) : row.tools_ok;
    await withTransaction(this.d.pool, (c) =>
      c.query("UPDATE ai_connections SET tested_at = now(), test_ok = $2, test_error = $3, tools_ok = $4 WHERE id = $1", [id, r.ok, r.ok ? null : r.error, tools]),
    );
    if (this.d.provider instanceof WorkspaceGateway) this.d.provider.invalidate();
    return { test: { ...r, tools } };
  }

  /**
   * The form's "Kiểm tra" and model list before saving: what is typed (or, with `id`, the stored key).
   * Nothing is stored. With `model` it also makes one tiny call.
   */
  @Post("connections/check")
  @HttpCode(200)
  async check(@Req() req: Request, @Body() body: unknown) {
    this.admin(req);
    const b = parse(z.intersection(ConnectionInput, z.object({ id: z.string().max(40).optional(), model: z.string().trim().max(200).optional() })), body);
    const prev = b.id ? await withTransaction(this.d.pool, (c) => this.row(c, b.id!)) : undefined;
    const r = resolved({ ...b, modelSmart: b.modelSmart || b.model || "?" }, prev);
    const stored = prev && !b.apiKey && sameEndpoint(prev, r) ? this.draftOf(prev)?.apiKey : undefined;
    const draft: Draft = { mode: r.mode, vendor: r.vendor, baseUrl: r.baseUrl, apiKey: b.apiKey || stored || "" };
    const models = await listModels(draft).then(
      (m) => ({ ok: true as const, models: m }),
      (e) => ({ ok: false as const, models: [] as string[], error: friendlyError(e) }),
    );
    const model = b.model || b.modelFast || b.modelSmart || models.models[0];
    return { baseUrl: r.baseUrl, models, test: model ? await testConnection(draft, model) : null };
  }

  private async row(c: import("pg").PoolClient, id: string): Promise<ConnectionRow> {
    const row = (await c.query<ConnectionRow>(`SELECT ${CONNECTION_COLS} FROM ai_connections WHERE id = $1`, [id])).rows[0];
    if (!row) throw new NotFoundException("connection not found");
    return row;
  }

  private draftOf(row: ConnectionRow): Draft | null {
    try {
      return { mode: row.mode, vendor: row.vendor, baseUrl: row.base_url, apiKey: row.api_key_enc ? decryptSecret(row.api_key_enc) : "" };
    } catch {
      return null;
    }
  }
}
