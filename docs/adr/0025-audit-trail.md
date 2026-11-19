# ADR-0025: One audit trail for the whole workspace, built from events, private content excluded

- Status: Accepted
- Date: 2026-11-05
- Related: [ADR-0020](0020-ai-insights-principles.md) (AI Insights principles), [ADR-0021](0021-one-server-no-valkey.md) (events in process), [ADR-0023](0023-one-workspace-data-model.md) (one workspace)

## Context

The owner asked for an audit log across the whole system: an admin must be able to trace who did what, except
private content such as messages. What existed was partial and scattered: `identity.audit_log` (members, roles,
keys, SSO), `platform.audit_log` (settings, webhooks), `identity.auth_events` (sign-in history, 90 days),
`identity.mcp_calls` and `ai.ai_audit` (AI tool calls, with their input). Tasks, pages, approvals, leave, chat
structure and AI settings left no admin-readable trace at all, and Admin › Nhật ký merged two sources in the browser.

Every module already publishes its state changes as domain events through a transactional outbox, and each module
owns one schema that no other module may read (ADR-0015, ADR-0023).

## Decision

- **One append-only table, `platform.audit_trail`**, owned by the platform module (it already owned admin audit,
  its retention job and the workspace settings). One row: ULID id, time, actor (`user` | `agent` | `apikey` |
  `system` | `anonymous` + id), how the actor called (`session`, `personal_key`, `workspace_key`, `oauth` for MCP),
  IP and browser, module, action `module.entity.verb`, target type/id/readable label, outcome
  (`success` | `failure` | `denied`), request id, a small `changes` jsonb (field → from/to) and `meta`. The module's
  role may only `SELECT` and `INSERT`; only the maintenance-owned `audit_trail_prune()` deletes.
- **Coverage through the event bus first.** A `platform-audit` consumer reads the topics an admin may need to trace
  and maps each event type to rows (`platform/audit/mapping.ts`, one case per type, each with its privacy rule).
  Events carry only the new state, so the last audited state of a task, project, page, board, channel, profile or
  meeting is kept in `platform.audit_subjects` and diffed ("status todo → doing").
- **Direct entries where no event says it**: modules call `recordAudit(c, entry)` (`@workspace/shared`) in their
  own transaction, which appends `audit.entry.recorded.v1` to their outbox; the same consumer writes it. Used for
  sign-ins and failures, MCP tool calls, exports and downloads, admin settings (with before/after), moderator
  deletions, AI policy, erasure and retention. Platform's own actions insert directly. Identity's and platform's
  existing `audit()` helpers write both their legacy table and the trail; identity's history was carried over
  through its outbox (`identity/003_audit_trail_backfill.sql`), platform's by `platform/002_audit_trail.sql`.
- **Origin travels with the request**: the gateway signs `{ ip, userAgent, via }` into the internal token, the
  principal middleware binds it in the request context, `appendToOutbox` copies it onto the envelope's optional
  `origin`, and the consumer stores it. The web BFF forwards the browser's user agent.
- **Privacy is enforced in two places.** Mappings never copy content fields (they keep a fingerprint when "it
  changed" matters), and every `meta`/`changes` that comes from a producer passes `scrub()` (`platform/audit/
  privacy.ts`), which drops any key whose words name content or secrets (body, text, description, comment, prompt,
  answer, note, reason, query, topic, password, token, secret, key…). Direct messages and group conversations are
  not audited at all; a private channel is named only by its kind. Search queries are never recorded.
- **Reads are traced**: listing the trail records `platform.audit.viewed` (at most once per ten minutes per
  person), each CSV export `platform.audit.exported`. Only `audit.read` holders (owner/admin roles) read it.
- **Cheap on the hot path**: a direct entry is one outbox insert in a transaction that already runs; the consumer
  skips unmapped events before any database work and needs no `processed_events` row (the event id is the trail's
  primary key). Retention: `AUDIT_TRAIL_RETENTION_DAYS` (default 365), in platform's daily retention job.

## Consequences

- One place to answer "who changed this", "what did this person do", "what happened in this request", with
  indexes for each (time; actor; target; action; request id).
- The trail is eventually consistent (milliseconds in one process); an entry exists only if its change committed.
- A new event type is not audited until it gets a case in the mapping; `MAPPED_TYPES` and the coverage table in
  [docs/architecture/audit-log.md](../architecture/audit-log.md) are the list to keep current.
- The legacy `identity.audit_log` and `platform.audit_log` remain (their endpoints still answer) and can be dropped
  in a later release once nothing reads them.
