-- The audit trail (ADR 0025) lives in the platform module; identity's earlier admin log carries over to it
-- as `audit.entry.recorded.v1` events through the outbox (the only way into another module's schema). Each event
-- keeps the entry's id, so the trail row is written once however often this is delivered. Idempotent: an entry
-- already in the outbox is skipped. `audit_log` stays for its endpoint; new entries go to both (repo.ts audit()).

INSERT INTO outbox (id, aggregatetype, aggregateid, type, payload)
SELECT a.id, 'audit.entry', left(a.resource || ':' || a.resource_id, 128), 'audit.entry.recorded.v1',
       jsonb_build_object(
         'eventId', a.id,
         'eventType', 'audit.entry.recorded.v1',
         'version', 1,
         'aggregateType', 'audit.entry',
         'aggregateId', left(a.resource || ':' || a.resource_id, 128),
         'actorId', CASE WHEN a.actor = '' THEN 'system' ELSE a.actor END,
         'occurredAt', to_char(a.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         'requestId', 'backfill-identity-audit',
         'payload', jsonb_strip_nulls(jsonb_build_object(
           'action', 'identity.' || a.action,
           'targetType', a.resource,
           'targetId', a.resource_id,
           'targetLabel', coalesce(a.metadata->>'email', a.metadata->>'name', a.metadata->>'client', m.email),
           'outcome', 'success',
           'meta', a.metadata
         ))
       )
  FROM audit_log a
  LEFT JOIN members m ON a.resource = 'member' AND m.user_id = a.resource_id
 WHERE a.action ~ '^[a-z]+(\.[a-z_]+)+$' AND a.resource <> '' AND a.resource_id <> ''
ON CONFLICT (id) DO NOTHING;
