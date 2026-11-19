# Third-party notices

workspace is licensed under the [MIT License](LICENSE). It bundles or depends on third-party software
that keeps its own licence. This file lists what ships inside the workspace Docker image and the web app, and how
to regenerate the dependency summary.

## Bundled in the image or the web app

| Component | Licence | Notes |
|---|---|---|
| Node.js 22 (Alpine package) | MIT | Runtime of the server and the web app |
| Alpine Linux base image and packages (`icu-data-full`, `tini`, `npm`) | MIT and others, per package | See each package in `apk info -L` |
| Inter, Inter Tight (`frontend/web/src/fonts/`) | SIL Open Font License 1.1 | Copy of the licence in that folder |
| Geist, Geist Mono (`frontend/web/src/fonts/`) | SIL Open Font License 1.1 | Copyright (c) 2023 Vercel; copy of the licence in that folder |
| Noto Sans, subset to Latin and Vietnamese (`backend/server/assets/fonts/`, embedded in the PDFs the AI makes) | SIL Open Font License 1.1 | Copyright 2022 The Noto Project Authors; `OFL.txt` in that folder |
| `pdfkit` (PDF export, loaded on the first PDF made) | MIT | |
| `@excalidraw/excalidraw` 0.18 (the whiteboard editor) | MIT | Copyright (c) 2020 Excalidraw. Loaded only on a whiteboard's page; its Mermaid import is left out of the build |
| Nunito, Virgil, Lilita One, Cascadia Code (`frontend/web/public/excalidraw/fonts/`, copied from `@excalidraw/excalidraw` on install) | SIL Open Font License 1.1 | Each family's `OFL.txt` with its copyright line sits next to its files |
| Comic Shanns (`frontend/web/public/excalidraw/fonts/ComicShanns/`) | MIT | `LICENSE.txt` next to the files |
| Assistant (the whiteboard editor's interface font, bundled by its stylesheet) | SIL Open Font License 1.1 | Licence in `frontend/web/public/excalidraw/fonts/Assistant/OFL.txt` |
| `dompurify` (through the whiteboard editor) | MPL-2.0 OR Apache-2.0 | Used under Apache-2.0 |
| `pako` (through the whiteboard editor) | MIT AND Zlib | |
| `fractional-indexing`, `robust-predicates` (through the whiteboard editor) | CC0-1.0, Unlicense | Public-domain dedications |
| libvips, through `sharp` prebuilt binaries (`@img/sharp-libvips-*`) | LGPL-3.0-or-later | Dynamically linked; source at https://github.com/libvips/libvips. Replace the `@img/sharp-libvips-*` package to use your own build |
| `web-push` | MPL-2.0 | Source at https://github.com/web-push-libs/web-push |
| `machina` | MIT OR GPL | Used under the MIT option |
| Everything else under `node_modules` reachable from the production bundles | MIT, Apache-2.0, ISC, BSD-2-Clause, BSD-3-Clause, BlueOak-1.0.0, 0BSD, MIT-0, Python-2.0, CC-BY-4.0 | Summary below |

The backend bundles are produced by esbuild with legal comments kept (`tooling/scripts/bundle-backend.mjs`), so the
licence headers of bundled packages remain inside the files that ship.

## Run next to it (not bundled, pulled as separate images by `infra/production/docker-compose.yml`)

| Image | Licence |
|---|---|
| PostgreSQL | PostgreSQL License |
| Caddy | Apache-2.0 |
| SeaweedFS (optional) | Apache-2.0 |
| LiveKit server (optional) | Apache-2.0 |
| PgBouncer (optional) | ISC |

## Dependency summary (production dependencies, version 1.0.0)

705 packages resolved by `pnpm licenses list --prod`:

| Licence | Packages |
|---|---|
| MIT | 448 |
| Apache-2.0 | 195 |
| ISC | 29 |
| BSD-3-Clause | 15 |
| BSD-2-Clause | 6 |
| BlueOak-1.0.0 | 4 |
| LGPL-3.0-or-later | 1 (`@img/sharp-libvips-*`) |
| MPL-2.0 | 1 (`web-push`) |
| (MIT OR GPL) | 1 (`machina`, used as MIT) |
| (Apache-2.0 AND BSD-3-Clause), Python-2.0, CC-BY-4.0, MIT-0, 0BSD | 1 each |

No GPL-only or AGPL package is in the production dependency tree.

Regenerate the summary after changing dependencies:

```bash
pnpm licenses list --prod --json > /tmp/licenses.json
node -e 'const d=require("/tmp/licenses.json");for(const [k,v] of Object.entries(d).sort((a,b)=>b[1].length-a[1].length))console.log(v.length,k)'
```
