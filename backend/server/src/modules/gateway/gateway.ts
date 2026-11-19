import { createHash } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet, type JWTVerifyGetKey } from "jose";
import { type DeployFeature, type Principal, featureDisabled, runWithRequestId } from "@workspace/shared";
import { kv, logger, ServiceCallError, ServiceClient, serviceFetch, signInternalToken, PRINCIPAL_HEADER, requestIdFrom, REQUEST_ID_HEADER } from "@workspace/service-kit";
import { challenge, MCP_PATH, mountOAuth, openCors, publicBase, type OAuthResolution } from "./oauth.js";
import { BFF_READ_HEADER, bffReadKey, isBffRead } from "./bff-read.js";
import { DEMO_LOCKED_BODY, DEMO_LOCKED_PUBLIC, DEMO_ROLES, DEMO_SEED_HEADER, demoLocked, demoSeeding, type DemoConfig, type DemoRole } from "./demo.js";

/**
 * BFF / API gateway.
 *
 *   browser ──Bearer (identity's access JWT, EdDSA)──► verify with the public keys (JWKS)
 *     ──► session alive and account version current? (in memory, filled from identity on a miss)
 *     ──► member of the installation's workspace? ──► principal (identity, cached in memory 60s)
 *     ──► sign internal token ──► forward to the owning module
 *
 * An installation holds exactly one workspace (ADR 0005): the gateway looks it up itself, so clients never
 * name one.
 */
export interface GatewayConfig {
  /** identity's public keys for access tokens (internal URL). */
  jwksUrl: string;
  internalSecret: string;
  identity: ServiceClient;
  platform: ServiceClient;
  /** work, for the public meeting-link routes (guests have no account). */
  work?: ServiceClient;
  /** ai, for the AI browser extension (its connection code is its only credential). */
  ai?: ServiceClient;
  /** Route prefix (`/api/<module>/…`) → the module's internal base URL. */
  services: Record<string, string>;
  /** ssrReadsPerMinute: the separate bucket for the web app's page-render reads (bff-read.ts); default 5× the user limit. */
  rateLimit: { userPerMinute: number; signupPerIpPerHour: number; recoveryPerIpPerHour?: number; ssrReadsPerMinute?: number };
  /** Express "trust proxy" setting: which hops may set X-Forwarded-For (the web BFF forwards the browser's IP). */
  trustProxy?: string;
  /** Serve the OpenAPI document and its viewer at /api/docs (API_DOCS=1). */
  apiDocs?: boolean;
  /** The public demo (DEMO_MODE=1): quick sign-in, locked admin actions, per-IP limits (demo.ts). */
  demo?: DemoConfig | null;
  /** Public origins (APP_URL first, then PUBLIC_API_URL) for the MCP OAuth metadata (oauth.ts). */
  publicOrigins?: string[];
}

interface AuthedRequest extends Request {
  userId?: string;
  /** The sign-in session the token belongs to, and whether it passed two-step sign-in. */
  sessionId?: string;
  mfa?: boolean;
  /** The session's account must replace a password someone else set (admin reset, invite with password). */
  pwc?: boolean;
  apiKey?: string;
  /** An OAuth access token (woa_…, MCP clients): it only opens /api/mcp. */
  oauthToken?: string;
  /** Which credential made the call, for the MCP activity log: its kind and a reference (key hash, grant id). */
  credential?: { via: "oauth" | "personal_key" | "workspace_key" | "session"; ref: string | null };
  principal?: Principal;
  /** Modules switched on for the workspace (platform), when known. */
  features?: Record<string, boolean> | undefined;
  requestId?: string;
}

/** Cache key of the workspace's state (status, module switches). */
const WORKSPACE_KEY = "workspace-state";
/** Cache key of the workspace's two-step sign-in policy. */
const MFA_POLICY_KEY = "mfa-policy";

export function createGateway(cfg: GatewayConfig): express.Express {
  // Caches shared with identity (it overwrites a session's state the moment the session changes).
  const cache = kv();
  const bffKey = bffReadKey(cfg.internalSecret);
  const ssrRead = (req: Request) => isBffRead(req.method, req.header(BFF_READ_HEADER), bffKey);
  const ssrPerMinute = cfg.rateLimit.ssrReadsPerMinute ?? cfg.rateLimit.userPerMinute * 5;
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", cfg.trustProxy ?? "loopback");
  // History and task imports (Slack, Jira, Trello) are large by nature; everything else stays at 1 MB.
  app.use(["/api/chat/imports", /^\/api\/work\/projects\/[^/]+\/import$/], express.json({ limit: "25mb" }));
  // Documents may hold 500,000 characters (Vietnamese is up to 3 bytes each).
  app.use(/^\/api\/work\/docs(\/[^/]+)?$/, express.json({ limit: "4mb" }));
  // A whiteboard snapshot may be 5 MB of scene JSON plus its thumbnail (whiteboard-scene.ts SCENE_LIMITS).
  app.use(/^\/api\/work\/whiteboards\/[^/]+\/scene$/, express.json({ limit: "6mb" }));
  // Hỏi đáp: a question carries its images and files (up to 8 MB, as base64).
  app.use("/api/ai/assistant/messages", express.json({ limit: "12mb" }));
  // What a system outside posts to a workflow's address is small by rule (work/workflows/triggers.ts hookBody).
  // Refused here in words (too large, not readable), not as the "upstream unavailable" other parse failures get.
  const hookBody =
    (parser: express.RequestHandler): express.RequestHandler =>
    (req, res, next) =>
      parser(req, res, (err?: unknown) => {
        if (!err) return next();
        const tooLarge = (err as { status?: number }).status === 413;
        res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? "too large: at most 64 KB" : "the body could not be read" });
      });
  app.use("/api/hooks", hookBody(express.json({ limit: "64kb" })), hookBody(express.text({ type: "text/*", limit: "64kb" })));
  app.use(express.json({ limit: "1mb" }));
  // Keys are cached; an unknown kid (just rotated) refetches at most every 30 s.
  const jwks = cachedJwks(cfg.jwksUrl, { cooldownMs: 30_000, maxAgeMs: 10 * 60_000 });

  // Every request gets an id (the caller's if well-formed), echoed in x-request-id, bound for
  // logs, forwarded to the modules, and added to every error body.
  app.use((req: AuthedRequest, res, next) => {
    const requestId = requestIdFrom(req.header(REQUEST_ID_HEADER));
    req.requestId = requestId;
    res.setHeader(REQUEST_ID_HEADER, requestId);
    const json = res.json.bind(res);
    res.json = (body?: unknown) => json(res.statusCode >= 400 && body && typeof body === "object" && !Array.isArray(body) ? { ...body, requestId } : body);
    runWithRequestId(requestId, () => next());
  });

  app.get("/health", (_req, res) => res.json({ ok: true }));

  if (cfg.demo) {
    const demo = cfg.demo;
    // Everyone shares three accounts, so the per-user limits do not separate visitors: count per IP as well.
    app.use("/api", (req: AuthedRequest, res, next) => {
      const bucket = ssrRead(req) ? (["rl:demo-ip-ssr", demo.perIpPerMinute * 5] as const) : (["rl:demo-ip", demo.perIpPerMinute] as const);
      if (!demoSeeding(demo, req.header(DEMO_SEED_HEADER)) && !allow(`${bucket[0]}:${req.ip ?? "unknown"}`, bucket[1], 60)) return res.status(429).json({ error: "rate_limited" });
      next();
    });
    app.use(DEMO_LOCKED_PUBLIC, (req: AuthedRequest, res, next) => (demoSeeding(demo, req.header(DEMO_SEED_HEADER)) ? next() : res.status(403).json(DEMO_LOCKED_BODY)));
  }

  // The public API's OpenAPI document and a viewer, only when the admin asks for them (API_DOCS=1). Built from the
  // same schemas the modules parse, on first request.
  if (cfg.apiDocs) {
    let doc: Promise<string> | null = null;
    app.get("/api/docs/openapi.json", async (_req, res, next) => {
      try {
        doc ??= import("@workspace/contracts/openapi").then(({ buildOpenApi }) => JSON.stringify(buildOpenApi()));
        res.type("application/json").send(await doc);
      } catch (e) {
        next(e);
      }
    });
    app.get("/api/docs", (_req, res) => {
      res.setHeader(
        "content-security-policy",
        "default-src 'none'; script-src https://cdn.jsdelivr.net; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data: https:; connect-src 'self'; worker-src blob:",
      );
      res.type("html").send(API_DOCS_PAGE);
    });
  }

  // ---- public ----
  // First-run setup: whether this installation's one workspace exists yet.
  app.get("/api/setup", (req: AuthedRequest, res, next) => forward(cfg.platform, "GET", "/setup", undefined, undefined, req, res).catch(next));

  // The workspace logo (Admin › Cài đặt), for the sign-in page as well as the app: public, cacheable per version. An
  // SVG is a document, so it is served sandboxed (no scripts, no requests) in case someone opens it directly.
  app.get("/api/workspace-logo", async (req: AuthedRequest, res, next) => {
    try {
      if (!allow(`rl:logo:${req.ip ?? "unknown"}`, 600, 3600)) return res.status(429).json({ error: "too many requests" });
      const r = await cfg.platform.request<{ contentType: string; data: string; version: number }>("GET", "/logo", undefined, undefined, req.requestId);
      res.setHeader("content-type", r.contentType);
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
      res.setHeader("cache-control", req.query.v === String(r.version) ? "public, max-age=31536000, immutable" : "no-cache");
      res.send(Buffer.from(r.data, "base64"));
    } catch (e) {
      if (e instanceof ServiceCallError) return res.status(e.status).json(e.body);
      next(e);
    }
  });

  app.post("/api/signup", async (req: AuthedRequest, res, next) => {
    try {
      const ip = req.ip ?? "unknown";
      if (!allow(`rl:signup:${ip}`, cfg.rateLimit.signupPerIpPerHour, 3600)) {
        return res.status(429).json({ error: "too many signups, try later" });
      }
      await forward(cfg.platform, "POST", "/signup", req.body, cfg.platform.servicePrincipal(), req, res);
      // The workspace exists from now on: forget everything cached about the installation before it (its state,
      // sign-in policy and people), so nothing from an earlier, emptied installation applies to this one.
      if (res.statusCode < 300) {
        cache.del(WORKSPACE_KEY, MFA_POLICY_KEY);
        cache.delPrefix("principal:");
      }
    } catch (e) {
      next(e);
    }
  });

  // Account recovery for the sign-in screen. Rate-limited per IP;
  // the reset request answers the same whether or not the email exists.
  const perIp = cfg.rateLimit.recoveryPerIpPerHour ?? 20;
  const recovery = (path: string, limit: number) => async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      if (!allow(`rl:recover:${path}:${req.ip ?? "unknown"}`, limit, 3600)) return res.status(429).json({ error: "too many attempts, try later" });
      // At most 5 reset emails per address per hour, so nobody can flood a colleague's inbox.
      const email = path === "password-reset" && typeof req.body?.email === "string" ? req.body.email.toLowerCase() : null;
      if (email && !allow(`rl:recover:email:${email}`, 5, 3600)) return res.status(202).json({ ok: true });
      const out = await cfg.identity.request("POST", `/internal/accounts/${path}`, req.body, undefined, req.requestId);
      res.status(path === "password-reset" ? 202 : 200).json(out);
    } catch (e) {
      next(e);
    }
  };
  app.post("/api/auth/password-reset", recovery("password-reset", perIp));
  app.post("/api/auth/token", recovery("token", perIp * 6));
  app.post("/api/auth/password-set", recovery("password-set", perIp * 2));

  // Sign-in, two-step code, token refresh and sign-out (identity owns them). The visitor's
  // address and browser go along for lockout, the sign-in history and the sessions list.
  const auth = (path: string, limit: number) => async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      if (!allow(`rl:auth:${path}:${req.ip ?? "unknown"}`, limit, 3600)) return res.status(429).json({ error: "rate_limited" });
      const body = { ...(req.body && typeof req.body === "object" ? req.body : {}), ip: req.ip ?? null, userAgent: req.header("user-agent")?.slice(0, 300) ?? null };
      const out = await cfg.identity.request("POST", `/internal/auth/${path}`, body, undefined, req.requestId);
      res.status(out === undefined || out === null ? 204 : 200).json(out ?? undefined);
    } catch (e) {
      next(e);
    }
  };
  // Per-IP ceilings sit above what one office behind a single NAT address needs; lockout per account is in identity.
  app.post("/api/auth/login", auth("login", perIp * 30));
  app.post("/api/auth/mfa", auth("mfa", perIp * 30));
  app.post("/api/auth/refresh", auth("refresh", perIp * 600));
  app.post("/api/auth/logout", auth("logout", perIp * 60));

  // Demo quick sign-in: signs in as one of the seeded accounts without typing its password. The route does not
  // exist outside the demo, and the passwords never leave the server.
  app.post("/api/auth/demo", async (req: AuthedRequest, res, next) => {
    try {
      if (!cfg.demo) return res.status(404).json({ error: "not found" });
      const as = (req.body as { as?: unknown } | undefined)?.as;
      if (typeof as !== "string" || !DEMO_ROLES.includes(as as DemoRole)) return res.status(400).json({ error: "as must be owner, manager or staff" });
      if (!allow(`rl:auth:demo:${req.ip ?? "unknown"}`, perIp * 3, 3600)) return res.status(429).json({ error: "rate_limited" });
      const account = cfg.demo.accounts[as as DemoRole];
      const body = { email: account.email, password: account.password, ip: req.ip ?? null, userAgent: req.header("user-agent")?.slice(0, 300) ?? null };
      res.json(await cfg.identity.request("POST", "/internal/auth/login", body, undefined, req.requestId));
    } catch (e) {
      next(e);
    }
  });

  // Video meeting links (/meet/abc-defg-hij): anyone with the link may look at the meeting and ask to
  // join as a guest. Codes are unguessable; per-IP limits stop scanning and lobby spam.
  const meetCode = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
  const meet = (path: string, method: "GET" | "POST", limit: number, window: number) => async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const code = String(req.params.code);
      if (!cfg.work || !meetCode.test(code)) return res.status(404).json({ error: "meeting not found" });
      if (!allow(`rl:meet:${path || "preview"}:${req.ip ?? "unknown"}`, limit, window)) return res.status(429).json({ error: "too many attempts, try later" });
      res.json(await cfg.work.request(method, `/internal/meet/${code}${path}`, method === "POST" ? req.body : undefined, undefined, req.requestId));
    } catch (e) {
      next(e);
    }
  };
  app.get("/api/meet/:code", meet("", "GET", 120, 600));
  app.post("/api/meet/:code/join", meet("/join", "POST", 20, 600));
  // Waiting guests poll every 2.5 s for up to 15 minutes (360 polls each); a whole office behind one
  // NAT address can be waiting at once, so allow about 20 of them per hour.
  app.post("/api/meet/:code/status", meet("/status", "POST", 7200, 3600));

  // A workflow's "from another system" address (work/workflow-triggers.ts): no sign-in, the unguessable token in the
  // address is the credential. Per-address and per-caller limits; the workflow has its own hourly cap behind them.
  app.post("/api/hooks/:token", async (req: AuthedRequest, res, next) => {
    try {
      const token = String(req.params.token);
      if (!cfg.work || featureDisabled("ai") || !/^wfh_[A-Za-z0-9_-]{20,80}$/.test(token)) return res.status(404).json({ error: "not found" });
      if (!allow(`rl:hook:ip:${req.ip ?? "unknown"}`, 120, 3600) || !allow(`rl:hook:${token.slice(-12)}`, 60, 3600)) {
        res.setHeader("retry-after", "600");
        return res.status(429).json({ error: "too many requests" });
      }
      res.status(202).json(await cfg.work.request("POST", `/internal/workflow-hooks/${token}`, req.body ?? {}, undefined, req.requestId));
    } catch (e) {
      if (e instanceof ServiceCallError) return res.status(e.status === 404 ? 404 : e.status).json(e.status === 404 ? { error: "not found" } : e.body);
      next(e);
    }
  });

  // Calendar subscription links (Google Calendar, Outlook, Apple poll them without signing in).
  app.get("/api/calendar/:file", async (req: AuthedRequest, res, next) => {
    try {
      const token = String(req.params.file).replace(/\.ics$/, "");
      if (!cfg.work || featureDisabled("calendar") || !/^[A-Za-z0-9_-]{20,64}$/.test(token)) return res.status(404).json({ error: "calendar not found" });
      if (!allow(`rl:cal:${req.ip ?? "unknown"}`, 240, 3600)) return res.status(429).json({ error: "too many requests" });
      const r = await cfg.work.request<{ ics: string }>("GET", `/internal/calendar-feed/${token}`, undefined, undefined, req.requestId);
      res.setHeader("content-type", "text/calendar; charset=utf-8");
      res.setHeader("cache-control", "private, max-age=900");
      res.send(r.ics);
    } catch (e) {
      next(e);
    }
  });

  // The AI browser extension (ChatGPT, Claude, Gemini, Copilot activity): its connection code is the only
  // credential; the ai module resolves it to a person. Limited per code and per IP.
  app.post("/api/ai-monitor/events", async (req: AuthedRequest, res, next) => {
    try {
      const auth = req.header("authorization") ?? "";
      const token = /^Bearer (aim_[A-Za-z0-9_-]{20,64})$/.exec(auth)?.[1];
      // Without AI the extension has nowhere to report to: 404, so it stops rather than asking for a new code.
      if (featureDisabled("ai")) return res.status(404).json({ error: "feature_off", feature: "ai" });
      if (!token || !cfg.ai) return res.status(401).json({ error: "connection code required" });
      const keyId = createHash("sha256").update(token).digest("hex").slice(0, 32);
      if (!allow(`rl:aim:${keyId}`, 120, 60) || !allow(`rl:aim-ip:${req.ip ?? "unknown"}`, 600, 60)) return res.status(429).json({ error: "rate limit exceeded" });
      res.json(await cfg.ai.request("POST", "/internal/monitor/events", { token, events: (req.body as { events?: unknown })?.events }, undefined, req.requestId));
    } catch (e) {
      next(e);
    }
  });

  // OAuth 2.1 for remote MCP clients: metadata, registration, token and revocation (oauth.ts; identity keeps the state).
  const publicOrigins = cfg.publicOrigins?.length ? cfg.publicOrigins : ["http://localhost:3000"];
  mountOAuth(app, { identity: cfg.identity, publicOrigins, allow });

  // ---- authenticated ----
  const authenticate = async (req: AuthedRequest, res: Response, next: NextFunction) => {
    const header = req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: "missing bearer token" });
    // Workspace API keys (Integrations): resolved to a service principal in resolveWorkspace.
    if (token.startsWith("wos_")) {
      req.apiKey = token;
      const keyId = createHash("sha256").update(token).digest("hex").slice(0, 32);
      if (!paced(res, `rl:key:${keyId}`, cfg.rateLimit.userPerMinute)) return res.status(429).json({ error: "rate limit exceeded" });
      return next();
    }
    // OAuth access tokens (MCP clients that connected with the URL): resolved by identity in resolveWorkspace.
    if (token.startsWith("woa_")) {
      req.oauthToken = token;
      const keyId = createHash("sha256").update(token).digest("hex").slice(0, 32);
      if (!paced(res, `rl:key:${keyId}`, cfg.rateLimit.userPerMinute)) return res.status(429).json({ error: "rate limit exceeded" });
      return next();
    }
    let claims: { sub?: string; sid?: unknown; rv?: unknown; mfa?: unknown };
    try {
      ({ payload: claims } = await jwtVerify(token, jwks, {
        issuer: "workspace",
        audience: "workspace",
        algorithms: ["EdDSA"],
        typ: "at+jwt",
        requiredClaims: ["sub", "exp", "iat"],
      }));
    } catch {
      return res.status(401).json({ error: "invalid token" });
    }
    if (!claims.sub || typeof claims.sid !== "string" || typeof claims.rv !== "number") return res.status(401).json({ error: "invalid token" });
    // A signature is not enough: the session must still be alive (sign-out, revoked device, disabled account) and
    // the token must carry the account's current version (password changed, signed out everywhere).
    const state = await sessionState(claims.sid, req.requestId);
    if (!state?.active || state.userId !== claims.sub) return res.status(401).json({ error: "session_revoked" });
    if (state.rv !== claims.rv) return res.status(401).json({ error: "token_stale" });
    req.userId = claims.sub;
    req.sessionId = claims.sid;
    req.mfa = state.mfa === true;
    req.pwc = state.pwc === true;
    const limited = ssrRead(req) ? !paced(res, `rl:ssr:${claims.sub}`, ssrPerMinute) : !paced(res, `rl:user:${claims.sub}`, cfg.rateLimit.userPerMinute);
    if (limited) {
      return res.status(429).json({ error: "rate limit exceeded" });
    }
    next();
  };

  /**
   * A session's state, cached 60 s. identity overwrites the entry the moment a session is revoked or the
   * account version changes; this side only fills an absent entry (NX), so it never puts back stale state.
   */
  const sessionState = async (sid: string, requestId?: string): Promise<{ active: boolean; userId?: string; rv?: number; mfa?: boolean; pwc?: boolean } | null> => {
    const key = `authsess:${sid}`;
    const hit = cache.get(key);
    if (hit) return JSON.parse(hit) as { active: boolean; userId?: string; rv?: number; mfa?: boolean; pwc?: boolean };
    const s = await cfg.identity
      .request<{ active: boolean; userId?: string; rv?: number; mfa?: boolean; pwc?: boolean }>("POST", "/internal/auth/session-state", { sid }, undefined, requestId)
      .catch(() => null);
    if (s) cache.set(key, JSON.stringify(s), { ttlMs: (s.active ? 60 : 660) * 1000, nx: true });
    return s;
  };

  /** Whether the workspace requires two-step sign-in, cached 60 s; dropped at once when the admin changes it. */
  const mfaRequired = async (requestId?: string): Promise<boolean> => {
    const hit = cache.get(MFA_POLICY_KEY);
    if (hit !== null) return hit === "1";
    const r = await cfg.identity.request<{ required: boolean }>("GET", "/internal/mfa-policy", undefined, undefined, requestId).catch(() => null);
    if (!r) return false;
    cache.set(MFA_POLICY_KEY, r.required ? "1" : "0", { ttlMs: 60_000 });
    return r.required;
  };

  /**
   * Status and modules of the installation's workspace, cached 30 s (dropped at once on a config change); null
   * until first-run setup created it.
   */
  const workspaceState = async (requestId?: string): Promise<WorkspaceState | null> => {
    const hit = cache.get(WORKSPACE_KEY);
    if (hit) return JSON.parse(hit) as WorkspaceState;
    const state = await cfg.platform
      .request<WorkspaceState>("GET", "/internal/workspace", undefined, undefined, requestId)
      .then((w) => ({ status: w.status, features: w.features }))
      .catch((e: unknown) => {
        if (e instanceof ServiceCallError && e.status === 404) return null;
        throw e;
      });
    if (state) cache.set(WORKSPACE_KEY, JSON.stringify(state), { ttlMs: 30_000 });
    return state;
  };

  const resolveWorkspace = async (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (req.oauthToken) {
      // Issued for the MCP endpoint only (its resource); the rest of the API stays with sessions and API keys.
      if (req.path !== MCP_PATH) return res.status(403).json({ error: "insufficient_scope", message: "this token is for /api/mcp only" });
      const hash = createHash("sha256").update(req.oauthToken).digest("hex");
      const key = `oauth:${hash}`;
      try {
        let r = JSON.parse(cache.get(key) ?? "null") as OAuthResolution | null;
        if (!r) {
          r = await cfg.identity.request<OAuthResolution>("POST", "/internal/oauth/resolve", { token: req.oauthToken }, undefined, req.requestId);
          // identity drops every oauth: entry the moment a connection is revoked; otherwise at most 30 s, never past expiry.
          cache.set(key, JSON.stringify(r), { ttlMs: Math.max(1000, Math.min(30_000, new Date(r.expiresAt).getTime() - Date.now())) });
        }
        req.principal = r.principal;
        req.credential = { via: "oauth", ref: r.grantId };
        req.features = (await workspaceState(req.requestId))?.features;
        return next();
      } catch (e) {
        if (e instanceof ServiceCallError && (e.status === 401 || e.status === 400)) return res.status(401).json({ error: "invalid_token" });
        return next(e);
      }
    }
    if (req.apiKey) {
      const key = `apikey:${createHash("sha256").update(req.apiKey).digest("hex")}`;
      try {
        let principal = JSON.parse(cache.get(key) ?? "null") as Principal | null;
        if (!principal) {
          principal = await cfg.identity.request<Principal>("POST", "/internal/api-keys/resolve", { key: req.apiKey }, undefined, req.requestId);
          cache.set(key, JSON.stringify(principal), { ttlMs: 30_000 }); // revocation applies within 30 s
        }
        // A personal key acts as a person, but never as their sign-in: it cannot touch the account itself.
        if (keyForbiddenPath(req.path)) return res.status(403).json({ error: "not_for_api_keys" });
        req.principal = principal;
        req.credential = { via: principal.type === "user" ? "personal_key" : "workspace_key", ref: key.slice("apikey:".length) };
        req.features = (await workspaceState(req.requestId))?.features;
        return next();
      } catch (e) {
        if (e instanceof ServiceCallError && (e.status === 401 || e.status === 400)) return res.status(401).json({ error: "invalid or revoked API key" });
        return next(e);
      }
    }
    try {
      const state = await workspaceState(req.requestId);
      if (!state) return res.status(409).json({ error: "not_set_up", message: "this installation has no workspace yet" });
      const key = `principal:${req.userId}`;
      req.features = state.features;
      const cached = cache.get(key);
      let principal: Principal;
      if (cached) principal = JSON.parse(cached) as Principal;
      else {
        principal = await cfg.identity.request<Principal>("POST", "/internal/resolve", { userId: req.userId }, undefined, req.requestId);
        cache.set(key, JSON.stringify(principal), { ttlMs: 60_000 });
      }
      req.principal = principal;
      req.credential = { via: "session", ref: null };
      // A temporary password (admin reset, invite with a password): nothing but replacing it until it is replaced.
      if (req.pwc && !passwordChangePath(req.path)) return res.status(403).json({ error: "password_change_required" });
      // A workspace that requires two-step sign-in: until this session has it, only setting it up is possible.
      if (!req.mfa && !mfaSetupPath(req.path) && (await mfaRequired(req.requestId))) return res.status(403).json({ error: "mfa_setup_required" });
      next();
    } catch (e) {
      if (e instanceof ServiceCallError && e.status === 403) return res.status(403).json({ error: "not a member of this workspace" });
      next(e);
    }
  };

  app.get("/api/me", authenticate, resolveWorkspace, (req: AuthedRequest, res) => res.json({ principal: req.principal }));

  /** Short-lived ticket for Socket.IO / SSE connections that cannot send headers. */
  app.post("/api/realtime/ticket", authenticate, resolveWorkspace, async (req: AuthedRequest, res) => {
    res.json({ ticket: await signInternalToken({ principal: req.principal!, requestId: req.requestId! }, cfg.internalSecret, 60) });
  });

  /**
   * One call to a module as the caller: the module and AI switches, the signed principal, the timeout, and cache
   * eviction after a change. Shared by the REST proxy and the MCP tools, so both are checked the same way.
   */
  const upstream = async (req: AuthedRequest, service: string, method: string, path: string, body: unknown, gone?: AbortSignal): Promise<globalThis.Response> => {
    const refuse = (status: number, b: Record<string, unknown>) =>
      new Response(JSON.stringify({ ...b, requestId: req.requestId }), { status, headers: { "content-type": "application/json" } });
    // Module-to-module endpoints are called by the gateway's own routes and by modules, never forwarded from outside.
    if (/^\/internal(\/|$)/.test(routeKey(path))) return refuse(404, { error: "not found" });
    // A feature the deployment left out (DISABLED_FEATURES) does not exist here: 404 for reads and writes alike.
    const left = deployFeatureOf(service, path);
    if (left && featureDisabled(left)) return refuse(404, { error: "feature_off", feature: left, message: "This feature is not part of this installation." });
    // A module the admin switched off is refused here too, not only hidden in the UI (fails open if unknown).
    const needs = requiredFeature(method, service, path);
    if (needs && req.features && req.features[needs] === false) {
      return refuse(403, { error: "module_off", feature: needs, message: "this feature is switched off for the workspace" });
    }
    // AI is off unless the company switched it on (Admin › AI): its routes do not exist then, not even for reads.
    const aiNeeds = service === "ai" ? aiRouteFeature(path) : null;
    if (aiNeeds && req.features && req.features[aiNeeds] !== true) {
      return refuse(404, { error: "ai_off", feature: aiNeeds, message: "AI is switched off for this workspace." });
    }
    // The public demo refuses the writes that would break it for the next visitor (demo.ts), MCP tools included.
    if (cfg.demo && demoLocked(method, service, routeKey(path)) && !demoSeeding(cfg.demo, req.header(DEMO_SEED_HEADER))) return refuse(403, DEMO_LOCKED_BODY);
    const base = Object.hasOwn(cfg.services, service) ? cfg.services[service] : undefined;
    if (!base) return refuse(404, { error: "unknown service" });
    // Where the call came from, for the audit trail (ADR 0025): modules stamp it on the events they emit.
    const origin = { ip: req.ip, userAgent: req.header("user-agent")?.slice(0, 300), via: req.credential?.via ?? (req.sessionId ? "session" : undefined) };
    const token = await signInternalToken({ principal: req.principal!, requestId: req.requestId!, sessionId: req.sessionId, origin }, cfg.internalSecret);
    const res = await serviceFetch(base + path, {
      method,
      // UI language (vi, en, zh, es): modules that generate text, like the AI brief or the inbox, write in it.
      headers: {
        [PRINCIPAL_HEADER]: token,
        "content-type": "application/json",
        "x-request-id": req.requestId!,
        ...(/^(vi|en|zh|es)$/.test(String(req.headers["x-locale"] ?? "")) ? { "x-locale": String(req.headers["x-locale"]) } : {}),
      },
      ...(["GET", "HEAD"].includes(method) ? {} : { body: JSON.stringify(body ?? {}) }),
      // Model calls (the ai module, and the Home brief that calls it) can take tens of seconds with a hosted model; a
      // Hỏi đáp answer that uses outside (MCP) tools takes several model turns (the ai module stops calling tools after
      // a minute), which a small self-hosted model needs minutes for. A task chat answer (Hỏi AI) is the same loop, and
      // a written task description (AI viết) is a long answer from one call.
      // A streamed answer (Hỏi đáp, stream.ts) also ends when the person leaves, so the model stops writing.
      signal: AbortSignal.any([
        AbortSignal.timeout(
          service === "ai" && /^\/(assistant\/(messages|pending\/|conversations\/[^/]+\/regenerate\/stream)|tasks\/[^/]+\/chat$|tasks\/write$)/.test(path)
            ? 180_000
            : service === "ai" || path.includes("/brief")
              ? 60_000
              : 15_000,
        ),
        ...(gone ? [gone] : []),
      ]),
    });
    if (res.ok && !["GET", "HEAD"].includes(method)) evictAfterChange(service, path);
    return res;
  };

  /** Forwards to a module with the caller's principal. */
  const proxy = async (
    req: AuthedRequest,
    res: Response,
    next: NextFunction,
    service: string,
    path: string,
    /** Told how the call ended (an idempotent write keeps its answer); null when there is nothing to keep. */
    done?: (answer: { status: number; contentType: string | null; body: Buffer } | null) => void,
  ) => {
    const gone = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) gone.abort();
    });
    try {
      const up = await upstream(req, service, req.method, path, req.body, gone.signal);
      res.status(up.status);
      const ct = up.headers.get("content-type");
      if (ct) res.setHeader("content-type", ct);
      // A module that marks a response cacheable (a member's photo at a versioned URL) is passed on as it said.
      for (const h of ["cache-control", "x-content-type-options"]) {
        const v = up.headers.get(h);
        if (v) res.setHeader(h, v);
      }
      // Server-Sent Events (Hỏi đáp's answer as it is written) go on piece by piece, not once the answer is complete.
      if (ct?.startsWith("text/event-stream") && up.body) {
        res.setHeader("x-accel-buffering", "no");
        res.flushHeaders();
        try {
          for await (const chunk of up.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
        } catch {
          // The person left, or the module ended the stream: nothing more to send.
        }
        res.end();
        done?.(null);
        return;
      }
      const body = Buffer.from(await up.arrayBuffer());
      done?.({ status: up.status, contentType: ct, body });
      res.send(body);
    } catch (e) {
      done?.(null);
      if (gone.signal.aborted) return void res.end();
      next(e);
    }
  };

  /**
   * `Idempotency-Key` on a POST made with an API key: a script that retries after a timeout gets the first answer
   * again instead of a second task, message or run. Kept in memory for a day (a restart forgets it, like the rate
   * limits), per key and per credential; the same key with another request is refused rather than answered wrongly.
   */
  const idempotent = (req: AuthedRequest, res: Response, next: NextFunction, service: string, path: string) => {
    const given = req.header("idempotency-key");
    if (req.method !== "POST" || !req.apiKey || given === undefined) return void proxy(req, res, next, service, path);
    if (!/^[\x21-\x7e]{8,128}$/.test(given)) return void res.status(400).json({ error: "invalid", message: "Idempotency-Key must be 8 to 128 printable characters" });
    const slot = `idem:${req.credential?.ref ?? ""}:${createHash("sha256").update(given).digest("hex")}`;
    const print = createHash("sha256")
      .update(`${service} ${path}\n${JSON.stringify(req.body ?? null)}`)
      .digest("hex");
    const kept = JSON.parse(cache.get(slot) ?? "null") as { print: string; status?: number; contentType?: string | null; body?: string } | null;
    if (kept && kept.print !== print) return void res.status(422).json({ error: "idempotency_key_reused", message: "this Idempotency-Key was used for a different request" });
    if (kept && kept.status === undefined)
      return void res.status(409).json({ error: "idempotency_in_progress", message: "the first request with this Idempotency-Key is still running" });
    if (kept) {
      res.status(kept.status!).setHeader("idempotency-replayed", "true");
      if (kept.contentType) res.setHeader("content-type", kept.contentType);
      return void res.send(Buffer.from(kept.body ?? "", "base64"));
    }
    // In flight: a retry that arrives before the answer waits its turn (the caller retries on 409).
    cache.set(slot, JSON.stringify({ print }), { ttlMs: 60_000 });
    void proxy(req, res, next, service, path, (answer) => {
      // Only a success is worth repeating: a refusal may be fixed and tried again under the same key.
      if (answer && answer.status >= 200 && answer.status < 300 && answer.body.length <= 256 * 1024)
        cache.set(slot, JSON.stringify({ print, status: answer.status, contentType: answer.contentType, body: answer.body.toString("base64") }), { ttlMs: 24 * 3600_000 });
      else cache.del(slot);
    });
  };

  // MCP for AI agents (docs/integrations/mcp.md): the same caller, the same checks, through `upstream`.
  // A 401 here tells the client where to start OAuth (RFC 9728): Claude, ChatGPT, Cursor and VS Code connect with the URL.
  const mcpChallenge = (req: AuthedRequest, res: Response, next: NextFunction) => {
    const json = res.json.bind(res);
    res.json = (body?: unknown) => {
      if (res.statusCode === 401) res.setHeader("www-authenticate", challenge(publicBase(req, publicOrigins), !!req.header("authorization")));
      return json(body);
    };
    next();
  };
  app.all(MCP_PATH, openCors, mcpChallenge, authenticate, resolveWorkspace, async (req: AuthedRequest, res, next) => {
    try {
      const { handleMcp } = await import("./mcp.js");
      const credential = req.credential ?? { via: "session" as const, ref: null };
      await handleMcp(req, res, {
        principal: req.principal!,
        features: req.features,
        appUrl: publicOrigins[0],
        // Who called which tool, through which credential, and whether it worked: never the arguments or the answer.
        onToolCall: (tool, ok, error, durationMs) =>
          void cfg.identity
            .request(
              "POST",
              "/internal/mcp/calls",
              { calls: [{ userId: req.principal!.type === "user" ? req.principal!.id : null, via: credential.via, credential: credential.ref, tool, ok, error, durationMs }] },
              undefined,
              req.requestId,
            )
            .catch((err: unknown) => logger.warn({ err }, "mcp activity not recorded")),
        call: async (service, method, path, body) => {
          const up = await upstream(req, service, method, path, body);
          const text = await up.text();
          let parsed: unknown = text;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            // not JSON: keep the text
          }
          return { status: up.status, body: parsed };
        },
      });
    } catch (e) {
      next(e);
    }
  });
  const query = (req: AuthedRequest) => (req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "");

  app.all("/api/:service/*", authenticate, resolveWorkspace, (req: AuthedRequest, res, next) =>
    idempotent(req, res, next, String(req.params.service), "/" + (req.params as Record<string, string>)["0"] + query(req)),
  );

  app.use((err: unknown, req: AuthedRequest, res: Response, _next: NextFunction) => {
    if (err instanceof ServiceCallError) return res.status(err.status).json(err.body ?? { error: "upstream error" });
    logger.error({ err, requestId: req.requestId }, "gateway error");
    res.status(502).json({ error: "upstream unavailable" });
  });

  return app;
}

/**
 * identity's public signing keys, read through `serviceFetch` (an in-memory call) and cached like jose's remote
 * key set: kept `maxAgeMs`, refetched early when a token names an unknown key id (a rotation),
 * at most once per `cooldownMs`.
 */
function cachedJwks(url: string, opts: { cooldownMs: number; maxAgeMs: number }): JWTVerifyGetKey {
  let keys: { get: JWTVerifyGetKey; at: number } | null = null;
  let lastReload = 0;
  const load = async () => {
    const res = await serviceFetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`jwks ${res.status}`);
    keys = { get: createLocalJWKSet((await res.json()) as JSONWebKeySet), at: Date.now() };
    lastReload = keys.at;
    return keys.get;
  };
  return async (header, token) => {
    const get = keys && Date.now() - keys.at < opts.maxAgeMs ? keys.get : await load();
    try {
      return await get(header, token);
    } catch (err) {
      if ((err as { code?: string }).code !== "ERR_JWKS_NO_MATCHING_KEY" || Date.now() - lastReload < opts.cooldownMs) throw err;
      return (await load())(header, token);
    }
  };
}

async function forward(client: ServiceClient, method: string, path: string, body: unknown, as: Principal | undefined, req: AuthedRequest, res: Response) {
  try {
    const out = await client.request(method, path, body, as, req.requestId);
    res.status(method === "POST" ? 201 : 200).json(out);
  } catch (e) {
    if (e instanceof ServiceCallError) return res.status(e.status).json(e.body);
    throw e;
  }
}

/**
 * Changes that must apply at once instead of after the cache TTL: any member/role/team change drops the cached
 * principals (offboarding, role removal), and a platform config change drops the cached workspace state.
 */
export function evictAfterChange(service: string, rawPath: string): void {
  const cache = kv();
  const path = routeKey(rawPath);
  // Employee profile edits move people between departments (DEPARTMENT scope); the mirror lands a moment later.
  if ((service === "identity" && /^\/(members|roles|teams)(\/|$)/.test(path)) || (service === "employee" && /^\/(employees|departments)(\/|$)/.test(path)))
    cache.delPrefix("principal:");
  if (service === "identity" && /^\/security\/mfa-policy/.test(path)) cache.del(MFA_POLICY_KEY);
  // Ownership moved: both principals change their roles at once.
  if (service === "identity" && /^\/workspace\/owner/.test(path)) cache.delPrefix("principal:");
  // Config changes (modules switched on or off): the workspace's cached state.
  if (service === "platform" && /^\/workspace\/config/.test(path)) cache.del(WORKSPACE_KEY);
}

interface WorkspaceState {
  status: string;
  features?: Record<string, boolean> | undefined;
}

/** What a session with a temporary password may still reach: replacing it (and who it is). */
function passwordChangePath(path: string): boolean {
  return /^\/api\/identity\/me\/password(\/|$|\?)/.test(path) || path === "/api/me";
}

/** What a session without two-step sign-in may still reach in a workspace that requires it: setting it up. */
function mfaSetupPath(path: string): boolean {
  return /^\/api\/identity\/me\/(mfa|sessions|password)(\/|$|\?)/.test(path) || path === "/api/me";
}

/** Writes that belong to an optional module (keys of the workspace's `features`). Reads stay open. */
const MODULE_WRITES: [RegExp, string, RegExp, string][] = [[/^(POST|PUT)$/, "employee", /^\/attendance\//, "attendance"]];
export function requiredFeature(method: string, service: string, path: string): string | null {
  const route = routeKey(path);
  return MODULE_WRITES.find(([m, s, p]) => m.test(method) && s === service && p.test(route))?.[3] ?? null;
}

/**
 * Routes that belong to a feature a deployment can leave out (DISABLED_FEATURES, ADR 0026), by module. Every
 * method: unlike a module the admin switched off, a feature left out has no reads either. Attachments
 * (`/files/…`), video rooms (`/meet/…`) and public holidays stay: tasks, chat and calls use them.
 */
const DEPLOY_ROUTES: [string, RegExp, DeployFeature][] = [
  ["work", /^\/(docs|docs-home|spaces|drive)(\/|$)/, "docs"],
  ["work", /^\/whiteboards(\/|$)/, "whiteboards"],
  ["work", /^\/(calendar|meetings)(\/|$)/, "calendar"],
  ["employee", /^\/(attendance|leave)(\/|$)/, "time"],
  // Agent workflows and their runs, and a person's own AI outcomes: AI that lives in the work module.
  ["work", /^\/(workflows|runs|runner|agent-questions|me\/ai-outcomes)(\/|$)/, "ai"],
  ["work", /^\/tasks\/[^/]+\/runs(\/|$)/, "ai"],
  // The ai module's own routes follow the two AI switches (aiRouteFeature), which read off without `ai`; the two
  // that answer regardless of the switches (the status the web reads, health) keep answering.
  ["ai", /^\/(?!status$|health$)/, "ai"],
];
export function deployFeatureOf(service: string, path: string): DeployFeature | null {
  const route = routeKey(path);
  return DEPLOY_ROUTES.find(([s, p]) => s === service && p.test(route))?.[2] ?? null;
}

/**
 * Which AI switch an ai module route needs: `status` and the monitoring purge answer always (the web decides what
 * to show from status; the purge is for companies that switched monitoring off); oversight, policy and the
 * extension's connection need `aiMonitoring`; everything else is the company's assistant.
 */
export function aiRouteFeature(path: string): "aiAssistant" | "aiMonitoring" | null {
  const p = routeKey(path);
  if (p === "/status" || p === "/monitor/data" || p === "/health") return null;
  // A person's own computer (workspace-connect.mjs) serves both sides: workflows and answers for the assistant,
  // the safety net for AI Insights. The ai module answers each part by its own switch (local-connect.ts).
  if (/^\/local(\/|$)/.test(p)) return null;
  if (/^\/(oversight|policy|monitor|insights)(\/|$)/.test(p)) return "aiMonitoring";
  return "aiAssistant";
}

/**
 * What an API key may never reach, even a personal one acting as its creator: the account (password, two-step,
 * sessions), making more keys, and handing over the workspace. Those stay with a signed-in person.
 */
export function keyForbiddenPath(path: string): boolean {
  const p = routeKey(path);
  return /^\/api\/identity\/(api-keys|oauth|me\/(password|mfa|sessions|api-keys|oauth)|workspace\/owner)(\/|$)/.test(p) || p === "/api/realtime/ticket";
}

/** A path without its query or fragment. */
function beforeQuery(path: string): string {
  const q = path.search(/[?#]/);
  return q < 0 ? path : path.slice(0, q);
}

/**
 * A path as a router will match it, for the checks above: Express routes ignore case and trailing slashes, and the
 * gateway forwards Express's decoded params, so `/ME/API-KEYS/` and `/me%2Fapi-keys` reach the same handler as
 * `/me/api-keys`. Decoded, without query, lower-case, single slashes, no trailing slash.
 */
function routeKey(path: string): string {
  let p = beforeQuery(path);
  for (let i = 0; i < 3 && p.includes("%"); i++) {
    try {
      p = decodeURIComponent(p);
    } catch {
      break;
    }
  }
  p = beforeQuery(p)
    .toLowerCase()
    .replace(/\/{2,}/g, "/");
  return p.length > 1 ? p.replace(/\/$/, "") : p;
}

const API_DOCS_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>workspace API</title>
</head>
<body style="margin:0">
<redoc spec-url="/api/docs/openapi.json"></redoc>
<script src="https://cdn.jsdelivr.net/npm/redoc@2.1.5/bundles/redoc.standalone.js"></script>
</body>
</html>
`;

/**
 * One request against a credential's minute, with where the caller stands on the answer (the IETF `RateLimit-*`
 * headers) and, past the limit, how long to wait (`Retry-After`), so a script can pace itself instead of guessing.
 */
function paced(res: Response, key: string, limit: number): boolean {
  const n = kv().incr(key, 60_000);
  const reset = Math.max(1, Math.ceil(kv().ttl(key) / 1000));
  res.setHeader("ratelimit-limit", String(limit));
  res.setHeader("ratelimit-remaining", String(Math.max(0, limit - n)));
  res.setHeader("ratelimit-reset", String(reset));
  if (n <= limit) return true;
  res.setHeader("retry-after", String(reset));
  return false;
}

/** Fixed-window limiter (rate limiting), in this process's memory: one server, so one count per key. */
function allow(key: string, limit: number, windowSeconds: number): boolean {
  return kv().incr(key, windowSeconds * 1000) <= limit;
}
