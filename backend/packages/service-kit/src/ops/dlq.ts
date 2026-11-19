import pg from "pg";

/**
 * Dead letters: every consumer parks what it gave up on in its module schema's dead_events table
 * (consumeEvents). "Waiting" rows have not been replayed.
 *
 * Events are delivered inside the server process, so this tool (a separate process) cannot hand them to a
 * consumer itself. A replay is a request written to the database: the row's replay_requested_at is set, and the
 * running server's replay job (dead-letters.ts) delivers it to the group that failed it only, within seconds,
 * and stamps replayed_at. Requesting twice never re-drives a row twice, and other groups are not disturbed.
 *
 * The tool connects to the database as the owner role and works in each schema as workspace_maintenance
 * (the modules' roles may only insert dead letters).
 */
const EVENT_SCHEMAS = ["identity", "platform", "chat", "work", "home", "employee", "ai"] as const;

/** Schemas with a dead_events table: every event schema, plus the search indexer's (it consumes, never produces). */
export const DLQ_SCHEMAS = [...EVENT_SCHEMAS, "search"] as const;

/** The database as the owner role (same variable as `migrate`). */
function opsDatabaseUrl(): string {
  return process.env.MIGRATE_DATABASE_URL ?? "postgres://workspace_owner:owner_pw@localhost:5432/workspace";
}

export interface DlqSummary {
  schema: string;
  consumer: string;
  stream: string;
  waiting: number;
  total: number;
}

export interface DeadEvent {
  schema: string;
  id: string;
  consumer: string;
  stream: string;
  eventType: string | null;
  eventId: string | null;
  reason: string;
  failedAt: string;
  replayedAt: string | null;
}

/**
 * Runs fn as workspace_maintenance in one module schema. Returns null for a schema without a dead_events
 * table (modules that consume nothing) unless anySchema is set.
 */
async function withOpsSchema<T>(schema: string, fn: (c: pg.Client) => Promise<T>, url = opsDatabaseUrl(), anySchema = false): Promise<T | null> {
  if (!/^[a-z][a-z0-9_]*$/.test(schema)) throw new Error(`Invalid schema name: ${schema}`);
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query("SET ROLE workspace_maintenance");
    await c.query(`SET search_path TO ${schema}, pg_temp`);
    const has = (await c.query<{ t: string | null }>("SELECT to_regclass('dead_events')::text AS t")).rows[0]?.t;
    if (!has && !anySchema) return null;
    return await fn(c);
  } finally {
    await c.end();
  }
}

export async function listDlq(schemas: readonly string[] = DLQ_SCHEMAS): Promise<DlqSummary[]> {
  const out: DlqSummary[] = [];
  for (const schema of schemas) {
    const rows = await withOpsSchema(
      schema,
      async (c) =>
        (
          await c.query<{ consumer: string; stream: string; waiting: number; total: number }>(
            `SELECT consumer, stream, count(*) FILTER (WHERE replayed_at IS NULL)::int AS waiting, count(*)::int AS total
             FROM dead_events GROUP BY consumer, stream ORDER BY consumer, stream`,
          )
        ).rows,
    );
    for (const r of rows ?? []) out.push({ schema, ...r });
  }
  return out;
}

export async function readDlq(opts: { schemas?: readonly string[]; consumer?: string; onlyWaiting?: boolean; limit?: number } = {}): Promise<DeadEvent[]> {
  const out: DeadEvent[] = [];
  for (const schema of opts.schemas ?? DLQ_SCHEMAS) {
    const rows = await withOpsSchema(
      schema,
      async (c) =>
        (
          await c.query<{
            id: string;
            consumer: string;
            stream: string;
            event_type: string | null;
            event_id: string | null;
            reason: string;
            failed_at: Date;
            replayed_at: Date | null;
          }>(
            `SELECT id::text, consumer, stream, event_type, event_id, reason, failed_at, replayed_at FROM dead_events
            WHERE ($1::text IS NULL OR consumer = $1) AND (NOT $2 OR replayed_at IS NULL)
            ORDER BY failed_at DESC LIMIT $3`,
            [opts.consumer ?? null, opts.onlyWaiting ?? true, opts.limit ?? 50],
          )
        ).rows,
    );
    for (const r of rows ?? [])
      out.push({
        schema,
        id: r.id,
        consumer: r.consumer,
        stream: r.stream,
        eventType: r.event_type,
        eventId: r.event_id,
        reason: r.reason,
        failedAt: r.failed_at.toISOString(),
        replayedAt: r.replayed_at?.toISOString() ?? null,
      });
  }
  return out;
}

/**
 * Requests a replay of one consumer group's waiting dead letters (the running server delivers them). Fix the cause
 * first: an event that fails again is dead-lettered again (a new row). Returns how many rows were (or would be)
 * requested; rows already requested and not yet replayed are not counted again.
 */
export async function replayDlq(consumer: string, opts: { schemas?: readonly string[]; dryRun?: boolean; url?: string } = {}): Promise<number> {
  let n = 0;
  for (const schema of opts.schemas ?? DLQ_SCHEMAS) {
    const done = await withOpsSchema(
      schema,
      async (c) =>
        opts.dryRun
          ? ((await c.query<{ n: number }>("SELECT count(*)::int AS n FROM dead_events WHERE consumer = $1 AND replayed_at IS NULL AND replay_requested_at IS NULL", [consumer]))
              .rows[0]?.n ?? 0)
          : ((await c.query("UPDATE dead_events SET replay_requested_at = now() WHERE consumer = $1 AND replayed_at IS NULL AND replay_requested_at IS NULL", [consumer]))
              .rowCount ?? 0),
      opts.url,
    );
    n += done ?? 0;
  }
  return n;
}

export interface OutboxReplayFilter {
  /** Module schema whose outbox holds the events (e.g. "work"). */
  schema: string;
  /** Consumer group that receives them; no other group sees them. */
  group: string;
  types?: string[];
  since?: Date;
  until?: Date;
  dryRun?: boolean;
  url?: string;
}

/**
 * Re-sends events kept in a module's outbox (EVENT_RETENTION_DAYS) to one consumer group, e.g. after fixing a
 * consumer bug or restoring the database. They are queued as replay requests in that schema's dead_events (reason
 * "outbox replay"), which the running server delivers like any requested replay. Consumers dedupe on
 * processed_events, so handled events stay no-ops unless that ledger was cleared. Returns how many were queued.
 */
export async function replayFromOutbox(f: OutboxReplayFilter): Promise<number> {
  const n = await withOpsSchema(
    f.schema,
    async (c) => {
      const filter = `FROM outbox
        WHERE ($1::text[] IS NULL OR type = ANY($1)) AND ($2::timestamptz IS NULL OR created_at >= $2)
          AND ($3::timestamptz IS NULL OR created_at < $3)`;
      const args = [f.types?.length ? f.types : null, f.since ?? null, f.until ?? null];
      if (f.dryRun) return (await c.query<{ n: number }>(`SELECT count(*)::int AS n ${filter}`, args)).rows[0]?.n ?? 0;
      // entry_id carries the request time: the same row can be replayed to the same group again later.
      const r = await c.query(
        `INSERT INTO dead_events (consumer, stream, entry_id, event_id, event_type, reason, event, replay_requested_at)
         SELECT $4, 'workspace.' || aggregatetype, 'outbox:' || id || ':' || extract(epoch FROM now())::text, payload->>'eventId', type,
                'outbox replay', payload::text, now()
         ${filter} ORDER BY created_at`,
        [...args, f.group],
      );
      return r.rowCount ?? 0;
    },
    f.url,
  );
  if (n === null) throw new Error(`schema ${f.schema} has no dead_events table to queue the replay in`);
  return n;
}
