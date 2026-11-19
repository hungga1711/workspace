#!/bin/sh
# Restores a backup made by backup.sh into this directory's compose project, on EMPTY volumes (a new server, or
# after `docker compose down -v`). It refuses to overwrite a database that already holds data.
#
#   ./restore.sh <backup dir> [--yes]
#
# Steps: .env from the backup (when this directory has none), the generated secrets into the `secrets` volume,
# Postgres alone, the database, the files, then the whole stack. Runbook: docs/runbooks/backup-restore.md.
set -eu
cd "$(dirname "$0")"

src=${1:-}
if [ -z "$src" ] || [ ! -f "$src/db.dump" ]; then
  echo "usage: ./restore.sh <backup dir containing db.dump> [--yes]" >&2
  exit 1
fi
yes=${2:-}
dc() { docker compose "$@"; }

if [ ! -f .env ] && [ -f "$src/env" ]; then
  echo "restore: .env from the backup"
  (umask 077 && cp "$src/env" .env)
fi
if [ "$yes" != --yes ]; then
  printf 'Restore %s into compose project in %s? [y/N] ' "$src" "$(pwd)"
  read -r answer
  [ "$answer" = y ] || [ "$answer" = Y ] || exit 1
fi

if [ -f "$src/secrets.env" ]; then
  echo "restore: generated secrets"
  dc run --rm --no-deps -T --entrypoint sh init -c 'umask 022 && cat > /run/workspace/secrets.env' < "$src/secrets.env"
fi

echo "restore: starting postgres"
dc up -d postgres
# Over TCP: on an empty volume the socket already answers while the init scripts run on a temporary server.
i=0
until dc exec -T postgres pg_isready -h 127.0.0.1 -U postgres -d workspace -q 2> /dev/null; do
  i=$((i + 1))
  [ $i -lt 60 ] || {
    echo "restore: postgres did not start" >&2
    exit 1
  }
  sleep 2
done
tables=$(dc exec -T postgres psql -U postgres -d workspace -tAc "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')")
if [ "$tables" != 0 ]; then
  echo "restore: the database already has $tables tables; restore only into empty volumes (docker compose down -v first)" >&2
  exit 1
fi

echo "restore: database"
dc exec -T postgres pg_restore -U postgres -d workspace --exit-on-error < "$src/db.dump"

if [ -f "$src/files.tgz" ]; then
  if grep -q '^storage: local' "$src/manifest.txt" 2> /dev/null; then
    echo "restore: files (local disk)"
    dc run --rm --no-deps -T --entrypoint sh app -c 'mkdir -p /data/files && tar xzf - -C /data/files' < "$src/files.tgz"
  else
    echo "restore: files (bundled S3)"
    dc run --rm --no-deps -T --entrypoint sh s3 -c 'tar xzf - -C /data' < "$src/files.tgz"
  fi
fi

echo "restore: starting workspace"
dc up -d
echo "restore: done. Check: docker compose ps (app healthy), then sign in."
