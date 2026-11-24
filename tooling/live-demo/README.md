# Live demo

`workspace.hungga1711.dev/live-demo`: the real web app with sample data, as static files. No server, database or AI
behind it: visitors look around, and anything that would change data says the demo does not save changes.

| File | What it does |
|---|---|
| `fixtures.json` | The mock data: every gateway answer the screens read, recorded from the seeded demo company |
| `company.mjs` | The sample company: projects, tasks, meetings, chat, documents. Edit this to change the story |
| `company-more.mjs` | The owner's tasks, AI questions with answers, whiteboards, files, agent runs |
| `seed-extra.mjs` | After the seed: comments, meetings with minutes, chat by day, dates in the past |
| `build.mjs` | Builds the static site from the fixtures. Runs in CI (`.github/workflows/website.yml`); needs only Node |
| `preload.cjs` | While building: the clock of the recording, one signed-in person, no Postgres |
| `runtime.js` | In the visitor's browser: the bar on top, answers `fetch` from the saved files, refuses writes, keeps links inside the demo |
| `record.mjs` | Records `fixtures.json` again (developer machine, when the seed or the screens' reads change) |

```bash
pnpm install
node tooling/live-demo/build.mjs            # → website/out/live-demo (after the website's own build)
npx serve website/out                       # → http://localhost:3000/live-demo
```

The clock stands at the moment of the recording, so dates never go stale. Screens the fixtures lack say so.
English only: the language menu does not switch in the demo.

## Record again

On a throwaway database (never one with real data: everything it returns is published): an empty Postgres with
`infra/local/postgres/init.sql`, the server pointed at it on port 4600 with `SETUP_TOKEN`, `RATE_USER_PER_MIN=100000`,
then setup (`POST /api/signup`, as `infra/demo/first-run.mjs` does, for Alex Morgan of Sunrise Software),
`SEED_COMPANY=tooling/live-demo/company.mjs SEED_CURRENCY=EUR node tooling/scripts/seed-demo.mjs` (it rewrites
`.seed-demo.json`), `node tooling/live-demo/seed-extra.mjs` (a Monday reads best; `CLOCK_OFFSET_MS` shifts the recording browser when the
server and Postgres run on a shifted clock), a plain
`NEXT_DIST_DIR=.next-ldrec next build` in `frontend/web`, and `node tooling/live-demo/record.mjs` (about 20 minutes)
with the same `WEB_DATABASE_URL`, `SEED_OWNER_EMAIL` and `SEED_OWNER_PASSWORD`. Read the diff before committing.

A question to the AI is answered in the browser when the owner asked a similar one in `company-more.mjs` (the app's own
suggestions are all there); any other says that the demo has no AI. The build lists links to pages it did not build.
