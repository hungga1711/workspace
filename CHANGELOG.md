# Changelog

All notable changes to workspace. Versions follow [Semantic Versioning](https://semver.org/): a major version may change the API, and
every release ships the migrations from the previous one.

Each release's section is written by the release workflow from `## [Unreleased]` below and the commits since the
previous release. Add anything an operator must do by hand before upgrading under `## [Unreleased]`.

## [Unreleased]

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
