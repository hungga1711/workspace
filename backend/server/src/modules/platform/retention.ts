import type { Pool } from "pg";
import { logger, pruneInBatches, scheduleJob } from "@workspace/service-kit";
import { CLIENT_ERRORS_DAYS, pruneClientErrors } from "./client-errors.js";

export interface RetentionDays {
  /** Admin audit trail (AUDIT_LOG_RETENTION_DAYS, default 730: it is the record of who changed what). */
  auditLog: number;
  /** The audit trail of every module (AUDIT_TRAIL_RETENTION_DAYS, default 365; ADR 0025). */
  auditTrail?: number;
  /** Settled webhook deliveries (WEBHOOK_DELIVERIES_RETENTION_DAYS, default 30); each webhook keeps its newest one. */
  webhookDeliveries: number;
  /** Browser errors from the web app's error screen (CLIENT_ERRORS_RETENTION_DAYS, default 30). */
  clientErrors?: number;
}

const BATCH = 5000;

/**
 * Deletes what the platform schema would otherwise keep forever, through SECURITY DEFINER functions (owned by the
 * maintenance role: the module's own role may not delete audit entries).
 */
export async function pruneRetention(
  pool: Pool,
  days: RetentionDays,
  budgetMs = 60_000,
): Promise<{ auditLog: number; auditTrail: number; webhookDeliveries: number; clientErrors: number }> {
  const one = (fn: string, keep: number) => async () => (await pool.query<{ n: number }>(`SELECT ${fn}($1, $2) AS n`, [keep, BATCH])).rows[0]?.n ?? 0;
  const auditLog = await pruneInBatches(BATCH, budgetMs, one("audit_log_prune", days.auditLog));
  const auditTrail = await pruneInBatches(BATCH, budgetMs, one("audit_trail_prune", days.auditTrail ?? 365));
  const webhookDeliveries = await pruneInBatches(BATCH, budgetMs, one("webhook_deliveries_prune", days.webhookDeliveries));
  const clientErrors = await pruneClientErrors(pool, days.clientErrors ?? CLIENT_ERRORS_DAYS, budgetMs);
  if (auditLog || auditTrail || webhookDeliveries || clientErrors) logger.info({ auditLog, auditTrail, webhookDeliveries, clientErrors }, "platform retention");
  return { auditLog, auditTrail, webhookDeliveries, clientErrors };
}

/** Daily; scheduleJob's lock keeps it to one run at a time. */
export function scheduleRetention(pool: Pool, days: RetentionDays): () => void {
  return scheduleJob("platform-retention", 24 * 3600_000, () => pruneRetention(pool, days), { pool, firstRunMs: 6 * 60_000 });
}
