# ADR-0023: One workspace in the data model: no workspace column, no row-level security

- Status: Accepted
- Date: 2026-10-28
- Supersedes: the row-level security part of [ADR-0001](0001-database-per-service-rls.md); amends [ADR-0005](0005-single-workspace-self-hosted.md)

## Context

[ADR-0005](0005-single-workspace-self-hosted.md) made an installation hold one workspace but kept the multi-tenant
internals of the SaaS this code came from: `tenant_id` on every table, forced row-level security, a tenant context
on every request and event, and test switches that let suites create many workspaces. That machinery protected
nothing a single installation has (there is no second company to leak to), cost a transaction and a `set_config`
on every query, made SECURITY DEFINER functions necessary for every job that reads more than one row, and kept the
"several workspaces" idea alive: development databases ended up with ~1,900 test workspaces next to the
company's, and the code still carried workspace selectors and per-workspace caches.

## Decision

- **No workspace column anywhere.** Each module's migrations were squashed into a new `001_baseline.sql` that
  creates tables without `tenant_id`, policies or row-level security (checked against the old chain with
  `pg_dump --schema-only` and the reference data). Tables that held one row per workspace (settings, policies) are
  keyed by `singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton)`; upserts use `ON CONFLICT (singleton)`.
  Platform's workspace row and config are `workspace`/`workspace_config` (one row).
- **No workspace context.** `@workspace/shared` binds only the actor and request id (`runWithContext`,
  `getRequestContext`); `withTransaction` is a plain transaction. Principals, resources, event envelopes, storage
  keys, search documents, caches and internal endpoints carry no workspace id. The scope `TENANT` folded into
  `WORKSPACE`.
- **The gateway knows the workspace.** It reads the installation's state from platform (`GET internal/workspace`)
  and resolves people with identity (`POST internal/resolve { userId }`); clients never name a workspace.
- **Module boundaries stay.** One schema and one login role per module ([ADR-0015](0015-single-database-schema-per-module.md)),
  lint-enforced imports and events between modules are unchanged; authorization stays in the permission and scope
  checks ([shared/src/authz.ts](../../backend/packages/shared/src/authz.ts)).
- **Tests run on their own installation**, database `workspace_test` (`tooling/scripts/test-db.mjs`): each test file
  starts from a freshly migrated, empty database, and suites that go through first-run setup empty it first.

## Consequences

- Queries are plain SQL again; jobs read their tables directly; one less class of bug (a missing tenant filter) and
  one less layer to explain.
- Access control between people inside the company is unchanged (permissions, scopes, ACLs).
- Hosting several companies means several installations, as ADR-0005 already said; the code no longer pretends
  otherwise.
- Existing databases were wiped when this landed (2026-10-28): the new baselines start a database from scratch.
