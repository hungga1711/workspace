#!/bin/sh
# Entry point of the workspace image: the first argument selects what runs in this container.
set -e

usage() {
  cat <<'EOF'
workspace image. Usage: docker run [options] workspace <command>

  Run (each listens on PORT, default in brackets):
    app         migrate, then the server and the web app in this one container (the default setup)
    server      the backend: every module in one process; gateway /api, Socket.IO /socket.io,
                local files /storage                                             [4000]
    web         Next.js web app                                                  [3000]

  One-shot jobs:
    init-secrets  generate the secrets .env does not set into SECRETS_FILE [/run/workspace/secrets.env]
    migrate     apply every module's migrations to its schema (MIGRATE_DATABASE_URL, else OWNER_DATABASE_URL)
    dlq         events the server gave up on: dlq list | show [<group>] | replay <group> (MIGRATE_DATABASE_URL)
    reindex     rebuild the search index from the modules' data [--recreate]

  Anything else is executed as a command (e.g. `sh`).
  Configuration: infra/production/.env.example and infra/production/README.md.
EOF
}

SECRETS_FILE=${SECRETS_FILE:-/run/workspace/secrets.env}
# Secrets .env does not set (a clean `docker compose up -d`): the compose `init` job generated them once into a
# shared volume. Values from .env always win; the file only fills what is empty.
SECRET_NAMES="INTERNAL_TOKEN_SECRET SESSION_SECRET AUTH_SECRET POSTGRES_PASSWORD PG_OWNER_PASSWORD PG_APP_PASSWORD S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY"

init_secrets() {
  # Readable by the other containers' users (postgres, pgbouncer); the volume is mounted only into this stack.
  umask 022
  touch "$SECRETS_FILE"
  for name in $SECRET_NAMES; do
    grep -q "^$name=" "$SECRETS_FILE" && continue
    # 32 random bytes as hex: URL-safe, since the passwords end up inside connection URLs.
    printf '%s=%s\n' "$name" "$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')" >> "$SECRETS_FILE"
  done
  # The one-click templates mount this volume as Postgres' init directory and a second one as Caddy's /etc/caddy.
  cp /app/infra/bootstrap/postgres-init.sh "$(dirname "$SECRETS_FILE")/00-workspace-init.sh" 2> /dev/null || true
  [ -z "${PROXY_CONF_DIR:-}" ] || cp /app/infra/bootstrap/Caddyfile "$PROXY_CONF_DIR/Caddyfile"
  echo "init-secrets: $SECRETS_FILE ready (values set in .env take precedence)"
}

load_secrets() {
  [ -r "$SECRETS_FILE" ] || return 0
  while IFS='=' read -r name value; do
    # The Postgres superuser password is generated for the postgres container only; the app never needs it.
    [ "$name" != POSTGRES_PASSWORD ] || continue
    case " $SECRET_NAMES " in *" $name "*) ;; *) continue ;; esac
    eval "current=\${$name:-}"
    # shellcheck disable=SC2154 # set by the eval above
    [ -n "$current" ] || export "$name=$value"
  done < "$SECRETS_FILE"
  # Connection URLs were written by compose before the passwords were known: fill an empty password in.
  for var in $(env | sed -n 's/^\([A-Z_]*DATABASE_URL\)=.*/\1/p'); do
    eval "url=\$$var"
    # shellcheck disable=SC2154 # set by the eval above
    case "$url" in
      *://workspace_owner:@*) export "$var=$(printf '%s' "$url" | sed "s|://workspace_owner:@|://workspace_owner:$PG_OWNER_PASSWORD@|")" ;;
      *://*:@*) export "$var=$(printf '%s' "$url" | sed "s|://\([^:/@]*\):@|://\1:$PG_APP_PASSWORD@|")" ;;
    esac
  done
}

# The backend: one bundled file (tooling/scripts/bundle-backend.mjs). No --enable-source-maps: the image ships none, and errors cost no source-map lookups.
server() {
  cd /app/backend/server
  export SERVICE_NAME="${SERVICE_NAME:-server}"
  export PORT="${PORT:-4000}"
  exec node dist/main.js
}

web() {
  # Public URLs and security headers come from this container's environment (see web-config.mjs).
  node /app/infra/production/web-config.mjs
  cd /app/web/frontend/web
  export PORT="${PORT:-3000}" HOSTNAME=0.0.0.0
  exec node server.js
}

migrate() {
  cd /app
  export MIGRATE_DATABASE_URL="${MIGRATE_DATABASE_URL:-${OWNER_DATABASE_URL:-}}"
  node backend/packages/service-kit/dist/migrate-all.js
}

# The server and the web app side by side. If either stops, the other is stopped too and the container exits, so
# the restart policy brings both back; SIGTERM (docker stop) reaches both. Ports: SERVER_PORT [4000], WEB_PORT [3000].
app() {
  migrate
  (PORT="${SERVER_PORT:-4000}" server) &
  server_pid=$!
  (PORT="${WEB_PORT:-3000}" web) &
  web_pid=$!
  # shellcheck disable=SC2317 # called by the trap
  stop() {
    kill -TERM "$server_pid" "$web_pid" 2> /dev/null || true
    wait "$server_pid" "$web_pid" 2> /dev/null || true
    exit "${1:-0}"
  }
  trap 'stop 0' TERM INT
  while kill -0 "$server_pid" 2> /dev/null && kill -0 "$web_pid" 2> /dev/null; do sleep 2 & wait $!; done
  echo "app: a process stopped; stopping the container" >&2
  stop 1
}

cmd=${1:-help}
[ $# -gt 0 ] && shift
[ "$cmd" = init-secrets ] || load_secrets
case "$cmd" in
  init-secrets) init_secrets ;;
  app) app ;;
  server) server ;;
  web) web ;;
  migrate) migrate ;;
  dlq) cd /app && export MIGRATE_DATABASE_URL="${MIGRATE_DATABASE_URL:-${OWNER_DATABASE_URL:-}}" && exec node backend/packages/service-kit/dist/dlq.js "$@" ;;
  reindex) cd /app/backend/server && exec node dist/reindex-cli.js "$@" ;;
  help | --help | -h) usage ;;
  *) exec "$cmd" "$@" ;;
esac
