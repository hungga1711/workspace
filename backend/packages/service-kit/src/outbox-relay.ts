import pg from "pg";
import type { EventBus } from "./events.js";
import { envInt } from "./config.js";
import { poolSchema, scheduleDeadEventsPrune, scheduleJob } from "./jobs.js";
import { onShutdown } from "./lifecycle.js";
import { logger } from "./logger.js";

/**
 * Delivers committed outbox rows to the consumer groups of this process. The module's own transaction writes the
 * row (appendToOutbox); this loop, in the same module, delivers it:
 *
 *   BEGIN; outbox_claim(n) (FOR UPDATE SKIP LOCKED, oldest first) → bus.dispatch each, wait → outbox_mark_published → COMMIT
 *
 * Rows are marked only after every group handled or dead-lettered them, so a crash in between delivers them again
 * (consumers dedupe). SKIP LOCKED keeps two relays of one schema (a restart overlapping the old process) from
 * taking the same rows. It wakes on the outbox trigger's NOTIFY (a direct connection: LISTEN does not
 * work through a transaction pooler) and polls as a fallback. Nothing is dispatched before the bus's start gate
 * opens (every module subscribed). Rows of topics no group reads are just marked.
 */
export interface OutboxRelayOptions {
  /** The module's pool (app role): claims run through SECURITY DEFINER functions. */
  pool: pg.Pool;
  bus: EventBus;
  /** A direct (not pooled) connection string for LISTEN; without it the relay only polls. */
  listenUrl?: string;
  /** Rows per claim. The claim's transaction stays open while they are handled, so keep it modest. Default 100. */
  batch?: number;
  pollMs?: number;
}

export interface OutboxRelay {
  /** Delivers everything waiting now; resolves with how many rows went out (tests, shutdown). */
  flush(): Promise<number>;
  stop(): Promise<void>;
}

/** The outbox trigger notifies `workspace_outbox_<schema>`: each module's relay wakes for its own rows only. */
const OUTBOX_CHANNEL = "workspace_outbox";

export function startOutboxRelay(opts: OutboxRelayOptions): OutboxRelay {
  const batch = opts.batch ?? 100;
  let stopped = false;
  // A relay stopped before the gate opened (a module failing to start) must not wait for it forever.
  let halt!: () => void;
  const halted = new Promise<void>((resolve) => (halt = resolve));

  /** One claim → dispatch → mark round. Returns the rows claimed. */
  const round = async (): Promise<{ claimed: number; published: number }> => {
    const c = await opts.pool.connect();
    try {
      await c.query("BEGIN");
      const rows = (await c.query<{ id: string; aggregatetype: string; payload: unknown }>("SELECT id, aggregatetype, payload FROM outbox_claim($1, $2::text[])", [batch, []]))
        .rows;
      if (!rows.length) {
        await c.query("COMMIT");
        return { claimed: 0, published: 0 };
      }
      // Dispatched together: each group queues them in this order per workspace and runs workspaces in parallel.
      await Promise.all(
        rows.map((r) => {
          const stream = `workspace.${r.aggregatetype}`;
          if (!opts.bus.hasReaders(stream)) return undefined;
          return opts.bus.dispatch(stream, r.id, typeof r.payload === "string" ? r.payload : JSON.stringify(r.payload));
        }),
      );
      await c.query("SELECT outbox_mark_published($1::text[])", [rows.map((r) => r.id)]);
      await c.query("COMMIT");
      return { claimed: rows.length, published: rows.length };
    } catch (err) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  };

  let running: Promise<number> | null = null;
  let again = false;
  const flush = (): Promise<number> => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      let total = 0;
      try {
        await Promise.race([opts.bus.ready(), halted]);
        while (!stopped) {
          again = false;
          for (;;) {
            const r = await round();
            total += r.published;
            if (r.claimed < batch) break;
          }
          if (!again) break;
        }
      } catch (err) {
        logger.warn({ err }, "outbox relay round failed; retrying");
      } finally {
        running = null;
      }
      return total;
    })();
    return running;
  };

  // Wake-ups: NOTIFY from the outbox trigger on a direct connection, reconnected if it drops.
  let listener: pg.Client | null = null;
  const listen = async () => {
    if (!opts.listenUrl || stopped) return;
    const client = new pg.Client({ connectionString: opts.listenUrl });
    client.on("notification", () => void flush());
    client.on("error", (err) => {
      logger.warn({ err }, "outbox listener lost; reconnecting");
      listener = null;
      setTimeout(() => void listen(), 2000).unref();
    });
    try {
      const schema = await poolSchema(opts.pool);
      await client.connect();
      await client.query(`LISTEN ${client.escapeIdentifier(`${OUTBOX_CHANNEL}_${schema}`)}`);
      listener = client;
    } catch (err) {
      logger.warn({ err }, "outbox listener unavailable; polling");
      await client.end().catch(() => undefined);
      setTimeout(() => void listen(), 5000).unref();
    }
  };
  void listen();

  const pollMs = opts.pollMs ?? (opts.listenUrl ? 1000 : 250);
  const poll = setInterval(() => void flush(), pollMs);
  poll.unref();
  void flush();

  const stop = async () => {
    stopped = true;
    halt();
    clearInterval(poll);
    await running;
    await listener?.end().catch(() => undefined);
  };
  const unregister = onShutdown("relays", stop);
  return {
    flush,
    async stop() {
      unregister();
      await stop();
    },
  };
}

/**
 * Deletes published outbox rows older than keepDays (the copy `dlq outbox-replay` re-sends from), in batches,
 * through the module schema's outbox_prune() (SECURITY DEFINER). Undelivered rows stay.
 */
export async function pruneOutbox(pool: pg.Pool, keepDays: number, batch = 5000, maxBatches = 50): Promise<number> {
  let total = 0;
  for (let i = 0; i < maxBatches; i++) {
    const n = (await pool.query<{ n: number }>("SELECT outbox_prune($1, $2) AS n", [Math.max(1, keepDays), batch])).rows[0]?.n ?? 0;
    total += n;
    if (n < batch) break;
  }
  if (total) logger.info({ deleted: total, keepDays }, "outbox pruned");
  return total;
}

export interface EventsOptions extends OutboxRelayOptions {
  /** Days published events stay in the outbox (EVENT_RETENTION_DAYS, default 3). */
  retentionDays?: number;
  /** Days dead letters are kept (DEAD_EVENTS_RETENTION_DAYS, default 90); needs `listenUrl` (the owner connection). */
  deadEventsDays?: number;
}

/** Everything a producing module runs for events: the outbox relay, the outbox prune and the dead-letter prune. */
export async function startEvents(opts: EventsOptions): Promise<OutboxRelay> {
  const relay = startOutboxRelay(opts);
  const keep = opts.retentionDays ?? 3;
  const stopPrune = scheduleJob("outbox-prune", 3600_000, () => pruneOutbox(opts.pool, keep), { pool: opts.pool, firstRunMs: 60_000 });
  // Dead letters need the owner connection (the app role cannot delete them); without one they are kept.
  const stopDead = opts.listenUrl ? scheduleDeadEventsPrune(opts.pool, opts.listenUrl, opts.deadEventsDays ?? envInt("DEAD_EVENTS_RETENTION_DAYS", 90)) : () => undefined;
  return {
    flush: relay.flush,
    async stop() {
      stopPrune();
      stopDead();
      await relay.stop();
    },
  };
}
