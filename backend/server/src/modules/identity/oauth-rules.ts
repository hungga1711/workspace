import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * The rules of the MCP OAuth server that need no database: which redirect URIs a client may register and use, PKCE,
 * the permission presets on the consent page, and the shape of a registration. Unit-tested next to this file.
 */

/** What an MCP agent reads (the tools in gateway/mcp-tools.ts) and what it may change. */
export const MCP_READ = [
  "task.read",
  "project.read",
  "document.read",
  "message.read",
  "channel.read",
  "employee.profile.read",
  "home.read",
  "member.read",
  "file.read",
  "calendar.read",
] as const;
export const MCP_WRITE = ["task.create", "task.edit", "task.assign", "document.create", "document.edit", "message.post"] as const;
export const MCP_SCOPES = ["mcp:read", "mcp:write"] as const;

/** The permissions a consent preset stands for, among those the person may give. */
export function presetPermissions(preset: "read" | "write", grantable: readonly string[]): string[] {
  const want: readonly string[] = preset === "read" ? MCP_READ : [...MCP_READ, ...MCP_WRITE];
  return grantable.filter((p) => want.includes(p));
}

/** The OAuth scope string a set of permissions amounts to (what the token response reports). */
export function scopeOf(permissions: readonly string[]): string {
  return permissions.some((p) => (MCP_WRITE as readonly string[]).includes(p)) ? "mcp:read mcp:write" : "mcp:read";
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * A redirect URI a client may register: https anywhere, http only to this computer (native apps, RFC 8252 §7.3), or an
 * app's own scheme (cursor://, vscode://, RFC 8252 §7.1). Never javascript:, data:, file: or a fragment.
 */
export function validRedirectUri(raw: string): boolean {
  if (raw.length > 2000) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:") return LOOPBACK.has(u.hostname);
  if (/^(javascript|data|file|blob|about|vbscript|ws|wss|ftp):$/.test(u.protocol)) return false;
  // A private-use scheme: reverse-domain or an app name, letters first (RFC 3986 scheme syntax).
  return /^[a-z][a-z0-9+.-]{1,63}:$/.test(u.protocol);
}

/**
 * Whether a redirect URI sent with a request is one the client registered: exact match, except that a loopback
 * address may use any port (native apps pick a free port at run time, RFC 8252 §7.3).
 */
export function redirectMatches(registered: readonly string[], sent: string): boolean {
  if (registered.includes(sent)) return true;
  let s: URL;
  try {
    s = new URL(sent);
  } catch {
    return false;
  }
  if (s.protocol !== "http:" || !LOOPBACK.has(s.hostname)) return false;
  return registered.some((r) => {
    try {
      const u = new URL(r);
      return u.protocol === "http:" && u.hostname === s.hostname && u.pathname === s.pathname && u.search === s.search;
    } catch {
      return false;
    }
  });
}

/** What the consent page shows for "where you will be sent back": the host, or the app scheme. */
export function redirectLabel(uri: string): string {
  if (typeof uri !== "string") return "";
  try {
    const u = new URL(uri);
    return u.host || u.protocol.replace(/:$/, "");
  } catch {
    return uri.slice(0, 80);
  }
}

/** PKCE S256 (RFC 7636): BASE64URL(SHA256(verifier)) === challenge, compared in constant time. */
export function pkceOk(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const a = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** RFC 7591 client metadata; anything else a client sends is ignored. */
export const registerBody = z.object({
  redirect_uris: z.array(z.string()).min(1).max(10),
  client_name: z.string().trim().max(120).optional(),
  client_uri: z.string().url().max(500).optional(),
  token_endpoint_auth_method: z.enum(["none", "client_secret_post", "client_secret_basic"]).default("none"),
  grant_types: z.array(z.string()).max(5).optional(),
  response_types: z.array(z.string()).max(5).optional(),
  software_id: z.string().max(200).optional(),
  software_version: z.string().max(80).optional(),
});

/** The authorization request as the consent page passes it on (the client's query parameters). */
export const authorizeBody = z.object({
  clientId: z.string().min(1).max(100),
  redirectUri: z.string().min(1).max(2000),
  codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/, "code_challenge must be a S256 challenge"),
  codeChallengeMethod: z.literal("S256"),
  state: z.string().max(1000).optional(),
  resource: z.string().max(500).optional(),
  permissions: z.array(z.string()).max(60).default([]),
  approve: z.boolean(),
});

/** The client's redirect URI with the code (or the error) and its state. */
export function redirectWith(uri: string, params: Record<string, string | undefined>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}
