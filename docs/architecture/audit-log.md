# Audit trail

Admin › Nhật ký answers "who did what, when, from where" across the workspace, without exposing what people wrote to
each other. Decision record: [ADR-0025](../adr/0025-audit-trail.md).

## How an entry is made

```
module transaction ──► domain event (outbox)  ─┐
                  └──► recordAudit() → audit.entry.recorded.v1 (outbox) ─┤
                                                                         ▼
                              platform-audit consumer: audit/mapping.ts + audit/privacy.ts
                                                                         ▼
                                   platform.audit_trail (append-only)  ◄── platform's own actions (trail())
```

- **Domain events** (`backend/packages/contracts/src/events/*`) are mapped by `backend/server/src/modules/platform/audit/mapping.ts`.
  Updates are diffed against the last audited state (`platform.audit_subjects`).
- **Direct entries**: `recordAudit(c, { action, targetType, targetId, targetLabel?, outcome?, changes?, meta?,
  coalesceMinutes? })` from `@workspace/shared` (`backend/packages/shared/src/audit.ts`), in the caller's transaction. Use it only where no event says what
  happened. `settingsChanges(before, after)` builds `changes` for a settings form.
- **Origin**: IP, browser and credential kind come from the gateway (signed into the internal token) and ride on the
  event envelope (`origin`). Sign-ins pass them explicitly.
- **Actions** are `module.entity.verb`; their labels live in the web app's messages (`labels.auditTrail.*`); an
  unknown code shows as itself.

## Reading it

`GET /api/platform/audit` (`backend/server/src/modules/platform/audit/audit.controller.ts`, permission `audit.read`): filters `from`, `to`, `actor`, `actorType`, `module`,
`action` (exact, or a prefix ending in `.`), `targetType` + `targetId` (an object's history), `q` (target id or
label), `requestId` (everything one request did), `outcome`; keyset pagination with `cursor` (`next` in the
response), `limit` ≤ 1000. `GET /api/platform/audit/stats` returns totals for the same filter. Reading records
`platform.audit.viewed` (once per ten minutes per person); `purpose=export` (the CSV) records `platform.audit.exported`.
`POST /api/platform/audit/record` lets the web app record the CSV exports it builds itself (allowlisted actions,
`WEB_RECORDED`).

## Privacy rules

Never stored, whatever a producer sends:

- message, thread and DM bodies; page and whiteboard text; comments (tasks, pages, approvals); task and project
  descriptions; notes and reasons (leave, attendance, erasure); AI prompts and answers; decision details; channel
  topics; search queries; file contents;
- passwords, tokens, keys, secrets, codes, cookies.

`scrub()` drops any `meta`/`changes` key whose words name one of these (`body`, `text`, `content`, `description`,
`details`, `note`, `reason`, `comment`, `quote`, `prompt`, `answer`, `question`, `message`, `query`, `summary`,
`transcript`, `topic`, `password`, `token`, `secret`, `key`, `otp`, `cookie`, `input`, `output`…; ids such as
`messageId` are kept), clips strings to 200 characters and bounds depth and arrays. Where "it changed" matters
(a task's description, a page's text) the mapping keeps a fingerprint and the entry says `{ changed: true }`.

Chat: direct messages and group conversations leave no entry at all (who talks to whom is private). Channels:
created, renamed, archived, joined/left, members added/removed; a public channel is named (`#general`), a private
one only by its kind. Messages: only a moderator deleting someone else's message, without the text.

Tests: `backend/server/src/modules/platform/audit/privacy.test.ts`, `…/audit/mapping.test.ts`,
`backend/server/test/platform/audit.test.ts`.

## Coverage

| Area | Audited | Not audited, and why |
|---|---|---|
| Sign-in (identity) | sign-in, failed sign-in (reason code, typed email), sign-out, reused refresh token, 2FA on/off, password changed/reset, activation, sessions ended | the password, codes, tokens |
| People and access (identity) | invite / cancel, join, roles (from → to), enable / disable, rename, avatar, admin password and 2FA reset, activation link, owner transfer, roles, teams, agents (grants, tools, budget), API keys and MCP (OAuth) grants created / revoked, every MCP tool call (tool, client, ok) | each REST call made with an API key (its effects are audited, with `via`); MCP tool arguments |
| Workspace (platform) | setup, settings saved (each changed setting, from → to), logo, webhooks, reads and exports of the trail | webhook deliveries (their own log) |
| Chat | channel created / renamed / archived / topic changed, joined / left / added / removed, a moderator's message deletion, channel export | any message, edit, reaction or thread; DMs and groups entirely; private channel names; chat attachment downloads (they are message content, and images load as previews) |
| Tasks (work) | created, status / assignee / due date / title / project / priority / labels changed (from → to), description changed (no text), deleted, commented and comment deleted (no text), AI workflow runs (started, approved, paused, resumed, cancelled, finished, asked, answered) | comment and description text, check-in prompts, rank moves on a board |
| Projects, pages, boards (work) | created, renamed, status, owner / hand-over, due date, moved, shared with (who was added / removed), edited (once per 30 minutes per person), deleted, commented; spaces created / updated | page, board and comment text |
| Approvals, decisions, calendar (work) | requested (kind, amount), approved / rejected / cancelled, questions asked (no text), request templates, decisions proposed / recorded / withdrawn, delegations, meetings scheduled (a series once), rescheduled, cancelled | request details, decision details, approval Q&A text |
| Files and exports (work, web) | file downloaded (once per 10 minutes per person and file), file deleted, Drive item shared / trashed / restored / deleted, project CSV export, offboarding hand-over | uploads (the file appears on its task/page) |
| People data (employee) | leave requested / decided (type, days, dates), balances set and granted, leave types, department and manager changes, departments, compensation changed (never amounts), holidays, attendance corrections (before / after times), people settings (from → to), hand-over, announcements published / deleted, attendance export | leave and correction notes, check-in / check-out (attendance is its own record) |
| AI (ai) | connections and MCP servers added / edited / removed / default, recording policy (from → to), sensitive data flagged (kinds only), monitoring data deleted, erasure requested / decided, retention deletions (counts), safety keywords, prices and budgets, weekly report setting, refused agent tool calls, personal export | prompts, answers, conversation content, allowed tool calls (their effects are audited with the agent as actor) |
| Search, Home | — | search queries are private; notifications and the Home feed are projections, not actions |

Workflow runs are audited where the run changes state (`auditRun` in `backend/server/src/modules/work/workflows.ts`:
`work.workflow.started`, `.approved`, `.paused`, `.resumed`, `.cancelled`, `.finished`, a failed run with outcome
`failure`, target the task); questions asked and answered during a run come from `work.run.asked.v1` /
`work.run.answered.v1` as `work.workflow.asked` / `.answered`, never their text.

## Operating it

- Retention: `AUDIT_TRAIL_RETENTION_DAYS` (default 365, `.env.example`), daily in platform's retention job
  (`platform/retention.ts`, SQL function `audit_trail_prune` from `backend/server/migrations/platform/002_audit_trail.sql`).
- Size: one row is a few hundred bytes; indexes on `(at, id)`, `(actor_id, at)`, `(target_type, target_id, at)`,
  `(action, at)` and `request_id`.
- A mapping failure retries and then lands in platform's `dead_events` like any consumer; `dlq replay platform-audit` re-runs it.
