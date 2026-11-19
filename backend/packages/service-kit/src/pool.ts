import type { Pool } from "pg";
import { logger } from "./logger.js";

/**
 * An idle connection dropped by the server (restart, PgBouncer timeout) is emitted on the pool; unhandled, it would
 * crash the process. The pool discards that client and opens a new one when next asked.
 */
export function watchPool(pool: Pool, name: string): void {
  pool.on("error", (err) => logger.warn({ err, pool: name }, "idle database connection lost"));
}
