#!/bin/sh
# Backs up a running workspace (this directory's compose project) into BACKUP_DIR/workspace-<date>/:
#   db.dump       the `workspace` database (every module schema, search included), pg_dump custom format (compressed)
#   files.tgz     uploaded files: the local files (`data` volume), or the bundled SeaweedFS data (--profile s3)
#   env           this directory's .env; secrets.env: the secrets the `init` job generated (when .env left them empty)
#   manifest.txt  date, image, storage, sizes
# Your own S3/R2 bucket is not copied: mirror it with that provider's tools (rclone, aws s3 sync).
#
#   ./backup.sh [BACKUP_DIR]            # default ./backups; BACKUP_KEEP_DAYS (default 14) prunes older ones
#   cron: 15 3 * * * cd /opt/workspace/infra/production && ./backup.sh /var/backups/workspace >> backup.log 2>&1
#
# Keep a copy off this server. Restore with ./restore.sh <backup dir> (docs/runbooks/backup-restore.md).
set -eu
cd "$(dirname "$0")"

dest=${1:-${BACKUP_DIR:-./backups}}
keep=${BACKUP_KEEP_DAYS:-14}
stamp=$(date +%Y%m%d-%H%M%S)
out="$dest/workspace-$stamp"
umask 077
mkdir -p "$out"

dc() { docker compose "$@"; }
# A shell with the app's environment and volumes: the running container, else a one-off one (an app that is
# restarting must not turn "files on local disk" into "no files to back up").
in_app() {
  if dc ps --status running --services 2> /dev/null | grep -qx app; then
    dc exec -T app sh -c "$1"
  else
    dc run --rm --no-deps -T --entrypoint sh app -c "$1"
  fi
}
dc exec -T postgres pg_isready -U postgres -q || {
  echo "backup.sh: postgres is not running (docker compose ps)" >&2
  exit 1
}

echo "backup: database"
dc exec -T postgres pg_dump -U postgres -d workspace -Fc -Z 6 > "$out/db.dump.part"
mv "$out/db.dump.part" "$out/db.dump"

# shellcheck disable=SC2016 # expanded by the app container's shell, not here
storage=$(in_app 'if [ -n "${S3_ENDPOINT:-}" ] && [ "${STORAGE_DRIVER:-}" != local ]; then echo s3; else echo local; fi' 2> /dev/null || echo unknown)
if [ "$storage" = local ]; then
  echo "backup: files (local disk)"
  in_app 'tar czf - -C /data/files .' > "$out/files.tgz"
elif dc ps --status running --services 2> /dev/null | grep -qx s3; then
  echo "backup: files (bundled S3)"
  dc exec -T s3 tar czf - -C /data . > "$out/files.tgz"
else
  echo "backup: files are in your own S3 bucket; mirror it separately"
fi

[ -f .env ] && cp .env "$out/env"
in_app 'cat /run/workspace/secrets.env' > "$out/secrets.env" 2> /dev/null || rm -f "$out/secrets.env"

{
  echo "date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "image: $(docker inspect -f '{{.Config.Image}}' "$(dc ps -q app)" 2> /dev/null)"
  echo "storage: $storage"
  for f in db.dump files.tgz env secrets.env; do if [ -f "$out/$f" ]; then echo "$f: $(wc -c < "$out/$f" | tr -d ' ') bytes"; fi; done
} > "$out/manifest.txt"

# Older backups go (only directories this script made).
find "$dest" -maxdepth 1 -type d -name 'workspace-*' -mtime +"$keep" -exec rm -rf {} + 2> /dev/null || true
echo "backup: done → $out"
