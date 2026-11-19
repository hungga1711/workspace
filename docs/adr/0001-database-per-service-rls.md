# ADR-0001: Database per service, tenant isolation by Postgres row-level security

- Status: Superseded by [ADR-0015](0015-single-database-schema-per-module.md) (one database with a schema and role per module) and [ADR-0023](0023-one-workspace-data-model.md) (no `tenant_id`, no row-level security).
- Date: 2026-10-15

## Context

The system is split into seven services (identity, platform, chat, work, home, employee, ai; D6). Services must evolve their schemas independently and must not couple through shared tables. The code base also comes from a multi-tenant design: every row belongs to a tenant, and a single bug in a `WHERE tenant_id = …` clause would leak data between companies. Even in the single-workspace edition ([ADR-0005](0005-single-workspace-self-hosted.md)) the isolation model is kept so that integration tests can prove isolation between two workspaces and the code stays tenant-ready.

## Decision

- One Postgres **database per service** on one Postgres 16 cluster (`infra/local/postgres/init.sql`, `infra/production/postgres/`): `identity`, `platform`, `chat`, `work`, `home`, `employee`, `ai` (+ `keycloak`). No service connects to another service's database; data moves over HTTP with the caller's principal or over Kafka ([ADR-0002](0002-outbox-debezium-kafka.md)).
- Three roles: `workspace_owner` (owns schemas, runs migrations, REPLICATION for CDC), `workspace_app` (`NOBYPASSRLS`, DML only, used by services through PgBouncer), `workspace_maintenance` (`NOLOGIN BYPASSRLS`, owns `SECURITY DEFINER` functions for cross-tenant jobs such as `ai_prune_expired`).
- Every tenant table: `ENABLE` + `FORCE ROW LEVEL SECURITY` with policy `tenant_id = nullif(current_setting('app.tenant_id', true), '')` for `USING` and `WITH CHECK` (`backend/packages/shared/src/db/rls.ts`, `migrations/*_rls.sql`).
- All tenant access goes through `withTenant()` (`backend/packages/shared/src/db/with-tenant.ts`): `BEGIN; set_config('app.tenant_id', $1, true)`, so the setting is transaction-local and safe under PgBouncer transaction pooling. No context ⇒ zero rows (fail closed).
- Migrations are forward-only SQL per service, applied by the owner role at service start and by `tooling/scripts/migrate-all.mjs`.

## Consequences

- A missing tenant filter in application code cannot leak data; isolation is tested in `backend/packages/shared/test/with-tenant.test.ts` via PgBouncer.
- Cross-service joins are impossible; read models (home projector, employee master data, search) are built from events, which adds eventual consistency.
- Cross-tenant maintenance must be written as audited `SECURITY DEFINER` functions; ad-hoc admin SQL as `workspace_owner` sees nothing on FORCE-RLS tables (use the superuser or set `app.tenant_id`).
- One cluster keeps operations simple (one backup, one `pg_dumpall`), at the cost of shared failure and capacity; splitting to separate clusters later needs only connection-string changes.
- Schema details: [docs/database/README.md](../database/README.md).
