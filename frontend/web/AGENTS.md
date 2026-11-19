# frontend/web — guide for agents

Next.js 15 (App Router, React 19, server components first), Tailwind CSS v4, TypeScript strict. The web app is
also the BFF: server components call the gateway directly; the browser calls the same-origin proxy.

## Layout

```
src/
  app/
    (auth)/            sign-in, first-run /setup, password reset (public)
    app/               the product: home, work (tabs), chat, ai, me, search…   (signed in)
    admin/             workspace administration (members, roles, AI connections, agents, settings…)
    api/               route handlers: proxy to the gateway, ai-monitor intake for the extension, client errors
    meet/, cal/, files/  meeting rooms, calendar feeds, file downloads
  components/<area>/   UI by product area (work, chat, docs, admin, home, me, ai, meet, shell, ui…)
  lib/                 framework-free helpers: gateway (server), client (browser), i18n, format, ai gating…
  styles/globals.css   design tokens (@theme inline) — the only stylesheet
e2e/                   Playwright specs (flows, CSP, a11y with axe, Core Web Vitals)
scripts/               build-time checks (bundle budget)
```

## Data access

- **Server components / route handlers:** `gw<T>("/api/<module>/<path>")` from `src/lib/gateway.ts` (forwards the
  session; throws `GatewayError` with the status). Use `adminLoad()` in admin pages for a clean 403 state.
- **Client components:** `api<T>("<module>/<path>", { method, body })` from `src/lib/client.ts`
  (same-origin `/api/proxy`, CSRF header, request id). Refresh server data with `router.refresh()`.
- Start independent requests together (`Promise.all`); never waterfall a page.

## UI rules

- Read [DESIGN.md](../../DESIGN.md). Tailwind token utilities only (`bg-surface`, `text-ink-2`, `text-brand-text`…);
  no hex values, no new CSS files, `style={{}}` only for dynamic values (a bar's width).
- Shared primitives: `src/lib/ui.ts` (`btn`, `btnPrimary`, `input`, `list`, `row`…), `src/components/ui/*`
  (`Modal`, `Drawer`, `Field`, `PageHead`, `Empty`).
- Text: `useT()` (client) / `await getT()` (server) with keys in `src/lib/i18n/messages/en.ts` (the source catalog;
  its keys are the type) and translations in `vi.ts`, `zh.ts`, `es.ts` (partial: a missing key reads in English;
  `catalogs.test.ts` rejects keys English lacks and changed `{placeholders}`). Plurals use `_one`/`_other` (Spanish may
  add `_many`). Dates, numbers and money via `useFormat()` / `formatMoney` with the locale, never a hard-coded Intl tag.
- Accessibility: real buttons/links, labels on inputs, `aria-*` on custom controls; e2e `a11y.spec.ts` runs axe.

## AI surfaces

- Company AI (assistant, @AI, summaries, translate, task/doc panels, agents) renders only when
  `aiConfigured()` (server, `src/lib/ai.ts`) / `useAiEnabled()` (client, `src/lib/ai-context.tsx`) is true.
- Work › AI (`components/work/AiOversightView.tsx`) and Me › AI never depend on it: the browser
  extension works without company AI.
- Admin › AI connections (`app/admin/workspace/ai`, `components/admin/AiConnectionsAdmin.tsx`) manages connections;
  call `refreshAiStatus()` after a change so AI surfaces appear/hide immediately.
- AI › Connect (`app/app/ai/connect`, `components/ai-hub/ConnectView.tsx`) connects the AI on a person's own computer
  with one pasted line (`public/runner/workspace-connect.mjs`) for workflows, answers, token counts and the safety
  net; `components/admin/AiLocalAdmin.tsx` offers what was found to admins. Setup anywhere else links there instead of
  showing its own commands ([docs](../../docs/integrations/ai-on-computers.md)).

## Optional features (left out at deploy time)

- The server's `DISABLED_FEATURES` ([ADR-0026](../../docs/adr/0026-deploy-time-feature-flags.md)) leaves out `docs`,
  `whiteboards`, `calendar`, `time` or `ai`; the web never reads the variable, only the workspace's `features`.
- A page or layout of such a feature starts with `await requireFeature("docs")` (`src/lib/features.ts`, not-found when
  left out); server code that only needs to know uses `featureOn()`. Admin sections go in `SECTION_FEATURE`
  (`components/admin/page-perms.ts`).
- Client components hide its links, buttons and menu entries with `useFeature("docs")` / `useFeatures()`
  (`src/lib/features-context.tsx`); lists of links filter with `featureOfHref(href)` (`src/lib/feature-links.ts`).
- Never fetch a left-out feature's API (it answers 404): skip the read, do not render its failure.

## Performance (CI-gated)

- Route budgets in `scripts/check-bundle-budget.mjs` (gzip KB of initial JS). Run after `next build`:
  `pnpm budget` (or `NEXT_DIST_DIR=.next-prod pnpm budget`). The ceiling is 200 KB per route, set by the owner; keep heavy libraries on demand.
- Heavy libraries (editor, Yjs, LiveKit, dnd-kit, charts) load with `next/dynamic` or on interaction.
- Import `m` from `motion/react-m`, not the `motion/react` barrel.

## Commands

```bash
pnpm --filter @workspace/web dev          # :3000 against a running backend (Turbopack + warm-up, scripts/dev.mjs; DEV_BUNDLER=webpack to fall back)
pnpm --filter @workspace/web typecheck && pnpm --filter @workspace/web lint && pnpm --filter @workspace/web test
cd frontend/web && npx playwright test e2e/<spec>.spec.ts   # needs the stack running
```
