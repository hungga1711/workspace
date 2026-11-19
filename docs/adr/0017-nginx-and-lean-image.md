# ADR-0017: nginx with certbot in front, and a lean Alpine image with bundled services

- Status: Partly superseded by [ADR-0021](0021-one-server-no-valkey.md) (Caddy instead of nginx + certbot; the lean image stays)
- Date: 2026-10-15
- Amends: [ADR-0008](0008-socketio-realtime-chat-service.md) and [ADR-0009](0009-livekit-meetings.md) (the reverse
  proxy they mention is nginx, no longer Caddy).

## Context

The production stack put Caddy in front (optional profile) for automatic HTTPS, and shipped one 523 MB image built
on `node:22-alpine` with every production dependency of the backend installed by pnpm. The owner wants the
open-source edition as light as possible and asked for nginx, which most administrators already know, and for
the smallest image that keeps npm and Next.js image optimization, with OpenTelemetry tracing still working.

## Decision

**Reverse proxy: nginx 1.27 (`infra/production/nginx/`), on by default.**

- Site blocks are rendered at start from templates for `APP_DOMAIN` (web, and `/socket.io/` to realtime with
  WebSocket upgrade), `FILES_DOMAIN` (SeaweedFS, `Host` passed through for S3 signatures, 2 GB streamed bodies),
  `MEET_DOMAIN` (LiveKit) and `API_DOMAIN` (gateway). An empty name means that site is not served.
- `TLS=auto` (default): HTTPS with HTTP/2 once a certificate exists at `TLS_CERT`/`TLS_KEY`; until then port 80
  only answers Let's Encrypt challenges. `TLS=off`: plain HTTP behind a load balancer that terminates TLS.
- Certificates: the `certbot` profile (certbot 4.0, HTTP-01 webroot) obtains one certificate for every configured
  name and renews it 30 days before expiry; or the administrator mounts their own under `certs/`. nginx checks the
  certificate every `TLS_CHECK_INTERVAL` seconds (300) and reloads when it appears or changes, so neither
  container needs the Docker socket.
- Upstreams use keep-alive pools and `resolve` (Docker DNS), so a restarted container's new address is followed.
  `worker_connections 16384` and `nofile 65535` leave room for tens of thousands of WebSockets. Unknown host names
  get no certificate (`ssl_reject_handshake`). Security headers stay with the web app (one source for CSP/HSTS).

**Image: `alpine:3.21` with Alpine's Node.js 22, npm, `icu-data-full` and tini.**

- `icu-data-full` is required: Alpine's Node formats `vi-VN` dates and numbers as `en-US` without it.
- Each entry point (the four services, the OpenTelemetry preload, the migration runner, the DLQ and reindex tools)
  is bundled by esbuild from the tsc output (`tooling/scripts/bundle-backend.mjs`). Packages OpenTelemetry
  instruments (pg, express, ioredis, socket.io, pino, AWS SDK), NestJS with rxjs and reflect-metadata (one copy
  per process), and bcrypt (native) stay external; `@vercel/nft` copies only the files of theirs that load.
- The web app keeps Next.js standalone output with sharp (image optimization).
- Source maps, type declarations and package docs are removed from the runtime stage; the process runs as `node`.

## Consequences

- Image 281 MB instead of 523 MB (Alpine + Node + npm + ICU 108 MB, backend 32 MB, web 69 MB); a
  whole installation idles at about 530 MB of RAM (measured, `infra/production/README.md`).
- Tracing still covers HTTP, NestJS, Postgres, Valkey and Socket.IO, because instrumented packages load from
  node_modules. A dependency newly added to the backend is bundled unless it is listed as external: one that is
  instrumented or keeps global state must be added to `EXTERNAL` in the bundler.
- Module paths that depended on the compiled file layout now come from the service's main file (the migrations
  directory is passed to modules as `ctx.migrations`).
- Administrators edit nginx templates instead of a Caddyfile; automatic HTTPS needs the certbot profile.
