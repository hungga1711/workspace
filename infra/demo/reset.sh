#!/bin/sh
# demo-reset (infra/demo/docker-compose.yml): every DEMO_RESET_SECONDS, put the demo back the way the seed left it.
#   sh /demo/reset.sh        loop (the container's job)
#   sh /demo/reset.sh once   reset now (./demo.sh reset)
#
# The database is restored in place (pg_restore --clean in one transaction) rather than dropped: the app keeps its
# connections and simply sees the old data again. Web sign-in sessions live in the database (schema `web`), so the
# hour's sessions go with it; the server's in-memory caches (principals, workspace settings) expire within a minute.
set -u

reset() {
  echo "demo: reset at $(date -u +%FT%TZ)"
  if ! pg_restore -d workspace --clean --if-exists --single-transaction --exit-on-error /snapshot/seed.dump; then
    echo "demo: restore failed, the next round tries again"
    return 1
  fi
  find /files -mindepth 1 -delete 2>/dev/null || true
  # The snapshot's dates are the day it was seeded: move them to today (platform.demo_refresh, 004_demo_clock.sql).
  psql -d workspace -Atqc "SELECT platform.demo_refresh()" || echo "demo: could not move the data to today, it keeps the seed's dates"
  echo "demo: reset done"
}

until [ -f /snapshot/seed.dump ]; do
  [ "${1:-}" = "once" ] && { echo "demo: no snapshot yet (the seed has not finished)"; exit 1; }
  sleep 30
done

if [ "${1:-}" = "once" ]; then
  reset
  exit $?
fi

while :; do
  sleep "${DEMO_RESET_SECONDS:-3600}"
  reset || true
done
