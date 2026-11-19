import { createHash, randomBytes } from "node:crypto";
import { mcpFetch, readJson, readText } from "./net.js";

/**
 * OAuth 2.1 for remote MCP servers (MCP authorization spec): authorization code with PKCE (S256), the server found
 * through its protected-resource metadata (RFC 9728) and its authorization server's metadata (RFC 8414, or OpenID
 * discovery), a client registered dynamically (RFC 7591) when the server offers it, and the MCP server named as the
 * token's `resource` (RFC 8707). Every request goes through the guarded fetch.
 */

export interface AuthServerMeta {
  issuer?: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
}

/** What is kept on the server row once discovered: the endpoints and the scopes to ask for. */
export interface OAuthMeta {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  scope: string | null;
  resource: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scope: string | null;
}

const json = { accept: "application/json" };

async function getJson<T>(url: string, env?: NodeJS.ProcessEnv): Promise<T | null> {
  try {
    const res = await mcpFetch(url, { headers: { ...json, "mcp-protocol-version": "2025-06-18" }, timeoutMs: 8000 }, env);
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return null;
    }
    return await readJson<T>(res, 256 * 1024);
  } catch {
    return null;
  }
}

/** `{origin}/.well-known/{name}{path}` first (path-aware), then `{origin}/.well-known/{name}`. */
function wellKnown(base: string, name: string): string[] {
  const u = new URL(base);
  const path = u.pathname.replace(/\/+$/, "");
  return [...(path ? [`${u.origin}/.well-known/${name}${path}`] : []), `${u.origin}/.well-known/${name}`];
}

/**
 * Where to sign in for an MCP server: the resource metadata the server pointed to (its 401's WWW-Authenticate), else
 * the well-known locations; its authorization server's metadata, else the 2025-03-26 defaults on the server's origin.
 */
export async function discover(serverUrl: string, resourceMetadataUrl: string | null, env?: NodeJS.ProcessEnv): Promise<{ meta: OAuthMeta; advertised: boolean }> {
  let prm: { authorization_servers?: string[]; scopes_supported?: string[]; resource?: string } | null = null;
  for (const url of resourceMetadataUrl ? [resourceMetadataUrl] : wellKnown(serverUrl, "oauth-protected-resource")) {
    prm = await getJson(url, env);
    if (prm) break;
  }
  const issuer = prm?.authorization_servers?.[0] ?? new URL(serverUrl).origin;
  let as: AuthServerMeta | null = null;
  for (const url of [...wellKnown(issuer, "oauth-authorization-server"), ...wellKnown(issuer, "openid-configuration")]) {
    as = await getJson<AuthServerMeta>(url, env);
    if (as?.authorization_endpoint && as.token_endpoint) break;
    as = null;
  }
  const origin = new URL(issuer).origin;
  const meta: OAuthMeta = {
    authorizationEndpoint: as?.authorization_endpoint ?? `${origin}/authorize`,
    tokenEndpoint: as?.token_endpoint ?? `${origin}/token`,
    registrationEndpoint: as ? (as.registration_endpoint ?? null) : `${origin}/register`,
    scope: (prm?.scopes_supported ?? []).join(" ") || null,
    resource: prm?.resource ?? serverUrl,
  };
  return { meta, advertised: !!prm || !!as };
}

/** Registers workspace as a public client (PKCE, no secret) or a confidential one if the server insists. */
export async function registerClient(meta: OAuthMeta, redirectUri: string, env?: NodeJS.ProcessEnv): Promise<{ clientId: string; clientSecret: string | null }> {
  if (!meta.registrationEndpoint) throw new Error("the server does not offer dynamic client registration: enter a client ID");
  const res = await mcpFetch(
    meta.registrationEndpoint,
    {
      method: "POST",
      headers: { ...json, "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "workspace",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        ...(meta.scope ? { scope: meta.scope } : {}),
      }),
      timeoutMs: 10_000,
    },
    env,
  );
  if (!res.ok) throw new Error(`client registration failed (HTTP ${res.status}): ${(await readText(res, 2000).catch(() => "")).slice(0, 200)}`);
  const r = await readJson<{ client_id?: string; client_secret?: string }>(res, 64 * 1024);
  if (!r.client_id) throw new Error("client registration returned no client_id");
  return { clientId: r.client_id, clientSecret: r.client_secret ?? null };
}

export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function authorizeUrl(meta: OAuthMeta, a: { clientId: string; redirectUri: string; state: string; challenge: string }): string {
  const u = new URL(meta.authorizationEndpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", a.clientId);
  u.searchParams.set("redirect_uri", a.redirectUri);
  u.searchParams.set("state", a.state);
  u.searchParams.set("code_challenge", a.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("resource", meta.resource);
  if (meta.scope) u.searchParams.set("scope", meta.scope);
  return u.toString();
}

async function tokenRequest(
  meta: OAuthMeta,
  client: { clientId: string; clientSecret: string | null },
  params: Record<string, string>,
  env?: NodeJS.ProcessEnv,
): Promise<TokenSet> {
  const body = new URLSearchParams({ ...params, client_id: client.clientId, resource: meta.resource });
  const headers: Record<string, string> = { ...json, "content-type": "application/x-www-form-urlencoded" };
  if (client.clientSecret) headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`).toString("base64")}`;
  const res = await mcpFetch(meta.tokenEndpoint, { method: "POST", headers, body: body.toString(), timeoutMs: 10_000 }, env);
  const text = await readText(res, 64 * 1024);
  let r: { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string } = {};
  try {
    r = JSON.parse(text);
  } catch {
    /* a non-JSON error page */
  }
  if (!res.ok || !r.access_token)
    throw new Error(`token request failed (HTTP ${res.status}${r.error ? `: ${r.error}` : ""}${r.error_description ? ` – ${r.error_description.slice(0, 160)}` : ""})`);
  return {
    accessToken: r.access_token,
    refreshToken: r.refresh_token ?? null,
    expiresAt: typeof r.expires_in === "number" ? new Date(Date.now() + r.expires_in * 1000) : null,
    scope: r.scope ?? null,
  };
}

export const exchangeCode = (
  meta: OAuthMeta,
  client: { clientId: string; clientSecret: string | null },
  a: { code: string; verifier: string; redirectUri: string },
  env?: NodeJS.ProcessEnv,
) => tokenRequest(meta, client, { grant_type: "authorization_code", code: a.code, code_verifier: a.verifier, redirect_uri: a.redirectUri }, env);

export const refreshTokens = (meta: OAuthMeta, client: { clientId: string; clientSecret: string | null }, refreshToken: string, env?: NodeJS.ProcessEnv) =>
  tokenRequest(meta, client, { grant_type: "refresh_token", refresh_token: refreshToken }, env);
