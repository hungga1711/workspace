import pg from "pg";
import type { EventBus } from "./events.js";
import { scheduleJob } from "./jobs.js";
import { logger } from "./logger.js";
import { DLQ_SCHEMAS } from "./ops/dlq.js";

/**
 * Performs the replays `dlq replay` and `dlq outbox-replay` request (ops/dlq.ts): dead_events rows with
 * replay_requested_at set and not yet replayed are delivered to the group named on the row only, then stamped
 * replayed_at. It runs in the server because the consumers live there; the CLI only writes the request.
 *
 * Works as workspace_maintenance on the owner connection (the modules' roles may only insert dead letters). Each
 * batch stays locked (SKIP LOCKED) while it is delivered, so a second replica never replays the same rows; a crash
 * leaves them requested and they go out again (consumers dedupe). An event that fails again is dead-lettered as a
 * new row, under an entry id that names the replayed row.
 */
export async function replayRequestedDeadLetters(bus: EventBus, pool: pg.Pool, schemas: readonly string[] = DLQ_SCHEMAS, batch = 100): Promise<number> {
  let total = 0;
  for (const schema of schemas) {
    if (!/^[a-z][a-z0-9_]*$/.test(schema)) throw new Error(`dead letter replay: unexpected schema name (${schema})`);
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE workspace_maintenance");
      await c.query(`SET LOCAL search_path TO ${schema}, pg_temp`);
      if (!(await c.query<{ t: string | null }>("SELECT to_regclass('dead_events')::text AS t")).rows[0]?.t) {
        await c.query("COMMIT");
        continue;
      }
      const rows = (
        await c.query<{ id: string; consumer: string; stream: string; entry_id: string; event: string }>(
          `SELECT id::text, consumer, stream, entry_id, event FROM dead_events
           WHERE replay_requested_at IS NOT NULL AND replayed_at IS NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
          [batch],
        )
      ).rows;
      // A group this process does not run stays requested.
      const here = rows.filter((r) => bus.has(r.consumer));
      if (here.length < rows.length)
        logger.warn({ schema, groups: [...new Set(rows.filter((r) => !bus.has(r.consumer)).map((r) => r.consumer))] }, "dead letter replay: group not running here");
      await Promise.all(here.map((r) => bus.dispatch(r.stream, `${r.entry_id}#replay-${r.id}`, r.event, r.consumer)));
      if (here.length) await c.query("UPDATE dead_events SET replayed_at = now() WHERE id = ANY($1::bigint[])", [here.map((r) => r.id)]);
      await c.query("COMMIT");
      if (here.length) logger.info({ schema, replayed: here.length }, "dead letters replayed");
      total += here.length;
    } catch (err) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }
  return total;
}

/** The replay job (every 5 s, one replica at a time), on its own small pool over the owner connection. */
export function scheduleDeadLetterReplays(bus: EventBus, ownerUrl: string, everyMs = 5_000): () => void {
  const pool = new pg.Pool({ connectionString: ownerUrl, max: 2 });
  pool.on("error", (err) => logger.warn({ err }, "dead letter replay connection lost"));
  const stop = scheduleJob("dead-letter-replays", everyMs, () => bus.ready().then(() => replayRequestedDeadLetters(bus, pool)), { pool });
  return () => {
    stop();
    void pool.end();
  };
}
