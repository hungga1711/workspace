# Task sync: Asana, ClickUp, Linear, Jira Cloud

Task sync reads tasks from the tool your team already uses, so AI Insights can answer "do tasks done with AI finish
faster?" without moving anyone off that tool. It is **read-only**: nothing is ever written back, and synced tasks
cannot be edited in workspace (each one links back to the source).

It pairs with the **AI Insights only** mode (chosen at `/setup`, or in Admin › Settings › Workspace mode), which hides
chat, boards, docs, whiteboards and time from navigation. Task sync also works in the full mode.

## Set it up

Admin › Integrations › **Task sync** › Connect:

1. Pick the tool and paste a token (how to get one is below).
2. **Check token**: workspace lists the projects, lists or teams the token can read.
3. Tick the ones to sync and save. The first sync starts at once; after that every 15 minutes, or press **Sync now**.

Each source project becomes a workspace project with the same name. People are matched **by email**: a source
assignee whose email is a workspace member's becomes the task's assignee; others are left unassigned and counted as
"unmatched" on the connection.

## Tokens

The token belongs to one account and reads what that account can see. Use an account that can see the projects you
want, ideally a dedicated read-only one. Tokens are stored encrypted (AES-256-GCM, key from `TASK_SYNC_SECRETS_KEY` or
derived from `INTERNAL_TOKEN_SECRET`) and never returned by the API.

| Tool | Where to get the token | What workspace needs |
| --- | --- | --- |
| **Asana** | Profile › Settings › Apps › Developer apps › *Create new token* (Personal access token) | The token |
| **ClickUp** | Avatar › Settings › Apps › *API Token* (starts with `pk_`) | The token |
| **Linear** | Settings › Account › Security & access › *Personal API keys* | The key |
| **Jira Cloud** | <https://id.atlassian.com/manage-profile/security/api-tokens> › *Create API token* | The token, the site (`your-company.atlassian.net`) and the email of the account that made the token |

OAuth sign-in for each tool is planned; tokens keep the first version simple and self-host friendly.

## What is read

| | Asana | ClickUp | Linear | Jira Cloud |
| --- | --- | --- | --- | --- |
| Becomes a project | Project | List | Team | Project |
| Task key (what prompts and branches name) | none, our `T-…` code | custom id (`DEV-42`) or the task id as `#86B1X2Y3Z` | identifier (`ENG-123`) | key (`OPS-7`) |
| Status | completed flag; section name for in progress / review | status type, then its name | state type, then its name | status category, then its name |
| Dates | created, completed, due | created, start, done/closed, due | created, started, completed, due | created, resolved, due |
| Also | title, assignee email, link | title, first assignee email, link | title, assignee email, link | summary, assignee email, link |

Descriptions, comments, attachments and custom fields are **not** read. Our five statuses: To do, In progress, In
review, Done, Cancelled. Status names containing *review / QA / testing* map to In review; *progress / doing / active*
to In progress; *won't do / cancel / duplicate* to Cancelled.

Synced tasks keep the source's own dates (created, started, completed), so "added this week", cycle time and the
with/without AI comparison use the real history. A task's key becomes its workspace code when it looks like one
(`ENG-123`) and is free; either way the task answers to its key, so the browser extension and the coding-agent
collector link AI chats that mention `ENG-123`, `#86b1x2y3z` or a `CU-86b1x2y3z` branch to it.

## Incremental, and what it does not do

Each run asks only for tasks changed since the last run (with a minute of overlap). A task deleted or moved out of the
chosen projects at the source stays in workspace as it was. Disconnecting keeps the synced tasks and makes them
ordinary, editable tasks.

`TASK_SYNC_INTERVAL_MS` (default 900000) changes the interval.

## Check a token from the command line

Nothing is written; it prints what the token can read and the first tasks as they would be imported:

```bash
cd backend/server
pnpm task-sync:check --provider linear --token lin_api_…
pnpm task-sync:check --provider jira --site your-company.atlassian.net --email you@company.com --token … --project 10001
# production image: node dist/modules/work/task-sync/cli.js --provider asana --token …
```
