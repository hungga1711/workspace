import { randomBytes } from "node:crypto";
import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, Patch, Post, Put, Req } from "@nestjs/common";
import type { Request } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import { appendToOutbox, newId, withTransaction, type Principal } from "@workspace/shared";
import { assertAllowed, logger, requirePrincipal } from "@workspace/service-kit";
import { DEPS } from "../ai.controller.js";
import { guardAi } from "../budgets.js";
import { departmentOf, type Deps } from "../runtime.js";
import { outsideChips, resumeTaskChat, saveTaskAnswer, taskChatOf, taskChatWho } from "../task-chat.js";
import { NeedsAuth, openSession, saveToken } from "./client.js";
import { chips, resume, savePending, type PendingContext } from "./chat.js";
import { postAiComment } from "../mention.js";
import { extrasFor, extrasOf } from "../activity.js";
import { Trace } from "../progress.js";
import type { Source as ToolSource } from "../tools.js";
import { toolTitle } from "../workspace-tools.js";
import type { LoopState } from "./loop.js";
import { mcpFetch, NetError, urlProblem } from "./net.js";
import { authorizeUrl, discover, exchangeCode, pkce, registerClient, type OAuthMeta } from "./oauth.js";
import { freeSlug, hintOf, isMcpAdmin, mayUse, redirectUri, seal, SERVER_COLS, ServerInput, serverDto, ToolSettingsInput, unseal, type ServerRow } from "./store.js";

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const r = schema.safeParse(body);
  if (!r.success) throw new BadRequestException({ error: "invalid", issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
  return r.data;
}

/** Errors in words an admin can act on; never a secret (headers are not part of any message). */
export function mcpError(e: unknown): string {
  if (e instanceof NeedsAuth) return `needs_auth: ${e.message}`;
  if (e instanceof NetError) return e.code === "private" ? `blocked: ${e.message}` : e.code === "timeout" ? "timeout: the server did not answer in time" : e.message;
  const status = (e as { status?: number }).status;
  if (status === 401 || status === 403) return `auth: the server refused the credentials (HTTP ${status})`;
  const msg = ((e as Error).message ?? "").replace(/(Bearer|token|key)[\s:=]+\S{6,}/gi, "$1 …").slice(0, 240);
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET/.test(msg)) return `unreachable: workspace cannot reach this address (${msg})`;
  if (/timed? ?out/i.test(msg)) return "timeout: the server did not answer in time";
  return msg || "failed";
}

/** What an unauthenticated initialize tells about a server: answers (open), or a 401 pointing at its OAuth metadata. */
async function probe(url: string): Promise<{ status: number; resourceMetadata: string | null }> {
  const res = await mcpFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "workspace", version: "1.0.0" } },
    }),
    timeoutMs: 10_000,
  });
  await res.body?.cancel().catch(() => undefined);
  return { status: res.status, resourceMetadata: /resource_metadata="([^"]+)"/.exec(res.headers.get("www-authenticate") ?? "")?.[1] ?? null };
}

/**
 * MCP client: Admin › Kết nối AI › Máy chủ MCP (servers, their tools, who may use them, the call log), each person's
 * own sign-in to servers where everyone connects their own account, the OAuth callback, and the confirm card's answer.
 * Every change is in the audit log (ai.connection.* with mode "mcp"); secrets never leave the server.
 */
@Controller()
export class McpController {
  constructor(@Inject(DEPS) private readonly d: Deps) {}

  private admin(req: Request): Principal {
    const p = requirePrincipal(req);
    assertAllowed(p, "ai.agent.manage");
    return p;
  }

  private changed(c: PoolClient, p: Principal, action: "created" | "updated" | "deleted", row: Pick<ServerRow, "id" | "name" | "preset">) {
    return appendToOutbox(c, {
      eventId: newId(),
      eventType: `ai.connection.${action}.v1` as const,
      version: 1,
      aggregateType: "ai.connection",
      aggregateId: row.id,
      actorId: `user:${p.id}`,
      occurredAt: new Date().toISOString(),
      payload: { id: row.id, mode: "mcp", vendor: row.preset ?? null, name: row.name },
    });
  }

  private async row(c: PoolClient | Deps["pool"], id: string): Promise<ServerRow> {
    const row = (await c.query<ServerRow>(`SELECT ${SERVER_COLS} FROM mcp_servers WHERE id = $1`, [id])).rows[0];
    if (!row) throw new NotFoundException("server not found");
    return row;
  }

  // ---------------------------------------------------------------- admin

  @Get("mcp/servers")
  async list(@Req() req: Request) {
    this.admin(req);
    return withTransaction(this.d.pool, async (c) => {
      const rows = (await c.query<ServerRow>(`SELECT ${SERVER_COLS} FROM mcp_servers ORDER BY created_at`)).rows;
      const connected = new Set((await c.query<{ server_id: string }>("SELECT server_id FROM mcp_tokens WHERE user_id = ''")).rows.map((r) => r.server_id));
      const stats = (
        await c.query<{ server_id: string; calls: number; failed: number; people: number }>(
          `SELECT server_id, count(*)::int AS calls, count(*) FILTER (WHERE outcome NOT IN ('ok', 'declined'))::int AS failed, count(DISTINCT user_id)::int AS people
             FROM mcp_calls WHERE at > now() - interval '30 days' GROUP BY server_id`,
        )
      ).rows;
      const calls = (
        await c.query(
          `SELECT id, at, user_id AS "userId", agent_id AS "agentId", server_id AS "serverId", server_name AS "server", tool, feature, outcome, ms
             FROM mcp_calls ORDER BY at DESC LIMIT 40`,
        )
      ).rows;
      return {
        servers: rows.map((r) => ({ ...serverDto(r, connected.has(r.id)), stats: stats.find((s) => s.server_id === r.id) ?? { calls: 0, failed: 0, people: 0 } })),
        calls,
        redirectUri: redirectUri(),
      };
    });
  }

  @Post("mcp/servers")
  async create(@Req() req: Request, @Body() body: unknown) {
    const p = this.admin(req);
    const b = parse(ServerInput, body);
    if (b.auth === "header" && !b.secret) throw new BadRequestException({ error: "invalid", issues: [{ path: "secret", message: "a token is required" }] });
    return withTransaction(this.d.pool, async (c) => {
      const row = (
        await c.query<ServerRow>(
          `INSERT INTO mcp_servers (id, slug, name, url, preset, auth, header_name, secret_enc, secret_hint, oauth_per_user, oauth_client_id, oauth_client_secret_enc,
                                    audience, department_ids, enabled, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING ${SERVER_COLS}`,
          [
            newId(),
            await freeSlug(c, b.name),
            b.name,
            b.url,
            b.preset ?? null,
            b.auth,
            b.auth === "header" ? (b.headerName ?? null) : null,
            b.auth === "header" && b.secret ? seal(b.secret) : null,
            b.auth === "header" && b.secret ? hintOf(b.secret) : null,
            b.auth === "oauth" && !!b.oauthPerUser,
            b.auth === "oauth" ? b.oauthClientId || null : null,
            b.auth === "oauth" && b.oauthClientSecret ? seal(b.oauthClientSecret) : null,
            b.audience,
            b.audience === "departments" ? b.departmentIds : [],
            b.enabled ?? true,
            p.id,
          ],
        )
      ).rows[0]!;
      await this.changed(c, p, "created", row);
      return { server: serverDto(row, false) };
    });
  }

  @Patch("mcp/servers/:id")
  async update(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = this.admin(req);
    const b = parse(ServerInput, body);
    return withTransaction(this.d.pool, async (c) => {
      const prev = await this.row(c, id);
      // A secret is kept only for the same address and kind: an edited URL never receives the old credentials.
      const same = prev.url === b.url && prev.auth === b.auth;
      const secret = b.auth === "header" ? (b.secret ? seal(b.secret) : same ? prev.secret_enc : null) : null;
      if (b.auth === "header" && !secret) throw new BadRequestException({ error: "invalid", issues: [{ path: "secret", message: "a token is required" }] });
      const sameClient = same && (b.oauthClientId || null) === prev.oauth_client_id;
      const row = (
        await c.query<ServerRow>(
          `UPDATE mcp_servers SET name = $2, url = $3, auth = $4, header_name = $5, secret_enc = $6, secret_hint = $7, oauth_per_user = $8, oauth_client_id = $9,
                  oauth_client_secret_enc = $10, oauth_meta = $11, audience = $12, department_ids = $13, enabled = $14, updated_at = now()
            WHERE id = $1 RETURNING ${SERVER_COLS}`,
          [
            id,
            b.name,
            b.url,
            b.auth,
            b.auth === "header" ? (b.headerName ?? null) : null,
            secret,
            b.auth === "header" ? (b.secret ? hintOf(b.secret) : prev.secret_hint) : null,
            b.auth === "oauth" && !!b.oauthPerUser,
            b.auth === "oauth" ? b.oauthClientId || (same ? prev.oauth_client_id : null) : null,
            b.auth === "oauth" ? (b.oauthClientSecret ? seal(b.oauthClientSecret) : sameClient || (same && !b.oauthClientId) ? prev.oauth_client_secret_enc : null) : null,
            same ? (prev.oauth_meta ? JSON.stringify(prev.oauth_meta) : null) : null,
            b.audience,
            b.audience === "departments" ? b.departmentIds : [],
            b.enabled ?? prev.enabled,
          ],
        )
      ).rows[0]!;
      // Another address or kind of sign-in: the stored sign-ins were for the old one.
      if (!same || prev.oauth_per_user !== row.oauth_per_user) await c.query("DELETE FROM mcp_tokens WHERE server_id = $1", [id]);
      await this.changed(c, p, "updated", row);
      const connected = !!(await c.query("SELECT 1 FROM mcp_tokens WHERE server_id = $1 AND user_id = ''", [id])).rowCount;
      return { server: serverDto(row, connected) };
    });
  }

  @Delete("mcp/servers/:id")
  @HttpCode(200)
  async remove(@Req() req: Request, @Param("id") id: string) {
    const p = this.admin(req);
    return withTransaction(this.d.pool, async (c) => {
      const prev = await this.row(c, id);
      await c.query("DELETE FROM mcp_servers WHERE id = $1", [id]);
      await c.query("DELETE FROM mcp_pending WHERE server_id = $1", [id]);
      await this.changed(c, p, "deleted", prev);
      return { ok: true };
    });
  }

  /** Per-tool choices: on/off, and ask before running. */
  @Put("mcp/servers/:id/tools")
  async tools(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = this.admin(req);
    const b = parse(ToolSettingsInput, body);
    return withTransaction(this.d.pool, async (c) => {
      const prev = await this.row(c, id);
      const known = new Set(prev.tools.map((t) => t.name));
      const next = { ...prev.tool_settings, ...Object.fromEntries(Object.entries(b.tools).filter(([k]) => known.has(k))) };
      const row = (await c.query<ServerRow>(`UPDATE mcp_servers SET tool_settings = $2, updated_at = now() WHERE id = $1 RETURNING ${SERVER_COLS}`, [id, JSON.stringify(next)]))
        .rows[0]!;
      await this.changed(c, p, "updated", row);
      const connected = !!(await c.query("SELECT 1 FROM mcp_tokens WHERE server_id = $1 AND user_id = ''", [id])).rowCount;
      return { server: serverDto(row, connected) };
    });
  }

  /** Connects (as the admin), reads the server's name, version and tools, and keeps them. */
  @Post("mcp/servers/:id/test")
  @HttpCode(200)
  async test(@Req() req: Request, @Param("id") id: string) {
    const p = this.admin(req);
    const row = await this.row(this.d.pool, id);
    const r = await this.testRow(row, p.id);
    const fresh = await this.row(this.d.pool, id);
    const connected = !!(await this.d.pool.query("SELECT 1 FROM mcp_tokens WHERE server_id = $1 AND user_id = ''", [id])).rowCount;
    return { test: r, server: serverDto(fresh, connected) };
  }

  private async testRow(row: ServerRow, userId: string): Promise<{ ok: boolean; error: string | null; ms: number }> {
    const started = Date.now();
    let error: string | null = null;
    try {
      const s = await openSession(this.d.pool, row, userId, { timeoutMs: 15_000 });
      try {
        const tools = await s.listTools();
        await this.d.pool.query("UPDATE mcp_servers SET tools = $2, server_info = $3, tools_at = now() WHERE id = $1", [
          row.id,
          JSON.stringify(tools),
          JSON.stringify(s.serverInfo),
        ]);
      } finally {
        await s.close();
      }
    } catch (e) {
      error = mcpError(e);
    }
    await this.d.pool.query("UPDATE mcp_servers SET tested_at = now(), test_ok = $2, test_error = $3 WHERE id = $1", [row.id, !error, error]);
    return { ok: !error, error, ms: Date.now() - started };
  }

  /**
   * The add form's "Kiểm tra" before saving: whether the address answers, needs a sign-in (and offers OAuth), and
   * with a header token, the server's name and tool count. Nothing is stored.
   */
  @Post("mcp/check")
  @HttpCode(200)
  async check(@Req() req: Request, @Body() body: unknown) {
    this.admin(req);
    const b = parse(
      z.object({
        url: z.string().trim().max(500),
        headerName: z.string().trim().max(60).optional(),
        secret: z.string().trim().max(4000).optional(),
        id: z.string().max(40).optional(),
      }),
      body,
    );
    const problem = urlProblem(b.url);
    if (problem) return { ok: false, error: `blocked: ${problem}`, oauth: false };
    try {
      const first = await probe(b.url);
      const prev = b.id ? await this.row(this.d.pool, b.id).catch(() => null) : null;
      const secretEnc = b.secret ? seal(b.secret) : prev && prev.url === b.url && prev.auth === "header" ? prev.secret_enc : null;
      if ((first.status === 401 || first.status === 403) && !secretEnc) {
        const { advertised } = await discover(b.url, first.resourceMetadata);
        return { ok: false, error: "needs_auth", oauth: advertised };
      }
      const row = { id: "check", url: b.url, auth: secretEnc ? "header" : "none", header_name: b.headerName ?? null, secret_enc: secretEnc, oauth_per_user: false } as ServerRow;
      const s = await openSession(this.d.pool, row, "", { timeoutMs: 10_000 });
      try {
        const tools = await s.listTools();
        return { ok: true, error: null, oauth: false, serverInfo: s.serverInfo, tools: tools.length };
      } finally {
        await s.close();
      }
    } catch (e) {
      return { ok: false, error: mcpError(e), oauth: false };
    }
  }

  /** Signs the company account in (admin), or the admin's own on a per-person server. Returns the consent URL. */
  @Post("mcp/servers/:id/oauth/start")
  @HttpCode(200)
  async adminOAuth(@Req() req: Request, @Param("id") id: string) {
    const p = this.admin(req);
    const row = await this.row(this.d.pool, id);
    if (row.auth !== "oauth") throw new BadRequestException("this server does not use OAuth");
    return { url: await this.startOAuth(row, p, !row.oauth_per_user) };
  }

  @Delete("mcp/servers/:id/oauth")
  @HttpCode(200)
  async adminDisconnect(@Req() req: Request, @Param("id") id: string) {
    this.admin(req);
    await this.d.pool.query("DELETE FROM mcp_tokens WHERE server_id = $1 AND user_id = ''", [id]);
    return { ok: true };
  }

  private async startOAuth(row: ServerRow, p: Principal, forCompany: boolean): Promise<string> {
    let meta = row.oauth_meta as OAuthMeta | null;
    try {
      if (!meta) {
        const first = await probe(row.url).catch(() => ({ resourceMetadata: null }));
        meta = (await discover(row.url, first.resourceMetadata)).meta;
        await this.d.pool.query("UPDATE mcp_servers SET oauth_meta = $2 WHERE id = $1", [row.id, JSON.stringify(meta)]);
      }
      let clientId = row.oauth_client_id;
      if (!clientId) {
        const reg = await registerClient(meta, redirectUri());
        clientId = reg.clientId;
        await this.d.pool.query("UPDATE mcp_servers SET oauth_client_id = $2, oauth_client_secret_enc = $3 WHERE id = $1", [
          row.id,
          clientId,
          reg.clientSecret ? seal(reg.clientSecret) : null,
        ]);
      }
      const { verifier, challenge } = pkce();
      const state = randomBytes(24).toString("base64url");
      await this.d.pool.query("DELETE FROM mcp_oauth_states WHERE created_at < now() - interval '10 minutes'");
      await this.d.pool.query("INSERT INTO mcp_oauth_states (state, server_id, user_id, for_company, verifier_enc) VALUES ($1, $2, $3, $4, $5)", [
        state,
        row.id,
        p.id,
        forCompany,
        seal(verifier),
      ]);
      return authorizeUrl(meta, { clientId, redirectUri: redirectUri(), state, challenge });
    } catch (e) {
      throw new BadRequestException({ error: "oauth_failed", message: mcpError(e) });
    }
  }

  // ---------------------------------------------------------------- everyone

  /**
   * The servers I can use in Hỏi đáp (the welcome screen's row): name, preset, and whether I still have to connect my
   * own account. Empty when none, without any outside call.
   */
  @Get("mcp/mine")
  async mine(@Req() req: Request) {
    const p = requirePrincipal(req);
    assertAllowed(p, "ai.use");
    const rows = (await this.d.pool.query<ServerRow>(`SELECT ${SERVER_COLS} FROM mcp_servers WHERE enabled ORDER BY created_at`)).rows;
    if (!rows.length) return { servers: [] };
    const dept = rows.some((r) => r.audience === "departments") ? await departmentOf(this.d, p) : null;
    const usable = rows.filter((r) => mayUse(r, p, dept));
    const tokens = new Set(
      (await this.d.pool.query<{ server_id: string; user_id: string }>("SELECT server_id, user_id FROM mcp_tokens WHERE user_id IN ('', $1)", [p.id])).rows.map(
        (x) => `${x.server_id}:${x.user_id}`,
      ),
    );
    return {
      servers: usable
        .map((r) => {
          const perUser = r.auth === "oauth" && r.oauth_per_user;
          const ready = r.auth !== "oauth" || tokens.has(`${r.id}:${perUser ? p.id : ""}`);
          return { id: r.id, name: r.name, preset: r.preset, perUser, connected: ready, tools: r.tools.length };
        })
        // A company server nobody signed in to yet is not ready for anyone: not shown.
        .filter((s) => s.perUser || s.connected),
    };
  }

  /** Connect my own account to a server where everyone signs in for themselves. */
  @Post("mcp/servers/:id/connect")
  @HttpCode(200)
  async connect(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    assertAllowed(p, "ai.use");
    const row = await this.row(this.d.pool, id);
    if (!row.enabled || row.auth !== "oauth" || !row.oauth_per_user) throw new NotFoundException("server not found");
    if (!mayUse(row, p, row.audience === "departments" ? await departmentOf(this.d, p) : null)) throw new NotFoundException("server not found");
    return { url: await this.startOAuth(row, p, false) };
  }

  @Delete("mcp/servers/:id/connect")
  @HttpCode(200)
  async disconnect(@Req() req: Request, @Param("id") id: string) {
    const p = requirePrincipal(req);
    await this.d.pool.query("DELETE FROM mcp_tokens WHERE server_id = $1 AND user_id = $2", [id, p.id]);
    return { ok: true };
  }

  /** The consent page sent the browser back (/mcp-callback): only the person who started it may finish it. */
  @Post("mcp/oauth/callback")
  @HttpCode(200)
  async callback(@Req() req: Request, @Body() body: unknown) {
    const p = requirePrincipal(req);
    const b = parse(z.object({ state: z.string().min(10).max(200), code: z.string().min(1).max(4000) }), body);
    const st = (
      await this.d.pool.query<{ server_id: string; user_id: string; for_company: boolean; verifier_enc: string }>(
        "DELETE FROM mcp_oauth_states WHERE state = $1 AND created_at > now() - interval '10 minutes' RETURNING server_id, user_id, for_company, verifier_enc",
        [b.state],
      )
    ).rows[0];
    if (!st) throw new BadRequestException({ error: "expired", message: "this sign-in link expired; start again" });
    if (st.user_id !== p.id) throw new ForbiddenException("this sign-in was started by someone else");
    if (st.for_company && !isMcpAdmin(p)) throw new ForbiddenException("only AI admins connect the company account");
    const row = await this.row(this.d.pool, st.server_id);
    if (!row.oauth_meta || !row.oauth_client_id) throw new BadRequestException({ error: "oauth_failed", message: "start the sign-in again" });
    try {
      const tokens = await exchangeCode(
        row.oauth_meta,
        { clientId: row.oauth_client_id, clientSecret: row.oauth_client_secret_enc ? unseal(row.oauth_client_secret_enc) : null },
        { code: b.code, verifier: unseal(st.verifier_enc), redirectUri: redirectUri() },
      );
      await saveToken(this.d.pool, row.id, st.for_company ? "" : p.id, p.id, tokens);
    } catch (e) {
      logger.warn({ err: (e as Error).message, server: row.id }, "mcp oauth exchange failed");
      throw new BadRequestException({ error: "oauth_failed", message: mcpError(e) });
    }
    // The first sign-in also reads the server's tools, so the admin page lists them at once.
    if (st.for_company || !row.tools.length) await this.testRow(row, p.id).catch(() => undefined);
    return { ok: true, server: row.name, forCompany: st.for_company };
  }

  /** The confirm card's answer: run (or skip) the tool and finish the answer, which joins the conversation. */
  @Post("assistant/pending/:id")
  @HttpCode(200)
  async decide(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const p = requirePrincipal(req);
    assertAllowed(p, "ai.use");
    const b = parse(z.object({ approve: z.boolean() }), body);
    // Taken atomically: a double click cannot run the tool twice.
    const pending = (
      await this.d.pool.query<{ id: string; conversation_id: string | null; server_id: string; tool: string; state: LoopState; created_at: Date; context: PendingContext | null }>(
        "DELETE FROM mcp_pending WHERE id = $1 AND user_id = $2 AND created_at > now() - interval '1 hour' RETURNING id, conversation_id, server_id, tool, state, created_at, context",
        [id, p.id],
      )
    ).rows[0];
    if (!pending) throw new NotFoundException({ error: "expired", message: "this request expired; ask again" });
    // A card from a task chat (Hỏi AI về task) resumes with that chat's tools and is saved there, metered on the task.
    const taskChat = pending.conversation_id ? await taskChatOf(this.d.pool, pending.conversation_id, p.id) : null;
    // Its steps, notes and next questions are kept with the answer, as for an answer without a card (activity.ts).
    const progress = new Trace(pending.state.loc ?? "en", toolTitle);
    const who = taskChat ? taskChatWho(p, taskChat.taskId) : { principal: p, agentId: null, feature: "assistant", progress };
    let answer: Omit<Awaited<ReturnType<typeof resume>>, "sources"> & { sources?: unknown[] | undefined };
    try {
      answer = await guardAi(async () => {
        if (!taskChat) return resume(this.d, who, pending.state, b.approve);
        const { pending: paused, ...r } = await resumeTaskChat(this.d, who, pending.state, b.approve);
        return { ...r, ...(paused ? { pending: { state: paused.state, call: paused.call } } : {}) };
      });
    } catch (e) {
      // The model failed (not the tool): the card stays so the person can answer it again.
      await this.d.pool
        .query("INSERT INTO mcp_pending (id, user_id, conversation_id, server_id, tool, state, created_at, context) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING", [
          pending.id,
          p.id,
          pending.conversation_id,
          pending.server_id,
          pending.tool,
          JSON.stringify(pending.state),
          pending.created_at,
          pending.context ? JSON.stringify(pending.context) : null,
        ])
        .catch(() => undefined);
      throw e;
    }
    // Asked with @AI in a task's comments: the answer goes on the task, now that the person has decided.
    const posted = !answer.pending && pending.context?.surface === "task" && answer.text.trim() ? await postAiComment(this.d, p.id, pending.context.taskId, answer.text) : null;
    const extras = answer.pending ? {} : extrasOf(extrasFor(p, progress, pending.state.asked ?? "", answer.sources as ToolSource[] | undefined, pending.state.surface ?? "ask"));
    return withTransaction(this.d.pool, async (c) => {
      if (answer.pending) {
        const card = await savePending(c, p.id, pending.conversation_id, answer.pending, pending.context);
        return {
          conversationId: pending.conversation_id,
          answer: "",
          model: "",
          pending: card,
          toolCalls: taskChat ? outsideChips(answer.uses) : chips(answer.uses),
          sources: answer.sources ?? [],
        };
      }
      if (taskChat) {
        const sources = (answer.sources ?? []) as Awaited<ReturnType<typeof resumeTaskChat>>["sources"];
        await saveTaskAnswer(c, taskChat.id, { text: answer.text, model: answer.model, uses: answer.uses, sources });
        return { conversationId: taskChat.id, chatId: taskChat.id, answer: answer.text, model: answer.model, sources, toolCalls: outsideChips(answer.uses) };
      }
      if (pending.conversation_id) {
        const own = (await c.query("SELECT 1 FROM ai_conversations WHERE id = $1 AND user_id = $2", [pending.conversation_id, p.id])).rowCount;
        if (own) {
          await c.query(
            "INSERT INTO ai_messages (id, conversation_id, role, content, at, tool_calls, sources, blocks, extras) VALUES ($1, $2, 'assistant', $3, now(), $4, $5, $6, $7)",
            [
              newId(),
              pending.conversation_id,
              answer.text.slice(0, 20_000),
              JSON.stringify(chips(answer.uses)),
              answer.sources?.length ? JSON.stringify(answer.sources) : null,
              answer.blocks?.length ? JSON.stringify(answer.blocks) : null,
              Object.keys(extras).length ? JSON.stringify(extras) : null,
            ],
          );
          await c.query("UPDATE ai_conversations SET last_at = now(), model = CASE WHEN $2 = '' THEN model ELSE $2 END WHERE id = $1", [pending.conversation_id, answer.model]);
        }
      }
      return {
        conversationId: pending.conversation_id,
        answer: answer.text,
        model: answer.model,
        toolCalls: chips(answer.uses),
        sources: answer.sources ?? [],
        blocks: answer.blocks ?? [],
        ...extras,
        ...(posted ? { posted } : {}),
      };
    });
  }
}
