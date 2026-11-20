import type { Pool } from "pg";
import { logger } from "@workspace/service-kit";
import { newId, withTransaction, type Principal } from "@workspace/shared";
import type { ToolSpec } from "../providers.js";
import { headerOf, mayUse, SERVER_COLS, seal, settingOf, unseal, type McpToolInfo, type ServerRow } from "./store.js";
import { refreshTokens, type OAuthMeta } from "./oauth.js";
import { NetError } from "./net.js";

/**
 * Talking to external MCP servers: a session per server (the SDK's Client over the guarded transport, both imported
 * on first use so a workspace without MCP servers never loads them), credentials (header secret or OAuth token,
 * refreshed when close to expiry or refused), and the tool set one AI answer may use.
 */

/** A tool result is cut to this many characters before the model reads it. */
export const RESULT_MAX = 12_000;
/** A tool call that has not answered by then counts as failed (the model is told). */
export const CALL_TIMEOUT_MS = 30_000;
/** tools/list read at most this long ago is used as is. */
const TOOLS_TTL_MS = 10 * 60_000;

export class NeedsAuth extends Error {
  constructor(message = "not connected: sign in to this server first") {
    super(message);
  }
}

interface TokenRow {
  access_enc: string;
  refresh_enc: string | null;
  expires_at: Date | null;
}

/** The account whose token a call uses: the person's own on a per-person server, else the company's (''). */
const tokenOwner = (row: Pick<ServerRow, "oauth_per_user">, userId: string) => (row.oauth_per_user ? userId : "");

async function readToken(pool: Pool, serverId: string, owner: string): Promise<TokenRow | null> {
  return (await pool.query<TokenRow>("SELECT access_enc, refresh_enc, expires_at FROM mcp_tokens WHERE server_id = $1 AND user_id = $2", [serverId, owner])).rows[0] ?? null;
}

export async function saveToken(
  pool: Pool,
  serverId: string,
  owner: string,
  by: string,
  t: { accessToken: string; refreshToken: string | null; expiresAt: Date | null; scope: string | null },
) {
  await pool.query(
    `INSERT INTO mcp_tokens (server_id, user_id, access_enc, refresh_enc, expires_at, scope, connected_by) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (server_id, user_id) DO UPDATE SET access_enc = EXCLUDED.access_enc,
       refresh_enc = coalesce(EXCLUDED.refresh_enc, mcp_tokens.refresh_enc), expires_at = EXCLUDED.expires_at, scope = EXCLUDED.scope, updated_at = now()`,
    [serverId, owner, seal(t.accessToken), t.refreshToken ? seal(t.refreshToken) : null, t.expiresAt, t.scope, by],
  );
}

/** The access token for a call, refreshed first when it expires within a minute (or when `force`). */
async function accessToken(pool: Pool, row: ServerRow, userId: string, force = false): Promise<string> {
  const owner = tokenOwner(row, userId);
  const tok = await readToken(pool, row.id, owner);
  if (!tok) throw new NeedsAuth();
  const soon = tok.expires_at && tok.expires_at.getTime() < Date.now() + 60_000;
  if (!force && !soon) return unseal(tok.access_enc);
  if (!tok.refresh_enc || !row.oauth_meta || !row.oauth_client_id) {
    if (force) throw new NeedsAuth("the server refused the stored sign-in: connect again");
    return unseal(tok.access_enc);
  }
  try {
    const fresh = await refreshTokens(
      row.oauth_meta as OAuthMeta,
      { clientId: row.oauth_client_id, clientSecret: row.oauth_client_secret_enc ? unseal(row.oauth_client_secret_enc) : null },
      unseal(tok.refresh_enc),
    );
    await saveToken(pool, row.id, owner, userId || "system", fresh);
    return fresh.accessToken;
  } catch (e) {
    logger.warn({ err: (e as Error).message, server: row.id }, "mcp token refresh failed");
    throw new NeedsAuth("the sign-in expired: connect again");
  }
}

export interface Session {
  serverInfo: { name?: string; version?: string };
  listTools(): Promise<McpToolInfo[]>;
  call(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<{ text: string; isError: boolean }>;
  close(): Promise<void>;
}

/** One initialized session with a server, as `userId` (whose token a per-person server uses). */
export async function openSession(pool: Pool, row: ServerRow, userId: string, opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<Session> {
  const [{ Client }, { GuardedHttpTransport, McpAuthError }] = await Promise.all([import("@modelcontextprotocol/sdk/client/index.js"), import("./transport.js")]);
  const connect = async (forceRefresh: boolean) => {
    const headers: Record<string, string> =
      row.auth === "header" ? headerOf(row) : row.auth === "oauth" ? { authorization: `Bearer ${await accessToken(pool, row, userId, forceRefresh)}` } : {};
    const transport = new GuardedHttpTransport(row.url, () => headers, opts.timeoutMs ?? CALL_TIMEOUT_MS, opts.env);
    const client = new Client({ name: "workspace", version: "1.0.2" }, { capabilities: {} });
    await client.connect(transport, { timeout: opts.timeoutMs ?? 15_000 });
    return client;
  };
  let client: Awaited<ReturnType<typeof connect>>;
  try {
    client = await connect(false);
  } catch (e) {
    // A refused OAuth token: refresh once and try again; anything else is the caller's error.
    if (!(e instanceof McpAuthError) || row.auth !== "oauth") throw e;
    client = await connect(true);
  }
  const info = client.getServerVersion();
  return {
    serverInfo: { ...(info?.name ? { name: info.name } : {}), ...(info?.version ? { version: info.version } : {}) },
    async listTools() {
      const out: McpToolInfo[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5 && out.length < 300; page++) {
        const r = await client.listTools(cursor ? { cursor } : {}, { timeout: 15_000 });
        for (const t of r.tools) {
          const a = (t.annotations ?? {}) as { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
          out.push({
            name: t.name.slice(0, 200),
            title: (a.title ?? (t as { title?: string }).title ?? null)?.slice(0, 200) ?? null,
            description: (t.description ?? "").slice(0, 2000),
            inputSchema: cleanSchema(t.inputSchema as Record<string, unknown>),
            readOnly: a.readOnlyHint === true,
            destructive: a.destructiveHint === true,
          });
        }
        cursor = r.nextCursor;
        if (!cursor) break;
      }
      return out;
    },
    async call(name, args, timeoutMs = CALL_TIMEOUT_MS) {
      const r = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
      return { text: resultText(r as CallResult), isError: r.isError === true };
    },
    close: () => client.close().catch(() => undefined),
  };
}

interface CallResult {
  content?: { type: string; text?: string; resource?: { uri?: string; text?: string }; uri?: string; name?: string }[];
  structuredContent?: unknown;
  toolResult?: unknown;
  isError?: boolean;
}

/** A tool result as text for the model: text parts as they are, other parts named, capped at RESULT_MAX. */
export function resultText(r: CallResult): string {
  const parts = (r.content ?? []).map((c) => {
    if (c.type === "text") return c.text ?? "";
    if (c.type === "resource") return c.resource?.text ?? `[resource ${c.resource?.uri ?? ""}]`;
    if (c.type === "resource_link") return `[link ${c.name ?? ""} ${c.uri ?? ""}]`;
    return `[${c.type}]`;
  });
  let text = parts.join("\n").trim();
  if (!text && r.structuredContent !== undefined) text = JSON.stringify(r.structuredContent);
  if (!text && r.toolResult !== undefined) text = JSON.stringify(r.toolResult);
  return text.length > RESULT_MAX ? `${text.slice(0, RESULT_MAX)}\n…(result cut at ${RESULT_MAX} characters)` : text || "(empty result)";
}

/** A JSON schema the vendors accept: an object schema, without `$schema` (some APIs refuse unknown keywords there). */
export function cleanSchema(s: Record<string, unknown> | undefined): Record<string, unknown> {
  const { $schema: _drop, ...rest } = s ?? {};
  return { ...rest, type: "object", properties: (rest.properties as Record<string, unknown>) ?? {} };
}

/** `github__list_issues`: the server's slug and the tool's name, in the characters and length every vendor accepts. */
export function toolKey(slug: string, tool: string): string {
  return `${slug}__${tool.replace(/[^A-Za-z0-9_-]/g, "_")}`.slice(0, 64);
}

/** Servers whose tools are fresh enough, or read again (a short wait at most) and stored for everyone. */
async function freshTools(pool: Pool, row: ServerRow, userId: string): Promise<McpToolInfo[]> {
  if (row.tools_at && Date.now() - row.tools_at.getTime() < TOOLS_TTL_MS) return row.tools;
  // One person refreshes it; the others keep the stored list meanwhile.
  const claimed = await pool.query("UPDATE mcp_servers SET tools_at = now() WHERE id = $1 AND (tools_at IS NULL OR tools_at < now() - interval '10 minutes') RETURNING id", [
    row.id,
  ]);
  if (!claimed.rowCount) return row.tools;
  try {
    const s = await openSession(pool, row, userId, { timeoutMs: 6000 });
    try {
      const tools = await s.listTools();
      await pool.query("UPDATE mcp_servers SET tools = $2, server_info = $3, tools_at = now() WHERE id = $1", [row.id, JSON.stringify(tools), JSON.stringify(s.serverInfo)]);
      return tools;
    } finally {
      await s.close();
    }
  } catch (e) {
    logger.info({ err: (e as Error).message, server: row.id }, "mcp tools/list refresh failed; using the stored list");
    return row.tools;
  }
}

export interface ToolUse {
  key: string;
  serverId: string;
  server: string;
  tool: string;
  title: string | null;
  outcome: "ok" | "error" | "timeout" | "denied" | "declined" | "auth";
  ms: number;
}

export interface ExternalTool {
  key: string;
  row: ServerRow;
  tool: McpToolInfo;
  confirm: boolean;
}

export interface ExternalTools {
  specs: ToolSpec[];
  byKey: Map<string, ExternalTool>;
  /** Runs one call as the person, audited; never throws. The content is untrusted text for the model. */
  run(key: string, input: unknown): Promise<{ ok: boolean; content: string; use: ToolUse }>;
  /** Records a call the person declined (ask-before-run). */
  declined(key: string): Promise<ToolUse>;
  close(): Promise<void>;
}

/**
 * The external tools one answer may use: enabled servers this person may use, their enabled tools, and only those
 * that run without asking unless `withConfirm` (Hỏi đáp can show a confirm card; a workflow step cannot).
 * null when there are none, after one cheap query, so a workspace without MCP servers pays nothing more.
 */
export async function externalTools(
  pool: Pool,
  who: { principal: Principal; agentId: string | null; feature: string; departmentId: () => Promise<string | null> },
  opts: { withConfirm: boolean; env?: NodeJS.ProcessEnv },
): Promise<ExternalTools | null> {
  const rows = (await pool.query<ServerRow>(`SELECT ${SERVER_COLS} FROM mcp_servers WHERE enabled ORDER BY created_at`)).rows;
  if (!rows.length) return null;
  const p = who.principal;
  const dept = rows.some((r) => r.audience === "departments") ? await who.departmentId() : null;
  let usable = rows.filter((r) => mayUse(r, p, dept));
  // OAuth servers need a token: the company's, or this person's own on a per-person server.
  const oauth = usable.filter((r) => r.auth === "oauth");
  if (oauth.length) {
    const have = new Set(
      (
        await pool.query<{ server_id: string; user_id: string }>("SELECT server_id, user_id FROM mcp_tokens WHERE server_id = ANY($1) AND user_id IN ('', $2)", [
          oauth.map((r) => r.id),
          p.id,
        ])
      ).rows.map((x) => `${x.server_id}:${x.user_id}`),
    );
    usable = usable.filter((r) => r.auth !== "oauth" || have.has(`${r.id}:${tokenOwner(r, p.id)}`));
  }
  if (!usable.length) return null;
  const byKey = new Map<string, ExternalTool>();
  for (const row of usable) {
    const tools = await freshTools(pool, row, p.id);
    for (const tool of tools) {
      const s = settingOf(row, tool);
      if (!s.enabled || (s.confirm && !opts.withConfirm)) continue;
      let key = toolKey(row.slug, tool.name);
      if (byKey.has(key)) key = `${key.slice(0, 60)}_${byKey.size}`;
      byKey.set(key, { key, row, tool, confirm: s.confirm });
      if (byKey.size >= 64) break;
    }
  }
  if (!byKey.size) return null;
  const specs: ToolSpec[] = [...byKey.values()].map((x) => ({
    name: x.key,
    // The model learns which outside system a tool belongs to; the description itself comes from that server.
    description: `[${x.row.name}${x.confirm ? ", asks the user before running" : ""}] ${x.tool.title ? `${x.tool.title}: ` : ""}${x.tool.description}`.slice(0, 1024),
    inputSchema: x.tool.inputSchema,
  }));
  const sessions = new Map<string, Promise<Session>>();
  const session = (row: ServerRow) => {
    let s = sessions.get(row.id);
    if (!s) {
      s = openSession(pool, row, p.id, { ...(opts.env ? { env: opts.env } : {}) });
      // A failed connect is not kept: the next call tries again.
      s.catch(() => sessions.delete(row.id));
      sessions.set(row.id, s);
    }
    return s;
  };
  const audit = async (x: ExternalTool, outcome: ToolUse["outcome"], ms: number): Promise<ToolUse> => {
    await withTransaction(pool, (c) =>
      c.query("INSERT INTO mcp_calls (id, user_id, agent_id, server_id, server_name, tool, feature, outcome, ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [
        newId(),
        p.id,
        who.agentId,
        x.row.id,
        x.row.name,
        x.tool.name,
        who.feature,
        outcome,
        ms,
      ]),
    ).catch((err) => logger.warn({ err }, "mcp call audit failed"));
    return { key: x.key, serverId: x.row.id, server: x.row.name, tool: x.tool.name, title: x.tool.title, outcome, ms };
  };
  return {
    specs,
    byKey,
    async run(key, input) {
      const x = byKey.get(key)!;
      const started = Date.now();
      const args = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
      try {
        const r = await (await session(x.row)).call(x.tool.name, args);
        const use = await audit(x, r.isError ? "error" : "ok", Date.now() - started);
        return { ok: !r.isError, content: r.isError ? `The tool reported an error:\n${r.text}` : r.text, use };
      } catch (e) {
        const timeout = e instanceof NetError ? e.code === "timeout" : /timed? ?out/i.test((e as Error).message);
        const auth = e instanceof NeedsAuth || (e as { status?: number }).status === 401 || (e as { status?: number }).status === 403;
        const use = await audit(x, timeout ? "timeout" : auth ? "auth" : "error", Date.now() - started);
        logger.info({ err: (e as Error).message, server: x.row.id, tool: x.tool.name }, "mcp tool call failed");
        return {
          ok: false,
          content: timeout
            ? `${x.row.name} did not answer in time.`
            : auth
              ? `${x.row.name} refused the sign-in: the user (or an admin) must connect it again.`
              : `${x.row.name} could not run ${x.tool.name}; try again later.`,
          use,
        };
      }
    },
    declined: (key) => audit(byKey.get(key)!, "declined", 0),
    async close() {
      await Promise.all([...sessions.values()].map((s) => s.then((x) => x.close()).catch(() => undefined)));
    },
  };
}
