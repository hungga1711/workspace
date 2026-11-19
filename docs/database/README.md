# Database design

How workspace stores data. Everything here is taken from the migrations
(`backend/server/migrations/<module>/*.sql`), the role bootstrap
(`infra/local/postgres/init.sql`, `infra/production/postgres/init.sh`), and the shared data-access code
(`backend/packages/shared`, `backend/packages/service-kit`). One database, `workspace`, holds one schema per
module; the per-schema pages list every table:

| Schema | Owning module | Main aggregates | Page |
|---|---|---|---|
| `identity` | identity `backend/server/src/modules/identity` | members, roles and grants, teams, AI agents, API keys, sign-in, MCP OAuth, SMTP settings, audit log | [identity.md](identity.md) |
| `platform` | platform `backend/server/src/modules/platform` | the workspace row, its config and logo, master data, webhooks, audit trail, browser errors, demo clock | [platform.md](platform.md) |
| `work` | work `backend/server/src/modules/work` | projects and boards, tasks, documents and spaces, Drive, calendar and meetings, approvals, goals (OKR) | [work.md](work.md) |
| `chat` | chat `backend/server/src/modules/chat` | channels, messages (threads, reactions, pins), attachments, polls, scheduled messages | [chat.md](chat.md) |
| `employee` | employee `backend/server/src/modules/employee` | employees and departments, compensation, attendance, leave, announcements | [employee.md](employee.md) |
| `home` | home `backend/server/src/modules/home` | per-user read model (Needs You items, activity feed), notifications, push, reminders, user preferences | [home.md](home.md) |
| `ai` | ai `backend/server/src/modules/ai` | AI quota and usage, tool-call audit, AI activity (conversations), AI policy, provider connections | [ai.md](ai.md) |
| `search` | search `backend/server/src/modules/search` | unified search: a derived, rebuildable copy of searchable rows and AI passages (full-text, typo correction) | [search.md](search.md) |
| `web` | the web app `frontend/web/src/lib/session.ts` (migrations in `backend/server/migrations/web/`) | server-side sign-in sessions (`sessions`, `refresh_locks`); only `workspace_web` reaches it | [below](#the-web-schema) |

## 1. One database, a schema per module

- **One Postgres server, one database (`workspace`), one schema per module**: `identity`, `platform`, `chat`,
  `work`, `home`, `employee`, `ai`, `search`, plus `web` for the web app's sessions ([ADR-0015](../adr/0015-single-database-schema-per-module.md)). The
  migrations create the schemas; `public` holds only the extensions (`unaccent`, `pg_trgm`, `fuzzystrmatch`) and
  only the owner may create there.
- **Modules never touch each other's schema.** Each module has its own login role that can use its own schema
  only (below), so a query against another module's table fails with `permission denied`. Modules share data
  through events (outbox → in-process delivery) and each other's internal APIs (called in memory); there are **no foreign keys across schemas**.
  Columns such as `user_id`, `project_id` (in chat), `channel_id` (in work) or `department_id` (in identity) are
  references by value to another module's rows. One deliberate exception: chat's search endpoint may read the
  `search` schema (documents and two lookup functions) through `workspace_search_reader`.
- Production runs `postgres:16.4-alpine` with `max_connections=200` (`infra/production/docker-compose.yml`), and
  `jit = off` on the database (`platform/006_no_jit.sql`; applied only where `workspace_owner` owns the database). No
  logical replication: each module delivers its own outbox ([ADR-0021](../adr/0021-one-server-no-valkey.md)).

### The `web` schema

The web app's session store (`backend/server/migrations/web/001_baseline.sql`, migrated by `backend/server/src/main.ts`
before the modules start, and last by `migrate`). Code: `frontend/web/src/lib/session.ts`, pool of 5 as
`workspace_web` (`WEB_DATABASE_URL`). Only `workspace_web_rw` has `USAGE` on it; no outbox, no definer functions.

| Table | Columns | Notes |
|---|---|---|
| `sessions` | `key` text PK, `data` jsonb NOT NULL, `expires_at` timestamptz NOT NULL | `key` is `websess:` + SHA-256 of `SESSION_SECRET:<cookie id>`, so a dump yields no usable cookie. `data` holds the session as JSON, including the identity access and refresh tokens. Idle lifetime 7 days (`SESSION_IDLE_SECONDS`); expired rows are deleted by about 1 % of writes. Index `sessions_expires_idx (expires_at)` |
| `refresh_locks` | `key` text PK, `until` timestamptz NOT NULL | One token refresh per session at a time: whoever inserts the row refreshes; a lock past `until` (10 s) is taken over; deleted after the refresh |

### Roles

| Role | Attributes | Used for |
|---|---|---|
| `workspace_owner` | `LOGIN`; owns every schema and every object except the `workspace_maintenance` definer functions (it also owns `platform.demo_refresh()`); owns the database in production (`init.sh`), not in local development (created by `postgres`); member of `workspace_maintenance` | Runs migrations (`OWNER_DATABASE_URL` / `MIGRATE_DATABASE_URL`), each relay's `LISTEN` connection, the job-lock connection (`useJobLocks`), the dead-letter prune and replay connections and the `dlq` tool (the last three as `workspace_maintenance`). |
| `workspace_<m>_rw` | `NOLOGIN`, one per module | Holds everything module `<m>` may do: `USAGE` on schema `<m>` and the table/function grants written in its baseline; tables added later get `SELECT, INSERT, UPDATE, DELETE` through `ALTER DEFAULT PRIVILEGES` (end of each baseline). |
| `workspace_<m>` | `LOGIN`, member of `workspace_<m>_rw` only; `search_path = <m>, public` | What the server connects as for module `<m>` (`<M>_DATABASE_URL`, e.g. `WORK_DATABASE_URL`; the web app as `workspace_web`, `WEB_DATABASE_URL`). Unqualified names resolve in its own schema. The server opens one pool per module role. |
| `workspace_search_reader` | `NOLOGIN`; granted to `workspace_chat` | `USAGE` on `search`, `SELECT` on `search_documents` and `search_passages`, `EXECUTE` on `search_candidates` / `search_query_words`. |
| `workspace_maintenance` | `NOLOGIN`; `USAGE, CREATE` on each module schema (not `web`) | Owns the narrow `SECURITY DEFINER` functions that do what the module role may not (section 6), with the table grants they need; reads and replays `dead_events`. Nobody connects as it. |

Bootstrap: `infra/local/postgres/init.sql` (dev password `app_pw` for every module role, `owner_pw` for the owner;
the database itself comes from `POSTGRES_DB=workspace`) and `infra/production/postgres/init.sh` (creates `workspace`
owned by `workspace_owner`; `PG_OWNER_PASSWORD`, and one `PG_APP_PASSWORD` shared by every module role). The image
copies `init.sh` to `/app/infra/bootstrap/postgres-init.sh` for the one-click templates (`infra/docker/Dockerfile`).
It only runs on an empty data directory (docker-entrypoint-initdb.d). Development also has `workspace_app`
(password `app_pw`), used only by the shared package's tests in schema `public`.

### Connections and PgBouncer (optional)

The server connects **directly** to Postgres with one small pool per module, at most 100 connections
(identity 10, platform 10, chat 15 + 10 for search, work 15, home 10, employee 10, ai 10, search 10; `max` in each
module's `app.ts` / `start.ts`, `searchPool()` defaults to 10), plus one `LISTEN` connection per outbox relay (six:
identity, platform, chat, work, employee, ai), one job-lock connection, a two-connection owner pool for dead-letter
replays (`service-kit/src/dead-letters.ts`) and short-lived owner connections for migrations and the daily
dead-letter prune; the web app's session pool adds 5. That is well under `max_connections=200`.

For a database shared with other tools, or a managed Postgres with few connections, start the optional pooler (`--profile pgbouncer`, `infra/production/pgbouncer/pgbouncer.ini`:
`pool_mode = transaction`, `max_client_conn = 500`, `default_pool_size = 10`) and point the pools at it
(`PG_HOST=pgbouncer`, `PG_PORT=6432`; also `reserve_pool_size = 5`, `server_idle_timeout = 300`; the auth file is
written from `PG_OWNER_PASSWORD` / `PG_APP_PASSWORD` at container start). Development has its own
`infra/local/pgbouncer/` (`max_client_conn = 200`, `default_pool_size = 5`, a checked-in `userlist.txt` with the dev
passwords). Server connections are kept per role, so each module role's `search_path`
still applies. Migrations, `LISTEN` and job locks always connect to `postgres:5432` directly.

Either way **no session state may outlive a transaction** (a pooler hands the connection to another client
after it): the modules never `SET` anything outside a transaction.

## 2. One workspace

An installation holds exactly one workspace ([ADR-0005](../adr/0005-single-workspace-self-hosted.md)), and the
data model says so ([ADR-0023](../adr/0023-one-workspace-data-model.md)): no table has a workspace column, no table has
row-level security, and no request or event carries a workspace id. Keys are the entity's own (`PRIMARY KEY (id)`,
`UNIQUE (code)`, `UNIQUE (dm_key)`); foreign keys inside a schema point at those keys.

### One row per installation: `singleton`

Settings that exist once (platform's `workspace`, `workspace_config`, `workspace_logo` and `demo_clock`, each
module's `workspace_settings`, ai's `ai_policy` and `ai_report_settings`, employee's `employee_settings`) are keyed by

```sql
singleton boolean NOT NULL DEFAULT true CHECK (singleton) PRIMARY KEY
```

so the table can hold one row at most (written as `singleton boolean DEFAULT true NOT NULL`, a
`CHECK (singleton)` constraint and `PRIMARY KEY (singleton)`). The one exception is identity's `mail_settings`, keyed by
`id smallint DEFAULT 1 CHECK (id = 1)`. Writes are upserts on that key:
`INSERT … ON CONFLICT (singleton) DO UPDATE …`; reads are `SELECT … FROM workspace_settings` (zero or one row).

### Transactions and request context (code path)

1. **Request boundary.** `runWithContext({ actorId, requestId }, fn)` binds who is acting and for which request in
   an `AsyncLocalStorage` (`backend/packages/shared/src/context.ts`); audit rows and log lines read it
   (`getRequestContext()`). The principal middleware does it for every module request, consumers for every event.
2. **Writes that belong together** run in `withTransaction(pool, fn)` (`backend/packages/shared/src/transaction.ts`):
   `BEGIN`, `fn(client)`, `COMMIT` (`ROLLBACK` on error), so business rows and their outbox event commit together.
   Single reads may use `pool.query` directly.
3. **Event consumers**: `startConsumer()` runs each event in `runWithContext` with the event's actor and request id,
   inside `withTransaction` together with its dedupe row (`backend/packages/service-kit/src/events.ts`).

Access between people inside the company is decided by permissions and scopes (`authorize()`,
`backend/packages/shared/src/authz.ts`), checked in each module; the database roles keep the modules apart.

A rule that allows one row of a kind per installation (one default AI connection) is a unique index on `(true)`
with that kind's `WHERE` (`ai_connections_default_idx`).

## 3. Migrations

Mechanism: `migrate(ownerUrl, dir, schema)` in `backend/packages/service-kit/src/migrate.ts`.

- Connects as **`workspace_owner`** (directly, never through a pooler), creates the schema if missing and sets
  `search_path = <schema>, public, pg_temp`, so migration files use unqualified names and work under any
  schema name (the event-pipeline test applies ai's files to a schema of its own).
- Keeps `<schema>.schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`.
- Lists `*.sql` in the module's `migrations/` folder, **sorted by file name**, skips names already applied, and
  runs each remaining file **in its own transaction** together with its `schema_migrations` row. A failure
  rolls that file back and stops; earlier files stay applied.
- Who runs it: each module on start (`backend/server/src/modules/<module>/start.ts`), and `migrate`
  (`tooling/scripts/migrate-all.mjs`; the image's `app` command runs it before starting), which applies every schema
  in order identity, platform, search, chat, home, work, employee, ai, web.
- Migrations are forward-only; there are no down migrations.

**Baselines.** Each module starts from `001_baseline.sql`, squashed from the pre-release migrations (ADR-0015, and
again on 2026-10-28 for ADR-0023). A baseline is grouped by kind: schema access, functions, tables (primary keys and
unique constraints inline), sequences, foreign keys, indexes, views, triggers, grants, definer ownership, reference
data (platform's master data), then the default privileges for later files. Each squash was checked by comparing
`pg_dump --schema-only` of the old chain and the new baseline, and the reference data row by row. `web` has a single
`001_baseline.sql` with no maintenance role or definer functions.

Conventions for new files (`002_*.sql`, …):

- **Naming:** `NNN_short_name.sql`, three digits so lexical order = numeric order. The runner keys on the whole file
  name, so two files with the same number run in name order (existing pairs: `ai/008_demo_data.sql` /
  `ai/008_prompt_library_original.sql`, `work/007_board_column_status.sql` / `work/007_doc_drafts.sql`); do not add
  more.
- **Idempotent DDL** where possible: `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`,
  `CREATE INDEX IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`,
  `DROP CONSTRAINT IF EXISTS` before re-adding a widened `CHECK`. Never schema-qualify the module's own objects.
- **New tables** get their grants from the default privileges, narrow them with
  `REVOKE` when the role must not update or delete (e.g. `dead_events`: insert only). A table with one row per
  installation gets the `singleton` key (section 2).
- **Widening a status enum** is done with `CHECK` constraints, never Postgres enum types.
- **Backfills** are plain `UPDATE` / `INSERT … SELECT` statements in the migration.
- **SECURITY DEFINER** functions: `SET search_path FROM CURRENT` (pins `<schema>, public, pg_temp`),
  `ALTER FUNCTION … OWNER TO workspace_maintenance`, `REVOKE ALL … FROM PUBLIC`, `GRANT EXECUTE … TO
  workspace_<m>_rw` (section 6).

## 4. Outbox and idempotent consumers

### `outbox` (identity, platform, chat, work, home, employee, ai)

Shape (`backend/packages/shared/src/outbox.ts`; table, relay columns and functions in each baseline):

| Column | Type | Meaning |
|---|---|---|
| `id` | text PK | Event id (`eventId` of the envelope) |
| `aggregatetype` | text NOT NULL | Routes the event: topic `workspace.<aggregatetype>` |
| `aggregateid` | text NOT NULL | The entity the event is about |
| `type` | text NOT NULL | Event type (e.g. `chat.message.created.v1`) |
| `payload` | jsonb NOT NULL | The whole validated event envelope |
| `created_at` | timestamptz NOT NULL DEFAULT now() | Commit order for the relay; retention clock |
| `published_at` | timestamptz NULL | Set once every consumer group handled (or dead-lettered) the row |

Indexes: `outbox_unpublished_idx (created_at) WHERE published_at IS NULL`, `outbox_created_idx (created_at)`.
`search` and `web` have no outbox. Six modules start a relay (`startEvents`); home has the table and functions but
writes no events and starts no relay.

`appendToOutbox(client, event)` (`outbox.ts`) validates the event against the registry in `@workspace/contracts`
and the envelope (requires a request id), `INSERT`s
the row **in the caller's transaction**; a statement trigger (`outbox_notify`) sends `NOTIFY workspace_outbox_<schema>` (each module's relay listens on its own channel),
delivered on commit, so a rolled-back transaction emits nothing. The module's relay (service-kit `startEvents`)
claims and marks rows through `SECURITY DEFINER` functions owned by `workspace_maintenance`:
`outbox_claim(lim, skip)` (oldest unpublished rows, `FOR UPDATE SKIP LOCKED`), `outbox_mark_published(ids)`,
`outbox_prune(keep_days, lim)` (published rows older than `EVENT_RETENTION_DAYS`, default 3; unpublished rows
stay) and `outbox_waiting()`. The kept rows are the copy events are replayed from (`dlq outbox-replay`).

### `dead_events` (every consuming schema: the seven above and `search`)

Events a consumer group gave up on (created by each schema's `001_baseline.sql`): `id` bigint identity PK, `consumer`, `stream`, `entry_id` (unique together), `event_id`,
`event_type` (both nullable: a malformed entry has none), `reason`, `event` (raw envelope),
`failed_at`, `replayed_at`, `replay_requested_at`. The app role may only `INSERT`; the `dlq` tool reads rows and requests replays, and the server performs them
(`service-kit/src/dead-letters.ts`; the tool is `service-kit/src/ops/dlq.ts`, `pnpm ops:dlq`), both as
`workspace_maintenance`. Indexes `dead_events_waiting_idx (failed_at) WHERE replayed_at IS NULL` and
`dead_events_replay_requested_idx (id) WHERE replay_requested_at IS NOT NULL AND replayed_at IS NULL`.

### `processed_events` (consumer dedupe)

| Column | Type | Meaning |
|---|---|---|
| `consumer` | text | Consumer group id |
| `event_id` | text | Event id |
| `processed_at` | timestamptz NOT NULL DEFAULT now() | When handled |

PK `(consumer, event_id)` (each consuming schema's baseline; not in `search`, whose indexer is idempotent by key). `startConsumer()` inserts
`ON CONFLICT DO NOTHING` **in the same transaction as the handler**; zero rows inserted means a duplicate
delivery and the handler is skipped. Failures retry with backoff and then go to `dead_events`.

Pruning: each consuming schema has `prune_processed_events(keep_days, lim)` (SECURITY DEFINER, owned by
`workspace_maintenance`; index `processed_events_processed_at_idx (processed_at)` everywhere except identity). Every consuming
module calls it daily in batches (`scheduleProcessedEventsPrune`), keeping `PROCESSED_EVENTS_RETENTION_DAYS`
(default 30); the function never keeps less than 8 days, longer than any redelivery or replay window.

## 5. Ids, codes and time

- **Ids are ULIDs** stored as `text`: `newId()` uses a monotonic ULID factory
  (`backend/packages/shared/src/ids.ts:3-10`); `isUlid()` checks `^[0-9A-HJKMNP-TV-Z]{26}$`. ULIDs sort by
  creation time, so `id` keys are roughly time-ordered.
- **User ids** are `identity.users.id` (ULIDs), carried as text in
  every module. Agent principals appear as `agent:...` (`chat.known_members`).
- **Human-readable codes** (`T-001`, `P-001`, `D-001`, employee codes) are never primary keys
  (`ids.ts:7`). They come from transactional counters: `work.code_counters (entity, period)` and
  `employee.code_counters (entity)`, with formats from the workspace config (`work.workspace_settings.code_formats`).
- **Timestamps** are `timestamptz` everywhere, defaulting to `now()`; columns are named `*_at`. Calendar-day
  facts use `date` (`attendance.day`, `leave_requests.start_date`, `holidays.day`, `goals.starts_on`,
  `user_prefs.last_push_date`).
- **Time zone.** Postgres stores UTC instants; "today" is computed in the workspace's zone, set in Admin › Cài đặt
  (platform `workspace_config.config.timezone`, default `Asia/Ho_Chi_Minh` = `DEFAULT_TIME_ZONE` in
  `@workspace/shared`):
  - projected per module from platform events: `workspace_settings` in chat, home, employee, ai and work
    (`projectWorkspaceTimeZone`, read with `WORKSPACE_TZ_SQL` / `workspaceTimeZone()`);
  - per person in `home.user_prefs.timezone`, NULL = follow the workspace; the job functions
    (`digest_candidates`, `push_candidates`, `due_reminders`) resolve person → workspace → default;
  - the web formats every date in the same zone (`frontend/web/src/lib/timezone.ts`, from the public `GET /api/setup`).
- **Money** is integer VND (`*_vnd bigint|integer`) or `numeric(14,2)` with a currency code
  (`employee.compensation`).

## 6. SECURITY DEFINER functions

A module role holds only the rights its code needs: it may insert into `dead_events` but not delete, may not
delete audit rows, and so on. Where a job must do more than that (prune, claim and mark the outbox), it gets one
narrow SQL function:

- `LANGUAGE sql|plpgsql SECURITY DEFINER SET search_path FROM CURRENT` (pinned to `<schema>, public, pg_temp`:
  the module's own schema first, temporary objects last so they can never shadow a table);
- `OWNER TO workspace_maintenance` (which has only the table grants those functions need);
- `REVOKE ALL ... FROM PUBLIC; GRANT EXECUTE ... TO workspace_<m>_rw` (other roles cannot reach the schema anyway).

| Schema | Function | Purpose |
|---|---|---|
| identity, platform, chat, work, home, employee, ai | `outbox_claim(lim, skip)`, `outbox_mark_published(ids)`, `outbox_prune(keep_days, lim)`, `outbox_waiting()`, `prune_processed_events(keep_days, lim)` | The relay and the dedupe ledger (section 4) |
| identity | `revoke_personal_api_keys(uid)` | Revoke a person's personal API keys when their sign-ins are ended for them (password reset, sign out everywhere, disabling) |
| platform | `claim_webhook_deliveries(lim)` | Lease due deliveries for 2 minutes (`FOR UPDATE SKIP LOCKED`), returning their ids |
| platform | `audit_log_prune(days, lim)` | **Deletes** audit entries older than `AUDIT_LOG_RETENTION_DAYS` (default 730) |
| platform | `audit_trail_prune(days, lim)` | **Deletes** audit trail rows older than `AUDIT_TRAIL_RETENTION_DAYS` (default 365); the module role may only insert and read the trail |
| platform | `webhook_deliveries_prune(days, lim)` | **Deletes** settled deliveries older than `WEBHOOK_DELIVERIES_RETENTION_DAYS` (30), keeping each webhook's newest |
| work | `work_activity_prune(days, lim)` | Task and document history past retention |
| chat | `chat_collab_prune(lim)`, `chat_link_previews_prune(lim)` | Stale collaborative drafts and link previews |
| home | `home_notifications_prune(…)`, `home_items_prune(…)`, `home_activity_prune(…)`, `home_push_recent_prune(…)` | Inbox and feed retention (section 7) |
| ai | `ai_prune_expired(lim)` | **Deletes** AI conversations (and hourly prompt counts) past `ai_policy.retention_days` |
| ai | `ai_prune_views(…)`, `ai_prune_safety(…)`, `ai_prune_audit(…)` | AI side-table retention |
| search | `search_candidates(q, containers, reader, types, lim)`, `search_query_words(query)` | Search for chat's role, which may not read `search_terms` (search.md) |

One definer function breaks the pattern: `platform.demo_refresh()` (`platform/004_demo_clock.sql`) is owned by
`workspace_owner`, pins `search_path = pg_catalog`, writes tables in every module schema and is executable by
`workspace_platform_rw` ([platform.md](platform.md#demo_clock)). The trigger function `outbox_notify()` in each outbox
schema is plain.

Plain (non-definer) helpers run as the module role: work's `work_column_for()`, the trigger functions
`work_task_column_sync()` and `projects_task_counts()`, and home's job queries `push_candidates`,
`digest_candidates`, `claim_instant_pushes`, `due_reminders`, `due_personal_reminders`. API key, meeting code, calendar feed and extension token lookups and the "due" queues of work
and chat are plain queries in the code, on the module's own tables.

## 7. Retention and cleanup

| What | How | Where |
|---|---|---|
| AI conversations (+ messages by cascade) | `ai_prune_expired(5000)` hourly; deletes conversations whose `last_at` is older than `ai_policy.retention_days` (default 180, allowed 7–730), and hourly prompt counts of the same age | `ai_prune_expired()`, `backend/server/src/modules/ai/start.ts` |
| AI side tables | Content views, safety events and the agent audit older than `AI_VIEWS_RETENTION_DAYS`, `AI_SAFETY_RETENTION_DAYS`, `AI_AUDIT_RETENTION_DAYS` (default 365 each), daily | `ai_prune_views()`, `ai_prune_safety()`, `ai_prune_audit()` |
| Meeting recordings | Those older than `MEET_RECORDING_RETENTION_DAYS` (default 365); the daily job deletes object and row | `backend/server/src/modules/work/rooms.ts` |
| Abandoned uploads | `files` / `chat_files` rows are created `pending` at presign time with `expires_at`; sweepers delete expired ones with their objects | work `files.ts`, chat `files.ts` |
| Instant pushes | Claimed rows are deleted; rows older than 30 minutes are dropped unsent | `claim_instant_pushes()` |
| Outbox | Published rows older than `EVENT_RETENTION_DAYS` (default 3) are deleted hourly; unpublished rows stay | `outbox_prune()`, service-kit `outbox-relay.ts` |
| Processed-event ledger | Rows older than `PROCESSED_EVENTS_RETENTION_DAYS` (default 30, never under 8) deleted daily | `prune_processed_events()` |
| Dead letters | Older than `DEAD_EVENTS_RETENTION_DAYS` (default 90), daily, as `workspace_maintenance` on an owner connection; scheduled by the outbox relay, so only in the six schemas that run one (not home or search) | service-kit `jobs.ts` (`scheduleDeadEventsPrune`, from `outbox-relay.ts`) |
| Admin audit log, audit trail, webhook deliveries, browser errors | `AUDIT_LOG_RETENTION_DAYS` (default 730), `AUDIT_TRAIL_RETENTION_DAYS` (default 365), `WEBHOOK_DELIVERIES_RETENTION_DAYS` (default 30; each webhook keeps its newest delivery), `CLIENT_ERRORS_RETENTION_DAYS` (default 30), daily | `audit_log_prune()`, `audit_trail_prune()`, `webhook_deliveries_prune()`, `pruneClientErrors()`, `backend/server/src/modules/platform/retention.ts` |
| Sign-in and MCP | Every 6 h: sign-in events (90 days), spent challenges, sessions and refresh tokens, OAuth codes, tokens, revoked grants (90 days) and unused clients (30 days), MCP call log (180 days) | `auth-prune` in `backend/server/src/modules/identity/start.ts` (`auth/sessions.ts`, `oauth-store.ts`) |
| Web sessions | Expired rows deleted by about 1 % of session writes | `frontend/web/src/lib/session.ts` |
| Home inbox and feed | Read / unread notifications (90 / 180 days), Home items (180), activity (365), recent pushes (30); `*_RETENTION_DAYS` overrides, daily | `home_notifications_prune()`, `home_items_prune()`, `home_activity_prune()`, `home_push_recent_prune()`, `backend/server/src/modules/home/retention.ts` |
| Task and document history | `TASK_ACTIVITY_RETENTION_DAYS` (default 365), daily | `work_activity_prune()` |

`ai_usage` (cost history), identity's `audit_log` and platform's `client_error_groups` are not pruned.

## 8. Indexing conventions

- Primary keys are the entity's id; secondary indexes follow the access path, e.g. `tasks (assignee_id, status,
  due_at)`, `messages (channel_id, seq DESC)`.
- **Partial indexes** for queues and sparse states: `files (expires_at) WHERE status = 'pending'`,
  `scheduled_messages (send_at) WHERE sent_at IS NULL`, `webhook_deliveries (next_attempt_at) WHERE status =
  'pending'`, `home_items (...) WHERE resolved_at IS NULL`.
- **Partial unique indexes** for "at most one": `meeting_rooms (event_id) WHERE event_id IS NOT NULL`,
  `ai_connections ((true)) WHERE is_default`, `channels (lower(name)) WHERE kind IN ('public','private')`.
- **GIN** on arrays: `messages.mentions`, `documents.labels`.
- **Expression indexes** on JSON: `tasks ((source->>'eventId')) WHERE source->>'type' = 'meeting'`.
- Secret tokens are stored as hashes, unique or primary key (`api_keys.key_hash`,
  `calendar_feeds.token_hash`, `ai_monitor_tokens.token_hash`, `account_tokens.token_hash`, `oauth_tokens.token_hash`).
- Many references inside a schema are **not** declared as foreign keys (e.g. `tasks.parent_id`,
  `documents.project_id`, `approvals.template_id`, `meeting_guests.room_id`); the module code keeps them
  consistent. The per-module pages say which relations are enforced.
- **Lookup indexes** for the common access paths are in the baselines, e.g. work `task_comments (task_id, created_at)`, `tasks (parent_id)`,
  `calendar_events (starts_at)`, `approvals (requester_id, status)`; employee
  `leave_requests (user_id)`, `employees (department_id)`; identity `member_roles (role_id)`;
  home `push_subscriptions (user_id)`; ai `ai_content_views (user_id, at)`, `ai_audit (at)`.
  When you add a query that filters by a column, add the index in the same pull request.

## 9. Backups and restore

Details: [backup and restore runbook](../runbooks/backup-restore.md) and [operations runbook](../runbooks/operations.md).

- State lives in Docker volumes: `pgdata` (the `workspace` database with every schema, the rebuildable `search`
  schema and the web sessions included), `data` (files on local disk) or `s3data` (bundled S3), `secrets` (secrets
  the `init` job generated), plus `infra/production/.env`.
- `infra/production/backup.sh` (nightly from cron) writes `db.dump` (`pg_dump -Fc` of `workspace`), `files.tgz`
  (the `data` volume, or the bundled S3 data), `.env` and the generated secrets; keep copies off the server. Your
  own S3/R2 bucket is mirrored with that provider's tools. A custom-format dump can also restore one module:
  `pg_restore -n <schema>`. Roles are not in the dump: `postgres/init.sh` recreates them on an empty data directory.
- `infra/production/restore.sh <backup dir>` restores onto empty volumes. Events published since the dump are
  replayed per consumer group from the outboxes if needed (`dlq outbox-replay`); the search index is rebuilt with
  `reindex`.
- Before an upgrade take a backup; the `app` container runs the migrations before it starts the server.

There is no WAL archiving / point-in-time recovery configured; recovery point = last dump.

## 10. Diagrams

One ER diagram per schema; each page ends with the list of tables it should show.
