import pg from "pg";
import { onShutdown } from "./lifecycle.js";
import { logger } from "./logger.js";
import { runJob } from "./request-id.js";

/**
 * Job locks hold a connection for the whole run. Through PgBouncer that pins one of the database's few server
 * connections (in an idle transaction) while the job's own queries need more from the same pool: with several jobs
 * at once that starves the module's pool (PgBouncer `query_wait_timeout`). useJobLocks() gives the process one
 * direct connection to Postgres (the owner URL, not PgBouncer) where every job takes a session advisory lock
 * instead: one connection per process, whatever the number of jobs, and nothing from the pool.
 */
let lockUrl: string | null = null;
let lockClient: Promise<pg.Client> | null = null;
const heldHere = new Set<string>();

export function useJobLocks(directUrl: string): void {
  lockUrl = directUrl;
}

const schemas = new WeakMap<pg.Pool, Promise<string>>();

/**
 * The schema a pool's role works in (its search_path's first entry). All modules share one database, so
 * locks and wake-up channels are named per schema: two modules' jobs of the same name never block each other.
 */
export function poolSchema(pool: pg.Pool): Promise<string> {
  let s = schemas.get(pool);
  if (!s) {
    s = pool.query<{ s: string }>("SELECT current_schema() AS s").then((r) => r.rows[0]!.s);
    s.catch(() => schemas.delete(pool));
    schemas.set(pool, s);
  }
  return s;
}

async function directLockClient(): Promise<pg.Client> {
  lockClient ??= (async () => {
    const c = new pg.Client({ connectionString: lockUrl! });
    // A dropped connection releases its locks in Postgres; the next run reconnects.
    c.on("error", (err) => {
      logger.warn({ err }, "job lock connection lost");
      lockClient = null;
    });
    try {
      await c.connect();
    } catch (err) {
      lockClient = null;
      throw err;
    }
    return c;
  })();
  return lockClient;
}

/**
 * Runs fn only if no other process is running the same job right now (a Postgres advisory lock named after the job
 * and the pool's schema). Returns whether fn ran.
 *
 * With useJobLocks(), a session lock on the process's direct lock connection. Without it (tests, tools), a
 * transaction-level lock on a pool connection: PgBouncer pools by transaction, so a session lock there would
 * leak to whoever gets the connection next.
 *
 * This prevents concurrent runs, not repeated ones: two replicas may each run the job once per
 * interval, one after the other. Every job is written to be re-run (claims rows, "once per day"
 * markers), so that is safe; running the same batch twice at the same moment is what this stops.
 */
export async function runExclusive(pool: pg.Pool, name: string, fn: () => Promise<unknown>): Promise<boolean> {
  const key = `workspace.job:${await poolSchema(pool)}:${name}`;
  if (lockUrl) {
    // Session locks are re-entrant within a session, and this process has one: guard against itself here, per lock
    // key (every module runs jobs of the same names, such as outbox-prune, at the same moment).
    if (heldHere.has(key)) return false;
    heldHere.add(key);
    try {
      const c = await directLockClient();
      const got = (await c.query<{ got: boolean }>("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS got", [key])).rows[0]?.got;
      if (!got) return false;
      try {
        await fn();
        return true;
      } finally {
        await c.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]).catch(() => undefined);
      }
    } finally {
      heldHere.delete(key);
    }
  }
  const c = await pool.connect();
  // An error on a checked-out client has no pool listener to land on; without this it would crash the process.
  const onError = (err: Error) => logger.warn({ err, job: name }, "job lock connection lost");
  c.on("error", onError);
  try {
    await c.query("BEGIN");
    const got = (await c.query<{ got: boolean }>("SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS got", [key])).rows[0]?.got;
    if (!got) return false;
    await fn();
    return true;
  } finally {
    await c.query("COMMIT").catch(() => undefined);
    c.off("error", onError);
    c.release();
  }
}

export interface ScheduleOptions {
  /** The module's database pool, where the job lock lives. Omit for per-process jobs (health probes). */
  pool?: pg.Pool;
  /** Delay before the first run; defaults to one interval. */
  firstRunMs?: number;
  /** Skips a tick when false (e.g. only on weekday mornings). */
  when?: () => boolean;
}

/**
 * A periodic background job: one replica at a time (with `pool`), its own request id
 * (runJob), errors logged, never thrown. The timer does not keep the process alive.
 */
export function scheduleJob(name: string, everyMs: number, fn: () => Promise<unknown>, opts: ScheduleOptions = {}): () => void {
  let running: Promise<void> | null = null;
  let stopped = false;
  const tick = async () => {
    // A slow run is not overlapped by the next tick on the same replica either.
    if (stopped || running || (opts.when && !opts.when())) return;
    running = (async () => {
      try {
        // Stopped while this tick waited for the lock: the job does not start after stop() any more.
        if (opts.pool) await runExclusive(opts.pool, name, () => (stopped ? Promise.resolve() : runJob(name, fn)));
        else await runJob(name, fn);
      } catch (err) {
        // Only the lock itself can throw here (database down): the next tick retries.
        logger.warn({ err, job: name }, "job lock unavailable");
      } finally {
        running = null;
      }
    })();
    await running;
  };
  const first = setTimeout(() => void tick(), opts.firstRunMs ?? everyMs);
  const every = setInterval(() => void tick(), everyMs);
  first.unref();
  every.unref();
  const stop = () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(every);
  };
  // On shutdown the run in progress is let finish.
  const unregister = onShutdown("jobs", () => {
    stop();
    return running;
  });
  return () => {
    unregister();
    stop();
  };
}

/**
 * The dedupe ledger must outlive any redelivery: undelivered outbox rows, DLQ replays and outbox replays
 * (EVENT_RETENTION_DAYS, default 3). It never keeps less than this, whatever is configured.
 */
const MIN_PROCESSED_EVENTS_DAYS = 8;

/**
 * Deletes processed_events rows older than `keepDays`, in batches, through the module schema's
 * prune_processed_events() (SECURITY DEFINER). Batches continue while they
 * come back full, within a time budget: busy schemas (home consumes every chat message and task event) outrun a
 * fixed batch count. Returns how many rows went.
 */
export async function pruneProcessedEvents(pool: pg.Pool, keepDays = 30, batch = 5000, budgetMs = 60_000): Promise<number> {
  const days = Math.max(MIN_PROCESSED_EVENTS_DAYS, keepDays);
  const total = await pruneInBatches(batch, budgetMs, async () => (await pool.query<{ n: number }>("SELECT prune_processed_events($1, $2) AS n", [days, batch])).rows[0]?.n ?? 0);
  if (total) logger.info({ deleted: total, keepDays: days }, "processed_events pruned");
  return total;
}

/** Runs `one` (a delete of up to `batch` rows) until a batch comes back short or the time budget is spent. */
export async function pruneInBatches(batch: number, budgetMs: number, one: () => Promise<number>): Promise<number> {
  const until = Date.now() + budgetMs;
  let total = 0;
  for (;;) {
    const n = await one();
    total += n;
    if (n < batch || Date.now() >= until) return total;
  }
}

/**
 * Dead letters (`dead_events`) older than `keepDays`, replayed or not: after that long nobody is going to replay
 * them (`dlq list` shows them long before). The app role may only insert into that table, so this runs
 * on a direct owner connection as the maintenance role, the way `pnpm ops:dlq` reads it; the schema is the one
 * the pool's role defaults to. Returns how many rows went.
 */
export async function pruneDeadEvents(pool: pg.Pool, ownerUrl: string, keepDays = 90, batch = 5000, budgetMs = 60_000): Promise<number> {
  const schema = await poolSchema(pool);
  if (!/^[a-z][a-z0-9_]*$/.test(schema)) throw new Error(`dead_events prune: unexpected schema name (${schema})`);
  const days = Math.max(1, keepDays);
  const client = new pg.Client({ connectionString: ownerUrl });
  // A connection dropped mid-run is emitted as an error; unhandled, it would take the whole server down.
  client.on("error", (err) => logger.warn({ err }, "dead_events prune connection lost"));
  await client.connect();
  try {
    await client.query("SET ROLE workspace_maintenance");
    await client.query(`SET search_path TO ${schema}, public`);
    const total = await pruneInBatches(batch, budgetMs, async () => {
      const r = await client.query(
        "DELETE FROM dead_events d USING (SELECT id FROM dead_events WHERE failed_at < now() - make_interval(days => $1) ORDER BY failed_at LIMIT $2) old WHERE d.id = old.id",
        [days, batch],
      );
      return r.rowCount ?? 0;
    });
    if (total) logger.info({ deleted: total, keepDays: days, schema }, "dead_events pruned");
    return total;
  } finally {
    await client.end();
  }
}

/** The dead-letter pruning job (daily; DEAD_EVENTS_RETENTION_DAYS, default 90), scheduled by startEvents. */
export function scheduleDeadEventsPrune(pool: pg.Pool, ownerUrl: string, keepDays: number): () => void {
  return scheduleJob("dead-events-prune", 24 * 3600_000, () => pruneDeadEvents(pool, ownerUrl, keepDays), { pool, firstRunMs: 7 * 60_000 });
}

/** The pruning job every consuming module schedules (daily; PROCESSED_EVENTS_RETENTION_DAYS, default 30). */
export function scheduleProcessedEventsPrune(pool: pg.Pool, keepDays: number): () => void {
  return scheduleJob("processed-events-prune", 24 * 3600_000, () => pruneProcessedEvents(pool, keepDays), { pool, firstRunMs: 5 * 60_000 });
}
