#!/bin/sh
# Starts Caddy with the site addresses for APP_DOMAIN, API_DOMAIN, FILES_DOMAIN and MEET_DOMAIN (see Caddyfile).
# TLS=off, or the default localhost: plain HTTP (behind a load balancer that terminates TLS, or a first try).
set -e
scheme=""
if [ "${TLS:-auto}" = off ] || [ "${APP_DOMAIN:-localhost}" = localhost ]; then scheme="http://"; fi
site() { if [ -n "$1" ]; then echo "$scheme$1"; else echo "http://$2.invalid"; fi; }
WX_APP=$(site "${APP_DOMAIN:-localhost}" app)
WX_API=$(site "${API_DOMAIN:-}" api)
WX_FILES=$(site "${FILES_DOMAIN:-}" files)
WX_MEET=$(site "${MEET_DOMAIN:-}" meet)
# Global option line for the Caddyfile (substituted before parsing, so it may be empty).
WX_ACME_EMAIL=${LETSENCRYPT_EMAIL:+email $LETSENCRYPT_EMAIL}
export WX_APP WX_API WX_FILES WX_MEET WX_ACME_EMAIL
echo "caddy: app=$WX_APP api=$WX_API files=$WX_FILES meet=$WX_MEET"
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
