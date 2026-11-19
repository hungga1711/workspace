import { Controller, Get, Inject, Req } from "@nestjs/common";
import type { Request } from "express";
import type { Pool } from "pg";
import { withTransaction } from "@workspace/shared";
import { assertAllowed, requirePrincipal } from "@workspace/service-kit";
import { POOL } from "./common.js";

/**
 * What an admin has to look at among the outgoing webhooks (the admin overview's "Needs you" list): one
 * the system switched off after repeated failures, and one that is failing and on its way there. Read from the
 * webhook's own counters; an item is gone as soon as the webhook delivers again or is switched back on.
 */
export interface AttentionItem {
  id: string;
  kind: string;
  severity: "broken" | "warning" | "unknown";
  since: string | null;
  name: string;
  detail?: string;
  ownerId?: string;
  count?: number;
}
export interface HookRow {
  id: string;
  url: string;
  description: string;
  active: boolean;
  failure_count: number;
  disabled_reason: string | null;
  created_by: string;
  /** The first delivery that failed since the last one that got through. */
  failing_since: Date | null;
  last_status: number | null;
  last_error: string | null;
}

/** Failed deliveries in a row before a webhook is worth a look (it is switched off at 20). */
export const FAILING_AFTER = 3;

/** The webhook as its admin would recognise it: their description, else where it posts to (never the path, it may hold a secret). */
const label = (r: HookRow) => {
  if (r.description.trim()) return r.description.trim();
  try {
    return new URL(r.url).host;
  } catch {
    return r.url.slice(0, 60);
  }
};

export function webhookItems(rows: HookRow[]): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const r of rows) {
    const why = r.last_error?.trim() || (r.last_status ? `HTTP ${r.last_status}` : "");
    const base = { name: label(r), ownerId: r.created_by, since: r.failing_since ? r.failing_since.toISOString() : null, ...(why ? { detail: why.slice(0, 300) } : {}) };
    // Switched off by a person is their decision, not a problem; only what the system switched off is listed.
    if (!r.active && r.disabled_reason)
      out.push({ ...base, id: `platform.webhook.disabled:${r.id}`, kind: "platform.webhook.disabled", severity: "broken", count: r.failure_count });
    else if (r.active && r.failure_count >= FAILING_AFTER)
      out.push({ ...base, id: `platform.webhook.failing:${r.id}`, kind: "platform.webhook.failing", severity: "warning", count: r.failure_count });
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
      const r = await c.query<HookRow>(
        `SELECT w.id, w.url, w.description, w.active, w.failure_count, w.disabled_reason, w.created_by,
                (SELECT min(d.created_at) FROM webhook_deliveries d
                  WHERE d.webhook_id = w.id AND d.status <> 'succeeded'
                    AND d.created_at > COALESCE((SELECT max(s.created_at) FROM webhook_deliveries s WHERE s.webhook_id = w.id AND s.status = 'succeeded'), '-infinity')) AS failing_since,
                l.response_status AS last_status, l.error AS last_error
           FROM webhooks w
           LEFT JOIN LATERAL (SELECT response_status, error FROM webhook_deliveries d WHERE d.webhook_id = w.id AND d.attempts > 0 ORDER BY d.created_at DESC LIMIT 1) l ON true
          WHERE (NOT w.active AND w.disabled_reason IS NOT NULL) OR (w.active AND w.failure_count >= $1)`,
        [FAILING_AFTER],
      );
      return { items: webhookItems(r.rows) };
    });
  }
}
