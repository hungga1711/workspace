import { Controller, Get, Inject, Req } from "@nestjs/common";
import type { Request } from "express";
import type { Pool } from "pg";
import { withTransaction } from "@workspace/shared";
import { assertAllowed, requirePrincipal } from "@workspace/service-kit";
import { POOL } from "./identity.controller.js";

/**
 * What an admin has to look at among the workspace's API keys (the admin overview's "Needs you" list): a
 * key about to expire, and one that expired while something was still using it. Personal keys are their owner's to
 * mind. Read from the key's own dates; replacing or revoking the key ends the item.
 */
export interface AttentionItem {
  id: string;
  kind: string;
  severity: "broken" | "warning" | "unknown";
  /** When the key expires or expired: what "since" means for a deadline. */
  since: string | null;
  name: string;
  ownerId?: string;
}
export interface KeyRow {
  id: string;
  name: string;
  created_by: string;
  expires_at: Date | null;
  last_used_at: Date | null;
}

/** A key this close to its end is worth replacing now. */
export const EXPIRING_DAYS = 14;
/** An expired key is still listed this long, when it was in use near its end. */
export const EXPIRED_DAYS = 30;
const DAY = 86_400_000;

export function keyItems(rows: KeyRow[], now = Date.now()): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const r of rows) {
    // A key without an end date never expires: nothing to do.
    if (!r.expires_at) continue;
    const end = r.expires_at.getTime();
    const base = { name: r.name, ownerId: r.created_by, since: r.expires_at.toISOString() };
    if (end <= now) {
      // Something called with it in its last month: that script or integration has stopped.
      const inUse = !!r.last_used_at && r.last_used_at.getTime() > end - EXPIRED_DAYS * DAY;
      if (inUse && now - end < EXPIRED_DAYS * DAY) out.push({ ...base, id: `identity.key.expired:${r.id}`, kind: "identity.key.expired", severity: "broken" });
    } else if (end - now < EXPIRING_DAYS * DAY) out.push({ ...base, id: `identity.key.expiring:${r.id}`, kind: "identity.key.expiring", severity: "warning" });
  }
  return out;
}

@Controller("attention")
export class AttentionController {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  @Get()
  async attention(@Req() req: Request) {
    assertAllowed(requirePrincipal(req), "workspace.configure");
    return withTransaction(this.pool, async (c) => {
      const r = await c.query<KeyRow>(
        `SELECT id, name, created_by, expires_at, last_used_at FROM api_keys
          WHERE NOT personal AND revoked_at IS NULL AND expires_at IS NOT NULL
            AND expires_at > now() - interval '${EXPIRED_DAYS} days' AND expires_at < now() + interval '${EXPIRING_DAYS} days'`,
      );
      return { items: keyItems(r.rows) };
    });
  }
}
