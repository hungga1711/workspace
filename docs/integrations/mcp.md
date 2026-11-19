# MCP: workspace for AI agents

workspace is a [Model Context Protocol](https://modelcontextprotocol.io) server. Claude, ChatGPT, Cursor, VS Code and
any other MCP client connect with **just the URL**: the app opens a workspace page, the person signs in, sees which
app is asking and what it may do, and approves. From then on the agent reads and updates their work (tasks, projects,
documents, whiteboards, chat, the directory, "my day") as that person, with the permissions they chose. Admins see
every connected agent and every tool it called.

It is part of the server, needs no AI provider in workspace, and costs nothing until an agent calls it (the MCP SDK is
loaded on the first request).

- **Address:** `https://<APP_DOMAIN>/api/mcp`. Me › Profile › AI agents shows it with a copy button. The production proxy sends
  `/api/mcp`, `/.well-known/oauth-*` and `/oauth/{token,register,revoke}` to the server; the web app rewrites the same
  paths, so the app's address also works in development (`http://localhost:3000/api/mcp`) and behind any proxy.
- **Transport:** Streamable HTTP, stateless, JSON answers (POST only).
- **Authentication:** OAuth 2.1 (below), or `Authorization: Bearer wos_…` with a personal API key for clients without
  OAuth.

## Connect an app

| App | How |
|---|---|
| Claude (web, Desktop) | Settings › Connectors › Add custom connector, paste the address, Connect. |
| Claude Code | `claude mcp add --transport http workspace-app https://app.example.com/api/mcp`, then `/mcp` › workspace-app to sign in. (Claude Code reserves the name `workspace`: any other name works.) |
| ChatGPT | Settings › Apps & Connectors › Advanced › Developer mode, then Create a connector with the address and OAuth. |
| Cursor | Me › Profile › AI agents › "Add to Cursor" (`cursor://anysphere.cursor-deeplink/mcp/install?name=workspace&config=<base64 {"url":…}>`), or `~/.cursor/mcp.json`: `{"mcpServers":{"workspace":{"url":"…/api/mcp"}}}` |
| VS Code (Copilot, Agent mode) | Me › Profile › AI agents › "Add to VS Code" (`vscode:mcp/install?{"name":"workspace","type":"http","url":…}`), or `.vscode/mcp.json`: `{"servers":{"workspace":{"type":"http","url":"…/api/mcp"}}}` |
| Others without OAuth | A personal key in the `Authorization` header, or the stdio bridge below. |

## OAuth 2.1

```
client ─POST /api/mcp─► 401  WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/api/mcp"
  ─► GET /.well-known/oauth-protected-resource/api/mcp        (RFC 9728)
  ─► GET /.well-known/oauth-authorization-server              (RFC 8414)
  ─► POST /oauth/register                                     (RFC 7591, public clients; a secret on request)
  ─► browser: /oauth/authorize?response_type=code&code_challenge=…&code_challenge_method=S256…
       the web app's consent page, as the signed-in person: allow (read only / read and update / a chosen list) or deny
  ─► redirect_uri?code=…&state=…
  ─► POST /oauth/token  grant_type=authorization_code + code_verifier   → woa_… (1 h) + wor_… (30 days)
  ─► POST /oauth/token  grant_type=refresh_token                        → a new pair; the old refresh token is spent
  ─► POST /oauth/revoke                                                 (RFC 7009)
```

- PKCE with S256 only; codes last 10 minutes and work once (a replay ends the connection it made).
- Refresh tokens rotate on every use; presenting a spent one ends the connection for every holder.
- Redirect URIs: https, `http://localhost|127.0.0.1|[::1]` (any port at use, RFC 8252), or an app scheme
  (`cursor://`, `vscode://`). Never `javascript:`, `data:`, `file:` or a fragment. The consent page shows where the
  person will be sent back and never redirects to an address the client did not register.
- Codes, access and refresh tokens and client secrets are stored as SHA-256 hashes (`identity.oauth_*`).
- A token acts as the person, narrowed to the approved permissions and to what they hold at that moment, like a
  personal key, and opens **only `/api/mcp`** (anything else answers 403 `insufficient_scope`). It stops when the
  person disconnects the app (Me › Profile › AI agents), an admin does (Admin › Security & integrations › Agents), or the person's sessions end
  (sign out everywhere, password reset, disabled account). A workspace that requires two-step sign-in only lets people
  who use it connect apps.
- The OAuth `scope` is informational (`mcp:read`, `mcp:write`); the permissions chosen on the consent page decide.

## Personal and workspace keys

| Key | Made in | Acts as | `list_my_tasks`, `my_day` |
|---|---|---|---|
| **Personal key** | Me › Profile › Sign-in and security › Personal API keys | You, with your scopes, limited to the permissions you tick | Yes |
| Workspace key | Admin › Integrations (admins) | A service with the permissions you tick, workspace-wide | No (pass `projectId`) |

A key never reaches the account itself (password, two-step sign-in, sessions, keys, connected apps, the workspace
handover). The gateway forgets a revoked key within 30 seconds; a revoked OAuth connection stops at once.

## Tools

Every tool call is a normal API call made by the gateway as the caller, to the module that owns the data, so the same
permission checks apply as in the web app; nothing in the MCP layer reads a database. Tasks, projects, documents and
whiteboards take their id or the code shown in the app (`WEB-42`, `D-012`, `W-003`). Failures come back as a tool
result with `isError: true` and the reason. Input schemas are generated from the zod schemas the modules parse
(`backend/packages/contracts/src/api/`), the same ones behind the OpenAPI document.

| Tool | What it does | Annotations |
|---|---|---|
| `list_my_tasks` | My tasks (assigned and my to-dos), open first; `scope`, `status`, `projectId`, `cursor` | read-only |
| `get_task` | A task with description, newest 30 comments, subtasks, dependencies, file names, names instead of ids | read-only |
| `create_task` | Create a task (title, description, assignee, project, priority, due date, labels, parent) | write |
| `update_task` | Change status, title, description, assignee, priority, due date, labels, blocked reason | destructive, idempotent |
| `comment_on_task` | Comment on a task (mentions notify as in the app) | write |
| `list_workflows` | Agent workflows: what each does, its steps, the inputs a run asks for, where it runs | read-only |
| `start_workflow_run` | Hand a task to a workflow (or use the one it has) and start a run with its inputs | write |
| `get_workflow_run` | A run by id, or a task's latest: status, each step's state and result, open questions, what I may do; `step` adds what the agent did in that step, a line per action, and `afterLine` continues from the last line read | read-only |
| `decide_workflow_run` | `approve` the step a run waits on, `send_back` its result with a note, or `answer` the AI's open questions (or `skip`) | write |
| `stop_workflow_run` | Stop a run; one that already ended is left as it is | destructive, idempotent |
| `list_approvals` / `get_approval` | Requests waiting for my decision or sent by me; one request with its discussion | read-only |
| `request_approval` | Send a request for approval (money kinds need an amount) | write |
| `decide_approval` | Approve or reject a request that waits for me | destructive |
| `list_calendar_events` | My meetings, deadlines and events between two moments (62 days at most), with my answer | read-only |
| `schedule_event` | Put a meeting, deadline or event on the calendar and invite people | write |
| `respond_to_event` | Accept or decline an invitation | write, idempotent |
| `get_meeting` | A meeting's time, answers, agenda, minutes and the tasks made from it | read-only |
| `list_task_links` / `project_reviews` | A task's linked pull and merge requests, issues and designs as the connected tools report them now ([hub](hub.md)); a project's reviews by task | read-only |
| `link_work_to_task` | Attach the address of a pull request, issue or design to a task | write, idempotent |
| `list_projects` | Projects with progress and health | read-only |
| `get_project` | A project with owner, recent history and its open tasks | read-only |
| `project_progress` | One project or every active one: percent done, overdue, blocked, at risk, days left | read-only |
| `my_day` | What needs me, today's meetings and deadlines, my open tasks and week, unread inbox | read-only |
| `list_documents` / `read_document` | Documents I may read; a document's Markdown or text (up to `maxChars`) | read-only |
| `create_document` | A new page from Markdown (private unless placed in a space, project or the workspace) | write |
| `list_whiteboards` / `read_whiteboard` | Boards I may open; the words on one (stickies, labels, text) | read-only |
| `list_channels` / `read_channel` / `read_thread` | My channels and DMs with unread counts; recent messages (oldest first, with names); a thread | read-only |
| `post_message` | Post as me in a channel I belong to, or reply in a thread | write |
| `find_people` | The directory (name, title, department, manager), or one person | read-only |
| `search` | Full-text search over messages, channels, files, people, tasks, projects and documents | read-only |
| `team_workload` | Open, overdue, at-risk and blocked work per person and department for the people I manage | read-only |
| `overdue_work` | Tasks past due or at risk among those I may read, optionally for one project | read-only |
| `blocked_work` | Blocked tasks, longest blocked first, with the open tasks each waits on | read-only |
| `team_output` | Tasks finished per person I manage over 7, 14, 30 or 90 days, against the window before, with the on-time rate | read-only |
| `unanswered_questions` | Questions put to me in chat that nobody answered after `hours`, looking back `days` | read-only |
| `attendance_summary` | Days worked, hours, late arrivals, missed clock-outs, leave and absences per person I may see (92 days at most) | read-only |
| `ai_insights_summary` | AI use by department, tool and topic over 7/30/90 days; aggregates only | read-only |

A tool is listed only for a connection that holds what it needs (`TOOL_NEEDS` in `mcp-tools.ts`), and a feature the
deployment leaves out takes its tools with it (workflows with `ai`, calendar tools with `calendar`). Tools that
decide, start, stop or schedule ask for a write permission even where the module would let the person act without
one (the approver a step names, the person who started a run), so a connection approved as **read only** can read a
run or a request and never act on it. Commenting on a task is the one write a reader has, as in the app.

Following a run: `start_workflow_run`, then `get_workflow_run` every few seconds (with `step` and `afterLine` for
the agent's actions as they happen) until `status` is `done`, `failed` or `cancelled`, or `waitsFor` names what a
person must do. A script without an agent does the same with `GET /api/work/runs/{id}` and
`GET /api/work/runs/{id}/activity`, or subscribes to the `work.run.*` webhooks instead of polling.

## Prompts and resources

- **Prompts** (picked from the app's prompt menu): `daily_standup`, `plan_my_week` (`hours_per_day`),
  `project_status_report` (`project`), `team_check_in`, `catch_up_channel` (`channel`); each takes `language`.
- **Resources:** `workspace://tasks/{id}`, `workspace://projects/{id}`, `workspace://docs/{id}`,
  `workspace://whiteboards/{id}` (templates), and my open tasks listed as resources.

## What admins see

Admin › Security & integrations › Agents (permission `audit.read`; revoking needs `workspace.configure`):

- every live connection: OAuth apps and personal keys, whose they are, their permissions and last use;
- the log of tool calls: who, which app (or key), which tool, when, the result (`not_allowed`, `not_found`…) and how
  long it took, with totals per tool, person and app over 24 hours to 90 days. Arguments and answers are never kept.
  Rows are kept 180 days (`identity.mcp_calls`).

Each person sees their own connections and recent calls in Me › Profile › AI agents.

## Claude Desktop with a key (stdio bridge)

For a local-command setup, `tooling/scripts/mcp-stdio.mjs` (one file, Node 18+, no dependencies) forwards stdio to the
endpoint with a personal key:

```json
{
  "mcpServers": {
    "workspace": {
      "command": "node",
      "args": ["/path/to/mcp-stdio.mjs"],
      "env": { "WORKSPACE_URL": "https://app.example.com", "WORKSPACE_API_KEY": "wos_xxxxxxxx_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" }
    }
  }
}
```

Checked on 2026-11-13 against a running server, with a personal key made for the check and revoked after:

- The MCP SDK's own client (`@modelcontextprotocol/sdk` `Client` + `StdioClientTransport` starting the bridge):
  initialize, `tools/list`, `tools/call` (a read, a tool error for a task that does not exist), `prompts/list`,
  `resources/templates/list` and `ping` all answer.
- Claude Code 2.1: `claude mcp add workspace-app -e WORKSPACE_URL=… -e WORKSPACE_API_KEY=wos_… -- node mcp-stdio.mjs`,
  then `claude mcp list` reports `✔ Connected`. Name the server anything but `workspace`, which Claude Code refuses
  ("this name is reserved").

## Check it by hand

```bash
curl -si https://app.example.com/api/mcp -X POST -H "content-type: application/json" -d '{}' | grep -i www-authenticate
curl -s https://app.example.com/.well-known/oauth-authorization-server
curl -s https://app.example.com/api/mcp \
  -H "Authorization: Bearer wos_…" -H "content-type: application/json" -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## See also

- The same operations as a REST API: [docs/api/README.md](../api/README.md) and `docs/api/openapi.json`.
- Code: `backend/server/src/modules/gateway/mcp.ts` (endpoint), `mcp-tools.ts` (tools), `mcp-extras.ts` (prompts,
  resources), `oauth.ts` (OAuth edge); `identity/oauth.ts`, `oauth-rules.ts` (clients, grants, tokens, activity log);
  web: `app/(auth)/oauth/authorize` (consent), `components/me/AgentConnections.tsx`, `components/admin/McpAdmin.tsx`.
- Tests: `backend/server/test/gateway/mcp.test.ts`, `mcp-oauth.test.ts` (the whole OAuth flow with the SDK client).
