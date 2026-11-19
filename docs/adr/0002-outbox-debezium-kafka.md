# ADR-0002: Transactional outbox, Debezium CDC and Kafka for events

- Status: Superseded by [ADR-0012](0012-valkey-streams-events.md) (same day: in-service relay and Valkey Streams)
- Date: 2026-10-15

## Context

With a database per service ([ADR-0001](0001-database-per-service-rls.md)), other services learn about changes through events (home feed, search, employee profiles, quota, webhooks). Publishing to a broker after commit loses events on crashes; publishing before commit emits events for rolled-back work. Consumers also need replay and correlation with the user request that caused them.

## Decision

- Each service has an `outbox` table. `appendToOutbox()` (`backend/packages/shared/src/outbox/outbox.ts`) inserts the event **and deletes it in the same business transaction** (T-1); the row exists only in the WAL. An event without a request id is refused.
- **Debezium** Postgres connectors (`pgoutput`, one per database, `outbox-<db>`, registered idempotently by `infra/local/debezium/register.sh`, also run by the production `connectors` job) read only `INSERT`s on `public.outbox` and route them with the **EventRouter** to `workspace.<aggregatetype>` topics (e.g. `workspace.work.task`), keyed by aggregate id.
- **Kafka** (3.8, KRaft, single node in production) with 7-day retention; replay relies on retention because outbox rows are deleted.
- Envelope `domain.entity.event.vN` validated by zod (`backend/packages/contracts/src/event-envelope.ts`), carrying `tenantId`, `actorId`, `requestId` and W3C `traceparent` (Debezium drops custom headers, so the envelope is the carrier).
- Consumers use `startConsumer()` (`backend/packages/service-kit/src/kafka.ts`): bind tenant context, `INSERT processed_events` for idempotency, handle in the same transaction, retry 5× with backoff, then `<topic>.dlq`; malformed events go straight to DLQ.

## Consequences

- Exactly-once effects per consumer group under at-least-once delivery; no dual-write gap.
- Operational weight: Kafka + Connect add ~1.2 GB RAM and two more components to monitor. A stopped connector makes Postgres retain WAL in the replication slot, so disk must be watched.
- After a database restore or a fresh Connect, connectors must be re-registered (`docker compose run --rm connectors`).
- Search and home are eventually consistent (typically sub-second locally).
- Rebuilding a projection beyond 7 days needs a re-emit path (not built).
- Topic catalogue and payloads: [docs/events/README.md](../events/README.md).
