import { randomBytes } from "node:crypto";
import type pg from "pg";
import { CONSUMER_GROUPS, checkEvent, eventEnvelopeSchema, isConsumerGroup, isEventType, type EventEnvelope } from "@workspace/contracts";
import { runWithContext, runWithRequestId, withTransaction } from "@workspace/shared";
import { onShutdown } from "./lifecycle.js";
import { logger } from "./logger.js";

/**
 * Domain events, delivered inside the one server process (ADR 0021). The producer's transaction writes an outbox
 * row (appendToOutbox); its module's relay (outbox-relay.ts) hands each committed row to every consumer group that
 * reads the row's topic (`workspace.<aggregateType>`) and marks it published once they all have it:
 *
 *   module tx ─► outbox row ─► outbox relay ─► EventBus.dispatch ─► group A: handle (retries) or dead_events
 *                                                                 └► group B: …
 *
 * The outbox is the durable copy: a crash before the row is marked delivers it again, so delivery is at least
 * once and consumers dedupe through processed_events (startConsumer). There is no ordering between topics; one
 * workspace's events reach a group one after another (lanes), workspaces run in parallel.
 */

/** Request id an event is handled under: the producing request's, else the event id. */
export function eventRequestId(e: EventEnvelope): string {
  return e.requestId ?? e.eventId;
}

/** One consumer group as the bus sees it: hand it an entry, it resolves once the entry is handled or dead-lettered. */
interface Subscriber {
  topics: ReadonlySet<string>;
  deliver(stream: string, entryId: string, raw: string): Promise<void>;
}

/**
 * The process's event bus: consumer groups subscribe, outbox relays dispatch. Dispatching waits for the start gate,
 * opened once every module has subscribed (main.ts), so no group misses the events its module's relay or another's
 * would otherwise hand out first.
 */
export class EventBus {
  private readonly groups = new Map<string, Subscriber>();
  private open!: () => void;
  private readonly gate = new Promise<void>((resolve) => (this.open = resolve));

  /** Registers a group (consumeEvents); returns the unsubscribe. A group name is unique in the process. */
  subscribe(group: string, sub: Subscriber): () => void {
    if (this.groups.has(group)) throw new Error(`consumer group ${group} is already subscribed`);
    this.groups.set(group, sub);
    return () => void (this.groups.get(group) === sub && this.groups.delete(group));
  }

  /**
   * Opens the gate. With `requireAllGroups` (the server) every group in @workspace/contracts CONSUMER_GROUPS must
   * have subscribed by now: a missing one would silently lose its events, so the process refuses to run instead.
   * Tests that host a single module start without it, and events for absent groups are just marked published.
   */
  start(opts: { requireAllGroups?: boolean } = {}): void {
    if (opts.requireAllGroups) {
      const missing = Object.keys(CONSUMER_GROUPS).filter((g) => !this.groups.has(g));
      if (missing.length) throw new Error(`consumer groups without a handler in this process: ${missing.join(", ")}`);
    }
    this.open();
  }

  /** Resolves once start() has been called. */
  ready(): Promise<void> {
    return this.gate;
  }

  has(group: string): boolean {
    return this.groups.has(group);
  }

  /** Whether any group reads this topic (rows of topics nobody reads are marked without dispatching). */
  hasReaders(stream: string): boolean {
    for (const g of this.groups.values()) if (g.topics.has(stream)) return true;
    return false;
  }

  /**
   * Hands one entry to every group reading its topic (or to `only`, for replays) and resolves when each has
   * handled or dead-lettered it. The groups queue it synchronously, so entries dispatched in a row reach each
   * group's workspace lane in that order even when the caller does not await between them.
   */
  dispatch(stream: string, entryId: string, raw: string, only?: string): Promise<void> {
    const out: Promise<void>[] = [];
    for (const [name, g] of this.groups) if ((only ? name === only : true) && g.topics.has(stream)) out.push(g.deliver(stream, entryId, raw));
    return Promise.all(out).then(() => undefined);
  }
}

const g = globalThis as unknown as { __workspaceEventBus?: EventBus };

/** The process's event bus (one per process, shared by every module). */
export function eventBus(): EventBus {
  return (g.__workspaceEventBus ??= new EventBus());
}

export interface EventConsumerOptions {
  /** The process's bus (eventBus()). */
  bus: EventBus;
  groupId: string;
  topics: string[];
  /** Runs under the event's actor and request id (no database transaction: see startConsumer). */
  handle: (event: EventEnvelope) => Promise<void>;
  /** Attempts (with backoff) before the event goes to the dead letters. Default 5. */
  maxAttempts?: number;
  /** Database with the module's dead_events table (the app role may only insert). Without it a failure is only logged. */
  deadLetters?: pg.Pool;
}

export interface ConsumerOptions extends Omit<EventConsumerOptions, "handle" | "deadLetters"> {
  pool: pg.Pool;
  /** Runs in the same transaction as the dedupe insert. */
  handle: (event: EventEnvelope, client: pg.PoolClient) => Promise<void>;
}

export interface EventConsumer {
  readonly name: string;
  /** Stops taking events and waits for those in flight. */
  stop(): Promise<void>;
}

/**
 * Subscribes a consumer group on the bus. Each entry runs the pipeline every reader of domain events shares:
 *   parse envelope → validate the payload against @workspace/contracts → runWithContext → handle
 * Failures retry with backoff, then go to the dead letters: a bad event never blocks the group. A malformed
 * envelope or a payload that does not match its schema goes there directly. Types this build does not know are
 * handed over unchecked; handlers ignore types they do not switch on.
 *
 * A group's entries run one after another: projections update shared workspace-wide rows, and concurrent
 * transactions on them deadlock.
 */
export async function consumeEvents(opts: EventConsumerOptions): Promise<EventConsumer> {
  const group = opts.groupId;
  const topics = [...new Set(opts.topics)];
  if (isConsumerGroup(group)) {
    const registered = new Set<string>(CONSUMER_GROUPS[group]);
    if (registered.size !== topics.length || topics.some((t) => !registered.has(t))) {
      throw new Error(`consumer group ${group} reads [${topics.join(", ")}] but @workspace/contracts CONSUMER_GROUPS lists [${[...registered].join(", ")}]`);
    }
  }
  const maxAttempts = opts.maxAttempts ?? 5;

  const deadLetter = async (stream: string, id: string, raw: string, reason: string, event?: EventEnvelope) => {
    logger.error({ topic: stream, entryId: id, consumer: group, eventId: event?.eventId, eventType: event?.eventType, reason }, "event dead-lettered");
    if (!opts.deadLetters) return;
    try {
      await opts.deadLetters.query(
        `INSERT INTO dead_events (consumer, stream, entry_id, event_id, event_type, reason, event)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
        [group, stream, id, event?.eventId ?? null, event?.eventType ?? null, reason.slice(0, 2000), raw],
      );
    } catch (err) {
      // The database is down: the entry is acknowledged anyway (holding it would hold its whole outbox batch), and
      // stays in the producer's outbox for `dlq outbox-replay` (EVENT_RETENTION_DAYS).
      logger.error({ err, consumer: group, topic: stream, entryId: id, eventId: event?.eventId }, "dead letter not stored");
    }
  };

  /** Handles one entry; resolves once it is handled, a duplicate, or dead-lettered. */
  const process1 = async (stream: string, id: string, raw: string): Promise<void> => {
    let event: EventEnvelope;
    try {
      event = eventEnvelopeSchema.parse(JSON.parse(raw || "null"));
    } catch (err) {
      return deadLetter(stream, id, raw, `malformed: ${(err as Error).message}`);
    }
    if (isEventType(event.eventType)) {
      try {
        event = { ...event, payload: checkEvent(event) };
      } catch (err) {
        return deadLetter(stream, id, raw, `invalid: ${(err as Error).message}`, event);
      }
    }
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // Under the producing request's id, so logs and the events this handler emits stay correlated with the
        // user action that started the chain.
        await runWithContext({ actorId: event.actorId, requestId: eventRequestId(event) }, () => opts.handle(event));
        return;
      } catch (err) {
        if (err instanceof DuplicateEvent) return;
        runWithRequestId(eventRequestId(event), () => logger.warn({ err, eventId: event.eventId, attempt, consumer: group }, "event handling failed"));
        if (attempt === maxAttempts) return runWithRequestId(eventRequestId(event), () => deadLetter(stream, id, raw, (err as Error).message, event));
        await sleep(100 * 2 ** attempt);
      }
    }
  };

  // One chain per group: each entry starts when the previous one is handled.
  let tail: Promise<void> = Promise.resolve();
  const inFlight = new Set<Promise<void>>();
  let stopped = false;

  const deliver = (stream: string, id: string, raw: string): Promise<void> => {
    if (stopped) return Promise.resolve();
    const done = tail.then(async () => {
      try {
        await process1(stream, id, raw);
      } catch (err) {
        // process1 handles its own failures; anything else is a bug here, not a reason to redeliver forever.
        logger.error({ err, topic: stream, entryId: id, consumer: group }, "event delivery failed");
      }
    });
    tail = done;
    inFlight.add(done);
    void done.finally(() => inFlight.delete(done));
    return done;
  };

  const unsubscribe = opts.bus.subscribe(group, { topics: new Set(topics), deliver });
  const stop = async () => {
    stopped = true;
    unsubscribe();
    await Promise.all([...inFlight]);
  };
  const unregister = onShutdown("consumers", stop);
  return {
    name: group,
    async stop() {
      unregister();
      await stop();
    },
  };
}

/** Thrown inside the transaction to roll it back when an event was already handled. */
class DuplicateEvent extends Error {}

/**
 * Idempotent consumer for modules with a database:
 *   consumeEvents → BEGIN → INSERT processed_events (dup → skip) → handle → COMMIT
 * The dedupe row and the handler's writes commit together, so a redelivered event is a no-op.
 * Failures land in the module's dead_events table.
 */
export async function startConsumer(opts: ConsumerOptions): Promise<EventConsumer> {
  return consumeEvents({
    ...opts,
    deadLetters: opts.pool,
    handle: (event) =>
      withTransaction(opts.pool, async (client) => {
        const ins = await client.query("INSERT INTO processed_events (consumer, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [opts.groupId, event.eventId]);
        if (ins.rowCount === 0) throw new DuplicateEvent();
        await opts.handle(event, client);
      }),
  });
}

/**
 * Dispatches envelopes straight to the bus's groups, bypassing the outbox, and waits until they are handled. For
 * tests and tools only: modules publish through appendToOutbox so an event exists exactly when its transaction
 * commits. Returns the entry ids used (what dead_events records as entry_id).
 */
export async function publishEvents(bus: EventBus, events: { topic: string; event: unknown; only?: string }[]): Promise<string[]> {
  const ids = events.map(() => `direct-${randomBytes(8).toString("hex")}`);
  await Promise.all(events.map((e, i) => bus.dispatch(e.topic, ids[i]!, typeof e.event === "string" ? e.event : JSON.stringify(e.event), e.only)));
  return ids;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
