import express, { type NextFunction, type Request, type Response } from "express";
import { ServiceCallError, type ServiceClient } from "@workspace/service-kit";

/**
 * OAuth 2.1 at the edge, so a remote MCP client (Claude, ChatGPT, Cursor, VS Code) connects with just the URL:
 *
 *   client ─POST /api/mcp─► 401 + WWW-Authenticate: resource_metadata=…/.well-known/oauth-protected-resource/api/mcp
 *     ─► /.well-known/oauth-authorization-server ─► POST /oauth/register (RFC 7591)
 *     ─► browser: /oauth/authorize (the web app's consent page, as the signed-in person) ─► redirect_uri?code=…
 *     ─► POST /oauth/token (code + PKCE S256) ─► woa_ access token (1 h) + wor_ refresh token (rotated)
 *
 * This file only speaks the protocol (metadata, form bodies, client authentication, rate limits); identity keeps the
 * clients, grants and tokens (identity/oauth.ts). Tokens are opaque and only open /api/mcp.
 */

export interface OAuthEdgeConfig {
  identity: ServiceClient;
  /** Public origins this installation answers on (APP_URL, PUBLIC_API_URL); the first one is the app. */
  publicOrigins: string[];
  /** Fixed-window limiter shared with the gateway. */
  allow(key: string, limit: number, windowSeconds: number): boolean;
}

export const SCOPES = ["mcp:read", "mcp:write"];
export const MCP_PATH = "/api/mcp";

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/**
 * The origin the client used, for the metadata: one of the configured public origins, or this computer in
 * development. Anything else (a forged Host header) gets the app's configured origin.
 */
export function publicBase(req: Request, origins: string[]): string {
  const trusted = (req.app.get("trust proxy fn") as ((addr: string, i: number) => boolean) | undefined)?.(req.socket.remoteAddress ?? "", 0) ?? false;
  const host = ((trusted && req.get("x-forwarded-host")?.split(",")[0]?.trim()) || req.get("host") || "").toLowerCase();
  const seen = `${req.protocol}://${host}`;
  const known = origins.find((o) => o.toLowerCase() === seen);
  if (known) return known;
  if (LOOPBACK.test(host)) return seen;
  return origins[0] ?? seen;
}

/** The challenge a 401 from /api/mcp carries (RFC 9728 §5.1), with `invalid_token` when a token was sent. */
export function challenge(base: string, invalid: boolean): string {
  return `Bearer ${invalid ? 'error="invalid_token", ' : ""}resource_metadata="${base}/.well-known/oauth-protected-resource${MCP_PATH}"`;
}

export function protectedResourceMetadata(base: string) {
  return {
    resource: `${base}${MCP_PATH}`,
    authorization_servers: [base],
    scopes_supported: SCOPES,
    bearer_methods_supported: ["header"],
    resource_name: "workspace",
  };
}

export function authorizationServerMetadata(base: string, appOrigin: string) {
  const auth = ["none", "client_secret_post", "client_secret_basic"];
  return {
    issuer: base,
    authorization_endpoint: `${appOrigin}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: auth,
    revocation_endpoint_auth_methods_supported: auth,
    scopes_supported: SCOPES,
    service_documentation: "https://github.com/hungga1711/workspace/blob/main/docs/integrations/mcp.md",
  };
}

/** CORS for the endpoints browser-based MCP clients call: bearer tokens only, never cookies, so any origin is fine. */
export function openCors(req: Request, res: Response, next: NextFunction) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("access-control-allow-headers", "authorization, content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id");
  res.setHeader("access-control-expose-headers", "www-authenticate, mcp-session-id");
  res.setHeader("access-control-max-age", "86400");
  if (req.method === "OPTIONS") return void res.status(204).end();
  next();
}

/** client_secret_basic: the client id and secret from the Authorization header (RFC 6749 §2.3.1, form-encoded). */
function basicClient(req: Request): { client_id?: string; client_secret?: string } {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(req.header("authorization") ?? "");
  if (!m) return {};
  const raw = Buffer.from(m[1]!, "base64").toString("utf8");
  const i = raw.indexOf(":");
  if (i < 0) return {};
  try {
    return { client_id: decodeURIComponent(raw.slice(0, i)), client_secret: decodeURIComponent(raw.slice(i + 1)) };
  } catch {
    return {};
  }
}

/** The protocol routes. Answers carry no-store (RFC 6749 §5.1) and OAuth-shaped errors. */
export function mountOAuth(app: express.Express, cfg: OAuthEdgeConfig) {
  const form = [express.urlencoded({ extended: false, limit: "64kb" }), express.json({ limit: "64kb" })];
  const app0 = () => cfg.publicOrigins[0] ?? "http://localhost:3000";

  const prm = (req: Request, res: Response) => res.json(protectedResourceMetadata(publicBase(req, cfg.publicOrigins)));
  app.options(/^\/(\.well-known\/oauth-[a-z-]+(\/.*)?|oauth\/(token|register|revoke))$/, openCors);
  app.get(["/.well-known/oauth-protected-resource", `/.well-known/oauth-protected-resource${MCP_PATH}`], openCors, prm);
  // RFC 8414 puts the issuer's path after the well-known prefix; the issuer has none, but older clients append the MCP path.
  app.get(["/.well-known/oauth-authorization-server", `/.well-known/oauth-authorization-server${MCP_PATH}`], openCors, (req, res) =>
    res.json(authorizationServerMetadata(publicBase(req, cfg.publicOrigins), app0())),
  );

  // The consent page lives in the web app. Reached here when the gateway has its own address (development, API domain).
  app.get("/oauth/authorize", (req, res) => {
    const q = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    res.redirect(302, `${app0()}/oauth/authorize${q}`);
  });

  const call =
    (path: string, limit: number, status: number) =>
    async (req: Request, res: Response): Promise<void> => {
      res.setHeader("cache-control", "no-store");
      res.setHeader("pragma", "no-cache");
      if (!cfg.allow(`rl:oauth:${path}:${req.ip ?? "unknown"}`, limit, 3600)) {
        res.status(429).json({ error: "slow_down", error_description: "too many requests, try later" });
        return;
      }
      const body = { ...(req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {}), ...(path === "register" ? {} : basicClient(req)) };
      try {
        const out = await cfg.identity.request("POST", `/internal/oauth/${path}`, body);
        res.status(status).json(out ?? {});
      } catch (e) {
        if (e instanceof ServiceCallError && e.status < 500) {
          const b = (e.body ?? {}) as { error?: unknown; error_description?: unknown };
          if (e.status === 401 && req.header("authorization")?.startsWith("Basic")) res.setHeader("www-authenticate", 'Basic realm="workspace"');
          res.status(e.status).json({
            error: typeof b.error === "string" ? b.error : "invalid_request",
            ...(typeof b.error_description === "string" ? { error_description: b.error_description } : {}),
          });
          return;
        }
        res.status(503).json({ error: "temporarily_unavailable" });
      }
    };
  // A registration per minute from one address is plenty for people connecting apps; scanners get nothing more.
  app.post("/oauth/register", openCors, ...form, call("register", 60, 201));
  app.post("/oauth/token", openCors, ...form, call("token", 1200, 200));
  app.post("/oauth/revoke", openCors, ...form, call("revoke", 600, 200));
}

/** The principal an OAuth access token acts as, from identity, with what the activity log needs. */
export interface OAuthResolution {
  principal: import("@workspace/shared").Principal;
  grantId: string;
  clientName: string;
  expiresAt: string;
}
