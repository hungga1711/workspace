import { Controller, ForbiddenException, Get, Inject, Req } from "@nestjs/common";
import type { Request } from "express";
import { authorize, withTransaction } from "@workspace/shared";
import { requirePrincipal } from "@workspace/service-kit";
import { DEPS } from "./ai.controller.js";
import type { Deps } from "./runtime.js";

/**
 * What an admin has to look at in the AI section (the admin overview's "Needs you" list): connections and
 * outside tools that fail, lost their sign-in, or were never checked. Built on what the module already records (the
 * last check of a connection or a server, the log of tool calls, the gateway's fail-over state); nothing is stored for
 * it, so an item is gone as soon as its cause is.
 *
 * One rule throughout: missing data is "unknown", never healthy. A connection nobody has checked is listed as
 * unknown rather than left out.
 */
export interface AttentionItem {
  /** Stable while the cause lasts: `<kind>:<what>`. */
  id: string;
  kind: string;
  /** broken: it does not work now. warning: it works but will not for long, or not fully. unknown: nobody knows. */
  severity: "broken" | "warning" | "unknown";
  /** Since when, when that is known. */
  since: string | null;
  /** What it is about, as its owner named it. */
  name: string;
  /** The reason as recorded (an error message), clipped. */
  detail?: string;
  /** Whose it is, when it is someone's. */
  ownerId?: string;
  count?: number;
}

export interface ConnectionRow {
  id: string;
  name: string;
  mode: string;
  is_default: boolean;
  test_ok: boolean | null;
  test_error: string | null;
  tested_at: Date | null;
  created_at: Date;
  created_by: string;
}
export interface ServerRow {
  id: string;
  name: string;
  auth: string;
  oauth_per_user: boolean;
  test_ok: boolean | null;
  test_error: string | null;
  tested_at: Date | null;
  tools_at: Date | null;
  created_at: Date;
  created_by: string;
  /** The company's OAuth token: whether there is one, when it ends and whether it can renew itself. */
  has_token: boolean;
  token_expires_at: Date | null;
  token_renews: boolean;
  /** Calls that failed since the last one that worked, in the last day; `auth` those refused for the sign-in. */
  failed: number;
  failed_auth: number;
  failed_since: Date | null;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const clip = (s: string | null | undefined) => (s?.trim() ? s.trim().slice(0, 300) : undefined);
/** Failed calls in a row before a server is called failing: one timeout is not news. */
export const FAILED_CALLS = 3;

/** Enabled company connections: the last check failed, or there never was one. A person's own computer is theirs to mind. */
export function connectionItems(rows: ConnectionRow[]): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const r of rows) {
    if (r.mode === "device") continue;
    const detail = clip(r.test_error);
    if (r.test_ok === false)
      out.push({
        id: `ai.connection.failed:${r.id}`,
        kind: "ai.connection.failed",
        // The default connection answers everything nobody routed elsewhere.
        severity: r.is_default ? "broken" : "warning",
        since: iso(r.tested_at),
        name: r.name,
        ...(detail ? { detail } : {}),
        ownerId: r.created_by,
      });
    else if (r.test_ok === null)
      out.push({ id: `ai.connection.unchecked:${r.id}`, kind: "ai.connection.unchecked", severity: "unknown", since: iso(r.created_at), name: r.name, ownerId: r.created_by });
  }
  return out;
}

/** Enabled outside tools (MCP servers): no sign-in, a failed check, calls failing in a row, or never checked. One item per server, the worst. */
export function serverItems(rows: ServerRow[], now = Date.now()): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const r of rows) {
    const base = { name: r.name, ownerId: r.created_by };
    const company = r.auth === "oauth" && !r.oauth_per_user;
    const expired = !!r.token_expires_at && r.token_expires_at.getTime() < now && !r.token_renews;
    const detail = clip(r.test_error);
    if (company && (!r.has_token || expired))
      out.push({ ...base, id: `ai.mcp.signin:${r.id}`, kind: "ai.mcp.signin", severity: "broken", since: expired ? iso(r.token_expires_at) : null });
    else if (r.failed_auth >= FAILED_CALLS && r.failed_auth === r.failed)
      out.push({ ...base, id: `ai.mcp.signin:${r.id}`, kind: "ai.mcp.signin", severity: "broken", since: iso(r.failed_since), count: r.failed });
    else if (r.test_ok === false)
      out.push({ ...base, id: `ai.mcp.failed:${r.id}`, kind: "ai.mcp.failed", severity: "broken", since: iso(r.tested_at), ...(detail ? { detail } : {}) });
    else if (r.failed >= FAILED_CALLS) out.push({ ...base, id: `ai.mcp.calls:${r.id}`, kind: "ai.mcp.calls", severity: "warning", since: iso(r.failed_since), count: r.failed });
    else if (r.test_ok === null && !r.tools_at) out.push({ ...base, id: `ai.mcp.unchecked:${r.id}`, kind: "ai.mcp.unchecked", severity: "unknown", since: iso(r.created_at) });
  }
  return out;
}

/** The main model is failing over to a simpler one (quota, an outage). */
export function modelItems(status: { degraded: boolean; reason?: string; since?: string } | undefined, provider: string): AttentionItem[] {
  if (!status?.degraded) return [];
  return [
    { id: "ai.model.degraded", kind: status.reason === "rate_limited" ? "ai.model.quota" : "ai.model.down", severity: "broken", since: status.since ?? null, name: provider },
  ];
}

@Controller()
export class AttentionController {
  constructor(@Inject(DEPS) private readonly d: Deps) {}

  /** Each kind only to who may fix it: connections and outside tools to AI admins, the model's state to them or whoever sets AI policy. */
  @Get("attention")
  async attention(@Req() req: Request) {
    const p = requirePrincipal(req);
    const manage = authorize(p, "ai.agent.manage").allowed;
    if (!manage && !authorize(p, "ai.policy.manage").allowed) throw new ForbiddenException("admin only");
    const items = modelItems(this.d.provider.status?.(), this.d.provider.name);
    if (!manage) return { items };
    return withTransaction(this.d.pool, async (c) => {
      const connections = await c.query<ConnectionRow>(
        "SELECT id, name, mode, is_default, test_ok, test_error, tested_at, created_at, created_by FROM ai_connections WHERE enabled",
      );
      const servers = await c.query<ServerRow>(
        `SELECT s.id, s.name, s.auth, s.oauth_per_user, s.test_ok, s.test_error, s.tested_at, s.tools_at, s.created_at, s.created_by,
                t.server_id IS NOT NULL AS has_token, t.expires_at AS token_expires_at, t.refresh_enc IS NOT NULL AS token_renews,
                COALESCE(f.failed, 0)::int AS failed, COALESCE(f.failed_auth, 0)::int AS failed_auth, f.failed_since
           FROM mcp_servers s
           LEFT JOIN mcp_tokens t ON t.server_id = s.id AND t.user_id = ''
           LEFT JOIN LATERAL (
             SELECT count(*) AS failed, count(*) FILTER (WHERE k.outcome = 'auth') AS failed_auth, min(k.at) AS failed_since
               FROM mcp_calls k
              WHERE k.server_id = s.id AND k.at > now() - interval '24 hours' AND k.outcome IN ('error', 'timeout', 'auth')
                AND k.at > COALESCE((SELECT max(o.at) FROM mcp_calls o WHERE o.server_id = s.id AND o.outcome = 'ok'), '-infinity')
           ) f ON true
          WHERE s.enabled`,
      );
      return { items: [...items, ...connectionItems(connections.rows), ...serverItems(servers.rows)] };
    });
  }
}
