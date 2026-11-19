# Backup and restore

For an installation made with `infra/production/` (install.sh or `docker compose up -d`). Run the commands in
`infra/production/` (or the directory install.sh created).

## What holds state

| Where | What | In the backup |
|---|---|---|
| `pgdata` volume | Everything in the database: accounts, work, chat, documents, AI Insights, search index, sign-in sessions | `db.dump` (`pg_dump -Fc` of `workspace`) |
| `data` volume (local disk storage, `/data/files`; also the generated setup token) or `s3data` (bundled SeaweedFS, `--profile s3`) | Uploaded files, avatars | `files.tgz` |
| `.env` and the `secrets` volume | Passwords and keys; the database roles were created with these | `env`, `secrets.env` |
| `caddydata` | Certificates | not needed: Caddy obtains new ones |

Your own S3/R2 bucket is not copied by `backup.sh`; use the provider's versioning or `rclone sync` to a second bucket.

## Back up

```bash
./backup.sh /var/backups/workspace      # → /var/backups/workspace/workspace-YYYYMMDD-HHMMSS/
```

It runs against the live stack (pg_dump is a consistent snapshot; uploads written during the archive may or may not
be in it). Backups older than `BACKUP_KEEP_DAYS` (default 14) in that directory are removed. Each backup has a
`manifest.txt` (date, image, storage, sizes).

**Every night** (cron, as a user that can run `docker`):

```cron
15 3 * * * cd /opt/workspace/infra/production && ./backup.sh /var/backups/workspace >> /var/log/workspace-backup.log 2>&1
```

Copy the backup directory off the server (another machine, an object store with retention). It contains every
secret of the installation: keep it as private as the server itself, e.g. `restic`/`borg` with encryption, or
`gpg -c` on the archive.

## Restore

Onto a new server, or the same one after `docker compose down -v`. `restore.sh` refuses a database that already has
tables.

```bash
# new server: install the compose files without starting (install.sh --no-start), or copy infra/production/
./restore.sh /var/backups/workspace/workspace-20261025-031500 --yes
docker compose ps        # app healthy
```

What it does: `.env` from the backup when the directory has none; the generated secrets into the `secrets` volume;
Postgres alone; `pg_restore` of `db.dump`; the files into their volume; then `docker compose up -d` (migrations run
first, so a backup from an older release is brought up to date).

After a restore:

- People stay signed in as of the backup (sessions are in the database); sessions started since are gone.
- The search index is in the database; `docker compose exec app /app/infra/production/entrypoint.sh reindex` rebuilds
  it if results look stale (it needs the running server).
- A projection that missed events while the old server went down can be replayed:
  `docker compose exec app /app/infra/production/entrypoint.sh dlq outbox-replay <schema> <group>` (see
  [operations.md](operations.md)).

## Test your backups

A backup is only real once it has been restored. Once a month, on a spare machine (on the server itself the published
ports 3000, 4000 and 443 collide with the running stack):

```bash
cp -r infra/production /tmp/wx-restore-test && cd /tmp/wx-restore-test
COMPOSE_PROJECT_NAME=wxrestore HTTP_PORT=8089 ./restore.sh /var/backups/workspace/<latest> --yes
docker compose -p wxrestore exec -T postgres psql -U postgres -d workspace -c 'SELECT count(*) FROM work.tasks'
docker compose -p wxrestore down -v
```
