import type pg from "pg";
import { logger } from "@workspace/service-kit";

export interface RetentionDays {
  /** Read notifications go after this many days. */
  notificationsRead: number;
  /** Unread ones after this many. */
  notificationsUnread: number;
  /** Resolved home items (tasks done, approvals decided, DMs answered). */
  homeItems: number;
  /** The activity feed. */
  activity: number;
  /** push_recent dedupe rows (a ten-minute window; anything older than a day is dead). */
  pushRecent: number;
}

export const DEFAULT_RETENTION: RetentionDays = { notificationsRead: 90, notificationsUnread: 180, homeItems: 180, activity: 365, pushRecent: 30 };

/**
 * Deletes what the retention settings say, in batches of `batch` through the prune functions (home baseline migration), which
 * keep each batch to one indexed DELETE. Each function is called
 * until a batch comes back short, at most `maxBatches` times, so a backlog drains over a few days instead of one
 * long transaction. Returns how many rows went in total.
 */
export async function runHomeRetention(pool: pg.Pool, days: RetentionDays = DEFAULT_RETENTION, batch = 20_000, maxBatches = 20): Promise<number> {
  const drain = async (sql: string, args: unknown[]) => {
    let total = 0;
    for (let i = 0; i < maxBatches; i++) {
      const n = (await pool.query<{ n: number }>(sql, args)).rows[0]?.n ?? 0;
      total += n;
      if (n < batch) break;
    }
    return total;
  };
  const notifications = await drain("SELECT home_notifications_prune($1, $2, $3) AS n", [days.notificationsRead, days.notificationsUnread, batch]);
  const items = await drain("SELECT home_items_prune($1, $2) AS n", [days.homeItems, batch]);
  const activity = await drain("SELECT home_activity_prune($1, $2) AS n", [days.activity, batch]);
  const pushRecent = await drain("SELECT home_push_recent_prune($1, $2) AS n", [days.pushRecent, batch]);
  const total = notifications + items + activity + pushRecent;
  if (total) logger.info({ notifications, items, activity, pushRecent }, "home retention");
  return total;
}
