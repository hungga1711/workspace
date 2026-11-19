# ADR-0012: Events on Valkey Streams with an in-service outbox relay

- Status: Superseded by [ADR-0021](0021-one-server-no-valkey.md) (events handed over in process; the outbox and its relay stay). Superseded [ADR-0002](0002-outbox-debezium-kafka.md)
- Date: 2026-10-15

## Context

ADR-0002 moved events from each service's outbox to consumers with Debezium (Kafka Connect, logical replication)
and Kafka. For a self-hosted product installed by one company on one small server, that pipeline was the heaviest
part of the stack: Kafka and Kafka Connect are two JVMs (~1.1 GB of RAM at idle), Postgres had to run
`wal_level=logical` with a replication slot per database (an idle or dropped slot pins or loses WAL), and
connectors had to be registered after every fresh install. The owner wants the open-source edition as light as
possible while staying event-driven, with events that survive a restart and are deleted after a retention period,
and does not need ordering between events.

Options considered: Redpanda (Kafka API, BSL licence, needs about 1–2 GB of RAM per core: not lighter), NATS
JetStream (light, on disk, but one more system to run), Postgres `LISTEN/NOTIFY` alone (no consumer groups or
redelivery), RabbitMQ (heavier, no replay). The stack already runs Redis for caches, sessions and the Socket.IO
adapter.

## Decision

- **Broker: Valkey Streams** (the BSD-licensed Redis fork; Redis 7.4+ is RSAL/SSPL). One Valkey instance holds
  events, caches and the Socket.IO adapter, configured `maxmemory-policy noeviction` and `appendonly yes`,
  `appendfsync everysec`. Because nothing is evicted, every cache key must carry a TTL.
- **Producers are unchanged**: `appendToOutbox` writes the envelope in the business transaction. The outbox now
  keeps the row (`created_at`, `published_at`); a statement trigger `NOTIFY`s on commit.
- **Relay inside each producing service** (`service-kit startEvents`): claims unpublished rows
  (`FOR UPDATE SKIP LOCKED`, so replicas cooperate), `XADD`s them to `workspace.<aggregateType>`, marks them published
  after Valkey accepted them. Woken by `LISTEN` on a direct connection, 1 s poll as a fallback. No CDC, no
  replication slots, `wal_level` back to the default.
- **Consumers** keep `startConsumer` / `consumeEvents`: consumer groups (`XREADGROUP`), concurrent handling, `XACK`
  after the handler, takeover of entries a dead consumer left pending (`XPENDING` + `XCLAIM`), dead letters after
  5 attempts or 5 deliveries into a `dead_events` table in the consuming service's database. Dedupe through
  `processed_events` as before. **No ordering guarantee.**
- **Memory holds only unhandled events.** A trim job removes every entry all groups of a stream have acknowledged.
  Consumer groups are registered in `@workspace/contracts` (`CONSUMER_GROUPS`) and created up front, so a group
  whose service is down still keeps its entries; a per-stream backlog limit (50,000) makes the relay leave further
  events in the outbox on disk until the consumer catches up.
- **The durable copy is the outbox**, kept `EVENT_RETENTION_DAYS` (default 3) and pruned hourly. Replays read it
  (`dlq outbox-replay <db> <group>`) and are addressed to one group (`only` field); dead letters are replayed the
  same way (`dlq replay <group>`).

## Consequences

- Kafka, Kafka Connect, Debezium, the connectors job and logical replication are gone: two JVMs and about 1.1 GB of
  RAM less, one container (Valkey) instead of three, nothing to register after install.
- Delivery stays at least once with effectively-once database effects. Handlers must tolerate any order; the
  projections that care were already version-gated.
- Replay depth is the outbox retention (3 days by default) rather than Kafka's 7; the search index and projections
  with an HTTP resync are rebuilt from the databases as before.
- A machine crash can lose up to about one second of stream entries (AOF `everysec`); their outbox rows are marked
  published, so that window is republished with `dlq outbox-replay`. Valkey being down never blocks writes: events
  wait in the outboxes.
- A consumer group retired from the code must also leave `CONSUMER_GROUPS` (and be destroyed in Valkey), or its
  streams stop trimming and fill to the backlog limit.
- Throughput is far beyond what one company produces; very large installations could move the transport to a
  dedicated broker without touching producers or handlers (the relay and `consumeEvents` are the only adapters).
