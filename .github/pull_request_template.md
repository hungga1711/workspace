## What and why

<!-- The user-visible change and the reason for it. Link the issue: "Closes #123". -->

## How it was tested

<!-- Commands run, specs added or updated, manual checks. -->

## Checklist

- [ ] `pnpm typecheck`, `pnpm lint` and `pnpm format:check` pass
- [ ] Tests added or updated (Playwright spec in `frontend/web/e2e/` for UI changes)
- [ ] UI follows [DESIGN.md](../DESIGN.md) (Tailwind tokens only); before/after screenshots attached
- [ ] New user-facing text is in both `vi.ts` and `en.ts`
- [ ] Works without an AI provider configured
- [ ] New environment variables are documented in `.env.example`
