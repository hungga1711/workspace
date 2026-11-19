<p align="center"><img src="docs/assets/logo.svg" width="72" height="72" alt="Workspace logo"></p>

<h1 align="center">Workspace</h1>

<p align="center"><strong>Tasks, chat and your company's AI in one self-hosted app. See who does what, and whether AI helps.</strong></p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <a href="https://github.com/hungga1711/workspace/pkgs/container/workspace"><img alt="Container image" src="https://img.shields.io/badge/ghcr.io-hungga1711%2Fworkspace-blue?logo=docker"></a>
</p>

<p align="center"><a href="#what-it-is-for">What it is for</a> · <a href="#video">Video</a> · <a href="#install">Install</a> · <a href="#before-you-go-live">Before you go live</a> · <a href="#contributing">Contributing</a></p>

<p align="center"><a href="README.vi.md">Tiếng Việt</a> · <a href="README.zh.md">中文</a> · <a href="README.es.md">Español</a></p>

## What it is for

One installation runs one company's work on its own server:

- **Tasks and projects:** boards, lists, timelines, subtasks, dependencies, recurring tasks, goals.
- **Chat and meetings:** channels, threads, task references, meetings with agenda, minutes and action items.
- **Requests and time:** leave, purchases, payments and trips with approval; clock in and out; holidays and work week
  by country.
- **Docs and whiteboards** with live co-editing.
- **The company's own AI (optional):** connect an API key, any OpenAI-compatible server or a model on your own
  computer. Ask about tasks, people and leave; have it create and update tasks, summarize channels, read websites,
  and make Word, Excel and PowerPoint files. Every change waits for your confirmation.
- **AI Insights (optional, off by default):** with a browser extension and a notice on every recorded page, see what
  people use ChatGPT, Claude, Gemini and Copilot for, which sensitive data was caught before it was sent, and whether
  tasks done with AI finish faster.

For the owner: **Home** shows who is stuck and why, what waits for your decision, and AI use this week.
**Progress** shows each person and department. Nothing is sent to us or to any third party; every feature works
without AI. English, Tiếng Việt, 中文 and Español.

## Video

https://github.com/user-attachments/assets/2c138cb5-2642-4455-aca1-fa205fef1153

## Install

You need a computer or server that stays on, with **2 CPU cores, 2 GB of RAM and 20 GB of disk**. For a company,
use a Linux server (any cloud VPS) and a domain name pointing at it. To try it first, your own laptop is enough.

### 1. Install Docker

**Linux server** (Ubuntu, Debian, Fedora, CentOS…):

```bash
curl -fsSL https://get.docker.com | sh
```

**macOS or Windows:** install [Docker Desktop](https://www.docker.com/products/docker-desktop/) and open it once.
On macOS, [OrbStack](https://orbstack.dev) works too and is lighter.

Check that it works:

```bash
docker compose version
```

### 2. Run the installer

```bash
curl -fsSL https://raw.githubusercontent.com/hungga1711/workspace/main/infra/production/install.sh | sh
```

It asks four things:

| Question | Answer |
|---|---|
| Domain | `work.yourcompany.com`, or `localhost` to try it on your laptop |
| Domain for files | leave empty: files stay on the server's disk |
| Email | for HTTPS certificate notices; empty on `localhost` |
| Mail server (SMTP) | optional; skip it and add it later in Admin › Settings & features › Email |

It downloads the app, generates every password and secret into `workspace/.env`, starts it and prints:

```
Open   https://work.yourcompany.com/setup
Token  4f8a…
```

### 3. Create your company

Open that address, enter the token, name the company, pick its country (holidays, annual leave, currency and work
week follow it) and create the owner account. Then invite people from **Admin › Members**, and connect an AI in
**Admin › AI connections** if you want one.

Other ways to run it: [Coolify, Portainer, Railway, Unraid and CasaOS templates](infra/templates/README.md), or
your own reverse proxy ([self-host guide](infra/production/README.md)).

## Before you go live

- **DNS first.** Point the domain at the server and open ports 80 and 443 before installing; the HTTPS certificate is
  requested automatically and fails until both are true.
- **Keep `workspace/.env` safe.** It holds the database passwords and the keys that encrypt saved secrets. Losing it
  means losing access to the data.
- **Back up.** `workspace/backup.sh` saves the database, files and `.env`; schedule it daily (for example with cron)
  and copy the result off the server. Restore with `restore.sh`. See [backups](docs/runbooks/backup-restore.md).
- **Upgrade** with `workspace/upgrade.sh <version>`: it backs up, pulls the new version, migrates the database and
  rolls back by itself if the new version does not start.
- **Without SMTP** nobody gets e-mails: copy each invitation link from Admin › Members and send it yourself.
- **AI is optional.** Without a connected AI, the AI screens are hidden and everything else works. AI keys are stored
  encrypted on your server.
- **AI Insights records people's prompts** only after the company turns it on and each person installs the
  extension; tell your staff first. What it sends: [docs/extension/what-is-sent.md](docs/extension/what-is-sent.md).
- **Leave out what you don't use** with `DISABLED_FEATURES` in `.env`: `docs`, `whiteboards`, `calendar`, `time`, `ai`.
  Chat and tasks are always on.
- **Video meetings** need LiveKit and extra ports (TCP 7881, UDP 50000–50100):
  `COMPOSE_PROFILES=meet` in `.env`.
- Every setting is described in [`infra/production/.env.example`](infra/production/.env.example); the full guide is
  [infra/production/README.md](infra/production/README.md).

## Contributing

Bug reports, ideas and pull requests are welcome.

```bash
git clone https://github.com/hungga1711/workspace && cd workspace
pnpm install && pnpm build:packages      # Node 22, pnpm 10
cp .env.example .env
pnpm infra:up && pnpm migrate            # Postgres, file storage and LiveKit in Docker
pnpm dev:server                          # the backend on :4000
pnpm --filter @workspace/web dev         # the web app on http://localhost:3000
```

Open http://localhost:3000 and create the company at `/setup`. For realistic data (a small team with projects, chat, documents and eight
weeks of history): `SEED_OWNER_EMAIL=<owner email> SEED_OWNER_PASSWORD=<owner password> pnpm seed:demo`.

Before a pull request: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm -r test`.

- Rules, conventions and how to add an integration: [CONTRIBUTING.md](CONTRIBUTING.md)
- How the code is organised (AI coding agents start here too): [AGENTS.md](AGENTS.md)
- Architecture: [docs/architecture/overview.md](docs/architecture/overview.md) · UI rules: [DESIGN.md](DESIGN.md)
- [Code of Conduct](CODE_OF_CONDUCT.md) · security problems, privately: [SECURITY.md](SECURITY.md)

## License

[MIT](LICENSE). Use it, change it, sell it, host it for others; keep the copyright line. Third-party components:
[NOTICE.md](NOTICE.md).
