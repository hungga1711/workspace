# website

The public site for workspace: the landing page (`/`) and the documentation (`/docs`). Next.js 16 (App Router,
static export), [Fumadocs](https://fumadocs.dev) for the docs, Tailwind CSS v4 with the tokens from
[DESIGN.md](../DESIGN.md). It is its own pnpm project, outside the app's workspace, so it never touches the app's
install, CI budgets or the "no public site" rule of the product itself.

```bash
cd website
pnpm install
pnpm dev            # http://localhost:3000
pnpm build          # static site in out/
pnpm types:check
```

## Where things live

| Path | What |
|---|---|
| `src/app/(home)/page.tsx` | The landing page, one function per section |
| `src/components/home/` | Landing components: header and footer (`site-chrome.tsx`), the hero's product tour (`tour-player.tsx`, playing `public/media/tour.mp4`), the hub diagram, the workflow run and templates, the feature switches, scroll-reveal helpers (`motion.tsx`), copy-to-clipboard |
| `src/components/brand.tsx` | The mark (same paths as `frontend/web/src/lib/brand-mark.ts`) and the wordmark |
| `src/app/global.css` | Tokens (`bg-ground`, `text-ink-3`, `text-signal`…) and the Fumadocs colour mapping: docs light or dark (`.dark`), landing page always dark (`.landing`) |
| `src/lib/site.ts` | Site URL, repository and install links (`gitConfig` in `src/lib/shared.ts` names the same repository) |
| `content/docs/` | The docs, MDX; `meta.json` files order the sidebar |
| `src/components/diagrams/` | The architecture diagrams, inline SVG that follows the docs theme (`parts.tsx` has the building blocks) |

The hero plays a recorded tour (`public/media/tour.mp4`, poster `tour-poster.jpg`); re-record it when the screens it
shows change. The other product pictures (`workflow-run.tsx`, `workflow-templates.tsx`, `hub-diagram.tsx`) are drawn
in HTML so they stay sharp at any size; `workflow-templates.tsx` copies the template list from
`backend/server/src/modules/work/workflows/templates.ts`.

In MDX, `<Diagram name="containers" caption="…" />` draws one of the diagrams in `src/components/diagrams/`; `Steps`, `Tabs`,
`Cards` and `Callout` are available without imports.

The social preview `public/og.png` (1200×630) is `scripts/og.html` rendered in a browser at that size; edit the
HTML and take a new screenshot to change it.

## Deploy

`.github/workflows/website.yml` builds on every change under `website/` and publishes `out/` to GitHub Pages from
`main`. Any static host works too (Cloudflare Pages, Netlify, an nginx folder): build command `pnpm build`, output
directory `out`.
