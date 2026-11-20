# Changelog

All notable changes to workspace. Versions follow [Semantic Versioning](https://semver.org/): a major version may change the API, and
every release ships the migrations from the previous one.

Each release's section is written by the release workflow from `## [Unreleased]` below and the commits since the
previous release. Add anything an operator must do by hand before upgrading under `## [Unreleased]`.

## [Unreleased]

## [1.0.3] - 2026-11-20

### Commits

**README**

- step 4, connect an AI in AI › Connect (#39)
- the product image leads, instead of the AI adoption screenshot (#41)

**Task page and Ask**

- no reload after answers or a run's comment; agent card buttons; history rail (#40)

## [1.0.2] - 2026-11-20

### Commits

**Other**

- AI › Connect: step-by-step install for the extension (#38)

## [1.0.1] - 2026-11-20

### Commits

**Extension**

- Workspace logo, and the connection code points to AI › Connect (#37)

**Image**

- the web app's CSS and JS load again; install.sh asks for another port when one is taken (#33)

**Jobs**

- a tick waiting for its lock when stop() is called no longer runs the job afterwards (#34)

**Production**

- the host ports are WEB_HOST_PORT / API_HOST_PORT, so choosing one no longer moves the app inside its container (#35)

**Production install**

- Postgres init no longer fails on a non-executable init.sh; install.sh shows each container (#29)
- a deleted .env no longer locks the app out of its database; the summary says what to open and where everything is (#30)
- curl | sh prints the setup address and summary again (#31)

**Setup**

- a new workspace starts with #general and one welcome message, no sample content (#36)

**Whiteboard**

- "Saved" goes away while a change waits for its save, so a reload on "Saved" keeps it (#32)

## [1.0.0] - 2026-11-20

First public release: a self-hosted work app for one company, with tasks, chat and the company's own AI.

- **Tasks and projects:** board, list and timeline views, subtasks, dependencies, recurring tasks, templates, bulk
  edits with undo, project pace instead of a percentage, goals with key results.
- **Chat and meetings:** channels, threads, task references, meetings with agenda, minutes and action items, optional
  video meetings (LiveKit).
- **Requests and time:** leave, purchases, payments and trips with approval; clock in and out; holidays, annual leave,
  currency and work week by country.
- **Docs and whiteboards** with live co-editing.
- **Company AI (optional):** any vendor API key, an OpenAI-compatible server or a model on a person's own computer.
  Ask about tasks, people and leave; create and change tasks after a confirmation; summarize channels; read web
  pages; make and edit Word, Excel and PowerPoint files; `@AI` in chat and on tasks.
- **Agent workflows:** multi-step runs on a task with AI steps, checks, approvals and a sandboxed runner.
- **AI Insights (optional, off by default):** what people use ChatGPT, Claude, Gemini and Copilot for, sensitive data
  caught before it is sent, and whether tasks done with AI finish faster, through a browser extension with a notice.
- **Integrations:** MCP server for AI agents, OpenAPI 3.1, webhooks, importers (Jira, Trello, Asana, ClickUp, Notion,
  CSV), task sync, GitHub, GitLab and Figma on tasks.
- **Administration:** setup checklist, roles in plain language, audit log, backups, upgrades with roll-back, features
  that can be left out (`DISABLED_FEATURES`).
- English, Tiếng Việt, 中文 and Español; web, desktop (Tauri) and a browser extension.
