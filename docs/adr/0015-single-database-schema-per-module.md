# ADR-0015: One database, a schema and a role per module (supersedes the database-per-service part of ADR-0001)

- Status: Accepted
- Date: 2026-10-15
- Supersedes: the "one database per service" decision of [ADR-0001](0001-database-per-service-rls.md); its
  row-level security model stayed until [ADR-0023](0023-one-workspace-data-model.md) removed it (2026-10-28).
- Amended by: [ADR-0023](0023-one-workspace-data-model.md) (no `tenant_id`, no row-level security; schemas and roles stay).

## Context

workspace ran eight Postgres databases on one server (identity, platform, chat, work, home, employee, ai, search)
behind PgBouncer. For a self-hosted product meant to run on a 2–4 GB server this cost more than it gave:

- every database has its own catalog, autovacuum workers and connection pools (each pool is per database and
  role), and PgBouncer was required to keep the connection count down;
- backups, restores, role changes and monitoring had to be repeated eight times;
- 139 migration files (some fixing earlier ones) had to be replayed on every fresh install, though nothing had
  been released yet.

What the separate databases bought was isolation: a service could not read another service's tables. That is
what must be kept. The services are also about to be grouped into four processes (core, work, realtime, ai), so
one process will host several modules.

## Decision

- **One database, `workspace`; one schema per module**: `identity`, `platform`, `chat`, `work`, `home`,
  `employee`, `ai`, `search`. `public` holds only the extensions and only the owner may create there.
- **One login role per module** (`workspace_<m>`, `NOBYPASSRLS`, `search_path = <m>, public`) whose only
  privileges come from its access role `workspace_<m>_rw` (`USAGE` on schema `<m>` plus the grants written in
  the module's migrations). Isolation between modules is now enforced by privileges: a module reading another
  module's table gets `permission denied`. A service that hosts several modules opens one pool per module role;
  modules never share a role, so merging services changes connection strings, not grants.
- The only cross-module grant is `workspace_search_reader` (held by `workspace_chat`): `SELECT` on
  `search.search_documents` under RLS and `EXECUTE` on the two search lookup functions.
- `workspace_owner` runs migrations and owns everything except the cross-tenant `SECURITY DEFINER` functions,
  which belong to `workspace_maintenance` (`BYPASSRLS`, `NOLOGIN`) as before. Those functions now pin
  `search_path = <schema>, public, pg_temp` (`SET search_path FROM CURRENT`): `pg_temp` last closes the
  temporary-table shadowing that the old `SET search_path = public` left open.
- Row-level security is unchanged: `tenant_id` on every tenant table, `ENABLE` + `FORCE`, `withTenant()`.
- **Migrations squashed into one baseline per schema** (`<module>/migrations/001_baseline.sql`), generated from
  the final schemas and cleaned into sections. The migration runner takes the schema
  (`migrate(url, dir, schema)`), creates it, records applied files in `<schema>.schema_migrations` and runs files
  with `search_path = <schema>, public, pg_temp`, so a baseline works under any schema name.
- Names that were per database become per schema: the outbox wake-up channel is `workspace_outbox_<schema>`,
  job advisory locks are named `workspace.job:<schema>:<job>`, `processed_events`, `dead_events`, `outbox` and
  `schema_migrations` exist in each schema.
- **PgBouncer becomes optional** (`--profile pgbouncer`). Services connect directly with small pools (about
  110 connections for one replica of everything, `max_connections = 200`).

## Verification

A fresh database built from the baselines was compared with databases built from the 139 old migrations:
`pg_dump --schema-only` of each schema, normalized for the schema name and the role names, gives identical
objects (tables, columns, types, defaults, constraints, indexes, policies, grants, functions, triggers, views,
the text search configuration) for all eight schemas. The only differences are intended: the search reader
grants, the definer functions' pinned `search_path`, the per-schema `NOTIFY` channel, and one comment inside
`prune_processed_events`. Platform's reference data (33 master-data rows) is identical row for row. Every
backend test suite and the web end-to-end suite pass on the new layout.

## Consequences

- One backup (`pg_dumpall`, or `pg_dump -Fc -d workspace` plus `--roles-only`, from which `pg_restore -n
  <schema>` restores one module), one set of roles, one connection target; fewer idle connections and no
  required pooler.
- Isolation between modules depends on grants instead of database boundaries. A grant to the wrong role in a
  migration would open a module to another; reviews check `GRANT` lines, and the access-role pattern keeps them
  to one role per module.
- Splitting a module into its own database later is still a `pg_dump -n <schema>` and a connection-string change:
  there are no cross-schema foreign keys or joins.
- The pre-baseline migration history lives only in git; the database docs keep citing those file names where
  they explain why something exists.
