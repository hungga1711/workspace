#!/bin/sh
# Upgrades this installation to another image tag, with a backup first and a roll-back when it does not come up.
#
#   ./upgrade.sh 1.0.0                 # ghcr.io/hungga1711/workspace:1.0.0 (the repository of WORKSPACE_IMAGE in .env)
#   ./upgrade.sh ghcr.io/acme/workspace:0.2.1
#   ./upgrade.sh 1.0.0 --no-backup     # skip backup.sh (not recommended)
#
# 1. backup.sh  2. pull the new image  3. WORKSPACE_IMAGE in .env  4. migrations (`app migrate`)
# 5. restart the services  6. health checks for 5 minutes. A failure in 2 changes nothing; a failure in 4–6
# puts the previous image back and starts it. Migrations are forward-only and written to keep the previous
# release working, so the previous image normally runs on the migrated database; if it does not, restore the
# backup from step 1 (docs/runbooks/upgrade.md).
set -eu
cd "$(dirname "$0")"

target=${1:-}
[ -n "$target" ] || {
  echo "usage: ./upgrade.sh <tag | image:tag> [--no-backup]" >&2
  exit 1
}
backup=1
[ "${2:-}" = --no-backup ] && backup=0
[ -f .env ] || {
  echo "upgrade.sh: no .env here (run install.sh first)" >&2
  exit 1
}
dc() { docker compose "$@"; }
get() { sed -n "s/^$1=//p" .env | tail -n 1; }
set_image() {
  if grep -q '^WORKSPACE_IMAGE=' .env; then
    sed "s|^WORKSPACE_IMAGE=.*|WORKSPACE_IMAGE=$1|" .env > .env.tmp && cat .env.tmp > .env && rm -f .env.tmp
  else
    printf 'WORKSPACE_IMAGE=%s\n' "$1" >> .env
  fi
}

previous=$(get WORKSPACE_IMAGE)
previous=${previous:-workspace:local}
# A bare tag (0.3.0) is a published release: on the image line in use, or the published one when this install runs a
# local build (workspace:local has no registry to pull from).
repo=${previous%:*}
case "$repo" in */*) ;; *) repo="ghcr.io/hungga1711/workspace" ;; esac
case "$target" in
  *:*) image=$target ;;
  *) image="$repo:$target" ;;
esac
[ "$image" != "$previous" ] || {
  echo "upgrade: already on $image"
  exit 0
}
echo "upgrade: $previous → $image"

if [ "$backup" = 1 ]; then ./backup.sh; fi

if ! docker image inspect "$image" > /dev/null 2>&1; then
  docker pull "$image" || {
    echo "upgrade: could not pull $image; nothing changed" >&2
    exit 1
  }
fi

healthy() {
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$(dc ps -q app)" 2> /dev/null)" = healthy ]
}

rollback() {
  echo "upgrade: $1; rolling back to $previous" >&2
  set_image "$previous"
  dc up -d --remove-orphans || true
  echo "upgrade: rolled back. If $previous does not start on the migrated database, restore the backup:" >&2
  echo "  docker compose down -v && ./restore.sh <latest backup dir> --yes" >&2
  exit 1
}

set_image "$image"
dc run --rm --no-deps app migrate || rollback "migrations failed"
dc up -d --remove-orphans || rollback "the services did not start"
i=0
until healthy; do
  i=$((i + 1))
  [ $i -lt 60 ] || rollback "not healthy after 5 minutes (docker compose logs app)"
  sleep 5
done
echo "$previous" > .upgrade-previous
echo "upgrade: done, running $image (previous image recorded in .upgrade-previous)"
