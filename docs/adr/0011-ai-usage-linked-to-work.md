# ADR-0011: AI use linked to the work it served, projected into work-service by event

- Status: Accepted
- Date: 2026-10-15

## Context

The owner's question is not only "who uses AI" but "does the AI we pay for help get work done". Comparing frequent
AI users with the rest (Công việc › AI) mixes people and roles; the sharper answer compares **tasks** finished with
the company AI's help against tasks finished without it.

The facts live in two databases: AI calls in ai-service (`ai_usage`), tasks and their completion in work-service.
Two ways to join them:

1. **Read at query time:** work-service asks ai-service (as the caller, `ServiceClient`) for the task ids it helped
   with in the window, then splits its own tasks.
2. **Project by event:** ai-service records the subject of each call (`ai_usage.subject_type/subject_id`) and, when
   there is one, emits `ai.usage.recorded.v1` through the outbox; work-service consumes it and keeps
   `task_ai_assists (task_id, first_at, last_at, calls, tokens, people)`.

## Decision

Option 2.

- Every in-app AI feature that runs on a piece of work passes its subject to `meteredGenerate`: task and document
  helpers (`tasks/:id/assist`, `docs/:id/assist`), extraction from a meeting, document or task (`extract` with
  `subjectId`), thread summaries (`message`) and @AI in a channel (`channel`).
- ai-service emits `ai.usage.recorded.v1` (topic `workspace.ai.usage`) only for calls with a subject.
- work-service's `work-ai-assists` consumer upserts `task_ai_assists` for subject `task` (idempotent through
  `processed_events`; other subject types are ignored for now).
- `followup/outcomes` returns `withAi: { assisted, other }`: done, on time among dated, median days to done, for tasks
  finished in the window by the caller's audience. A task counts as assisted only if the first AI help came before
  it was finished.

## Consequences

- The outcomes query stays one SQL statement in one database, as fast as before, and works when ai-service is down.
- Cross-service side effects go through events, as everywhere else ([ADR-0002](0002-outbox-debezium-kafka.md)); no
  synchronous coupling from work to ai, and no unbounded id lists over HTTP.
- The comparison is eventually consistent (seconds). Calls made before this change have no subject and count as
  "without AI"; the gap closes as new work is done.
- It is a correlation, not proof: people pick AI for some kinds of tasks. The UI says so and keeps the per-person view
  next to it.
- Browser-extension use (ChatGPT, Claude…) has no subject of its own; it joins the comparison once the person links
  the conversation to a task (below).

## Update 2026-10-25: outside AI linked to tasks (AI Insights, ADR 0020)

The extension cannot know which task a prompt on another site was for, and guessing would put words in people's
mouths. So a conversation from the extension (or an import) counts for a task only when **the person links it**, in
Của tôi › AI, in one of three ways that add up:

1. **Picked**: "Gắn với việc…" searches the person's open or recently finished tasks (`GET work me/tasks/match?mode=search`).
2. **Hint, confirmed**: the web keeps the last task the person opened (`localStorage["workspace.lastTaskSeen"]`); with
   the person's permission the extension sends it with the prompt, ai-service stores it in
   `ai_conversations.hint_task_id`, and Của tôi › AI asks "Gắn với «…»?". A hint alone never counts.
3. **Suggested, accepted**: a Postgres full-text match (`simple` configuration with `unaccent`, any shared word) of the
   conversation's title and first prompt against the person's own task titles (`GET work me/tasks/match?mode=suggest`,
   bounded to that person's tasks, so no index is needed).

On link, ai-service sets `task_id`/`task_link` and emits `ai.usage.recorded.v1` with a new payload field
`source: "extension"` (company-AI calls carry `source: "app"`; events without it are read as "app"), `usageId` = the
conversation id and `at` = when the conversation started, so the "AI came before done" rule holds. Re-linking to the
same task emits nothing; unlinking does not remove the task's mark (the projection only adds, and a wrong link is
rare). work-service's consumer is unchanged: it counts the task as AI-assisted whatever the source.

Consequences: Công việc › AI and Của tôi › AI ("AI có giúp xong việc nhanh hơn?") now include outside AI the person
chose to link; the number grows with how often people link, which the page asks them to do after each conversation.
