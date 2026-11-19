#!/bin/sh
# The public demo, one command each (infra/demo/README.md):
#   ./demo.sh init      write .env with generated secrets (asks for the domain and the Let's Encrypt email)
#   ./demo.sh up        build and start everything; seeds once, then resets every hour
#   ./demo.sh reset     reset now
#   ./demo.sh logs      follow the seed and reset logs
#   ./demo.sh down      stop (keeps the volumes; add -v to the compose command to drop them)
set -eu
cd "$(dirname "$0")"

compose() {
  docker compose --env-file .env -f ../production/docker-compose.yml -f docker-compose.yml "$@"
}

secret() { head -c 32 /dev/urandom | base64 | tr -d '/+=\n' | cut -c1-"${1:-40}"; }

case "${1:-}" in
  init)
    if [ -f .env ]; then
      echo ".env exists; edit it or delete it first"
      exit 1
    fi
    printf "Demo domain (e.g. demo.workspace.dev): "
    read -r app
    printf "Email for Let's Encrypt: "
    read -r email
    sed -e "s|^APP_DOMAIN=.*|APP_DOMAIN=$app|" \
      -e "s|^APP_URL=.*|APP_URL=https://$app|" \
      -e "s|^LETSENCRYPT_EMAIL=.*|LETSENCRYPT_EMAIL=$email|" \
      .env.example >.env
    for k in POSTGRES_PASSWORD PG_OWNER_PASSWORD PG_APP_PASSWORD INTERNAL_TOKEN_SECRET AUTH_SECRET SESSION_SECRET S3_SECRET_ACCESS_KEY SETUP_TOKEN DEMO_SEED_SECRET; do
      sed -i.bak "s|^$k=.*|$k=$(secret 40)|" .env
    done
    sed -i.bak "s|^S3_ACCESS_KEY_ID=.*|S3_ACCESS_KEY_ID=$(secret 20)|" .env
    # Letters and digits, so they pass the password rules; they are only ever used by the quick sign-in.
    sed -i.bak "s|^DEMO_OWNER_PASSWORD=.*|DEMO_OWNER_PASSWORD=Demo$(secret 16)1|" .env
    sed -i.bak "s|^DEMO_PASSWORD=.*|DEMO_PASSWORD=Demo$(secret 16)2|" .env
    rm -f .env.bak
    chmod 600 .env
    echo "Wrote infra/demo/.env. Next: ./demo.sh up"
    ;;
  up) compose up -d --build ;;
  reset) compose exec demo-reset sh /demo/reset.sh once ;;
  logs) compose logs -f demo-seed demo-reset ;;
  down) compose down ;;
  *)
    sed -n '2,7p' "$0"
    exit 1
    ;;
esac
