# syntax=docker/dockerfile:1
#
# One image for the whole of workspace: the backend server (every module in one process), the migration runner,
# the ops tools and the Next.js web app. The command picks what runs:
#
#   docker run workspace app                 # server + web in one container (the default setup)
#   docker run workspace server | web | migrate | dlq | reindex | help
#
# Production setup (Postgres, Caddy, optional S3 and LiveKit): infra/production/docker-compose.yml and infra/production/README.md.
#
#   docker build -f infra/docker/Dockerfile -t workspace .
#   docker build -f infra/docker/Dockerfile -t workspace --build-arg NEXT_PUBLIC_VAPID_PUBLIC_KEY=... .   # Web Push (optional)

# Pinned by digest so a rebuild of the same commit gets the same base; move the tag and digest together.
ARG BUILD_IMAGE=node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914
ARG RUNTIME_IMAGE=alpine:3.21.3@sha256:a8560b36e8b8210634f77d9f7f9efd7ffa463e380b75e2e74aff4511df3ef88c
ARG PNPM_VERSION=10.33.0

# ── build: install everything, compile, bundle the backend, build the web app ──────────────────────
# The build stage is the musl (Alpine) platform of the runtime, so native prebuilds (bcrypt, sharp) match.
FROM ${BUILD_IMAGE} AS build
ARG PNPM_VERSION
# Web Push key for the browser. NEXT_PUBLIC_* values are compiled into the browser bundle, and this one
# also decides whether push code is kept at all, so it is a build argument (empty: no Web Push).
ARG NEXT_PUBLIC_VAPID_PUBLIC_KEY=""
ENV CI=1 NEXT_TELEMETRY_DISABLED=1
# zip: the browser extension download (frontend/browser-extension → web/public/downloads) is built here, not committed.
RUN apk add --no-cache zip && npm install -g pnpm@${PNPM_VERSION} && npm cache clean --force
WORKDIR /app
COPY . .
# One step, so the layer keeps only what the runtime copies. The backend is built with a path filter, not
# `pnpm -r`: the root package's own `build` script would build the web app a second time.
#
# Backend: tsc output (decorator metadata included) → one esbuild bundle per entry point; the database, HTTP and
# socket clients, NestJS/rxjs and bcrypt stay external and only their traced files are copied
# (tooling/scripts/bundle-backend.mjs).
#
# Web: the public URLs are not known at build time. The build uses placeholders that the `web` command
# replaces with APP_URL / NEXT_PUBLIC_CHAT_URL when the container starts (infra/production/web-config.mjs),
# and it recomputes the security headers (CSP, HSTS) from the runtime environment the same way.
RUN pnpm install --frozen-lockfile --store-dir /tmp/pnpm-store \
 && rm -rf /tmp/pnpm-store \
 && pnpm --filter "./backend/**" --workspace-concurrency=2 run build \
 && node tooling/scripts/bundle-backend.mjs /out/app \
 && cd frontend/web \
 && pnpm ext:zip \
 && NEXT_OUTPUT=standalone \
    APP_URL=http://workspace-app-url.invalid \
    NEXT_PUBLIC_CHAT_URL=http://workspace-chat-url.invalid \
    NEXT_PUBLIC_VAPID_PUBLIC_KEY="$NEXT_PUBLIC_VAPID_PUBLIC_KEY" \
    NEXT_SKIP_CHECKS=1 \
    NODE_OPTIONS=--max-old-space-size=3072 \
    pnpm exec next build \
 && cd /app \
 && mkdir -p /out/web \
 && cp -a frontend/web/.next/standalone/. /out/web/ \
 && cp -a frontend/web/.next/static /out/web/frontend/web/.next/static \
 && cp -a frontend/web/public /out/web/frontend/web/public \
 # Nothing in the runtime reads source maps, type declarations or package docs, except the web app's own browser
 # maps (.next/static): the error screen's code resolves to file and line with them (Admin › Lỗi trình duyệt).
 && find /out -path /out/web/frontend/web/.next/static -prune -o \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \
      -o -iname 'README*' -o -iname 'CHANGELOG*' -o -iname 'HISTORY*' \) -type f -delete \
 && mkdir -p /out/app/infra/production \
 && cp infra/production/entrypoint.sh infra/production/web-config.mjs /out/app/infra/production/ \
 && cp frontend/web/next.config.mjs /out/app/infra/production/next.config.mjs \
 && cp LICENSE NOTICE.md /out/app/ \
 && rm -rf /app/node_modules /app/backend /app/frontend /app/tooling /root/.cache /root/.local/share/pnpm

# ── runtime: Alpine with its own Node.js 22 (npm kept), the bundles and the web app ──────────────────
FROM ${RUNTIME_IMAGE} AS runtime
# nodejs/npm: Node.js 22 from Alpine (npm stays for operators); icu-data-full: Vietnamese dates and numbers
# (Alpine's Node otherwise formats vi-VN as en-US); tini: signals reach node (clean shutdown on `docker stop`).
RUN apk add --no-cache 'nodejs~22' 'npm~10' icu-data-full tini \
 && addgroup -S -g 1000 node && adduser -S -D -H -u 1000 -G node -h /app node
WORKDIR /app
COPY --from=build /out/app/ /app/
COPY --from=build --chown=node:node /out/web/ /app/web/
# For the one-click templates (infra/templates/), which have no checkout to bind-mount from: the `init` job copies
# the database bootstrap and the proxy config into volumes.
COPY infra/production/postgres/init.sh /app/infra/bootstrap/postgres-init.sh
COPY infra/templates/Caddyfile /app/infra/bootstrap/Caddyfile
# /data/files: uploads with STORAGE_DRIVER=local; /run/workspace: secrets generated by the compose `init` job.
# Named volumes mounted there start with this ownership, so the app (user node) can write them.
RUN chmod +x /app/infra/production/entrypoint.sh \
 && mkdir -p /data/files /run/workspace /run/workspace-proxy && chown -R node:node /data /run/workspace /run/workspace-proxy
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    WORKSPACE_ROOT=/app
USER node
EXPOSE 3000 4000
ENTRYPOINT ["/sbin/tini", "--", "/app/infra/production/entrypoint.sh"]
CMD ["app"]
