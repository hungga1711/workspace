# workspace documentation

| Start here | |
|---|---|
| [Architecture overview](architecture/overview.md) | One page: what runs where and the rules every change follows |
| [System design](architecture/system-design.md) | The server and its modules, request path, auth, realtime, search, files, meetings, AI, observability, security, failure modes, deployment, testing |
| [Database design](database/README.md) | One database with a schema and role per module, migrations, outbox; one page per module with ER diagrams |
| [Events](events/README.md) | Outbox → relay → consumer groups in the same process, delivery guarantees; [catalog](events/catalog.md) of every event; [realtime](events/realtime.md) Socket.IO events |
| [Architecture decisions](adr/README.md) | Why it is built this way (ADRs) |
| [Public API](api/README.md) | The REST API for integrations, described in [`openapi.json`](api/openapi.json) (generated, checked in CI) |
| [MCP for AI agents](integrations/mcp.md) | The `/api/mcp` endpoint, personal API keys, tools, Claude Desktop and Claude Code setup |
| ["Needs you" for admins](architecture/admin-attention.md) | The one list on Admin › Overview of what is broken or about to break: what each module reports, who sees it, and the rule that unknown is never shown as healthy |
| [Agent workflows](architecture/agent-workflows.md) | The harness around the AI: inputs, environments (company AI, sandbox, computer), resources, checks, guardrails, outputs; triggers, live activity, performance; the runner protocol and the sandbox layout. [Questions](architecture/agent-questions.md) an AI step asks people |
| [The assistant in the workspace](architecture/ai-workspace-assistant.md) | AI › Ask, `@AI` in channels and task comments: retrieval, tools read with the asker's access, confirm cards for changes |
| [AI on a task](architecture/task-ai-chat.md) | Hỏi AI về task and the "Liên quan" view without a model; [AI viết](architecture/task-ai-write.md) for a task's title and description |
| [Audit trail](architecture/audit-log.md) | Admin › Activity log: who did what, when, from where, without private content; how entries are made, coverage, retention |
| [AI on people's computers](integrations/ai-on-computers.md) | One line connects a computer's AI (Claude Code, Codex, Gemini CLI, Ollama, LM Studio…) for workflows, answers, token counts and the sensitive-data safety net |
| [MCP client](integrations/mcp-client.md) | The company AI using tools from external MCP servers (GitHub, Linear, Notion, internal ones): setup, OAuth, confirm before run, audit |
| [Local development](runbooks/local-development.md) | Run the stack, seed demo data, common problems |
| [Operations](runbooks/operations.md) | Day-2 work: health checks, secrets, logs, incidents, dead letters, retention; step by step: [backup and restore](runbooks/backup-restore.md) (`backup.sh`, `restore.sh`, nightly cron, testing a restore), [upgrade](runbooks/upgrade.md) (`upgrade.sh`, roll back) |
| [AI Insights](ai-insights.md) | What it records and does not, who sees what, safety net, task links, reports; [notice, policy and impact-assessment templates](ai-insights/templates/) |
| [Browser extension](extension/) | [What it sends](extension/what-is-sent.md), [privacy policy](extension/privacy-policy.md), [store listing kit](extension/store-listing.md) and screenshots for the Chrome Web Store, Firefox Add-ons and Edge |
| [Integrations](integrations/) | [the hub](integrations/hub.md) (GitHub, GitLab, Figma on tasks; how to write an integration), [task sync](integrations/task-sync.md), [importers](integrations/importers.md) (Jira, Trello, Asana, ClickUp, Notion, Slack, CSV) |

Diagrams live in [`diagrams/`](diagrams/) as self-contained HTML (open in a browser) with an SVG export embedded in
the pages above. Screenshots used by the README are in [`assets/screenshots/`](assets/screenshots/) (regenerate with `node tooling/scripts/screenshots.mjs`).

Conventions for this folder:

- Docs describe the code as it is; cite files (`backend/server/src/modules/work/outcomes.ts`) so readers can check.
- A decision that changes gets a new ADR that supersedes the old one; ADRs are never rewritten, so the paths they cite
  are those of the code when they were recorded.
- When a change adds a table, an event or a module, update the matching page in the same pull request.
- The `wos_` prefix (API keys `wos_…`, the session and locale cookies, the `x-wos-csrf` header) predates the name workspace and stays: it is a contract with existing keys and integrations, not something to rename.
