# workspace on Railway (advanced)

Railway runs one container per service, which fits workspace's `app` container (the web app and the server in one).
Railway gives a service no path routing in front of it, so the app gets two public domains: one for the web app
and one for the server (live updates over WebSocket and file links). Expect about 20 minutes; not yet run on
Railway.

1. **New project › Deploy from GitHub repo** (this repository). Set *Settings › Config-as-code path* to
   `infra/templates/railway.json`: it builds the image from `infra/docker/Dockerfile` and starts `app` (migrations,
   then the server on 4000 and the web app on 3000).
2. Add **Postgres** from Railway's catalogue. Create workspace's roles once (the compose stacks do this on the
   first start), from a machine with `psql`, using the Postgres service's connection variables:

   ```bash
   export PGHOST=… PGPORT=… PGUSER=postgres PGPASSWORD=… POSTGRES_USER=postgres POSTGRES_DB=railway
   export PG_OWNER_PASSWORD=$(openssl rand -hex 32) PG_APP_PASSWORD=$(openssl rand -hex 32)
   sh infra/production/postgres/init.sh     # creates the workspace database and its roles
   ```

3. Variables on the service: `PORT=3000` (Railway health-checks the web app there), `NODE_ENV=production`, `INTERNAL_TOKEN_SECRET`, `AUTH_SECRET`, `SESSION_SECRET` (each
   `openssl rand -hex 32`), `APP_URL=https://<web domain>`, `WEB_ORIGIN` = the same, `GATEWAY_URL=http://127.0.0.1:4000`,
   and the `*_DATABASE_URL` of every module plus `WEB_DATABASE_URL` and `OWNER_DATABASE_URL` as in
   `infra/production/docker-compose.yml` (service `app`), with the role passwords from step 2 and Railway's Postgres
   host and port.
4. Files: add a **volume** mounted at `/data` and set `STORAGE_DRIVER=local`, `STORAGE_LOCAL_DIR=/data/files`,
   `SETUP_TOKEN_FILE=/data/setup-token`. (Or use any S3-compatible bucket with the `S3_*` variables and CORS `PUT`/`GET`
   from `APP_URL`, and `STORAGE_PUBLIC_ORIGIN` = `S3_ENDPOINT`.)
5. Public domains (*Settings › Networking*): one with target port **3000** (the web app, `APP_URL`) and one with
   target port **4000** (the server). Set `NEXT_PUBLIC_CHAT_URL` and `STORAGE_PUBLIC_URL` to `https://<server domain>`,
   and `STORAGE_PUBLIC_ORIGIN` to the same for local files.
6. Open `https://<web domain>/setup` with the setup token from the deploy logs (`setup token`).

If this is more than you want to maintain, a small VPS with [`infra/production/install.sh`](../production/README.md)
is simpler and cheaper.
