# Runbook: production operations

For operators of a self-hosted installation. The install guide is [infra/production/README.md](../../infra/production/README.md) (requirements, DNS, `.env`, first run, HTTPS); this runbook covers day-2 work: deploy, upgrade, backup/restore, secret rotation, health checks, logs and incident fixes. Topology and failure modes: [system design §15–16](../architecture/system-design.md).

> What has been verified on the current layout is in the status note of `infra/production/README.md`. Rehearse every procedure here on a staging copy first.

**Conventions.** All commands run in `infra/production/` (where `docker-compose.yml` and `.env` live). The compose project is `workspace-prod`, so volumes are `workspace-prod_pgdata`, `_data`, `_secrets`, `_s3data`, `_caddydata`, `_caddyconfig`. Optional parts (`s3`, `meet`, `pgbouncer`) are listed in `COMPOSE_PROFILES` in `.env`, so a plain `docker compose up -d` starts them. Tools that need the running server (`dlq`, `reindex`) run inside the app container: `docker compose exec app /app/infra/production/entrypoint.sh <tool> …`.

```bash
cd /path/to/workspace/infra/production
alias dc='docker compose'                     # COMPOSE_PROFILES in .env adds s3 / meet
```

## 1. Deploy (first time)

Install with `install.sh` or by hand as described in [infra/production/README.md](../../infra/production/README.md)
§2–4. Two things operators tend to miss:

- **Set `AI_SECRETS_KEY`** (uncomment it) to its own random value before anyone saves an AI connection: it decouples
  AI-key encryption from `INTERNAL_TOKEN_SECRET`, so either can be rotated later without the other (section 5).
- Never set `TEST_FIXTURES` or `WEBHOOK_ALLOW_PRIVATE` in production.

## 2. Upgrade

`./upgrade.sh <tag>` backs up, pulls, migrates, restarts, waits for a healthy `app` and rolls back to the previous
image on failure. Migrations are forward-only and also run on every start of `app`. Step by step, roll-back and
installations built from source: [upgrade.md](upgrade.md).

If `VAPID_PUBLIC_KEY` changed, a rebuild is required (it is compiled into the web bundle). Changing only `.env` values needs `dc up -d` (compose recreates affected containers), not a rebuild.

## 3. Backup and restore

`./backup.sh /var/backups/workspace` nightly from cron (database, files, `.env` and generated secrets), copies kept
off the server; `./restore.sh <backup dir> --yes` onto empty volumes. What is in a backup, cron, restoring and testing
a restore: [backup-restore.md](backup-restore.md).

Restore caveats an operator should know:

- To restore a single module from a backup's `db.dump`: `pg_restore -U postgres -d workspace -n work --clean db.dump`
  brings back the `work` schema alone.
- Projections (home feed, search, employee master data) reflect the backup only where their own tables were restored
  (they all live in Postgres). Events in the restored outboxes that a group missed can be re-sent with
  `dlq outbox-replay`; `reindex` (section 9.3) makes the `search` schema match the restored data exactly.
- If `.env` was lost, stored AI connection keys cannot be decrypted; admins re-enter them.

## 4. Health checks

| Check | Command | Healthy |
|---|---|---|
| All containers | `docker compose ps` | `healthy` / `exited (0)` for `init` |
| The server | `docker compose exec app wget -qO- http://127.0.0.1:4000/health` (gateway); `:4001/health` lists the modules | `{"ok":true}`, `{"ok":true,"modules":[…]}` |
| Web | `curl -fsI https://<APP_DOMAIN>/robots.txt` | 200 |
| Postgres | `docker compose exec postgres pg_isready -U postgres` | accepting connections |
| Dead letters | `docker compose exec app /app/infra/production/entrypoint.sh dlq list` (exit code 1 when something waits) | `waiting 0` everywhere (section 9.2) |
| AI | Admin › AI connections → Test; `GET /api/ai/status` | `configured: true` if AI is wanted; fallback warning absent |
| Disk | `df -h /var/lib/docker` | < 80 % |

There is no metrics export. Watch the logs instead: `"event dead-lettered"` (then `dlq list`), `"job failed"`, `"idle database connection lost"` and 5xx responses (`"level":50`). Who did what in the workspace is in Admin › Activity log.

## 5. Rotating secrets

Edit `.env`, then `dc up -d` (compose recreates the containers whose environment changed). Consequences per secret:

| Secret | Procedure | Consequence |
|---|---|---|
| `SESSION_SECRET` | edit, `dc up -d` | Session store keys change: **everyone is signed out**. |
| `INTERNAL_TOKEN_SECRET` | edit, `dc up -d` | In-flight internal tokens (≤ 60 s) and realtime tickets fail; sockets reconnect. **If `AI_SECRETS_KEY` is not set, every stored AI connection key becomes undecryptable** (derived via HKDF from this secret): AI falls back to env vendors or the local extractive provider, the connection test shows an error, admins must re-enter keys in Admin › AI connections. Prefer setting `AI_SECRETS_KEY` first, accept a one-time re-entry, and from then on rotate the two independently. |
| `AI_SECRETS_KEY` | edit, `dc up -d app` | **All stored AI keys become unreadable**; re-enter them in Admin › AI connections. No re-encryption tool exists. Rotate only when compromised. |
| Env AI vendor keys (`GEMINI_/ANTHROPIC_/OPENAI_API_KEY`) | rotate at the vendor, edit, `dc up -d app` | none |
| `PG_APP_PASSWORD` / `PG_OWNER_PASSWORD` / `POSTGRES_PASSWORD` | **first** set it on every role it covers: `PG_APP_PASSWORD` is the password of the eight module roles and the web app's (`for m in identity platform chat work home employee ai search web; do docker compose exec postgres psql -U postgres -c "ALTER ROLE workspace_$m PASSWORD '<new>'"; done`), `PG_OWNER_PASSWORD` of `workspace_owner`, `POSTGRES_PASSWORD` of `postgres`; then `.env`, then `dc up -d` (the optional PgBouncer rewrites its userlist at start) | `.env` alone has no effect after first boot. The owner password is also used by each module's outbox relay (`LISTEN`). |
| `AUTH_SECRET` | edit `.env`, `dc up -d app` | Encrypts token signing keys and two-step seeds: a new value signs everyone out (a new signing key is made), and two-step users sign in with a recovery code and set it up again. |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | bundled SeaweedFS: edit, `dc up -d` (s3 regenerates its config from env). External S3/R2: create the new key at the provider, edit, `dc up -d`, then revoke the old key | Outstanding presigned URLs (short-lived) fail. |
| `LIVEKIT_API_SECRET` | edit, `docker compose --profile meet up -d livekit app` | Running meetings drop; rejoin. |
| `VAPID_*` | edit, `docker compose build`, `dc up -d` | Existing push subscriptions stop working; users re-enable push. |
| Workspace API keys (`wos_…`), webhook secrets, extension codes | in the app (Admin › Integrations; Me › My AI) | Key revocation applies within 30 s (gateway cache). |

## 6. Logs

- All containers log JSON lines to stdout: `docker compose logs -f --since 30m app`.
- Follow one user report: take the `requestId` from the error body or `x-request-id` header, then `docker compose logs --no-log-prefix --since 24h | grep <requestId>`; the same id appears in the event consumers' logs for that action.
- Configure Docker log rotation (`/etc/docker/daemon.json`: `"log-driver": "json-file", "log-opts": {"max-size": "50m", "max-file": "5"}`); the compose file does not limit log size.
- `LOG_LEVEL` (default `info`) in `.env`.
- To keep logs longer or search them centrally, ship Docker's JSON logs with the log driver of your choice.

## 7. Incident playbook

| Symptom | Likely cause | Action |
|---|---|---|
| Nobody can sign in | `app` unhealthy or restarting, or Postgres down | `docker compose ps app postgres`; `docker compose logs --since 15m app`; `docker compose restart app` |
| Everyone signed out | `SESSION_SECRET` changed, or the database was restored from a backup | expected in both cases |
| Home feed / notifications / search stale | consumer errors, or the server was down (undelivered events wait in the outboxes) | `dlq list`, the app's logs |
| Search misses things that exist | events parked, or the `search` schema out of date after a restore | `dlq list`; otherwise `reindex` (section 9.3) |
| Dead letters waiting | handler failed 5×, malformed event, or a payload that does not match its schema | `dlq show <group>` (event, reason), fix the cause, `dlq replay <group>` (section 9.2) |
| AI answers poor / "fallback" warning in Admin › AI | provider 429/timeouts, circuit breaker using fallback route | check provider status and quota; Test the connection; adjust `AI_FALLBACK` / default connection |
| AI connection test error after maintenance | secrets changed (section 5) | re-enter the key |
| AI features vanished | no configured provider | expected without AI; add a connection |
| Uploads fail (403 / signature) | proxy rewrites `Host` on files domain, or `S3_ENDPOINT` not reachable from containers | keep `Host`; with a host proxy ensure the files hostname resolves inside containers |
| HTTPS fails (certificate error) | no certificate yet: DNS not pointing here, or ports 80/443 blocked | `docker compose logs caddy`; check DNS and ports; or mount your own certificate (README §5) |
| 502 from Caddy | the app container is down or restarting | `docker compose ps`; `docker compose logs app` |
| Meetings cannot connect | UDP 50000–50100 / TCP 7881 blocked, `LIVEKIT_URL` wrong | open firewall; consider TURN |
| 423 `workspace_suspended` | workspace status changed in the platform schema | should not happen in this edition; check `platform.workspace.status` as superuser |

## 8. Capacity notes

Three containers run by default (postgres, app, caddy). A fresh installation idles at about **300 MB** for the whole
stack (`app` 200 MB, Postgres 80 MB, Caddy 15 MB).
Postgres uses more as data grows (page cache). Disk grows with files (`data` or `s3data`) and the database (the
`search` schema holds a copy of searchable text); outboxes keep `EVENT_RETENTION_DAYS` (3) of events.

**Concurrent users** (load test 2026-10-15, before the backend became one process, so indicative only; whole stack limited to 2 CPU / 4 GB, method and full table in
`infra/production/README.md` §10, scripts in `tooling/loadtest/`):

- realistic use (socket open, one action every 30–60 s): **875 people at once pass** in a 6,000-person workspace
  (HTTP p95 429 ms, chat delivery p95 108 ms), 940 fail; **1,000 pass** in a 2,000-person workspace (p95 171 ms,
  70 % CPU);
- idle open apps: 7,000 sockets at 26 % CPU / 1.5 GB, 10,500 held (limit was the test machine);
- the three limits that test found (the member directory in every page, the task-rank lookup under the task-code
  lock, project task counts) are fixed since. Watch the `app` container's CPU near 100 % of one core (the web app is one Node thread) and Home latency first (one
  `app` container per installation: scale up, not out).
- Cloud vCPUs are usually 1.3–1.7× slower per core than the reference; measure with `tooling/loadtest/cpu-bench.mjs`.

### Connections

The server connects straight to Postgres, each module with its own role and a small pool: identity 10, platform 10,
chat 15 (+5 to read search), work 15, home 10, employee 10, ai 10, search 10, plus the web app's session pool (5),
the `LISTEN` connections of the relays and one job-lock connection: about 110 at most, against
`max_connections=200` (each idle connection costs a few MB). Pools open connections only under load. With a managed
Postgres that allows few connections, start the pooler: `docker compose --profile pgbouncer up -d` with
`PG_HOST=pgbouncer` and `PG_PORT=6432` in `.env`. Migrations, `LISTEN` and job locks keep their direct owner
connection either way.

## 9. Events and background jobs

How events move is in [docs/events/README.md](../events/README.md); this is what an operator runs. `dlq` and
`reindex` run inside the app container (`docker compose exec app /app/infra/production/entrypoint.sh dlq …` / `reindex …`): `dlq` needs the owner
connection, `reindex` the running server's internal port. In a checkout: `pnpm ops:dlq …`, `pnpm ops:reindex …`
after `pnpm build`.

### 9.1 Background jobs

Every periodic job (reminders, pushes, digests, webhook delivery, file sweeps, retention, pruning)
takes a Postgres advisory lock named after its module's schema and the job before it runs (`scheduleJob` in
`backend/packages/service-kit/src/jobs.ts`), so a restart that overlaps the old process never runs a job twice: one
runs it, the other skips that run. The locks live on one direct connection per process to Postgres
(`useJobLocks(OWNER_DATABASE_URL)`), not on the module's pool: a lock held on a pool connection pins it for the
whole run (with the optional PgBouncer, one of its few server connections) and starves the job's own queries. Outbox relays claim rows with `SKIP LOCKED`, so overlapping
processes never deliver the same row at once.

### 9.2 Dead letters and replays

A consumer that cannot handle an event retries five times (about 3 s), then records it in its module schema's
`dead_events` table (group, topic, event, reason) and moves on. A malformed entry or a payload that does not match
its schema in `@workspace/contracts` is recorded at once.

```bash
alias wx='docker compose exec app /app/infra/production/entrypoint.sh'
wx dlq list                          # waiting / total per schema and group
wx dlq show home-projector           # event type and id, reason (--all: replayed too)
wx dlq replay home-projector --dry-run
wx dlq replay home-projector         # after fixing the cause
wx dlq outbox-replay work home-projector --since 2026-10-14T00:00:00Z
```

Replay marks each waiting row for replay; the running server hands it to that group only within seconds and stamps
it replayed, so running it twice re-drives nothing twice. An event that fails again is recorded again:
read the reason before replaying.

`outbox-replay <schema> <group>` re-sends events still kept in a producing module's outbox (published within
`EVENT_RETENTION_DAYS`, default 3) to one group, filtered by `--type`, `--since`, `--until`. Use it to
rebuild a projection (delete that group's `processed_events` rows first, or every event is skipped as a duplicate)
or to resend events whose dead letter could not be stored.

### 9.3 Rebuild the search index

```bash
wx reindex              # delete every document, rebuild them
wx reindex --recreate   # also rebuild the typo-correction vocabulary from scratch
```

The server must be running: the identity, chat and work modules each page its current rows out as the events live indexing
understands (`GET /internal/search-feed/:kind` on the internal port, module-to-module only), and the tool writes them with the indexer's
own mapping into the `search` schema ([database/search.md](../database/search.md)). Nothing goes through the event bus and nobody is notified. Search for a workspace is incomplete while it is being
rebuilt (minutes for most companies); live indexing keeps running meanwhile.

The run also rebuilds the passages AI retrieval reads (tasks with comments, whole pages, meetings, calendar entries,
requests, files' words). An installation upgraded from a version without passages (before 2026-11-12) runs `reindex`
once, so that what already exists can be found; files are read in the background first (a few a minute), so their
words appear over the following hours without another run.

### 9.4 Event bookkeeping

- `processed_events` (each consumer's dedupe ledger) is pruned daily by every consuming module: rows older than
  `PROCESSED_EVENTS_RETENTION_DAYS` (default 30, never less than 8, longer than any redelivery or replay window).
- Each producing module keeps published events in its outbox for `EVENT_RETENTION_DAYS` (default 3) and prunes
  older rows hourly; unpublished rows always stay.
- The event catalog (`docs/events/catalog.md`) is generated from the registry; CI fails when they disagree.

### 9.5 Data retention

Every table that grows with use has a daily sweep. Most sweeps run as `SECURITY DEFINER` functions owned by the
maintenance role (the module roles may not delete history such as audit rows or the outbox themselves) in batches of 5,000 until a batch comes back short. Days are set per variable in `.env`:

| Table | Variable | Default |
|---|---|---|
| Task and document history (`work.activity`) | `TASK_ACTIVITY_RETENTION_DAYS` | 365 |
| Notifications, read / unread | `NOTIFICATIONS_READ_RETENTION_DAYS` / `NOTIFICATIONS_UNREAD_RETENTION_DAYS` | 90 / 180 |
| Resolved home items | `HOME_ITEMS_RETENTION_DAYS` | 180 |
| Home activity feed | `ACTIVITY_RETENTION_DAYS` | 365 |
| Push dedupe (`push_recent`) | `PUSH_RECENT_RETENTION_DAYS` | 30 |
| AI conversations and their rollup | Admin › AI retention (`ai_policy.retention_days`) | 180 |
| AI content views, safety events, AI audit | `AI_VIEWS_RETENTION_DAYS`, `AI_SAFETY_RETENTION_DAYS`, `AI_AUDIT_RETENTION_DAYS` | 365 |
| Admin audit log | `AUDIT_LOG_RETENTION_DAYS` | 730 |
| Audit trail (Admin › Activity log) | `AUDIT_TRAIL_RETENTION_DAYS` | 365 |
| Webhook deliveries (each webhook keeps its newest) | `WEBHOOK_DELIVERIES_RETENTION_DAYS` | 30 |
| Dead-lettered events, every module | `DEAD_EVENTS_RETENTION_DAYS` | 90 |
| Consumer dedupe ledgers, outboxes | `PROCESSED_EVENTS_RETENTION_DAYS`, `EVENT_RETENTION_DAYS` | 30, 3 |

How a workspace behaves with a million rows in its big tables, and which queries were tuned for it:
[tooling/loadtest/million-rows/README.md](../../tooling/loadtest/million-rows/README.md).
