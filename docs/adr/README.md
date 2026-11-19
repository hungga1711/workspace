# Architecture Decision Records

Nygard format (Status / Context / Decision / Consequences). One decision per file, numbered, never rewritten: a changed decision gets a new ADR that supersedes the old one. Dates are when the decision was recorded in this repository; several decisions are older. File paths in an ADR are those of the code when it was recorded (before [ADR-0021](0021-one-server-no-valkey.md) the backend lived in `backend/services/<service>/`; modules are now in `backend/server/src/modules/<module>/`). References such as D6 or E1–E8 (cited in code comments) point to earlier, unpublished design notes.

| # | Decision | Status | Date |
|---|---|---|---|
| [0001](0001-database-per-service-rls.md) | Database per service, tenant isolation by Postgres row-level security | Superseded by 0015 and 0023 | 2026-10-15 |
| [0002](0002-outbox-debezium-kafka.md) | Transactional outbox, Debezium CDC and Kafka for events | Superseded by 0012 | 2026-10-15 |
| [0003](0003-bff-gateway-internal-principal-token.md) | Next.js BFF and API gateway with signed internal principal tokens | Accepted | 2026-10-15 |
| [0004](0004-keycloak-identity.md) | Keycloak for identity, sessions and SSO; authorization stays in the app | Superseded by 0014 | 2026-10-15 |
| [0005](0005-single-workspace-self-hosted.md) | Single-workspace self-hosted edition (no multi-workspace code) | Amended by 0023 | 2026-10-15 |
| [0006](0006-optional-ai-company-gateway.md) | AI is optional; company-chosen provider through an admin-configured gateway | Accepted | 2026-10-15 |
| [0007](0007-ai-oversight-extension-transparency.md) | AI oversight via browser extension with policy levels and view log | Amended by 0027 | 2026-10-15 |
| [0008](0008-socketio-realtime-chat-service.md) | Socket.IO realtime inside chat-service with the Redis adapter (on Valkey) | Amended by 0021 | 2026-10-15 |
| [0009](0009-livekit-meetings.md) | LiveKit SFU for video meetings | Amended by 0021 | 2026-10-15 |
| [0010](0010-license-elastic-2.md) | Elastic License 2.0: free to self-host and modify, no selling as a hosted service | Superseded by 0019 | 2026-10-15 |
| [0011](0011-ai-usage-linked-to-work.md) | AI use linked to the work it served, projected into work-service by event | Accepted | 2026-10-15 |
| [0012](0012-valkey-streams-events.md) | Events on Valkey Streams with an in-service outbox relay (no Kafka, no Debezium) | Superseded by 0021 | 2026-10-15 |
| [0013](0013-postgres-full-text-search.md) | Postgres full-text search (unaccent, pg_trgm) instead of Elasticsearch | Amended by 0023 | 2026-10-15 |
| [0014](0014-own-authentication.md) | Own authentication in identity-service: bcrypt, Ed25519 JWT, rotating refresh tokens, TOTP, OIDC SSO (supersedes 0004; SSO removed 2026-11-11) | Accepted | 2026-10-15 |
| [0015](0015-single-database-schema-per-module.md) | One database, a schema and a login role per module; migrations squashed into baselines (supersedes the database-per-service part of 0001) | Amended by 0023 | 2026-10-15 |
| [0016](0016-four-services-hosting-modules.md) | Four services (core, work, realtime, ai) hosting modules; in-process calls between modules of one service | Superseded by 0021 | 2026-10-15 |
| [0017](0017-nginx-and-lean-image.md) | nginx with certbot in front; a lean Alpine image with esbuild-bundled services | Partly superseded by 0021, amended by 0022 | 2026-10-15 |
| [0018](0018-scopes-team-from-project-department-mirrored.md) | TEAM scope comes from the project, DEPARTMENT scope is mirrored from the org chart | Accepted | 2026-10-18 |
| [0019](0019-license-mit.md) | MIT licence (supersedes 0010) | Accepted | 2026-10-25 |
| [0020](0020-ai-insights-principles.md) | AI Insights principles: consent, self-view, no surveillance, audited full text, data stays on the server, off by default | Amended by 0027 | 2026-10-25 |
| [0021](0021-one-server-no-valkey.md) | One server process for every module (boundaries enforced by lint), no Valkey (events in process, state in Postgres or memory), one app container behind Caddy | Accepted | 2026-10-26 |
| [0022](0022-no-opentelemetry.md) | No OpenTelemetry (logs with request ids and the audit log); SMTP everywhere, no local mail catcher | Accepted | 2026-10-27 |
| [0023](0023-one-workspace-data-model.md) | One workspace in the data model: no workspace column, no row-level security | Accepted | 2026-10-28 |
| [0024](0024-whiteboards.md) | Whiteboards: Excalidraw scenes, a Yjs relay for live editing, REST snapshots merged per element | Accepted | 2026-10-28 |
| [0025](0025-audit-trail.md) | One audit trail for the whole workspace, built from events, private content excluded | Accepted | 2026-11-05 |
| [0026](0026-deploy-time-feature-flags.md) | Optional features (docs, whiteboards, calendar, time, AI) are left out at deploy time with `DISABLED_FEATURES`; chat and tasks always on | Accepted | 2026-11-11 |
| [0027](0027-nobody-reads-prompts.md) | Nobody but the person reads their prompts: no `full` policy, no view log; managers see the topic or the AI's one-line summary | Accepted | 2026-11-11 |

Context for all of them: [system design](../architecture/system-design.md).
