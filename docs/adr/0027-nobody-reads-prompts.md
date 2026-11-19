# ADR-0027: Nobody but the person reads their prompts

- Status: Accepted (amends [ADR-0007](0007-ai-oversight-extension-transparency.md) and principle 4 of
  [ADR-0020](0020-ai-insights-principles.md))
- Date: 2026-11-11

## Context

The read policy had three levels: `topic`, `summary` and `full`. Under `full` an admin could open the text of an
employee's AI conversation, and each opening was logged (`ai_content_views`) and shown to that person. Under
`summary` a manager saw the conversation's title next to its one-line summary, and the title is cut from the
person's first prompt, so part of the question was readable anyway. The owner's goal is to know what staff use AI
for and whether it helps, not to read what they typed.

## Decision

- The policy is `topic` or `summary` (default). Migration `ai/013_read_policy_no_full.sql` turns `full` into
  `summary` and narrows the CHECK; `PUT /api/ai/policy` refuses `full` (400).
- `GET /api/ai/oversight/conversations/:id` (the full text) is removed, with `canReadText` and the "who opened"
  list in `GET /api/ai/oversight/me`. `ai_content_views` is no longer written; its old rows expire with retention.
- Rows a manager or admin reads (`oversight`, `oversight/people/:id`, and the same rows shown to the person as
  "What managers see") carry the tool, topic, counts, sensitive-data kinds and, under `summary`, only the line the
  AI wrote. Never the title, never a prompt.
- The summary is written by the company's hosted model for the assistant's conversations and for what the
  extension records (prompts are masked before they are sent to it). With no hosted model there is no summary and
  the conversation shows its topic: every feature still works without AI.
- An imported prompt (vendor export) is used for the title, topic, sensitive-data kinds and task codes, then
  dropped, whatever the policy.
- The person still sees and exports their own data (`oversight/me/export`) and can ask for deletion.

## Consequences

- An admin can no longer investigate the wording of a flagged conversation; the sensitive-data kinds, the
  safety-net counts and a direct message to the person are what is left.
- Extension prompts now reach the company's own model provider for the one-line summary when one is connected.
  Only under `summary`: with `topic` nobody would read the line, so extension prompts are not sent for one. (The
  company assistant's own conversations already go to that provider and are summarised as before.)
- Conversations recorded before this change keep no summary unless the AI had written one; they show their topic.
