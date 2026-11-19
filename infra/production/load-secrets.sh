#!/bin/sh
# Sourced by the containers that do not run the workspace image (postgres, pgbouncer, s3) before they start:
# fills the secrets .env left empty from the file the compose `init` job generated (see entrypoint.sh).
# Values from .env always win.
if [ -r /run/workspace/secrets.env ]; then
  while IFS='=' read -r wx_name wx_value; do
    case "$wx_name" in '' | *[!A-Z0-9_]*) continue ;; esac
    eval "wx_current=\${$wx_name:-}"
    # shellcheck disable=SC2154 # set by the eval above
    [ -n "$wx_current" ] || export "$wx_name=$wx_value"
  done < /run/workspace/secrets.env
  unset wx_name wx_value wx_current
fi
