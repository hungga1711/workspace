# ADR-0005: Single-workspace self-hosted edition

- Status: Accepted (amended by [ADR-0023](0023-one-workspace-data-model.md): no workspace column or row-level security in the data model)
- Date: 2026-10-15

## Context

workspace is an open-source (MIT since [ADR-0019](0019-license-mit.md); Elastic License 2.0 when this was recorded) clone of a multi-tenant SaaS. Companies that self-host want one installation for their company, with no public sign-up, billing, plans or platform administration. Rewriting the internals as single-tenant would discard the isolation model and its tests.

## Decision

- **One installation = one workspace.** First-run setup at `/setup` creates it; afterwards `/setup` redirects to `/login` (`frontend/web/src/app/(auth)/setup/page.tsx`) and `POST /signup` is refused by platform-service once a workspace exists (`backend/services/platform/src/platform.controller.ts`). The gateway rate-limits signup per IP.
- ~~Internals stay multi-tenant: `tenant_id` everywhere and RLS.~~ Removed by [ADR-0023](0023-one-workspace-data-model.md) (2026-10-28).
- No multi-workspace code (2026-10-28): the `MULTI_WORKSPACE` test switch, the `x-workspace-id` selector, the `wos_ws` cookie and `/api/me/workspaces` are gone. The gateway looks the one workspace up itself; the workspace table holds one row (ADR-0023); offboarding always signs the person out.
- Tests run on their own installation, database `workspace_test` (`tooling/scripts/test-db.mjs`); a suite that needs first-run setup empties it first. Run against the development database, the old switch had left ~1,900 test workspaces beside the company's. Tests that proved isolation between two workspaces through the API are gone; row-level security is still tested directly (`backend/packages/shared/test`).
- Public marketing site, billing, plan pages and platform admin UI are removed from the web app; every module is included.

## Consequences

- Simple mental model and install: one company, one URL, one `.env`.
- The plan machinery is gone (2026-10-15): no `plans` table or plan columns, seat limit, meeting-length cap or Drive quota. What stays is configuration: the admin's module switches (attendance, custom workflow), which the gateway enforces on writes (`requiredFeature`, `MODULE_WRITES`).
- The tenant layer itself is gone too ([ADR-0023](0023-one-workspace-data-model.md)).
- Hosting several companies means several installations.
