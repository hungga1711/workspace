#!/bin/sh
# demo-seed (infra/demo/docker-compose.yml): first boot only. Creates the workspace, seeds it through the public API
# (plus the AI Insights history straight into the database), then snapshots the database for the hourly reset.
set -eu

if [ -f /snapshot/seed.dump ]; then
  echo "demo: snapshot exists, nothing to seed"
  exit 0
fi

# The seed scripts are Node; the Postgres image brings pg_dump and psql (the AI history goes in through psql).
apk add --no-cache nodejs >/dev/null

# The workspace's interface language (first-run.mjs); the seeded company is in English either way.
export DEMO_LOCALE="${DEMO_LOCALE:-en}"

node /demo/first-run.mjs
node /repo/tooling/scripts/seed-demo.mjs

# As the superuser: tables have row-level security, which pg_dump may not bypass as the owner role.
pg_dump -Fc -d workspace -f /snapshot/seed.dump.tmp
mv /snapshot/seed.dump.tmp /snapshot/seed.dump
echo "demo: seeded and snapshotted ($(du -h /snapshot/seed.dump | cut -f1))"
