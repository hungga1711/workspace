# tooling/

Developer tooling shared by the whole repository. Nothing here ships in the product image except
`scripts/migrate-all.mjs` (bundled by `scripts/bundle-backend.mjs`; the `migrate` command of the container).

| Path | Purpose |
|---|---|
| `tsconfig/base.json` | Compiler settings every backend package extends (`"extends": "@workspace/tsconfig/base.json"`) |
| `scripts/dev-server.mjs` | Runs the backend server (every module in one process, `backend/server`) in watch mode with the root `.env` (`pnpm dev:server`) |
| `scripts/migrate-all.mjs` | Applies each module's migrations to its schema of the `workspace` database, as the owner role (`pnpm migrate`) |
| `scripts/test-db.mjs` | The test installation: creates and migrates the `workspace_test` database (`pnpm test:db`, `--reset`), and empties it (`resetTestDatabase`, before every first-run setup in tests) and runs the server on it at :4100/:4101 with `TEST_FIXTURES=1` (`pnpm test:server`); the server's vitest config uses it |
| `scripts/bundle-backend.mjs` | Production build of the backend for the image: one esbuild bundle per entry point (the server, the migration runner, the ops tools), plus only the traced files of the external packages (`node tooling/scripts/bundle-backend.mjs <out-dir>`, run by `infra/docker/Dockerfile`) |
| `scripts/seed-demo.mjs` | A demo company in English (five members, two departments, three projects) through the public API (`pnpm seed:demo`; the people, projects and story live in `scripts/seed-demo-company.mjs`); `scripts/seed-demo-ai.mjs` adds the eight weeks of AI Insights history straight into the database, `scripts/seed-demo-balance.mjs` keeps how late the demo runs believable |
| `scripts/demo-refresh.mjs` | Moves the demo company's dates forward to today (`pnpm demo:refresh`; `--anchor <when it was seeded>` once for a database seeded before the demo clock); the public demo runs it after each reset, Admin › Settings offers it on a demo workspace |
| `scripts/new-module.sh` | Scaffolds a module `backend/server/src/modules/<module>` with its migrations and tests folders |
| `scripts/events-catalog.mjs` | Writes `docs/events/catalog.md` from the event registry in `@workspace/contracts` (`pnpm events:catalog`; `--check` in CI) |
| `scripts/openapi.mjs` | Writes `docs/api/openapi.json` from the public API table in `@workspace/contracts` (`pnpm api:openapi`; `--check` in CI) |
| `scripts/release.mjs` | Prepares a release: bumps every manifest and writes the CHANGELOG.md section (run by the release workflow; `--dry-run` previews the notes) |
| `scripts/desktop-build.mjs` | Builds the desktop app with one company's server address built in (`pnpm desktop:build https://work.company.com`; needs Rust and the Tauri prerequisites) |
| `scripts/mcp-stdio.mjs` | stdio ↔ HTTP bridge for MCP clients that can only start a local command |
| `scripts/screenshots.mjs`, `scripts/hero-gif.mjs`, `scripts/social-preview.mjs` | README screenshots, a GIF of the AI Insights flow and the GitHub social preview, from a seeded demo (headless Chromium). The README's video is a GitHub attachment (free accounts allow 10 MB), a 720p copy of `website/public/media/tour.mp4`: `ffmpeg -i tour.mp4 -vf "fps=30,scale=1280:720" -c:v libx264 -preset veryslow -tune animation -b:v 1070k -c:a aac -b:a 96k -movflags +faststart` (two passes), then drag it into a GitHub comment box for the URL |
| `loadtest/` | k6 load tests and the million-row database benchmark ([loadtest/README.md](loadtest/README.md)) |

Root-level config stays at the root where tools look for it: `eslint.config.mjs`, `.prettierrc.json`,
`.editorconfig`, `.nvmrc`, `pnpm-workspace.yaml`.
