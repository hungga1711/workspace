@AGENTS.md

## Claude Code notes

- Before visual or UI work, read [DESIGN.md](DESIGN.md) (fonts, colors, spacing, aesthetic). Ask before departing
  from it, and flag code that does not match it when reviewing UI.
- Styling in `frontend/web` is Tailwind CSS v4 only. Tokens live in `frontend/web/src/styles/globals.css`
  (`@theme inline`); use token utilities (`bg-surface`, `text-ink-2`, `bg-signal-wash`, …), never raw hex values,
  new `.css` files, or `style={{}}` for static styling (dynamic values such as a bar width are fine).
- Scope: self-hosted, single workspace; no public site, billing, plans or platform admin; every feature works without
  an AI provider. Roadmap: [TODOS.md](TODOS.md).
- Area rules: [backend/AGENTS.md](backend/AGENTS.md), [frontend/web/AGENTS.md](frontend/web/AGENTS.md), [infra/AGENTS.md](infra/AGENTS.md).
