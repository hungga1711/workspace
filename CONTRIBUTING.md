# Contributing to workspace

Thanks for helping. workspace is a self-hosted, single-workspace work-management app; changes should keep it easy to run for one company on one server.

## Getting started

Follow *Contributing* in [README.md](README.md#contributing), then run `SEED_OWNER_EMAIL=… SEED_OWNER_PASSWORD=… pnpm seed:demo` (the owner from `/setup`) for realistic data. The demo members' password is printed at the end.

On a fresh clone, build the shared packages once before `pnpm typecheck`, tests or `pnpm dev:server`. The server imports `@workspace/contracts`, `@workspace/shared` and `@workspace/service-kit` from their compiled `dist/`, so without this step typecheck fails with "cannot find module" errors. Run it again after changing anything in `backend/packages/`:

```bash
pnpm build:packages
```

## Ground rules

- **UI**
  - Read [DESIGN.md](DESIGN.md) before UI work.
  - Styling is Tailwind CSS v4 with the design tokens in `frontend/web/src/styles/globals.css`.
  - Don't use raw hex values, new `.css` files or `style={{}}` for static styling.
- **Text**
  - Every user-facing string lives in `frontend/web/src/lib/i18n/messages/`. `en.ts` is the source catalog (its keys are the type); add a key there first, then to `vi.ts`, `zh.ts` and `es.ts`. A missing key falls back to English.
  - Modules that send text, such as emails, follow the recipient's language.
- **Modules**
  - Each module owns its folder and its schema (its Postgres role cannot read another's), and never imports another module's code (`pnpm lint` refuses it). Cross-module data goes through the module's HTTP API with the caller's principal (in memory, `ServiceClient`), or through events (transactional outbox → in-process delivery).
  - Authorization is enforced in every module (`backend/packages/shared/src/authz`).
- **AI is optional.** Every feature must work without an AI provider configured.
- **Performance**
  - Heavy client code loads on demand.
  - Route JS budgets are checked by `pnpm --filter @workspace/web budget` after a build.

## Adding an integration

Connecting another tool (a code host, a design tool, a tracker) so its work shows on tasks is one provider file plus
recorded API answers: no frontend, no SQL. The walk-through is
[docs/integrations/hub.md › Write an integration](docs/integrations/hub.md#write-an-integration); start from
`backend/server/src/modules/work/integrations/providers/_template.ts`.

## Documentation

- Repository markdown is the source of truth for anything that lives with the code: [docs/](docs/README.md)
  (architecture, database, events, ADRs, runbooks, API), this file, and the self-hosting reference in
  [infra/production/README.md](infra/production/README.md). Update the matching page in the same pull request.
- The public site and its reader guides live in `website/` (Next.js and Fumadocs, see
  [website/README.md](website/README.md)). Its pages orient readers and link to the repository files for the full
  reference; they should not repeat them at length.

## Before opening a pull request

```bash
pnpm build:packages                # if backend/packages/ changed
pnpm typecheck
pnpm lint
pnpm format:check
cd frontend/web && pnpm test
pnpm -r test     # needs the development infrastructure running (tests use their own database)
```

For UI changes, add or update a Playwright spec in `frontend/web/e2e/` and include before/after screenshots in the PR.

## Commits

Write commit messages as a plain sentence describing the user-visible change ("Board: drag a card between projects keeps its order"). One logical change per commit. The release notes are built from these subjects, grouped by the area before the colon.

## Releases

Maintainers run **Actions › release › Run workflow** on `main` and pick patch, minor or major. It bumps every
version, writes the CHANGELOG.md section (from `## [Unreleased]` and the commit subjects since the last tag), tags,
creates the GitHub Release and publishes the image. Preview the notes locally with
`node tooling/scripts/release.mjs minor --dry-run`.

## License

workspace is [MIT](LICENSE). By opening a pull request you agree that your contribution is licensed under the same
terms. There is no CLA and no sign-off to add.
