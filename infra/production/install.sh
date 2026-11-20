#!/bin/sh
# workspace installer: one server, Docker Compose. Safe to run again (keeps .env and every secret in it).
#
#   curl -fsSL https://raw.githubusercontent.com/hungga1711/workspace/main/infra/production/install.sh | sh
#   ./install.sh                                    # from a checkout: installs in infra/production
#   ./install.sh --non-interactive --app-domain work.example.com --files-domain "" --email ops@example.com
#
# It asks four things: APP_DOMAIN (where people open workspace), FILES_DOMAIN (optional: a second name for
# the bundled S3 storage; empty keeps files on this server's disk), LETSENCRYPT_EMAIL (certificate notices) and
# SMTP_URL (optional: the mail server for invitations and password resets; MAIL_FROM is asked when it is set).
# Every secret is generated into .env (chmod 600), then `docker compose up -d` starts the stack and the script
# prints the /setup address and the setup token.
#
# Options (each also as an environment variable):
#   --non-interactive        never prompt; take values from the options/environment (APP_DOMAIN defaults to
#                            localhost over plain HTTP, for a first look)
#   --app-domain NAME        APP_DOMAIN
#   --files-domain NAME      FILES_DOMAIN ("" = files on local disk)
#   --email ADDRESS          LETSENCRYPT_EMAIL
#   --dir PATH               WORKSPACE_DIR: where to install when not run from a checkout [./workspace]
#   --version TAG            WORKSPACE_VERSION: image tag and files to download [latest release: main/latest]
#   --no-start               write the files and .env only
# Also read: WORKSPACE_IMAGE (image to run), WORKSPACE_RAW_URL (where the compose files are downloaded from),
# TLS, HTTP_PORT, HTTPS_PORT, BIND_ADDRESS (written into .env when set).
set -eu

OWNER="hungga1711"
VERSION=${WORKSPACE_VERSION:-}
RAW_URL=${WORKSPACE_RAW_URL:-}
INTERACTIVE=1
START=1
DIR=${WORKSPACE_DIR:-}
APP_DOMAIN_IN=${APP_DOMAIN-__unset__}
FILES_DOMAIN_IN=${FILES_DOMAIN-__unset__}
EMAIL_IN=${LETSENCRYPT_EMAIL-__unset__}

die() {
  echo "install.sh: $*" >&2
  exit 1
}
say() { printf '\033[1m%s\033[0m\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --non-interactive) INTERACTIVE=0 ;;
    --no-start) START=0 ;;
    --app-domain) APP_DOMAIN_IN=${2-}; shift ;;
    --files-domain) FILES_DOMAIN_IN=${2-}; shift ;;
    --email) EMAIL_IN=${2-}; shift ;;
    --dir) DIR=${2-}; shift ;;
    --version) VERSION=${2-}; shift ;;
    -h | --help) sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
  shift
done
# Piped into sh (curl … | sh) there is no terminal to ask on.
[ "$INTERACTIVE" = 1 ] && [ ! -t 0 ] && { [ -r /dev/tty ] || INTERACTIVE=0; }

command -v docker > /dev/null 2>&1 || die "Docker is not installed (https://docs.docker.com/engine/install/)"
docker compose version > /dev/null 2>&1 || die "the Docker Compose plugin v2 is missing (docker compose version)"

# ── Where: the checkout this script sits in, or a directory the compose files are downloaded into ──────────
here=$(cd "$(dirname "$0")" 2> /dev/null && pwd || echo "")
if [ -z "$DIR" ] && [ -n "$here" ] && [ -f "$here/docker-compose.yml" ] && [ -f "$here/caddy/Caddyfile" ]; then
  DIR=$here
  FROM_CHECKOUT=1
else
  DIR=${DIR:-./workspace}
  FROM_CHECKOUT=0
fi
mkdir -p "$DIR"
cd "$DIR"

if [ "$FROM_CHECKOUT" = 0 ]; then
  ref=${VERSION:+v$VERSION}
  RAW_URL=${RAW_URL:-https://raw.githubusercontent.com/$OWNER/workspace/${ref:-main}/infra/production}
  say "Downloading the compose files from $RAW_URL"
  for f in docker-compose.yml .env.example load-secrets.sh backup.sh restore.sh upgrade.sh postgres/init.sh pgbouncer/pgbouncer.ini \
    caddy/Caddyfile caddy/run.sh; do
    mkdir -p "$(dirname "$f")"
    curl -fsSL "$RAW_URL/$f" -o "$f.tmp" || die "could not download $f"
    mv "$f.tmp" "$f"
  done
  chmod +x caddy/run.sh load-secrets.sh backup.sh restore.sh upgrade.sh postgres/init.sh
fi

# ── .env: created once from .env.example, then only filled in ──────────────────────────────────────────────
umask 077
[ -f .env ] || cp .env.example .env
chmod 600 .env

get() { sed -n "s/^$1=//p" .env | tail -n 1; }
set_var() {
  # Replace the setting's line or append it (comments stay as they are); values never contain | or newlines.
  if grep -q "^$1=" .env; then
    sed "s|^$1=.*|$1=$2|" .env > .env.tmp && cat .env.tmp > .env && rm -f .env.tmp
  else
    printf '%s=%s\n' "$1" "$2" >> .env
  fi
}
random() { openssl rand -hex 32 2> /dev/null || od -An -tx1 -N32 /dev/urandom | tr -d ' \n'; }
ask() {
  # ask VAR "question" default
  if [ "$INTERACTIVE" = 1 ]; then
    printf '%s [%s]: ' "$2" "$3" > /dev/tty
    read -r answer < /dev/tty || answer=""
    [ -n "$answer" ] || answer=$3
  else
    answer=$3
  fi
  eval "$1=\$answer"
}

# A stack started before without .env (a plain `docker compose up -d`) keeps its secrets in the `secrets` volume, and
# its database was initialised with those passwords: carry them into .env instead of generating new ones.
previous=""
# The compose project: COMPOSE_PROJECT_NAME from the environment or .env, else the `name:` in docker-compose.yml.
project=${COMPOSE_PROJECT_NAME:-$(get COMPOSE_PROJECT_NAME)}
if [ -n "$(docker volume ls -q --filter "label=com.docker.compose.project=${project:-workspace-prod}" --filter label=com.docker.compose.volume=secrets)" ]; then
  previous=$(docker compose run --rm --no-deps -T --entrypoint cat init /run/workspace/secrets.env 2> /dev/null || true)
fi
for v in INTERNAL_TOKEN_SECRET SESSION_SECRET AUTH_SECRET POSTGRES_PASSWORD PG_OWNER_PASSWORD PG_APP_PASSWORD S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY; do
  [ -z "$(get "$v")" ] || continue
  value=$(printf '%s\n' "$previous" | sed -n "s/^$v=//p" | tail -n 1)
  set_var "$v" "${value:-$(random)}"
done

current_app=$(get APP_DOMAIN)
[ "$current_app" = work.example.com ] && current_app=""
current_files=$(get FILES_DOMAIN)
[ "$current_files" = files.example.com ] && current_files=""
if [ "$APP_DOMAIN_IN" != __unset__ ]; then app=$APP_DOMAIN_IN; else ask app "Domain people open workspace on (DNS must point here)" "${current_app:-localhost}"; fi
[ -n "$app" ] || app=localhost
if [ "$FILES_DOMAIN_IN" != __unset__ ]; then files=$FILES_DOMAIN_IN; else
  ask files "Second domain for file storage (S3), or - to keep files on this server's disk" "${current_files:--}"
fi
[ "$files" = - ] && files=""
if [ "$EMAIL_IN" != __unset__ ]; then email=$EMAIL_IN; else ask email "E-mail for Let's Encrypt notices (optional, - for none)" "$(get LETSENCRYPT_EMAIL | sed 's/^$/-/')"; fi
[ "$email" = - ] && email=""
# Email for invitations, password resets and the digest. Skippable: without it the admin hands over links, and
# Admin › Overview keeps "Connect a mail server" on its setup checklist. SMTP_URL / MAIL_FROM in the environment win.
if [ -n "${SMTP_URL:-}" ]; then smtp=$SMTP_URL; else ask smtp "Mail server for invitations and password resets (smtp://user:password@host:587), or - to skip" "$(get SMTP_URL | sed 's/^$/-/')"; fi
[ "$smtp" = - ] && smtp=""
if [ -n "$smtp" ]; then
  if [ -n "${MAIL_FROM:-}" ]; then mail_from=$MAIL_FROM; else ask mail_from "Sender shown on those emails" "$(get MAIL_FROM | sed "s/^$/workspace <no-reply@$app>/")"; fi
fi

for v in TLS HTTP_PORT HTTPS_PORT BIND_ADDRESS WORKSPACE_IMAGE; do
  eval "val=\${$v:-}"
  [ -z "$val" ] || set_var "$v" "$val"
done
tls=$(get TLS)
[ "$app" = localhost ] && [ -z "$tls" ] && tls=off
http_port=$(get HTTP_PORT)
if [ "$tls" = off ]; then
  url="http://$app${http_port:+:$http_port}"
  url=$(printf '%s' "$url" | sed 's/:80$//')
else
  https_port=$(get HTTPS_PORT)
  url=$(printf 'https://%s%s' "$app" "${https_port:+:$https_port}" | sed 's/:443$//')
fi
set_var APP_DOMAIN "$app"
set_var APP_URL "$url"
set_var FILES_DOMAIN "$files"
set_var LETSENCRYPT_EMAIL "$email"
set_var SMTP_URL "$smtp"
[ -n "$smtp" ] && set_var MAIL_FROM "$mail_from"
[ -n "$tls" ] && set_var TLS "$tls"
if [ -n "$files" ]; then
  scheme=${url%%://*}
  set_var S3_ENDPOINT "$scheme://$files"
else
  set_var S3_ENDPOINT ""
fi

# Profiles: the bundled S3 when it has a domain; meet (and pgbouncer) stay as set. Caddy obtains certificates itself.
profiles=$(get COMPOSE_PROFILES | tr ',' ' ')
keep=""
for p in $profiles; do case "$p" in s3) ;; *) keep="$keep $p" ;; esac done
[ -n "$files" ] && keep="$keep s3"
# shellcheck disable=SC2086 # word splitting trims and joins the list
set_var COMPOSE_PROFILES "$(echo $keep | tr ' ' ',')"

image=$(get WORKSPACE_IMAGE)
if [ -z "$image" ]; then
  if [ "$FROM_CHECKOUT" = 1 ]; then image=workspace:local; else image="ghcr.io/$OWNER/workspace:${VERSION:-latest}"; fi
  set_var WORKSPACE_IMAGE "$image"
fi
say "Configured $DIR/.env (APP_URL=$url, files: ${files:-local disk}, profiles: $(get COMPOSE_PROFILES))"

[ "$START" = 1 ] || exit 0

# ── Start ─────────────────────────────────────────────────────────────────────────────────────────────────
if ! docker image inspect "$image" > /dev/null 2>&1; then
  if ! docker compose pull --quiet 2> /dev/null; then
    [ "$FROM_CHECKOUT" = 1 ] || die "could not pull $image"
    say "Building the image from this checkout (5–10 minutes, about 2 GB of RAM)"
    docker compose build
  fi
fi
docker compose up -d --remove-orphans

say "Waiting for workspace to start"
i=0
until docker compose exec -T app sh -c 'wget -q -O /dev/null http://127.0.0.1:4000/health && wget -q -O /dev/null http://127.0.0.1:3000/robots.txt' 2> /dev/null; do
  i=$((i + 1))
  [ $i -lt 90 ] || die "not healthy after 7 minutes: docker compose ps; docker compose logs app"
  sleep 5
done

echo
say "workspace is running."
if docker compose exec -T app wget -q -O - http://127.0.0.1:4000/api/setup 2> /dev/null | grep -q '"setUp":true'; then
  echo "  Open      $url"
else
  token=$(get SETUP_TOKEN)
  [ -n "$token" ] || token=$(docker compose exec -T app cat /data/setup-token 2> /dev/null || true)
  echo "  Open      $url/setup"
  echo "  Token     ${token:-docker compose logs app | grep 'setup token'}"
fi
[ "$tls" = off ] || echo "  HTTPS     the certificate arrives within a minute once DNS for $app points here"
echo "  Backups   $DIR/backup.sh (see docs/runbooks/backup-restore.md)"
