# Public demo

The production stack with `DEMO_MODE=1`, seeded on first boot with a company of 11 people, four projects and eight
weeks of AI Insights history, and put back to that state every hour. The demo's language is `DEMO_LOCALE` in
`infra/demo/.env`: `en` (default: workspace in English and UTC, English data, an English company name) or `vi`
(Vietnamese, Asia/Ho_Chi_Minh). The UI opens in the workspace's language; visitors can switch to the other one in
the menu. The people keep their Vietnamese names in both.

What a visitor gets:

- A banner on every page: "Bản demo, tự đặt lại mỗi giờ" / "Demo, resets every hour".
- Quick sign-in on `/login` as the owner (lands on Work › AI), a manager (Head of Engineering) or a staff
  member (lands on Me › AI). No password is typed or shown; the gateway signs in server-side.
- Everything works except what would spoil the demo for the next visitor or reach outside: removing or disabling
  people, owner transfer, password and two-step changes, invitations, API keys, webhooks, AI
  connections, deleting AI Insights data, keywords, topics or shared prompts, imports, the weekly report email.
  The gateway refuses these with `403 demo_locked` (`backend/server/src/modules/gateway/demo.ts`); the web
  shows "Thao tác này bị tắt trong bản demo."
- Per-IP limits (`DEMO_RATE_PER_IP_PER_MIN`, default 120 requests a minute) on top of the per-account ones, since
  everyone shares three accounts.

No AI provider is connected: AI Insights runs on the seeded data and the extension, as on any install without a
model.

## Deploy on a VPS

A server with Docker (Compose v2.20 or newer), 2 GB of RAM, a DNS record for the demo domain
pointing at it, ports 80 and 443 open.

```bash
git clone https://github.com/hungga1711/workspace.git && cd workspace/infra/demo
./demo.sh init        # asks: demo.workspace.dev and your email; generates the rest
                      # (edit DEMO_LOCALE in .env now if you want the Vietnamese demo; the seed runs once)
./demo.sh up          # builds the image, starts the stack, seeds once (a few minutes), takes the snapshot
./demo.sh logs        # "demo: seeded and snapshotted" means it is ready
```

Then open `https://demo.workspace.dev/login`.

Later:

```bash
git pull && ./demo.sh up   # new version: rebuilds and restarts; the snapshot stays
./demo.sh reset            # reset now instead of waiting for the hour
./demo.sh down             # stop
```

A new version with migrations: the old snapshot belongs to the old schema. Drop it so the next start seeds again:
`docker compose -p workspace-demo down` then `docker volume rm workspace-demo_demosnapshot workspace-demo_pgdata`, and
`./demo.sh up`.

## How the reset works

- **Seed** (`demo-seed`, one shot, `seed.sh`): first-run setup through `/api/signup` with `SETUP_TOKEN` (locale and
  time zone from `DEMO_LOCALE`), then `tooling/scripts/seed-demo.mjs` through the gateway (a five-person company in
  English; it sends `DEMO_SEED_SECRET` in `x-demo-seed` to pass the locks), then the AI Insights history
  straight into the database (`seed-demo-ai.mjs`, through `psql`), then `pg_dump -Fc` into the `demosnapshot`
  volume. It skips everything when the snapshot exists. Changing `DEMO_LOCALE` later means dropping the snapshot
  (see above) so the demo seeds again.
- **Reset** (`demo-reset`, `reset.sh`): every `DEMO_RESET_SECONDS`, `pg_restore --clean --if-exists
  --single-transaction` into the same database (the app stays up and keeps its connections; web sessions live in the
  database and go with the hour's data, the server's in-memory caches expire within a minute), and the uploaded
  files volume is emptied. Visitors are signed out by it. Then `platform.demo_refresh()` moves the restored data
  forward to today (the seed records when its data was true in `platform.demo_clock`), so tasks, the weekly AI
  report, attendance and the calendar look like the seed ran this morning however old the snapshot is.
- No email is sent: there is no SMTP_URL, and the seed gives members a password instead of an invitation link.

Files are kept on local disk (`STORAGE_DRIVER=local`, the `demofiles` volume) so the reset can empty them.
