import type { PoolClient } from "pg";
import { z } from "zod";
import { authorize, type Principal } from "@workspace/shared";
import { secretBox } from "@workspace/service-kit";
import { urlProblem } from "./net.js";
import type { OAuthMeta } from "./oauth.js";

/**
 * External MCP servers (Admin › Kết nối AI › Máy chủ MCP): rows, the admin's input, what the page sees (never a
 * secret), the per-tool choices and who may use a server. Secrets go through their own secretBox label (same
 * AI_SECRETS_KEY override as the AI connections), so a leaked derived key for one does not open the other.
 */
const box = secretBox("ai-mcp/v1", "AI_SECRETS_KEY");
export const seal = (plain: string, env?: NodeJS.ProcessEnv) => box.encrypt(plain, env);
export const unseal = (enc: string, env?: NodeJS.ProcessEnv) => box.decrypt(enc, env);
export const hintOf = (secret: string) => (secret.length > 8 ? `…${secret.slice(-4)}` : "…");

export interface McpToolInfo {
  name: string;
  title: string | null;
  description: string;
  inputSchema: Record<string, unknown>;
  /** The server says the tool only reads (annotations.readOnlyHint). */
  readOnly: boolean;
  destructive: boolean;
}
export interface ToolSetting {
  enabled: boolean;
  /** Ask the person before it runs (a confirm card in Hỏi đáp); such tools are never offered where no one can answer. */
  confirm: boolean;
}

export type Audience = "everyone" | "departments" | "admins";
export type AuthKind = "none" | "header" | "oauth";

export interface ServerRow {
  id: string;
  slug: string;
  name: string;
  url: string;
  preset: string | null;
  auth: AuthKind;
  header_name: string | null;
  secret_enc: string | null;
  secret_hint: string | null;
  oauth_per_user: boolean;
  oauth_client_id: string | null;
  oauth_client_secret_enc: string | null;
  oauth_meta: OAuthMeta | null;
  audience: Audience;
  department_ids: string[];
  enabled: boolean;
  server_info: { name?: string; version?: string } | null;
  tools: McpToolInfo[];
  tools_at: Date | null;
  tool_settings: Record<string, ToolSetting>;
  tested_at: Date | null;
  test_ok: boolean | null;
  test_error: string | null;
  updated_at: Date;
}
export const SERVER_COLS =
  "id, slug, name, url, preset, auth, header_name, secret_enc, secret_hint, oauth_per_user, oauth_client_id, oauth_client_secret_enc, oauth_meta, audience, department_ids, enabled, server_info, tools, tools_at, tool_settings, tested_at, test_ok, test_error, updated_at";

/** A tool's effective setting: the admin's choice, else on, asking first unless the server marks it read-only. */
export function settingOf(row: Pick<ServerRow, "tool_settings">, t: Pick<McpToolInfo, "name" | "readOnly">): ToolSetting {
  const s = row.tool_settings[t.name];
  return { enabled: s?.enabled ?? true, confirm: s?.confirm ?? !t.readOnly };
}

/** What Admin › Kết nối AI shows: no secret, only its last characters; whether the company account is connected. */
export function serverDto(r: ServerRow, companyConnected: boolean) {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    url: r.url,
    preset: r.preset,
    auth: r.auth,
    headerName: r.header_name,
    secretHint: r.secret_hint,
    oauthPerUser: r.oauth_per_user,
    oauthClientId: r.oauth_client_id,
    hasClientSecret: !!r.oauth_client_secret_enc,
    connected: r.auth !== "oauth" || r.oauth_per_user ? null : companyConnected,
    audience: r.audience,
    departmentIds: r.department_ids,
    enabled: r.enabled,
    serverInfo: r.server_info,
    tools: r.tools.map((t) => ({ ...t, inputSchema: undefined, ...settingOf(r, t) })),
    toolsAt: r.tools_at,
    test: r.tested_at ? { at: r.tested_at, ok: !!r.test_ok, error: r.test_error } : null,
    updatedAt: r.updated_at,
  };
}

// ---------------------------------------------------------------- input

const url = z
  .string()
  .trim()
  .min(8)
  .max(500)
  .superRefine((v, ctx) => {
    const p = urlProblem(v);
    if (p) ctx.addIssue({ code: "custom", message: p });
  });

/** A header name an admin may set: a token, and never one that would change how the request is routed or framed. */
const headerName = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[A-Za-z0-9-]+$/, "letters, digits and dashes only")
  .refine(
    (h) => !/^(host|content-length|content-type|accept|connection|transfer-encoding|mcp-session-id|mcp-protocol-version|cookie)$/i.test(h),
    "this header is set by workspace",
  );

export const ServerInput = z.object({
  name: z.string().trim().min(1).max(80),
  url,
  preset: z.string().trim().max(40).nullable().optional(),
  auth: z.enum(["none", "header", "oauth"]),
  headerName: headerName.optional(),
  /** Write-only. Omitted on an edit keeps the stored one (same URL only). */
  secret: z.string().trim().min(1).max(4000).optional(),
  oauthPerUser: z.boolean().optional(),
  /** For servers without dynamic client registration: a client the admin registered with them. */
  oauthClientId: z.string().trim().max(300).optional(),
  oauthClientSecret: z.string().trim().max(1000).optional(),
  audience: z.enum(["everyone", "departments", "admins"]).default("everyone"),
  departmentIds: z.array(z.string().min(1).max(40)).max(200).default([]),
  enabled: z.boolean().optional(),
});
export type ServerInput = z.infer<typeof ServerInput>;

export const ToolSettingsInput = z.object({
  tools: z.record(z.string().min(1).max(200), z.object({ enabled: z.boolean(), confirm: z.boolean() })).refine((r) => Object.keys(r).length <= 500, "too many tools"),
});

/** A short, unique prefix for the server's tools: letters and digits of the name, then a number if taken. */
export async function freeSlug(c: PoolClient, name: string, exceptId?: string): Promise<string> {
  const base =
    name
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 12) || "mcp";
  const taken = new Set((await c.query<{ slug: string }>("SELECT slug FROM mcp_servers WHERE slug LIKE $1 AND id <> $2", [`${base}%`, exceptId ?? ""])).rows.map((r) => r.slug));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) if (!taken.has(`${base}${i}`)) return `${base}${i}`;
  return `${base.slice(0, 8)}${Date.now() % 100000}`;
}

/** The header an admin's secret is sent in: `Authorization: Bearer <token>` unless they named another header. */
export function headerOf(row: Pick<ServerRow, "header_name" | "secret_enc">): Record<string, string> {
  if (!row.secret_enc) return {};
  const name = row.header_name || "Authorization";
  let value = unseal(row.secret_enc);
  if (/^authorization$/i.test(name) && !/^\S+\s+\S/.test(value)) value = `Bearer ${value}`;
  return { [name.toLowerCase()]: value };
}

export const isMcpAdmin = (p: Principal) => authorize(p, "ai.agent.manage").allowed;

/** Whether this person may have the server's tools in their AI answers. */
export function mayUse(row: Pick<ServerRow, "audience" | "department_ids">, p: Principal, departmentId: string | null): boolean {
  if (row.audience === "everyone") return true;
  if (row.audience === "admins") return isMcpAdmin(p);
  return !!departmentId && row.department_ids.includes(departmentId);
}

/** The redirect URI registered with OAuth servers: the web app's callback page. */
export const redirectUri = (env: NodeJS.ProcessEnv = process.env) => `${(env.APP_URL || "http://localhost:3000").replace(/\/$/, "")}/mcp-callback`;
