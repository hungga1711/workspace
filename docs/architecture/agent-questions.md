# Agent questions: the AI asks before it acts

An AI step of a task's agent workflow can stop and ask the people on the task what it needs, the way a coding agent
asks before it changes code. Added 2026-11-05. Code: `backend/server/src/modules/work/agent-ask.ts` (the protocol, pure
functions), `workflows.ts` beside it (runs; the whole workflow model is in [agent-workflows.md](agent-workflows.md)),
`frontend/web/src/components/workflows/Ask*.tsx`, `TaskAskCard.tsx`, `useOpenAsks.ts`, `components/chat/AskConversation.tsx`.

## What people see

- **Chat sidebar**: while a run waits for answers or an approval, a small **Waiting for you** group (`AskNav.tsx`)
  lists one temporary item per open round or approval the reader may give, named by the task code ("T-142 · AI asks")
  with a dot. It opens `/app/chat/ask/<runId>`, a conversation built
  from the run that reads like any chat (2026-11-11): the AI asks one question a message, its choices are pills under
  the message (its own guess marked "Gợi ý", "Bỏ qua câu này" on an optional one), anything else is typed in the
  composer docked under the thread (Enter sends), and each answer shows as the reader's bubble, changeable until the
  round is sent. A typed last answer sends the round; a picked one waits for **Gửi trả lời**. **Để AI tự quyết** sits
  in the composer. An approval is the same conversation: the AI posts the result as a document (folded when long),
  offers **Duyệt · Gửi yêu cầu sửa · Dừng lượt chạy** as pills, and words typed in the composer go back as a change
  request (or as the note of an approval). The run's steps are one line under the title that opens the full list. A
  new round shows up in the same view; the item leaves the sidebar once the round closes. On phones (no sidebar) the
  same items are a tile at the top of the chat index (`ChatIndex.tsx`).
- **Task page and peek**: an **AI is asking** card under the title with the questions and answer fields in place. The
  Agent card lists the questions with a link to the conversation; the run's pipeline dialog shows the open round on the
  waiting stage and every closed round (question → answer, who, when) on its stage.
- **AI › Workflow**: a run waiting for answers is highlighted in "Đang chạy và gần đây" with **Trả lời**; the
  "waiting" figure counts approvals and questions together.
- **Inbox**: the starter and the assignee get a "needs action" notice (`task.agent_ask`, also pushed); it is settled
  when anyone answers, lets the AI decide, or the run is cancelled.

## No chat rows

The conversation is not a channel. Nothing is written to the chat module: the sidebar item, the conversation and the
task card are all read from the work module (`GET /api/work/agent-questions/open`, `GET /api/work/runs/:id/questions`,
`agentAsks` in the task detail). History stays with the run (the pipeline dialog), so chat stays about people talking.

## Data

- `task_agent_runs.status` gains `waiting_input`. The current step's state is `waiting` (shared with approval steps:
  an AI step only waits for answers, so the UI labels it "AI is asking").
- `task_agent_run_questions` (migration `work/005_agent_questions.sql`): one row per round, with `questions`,
  `answers`, `outcome` (`answered` | `skipped` | `cancelled`), who answered and when. A table rather than a jsonb column
  on the run because the open rounds are read on their own every minute by every signed-in tab (a partial index on
  `closed_at IS NULL` keeps that read tiny), rounds are multi-round history per step, and a row lock settles two people
  answering at once (the second gets 409).

## How the AI asks

One protocol for both runners. Every AI step's instruction ends with `ASK_HINT`: if something essential is unclear and
no reasonable assumption exists, reply only with

````
```workspace-ask
{"questions": [{"text": "Which market?", "options": ["Vietnam", "Singapore"]}, {"text": "Deadline?"}]}
```
````

and stop. `parseAsk` reads that block from the step's output (JSON, a bare list, trailing commas, or one question per
line), or a reply that is only `{"ask": [...]}` / `{"questions": [...]}`; ordinary prose is never taken for questions.
At most 5 questions a round and 6 options a question; a "choice" needs two options.

- **Server runner** (company AI): `driveServerRun` composes the step's prompt (`composePrompt`: the rendered
  instruction, the answers so far, the hint), calls the ai module as before, and parses the reply. A question round
  parks the run; answering kicks the drive again as the person who answered (like approving).
- **Runner** (`frontend/web/public/runner/workspace-runner.mjs`, protocol v2 since 2026-11-12): the server renders
  every step's instruction for the runner too (`runner/runs/:id/next`), with the answers so far and the ask or decide
  hint already in it, so the runner adds nothing. The coding agent prints the block and exits; the runner reports the
  output as usual, the server sees the block and answers `{ status: "waiting_input" }`, and the runner goes back to
  polling. Once answered the run is `queued` again and a runner re-claims it at the same step.
- **Cap** (2026-11-10; one round per run on the first AI step from 11-08 to 11-10): any AI step may ask, and ask again
  after the answers, up to three rounds per step (`MAX_STEP_ROUNDS`) and six per run (`MAX_RUN_ROUNDS`). Over a cap,
  or after "Để AI tự quyết" on that step, the questions reach nobody: the step runs again with `DECIDE_HINT` (assume,
  say what you assumed, do the step); a step that still asks fails the run with "the AI kept asking questions".
- **Step log** (`RunStep.history`): every attempt of a step (its instruction, its reply, model, tokens, how it ended:
  done, asked, decide, failed, cancelled) and what people did on it (answered, let the AI decide, sent back, approved),
  the latest 12, texts clipped. The pipeline's Log tab reads it.
- A step asks only through the block: a coding agent in print mode cannot wait for an answer mid-step, and the block
  works the same for every agent. People can answer from their own AI through the MCP endpoint
  (`get_workflow_run`, `decide_workflow_run` in `backend/server/src/modules/gateway/mcp-tools.ts`), as themselves.

## Who sees and answers

- Seeing: anyone who may read the task (`canReadTask`); the open list (`/agent-questions/open`) only lists rounds the
  reader may also answer.
- Answering (`answerRun`): the person who started the run, the assignee, or anyone with `task.edit` on the task. Every
  required question needs an answer, or "let the AI decide". Cancelling the run closes the open round.

## Events

All on the run (`workspace.work.run`, aggregate = run id):

- `work.run.asked.v1`: a round opened; home notifies `recipientIds` (starter and assignee) with an action notice
  linking to the conversation.
- `work.run.answered.v1`: a round closed (`answered` | `skipped` | `cancelled`); home settles the notices.
- `work.run.waiting.v1`: the run reached an approval step. `waitId` names this wait (a step waits again after its work
  was sent back) and `recipientIds` the people who can approve; home gives each an action notice
  (`task.agent_approval`) linking to the conversation.
- `work.run.decided.v1`: that wait closed (`approved` | `sent_back` | `cancelled`); home settles the notices and drops
  a push about it that was not sent yet.
- `work.run.started.v1`, `work.run.paused.v1`, `work.run.resumed.v1`, `work.run.cancelled.v1`,
  `work.run.finished.v1` (`done` | `failed`): lifecycle, for the audit trail. Registered in
  `backend/packages/contracts/src/events/work.ts`. Task activity rows: `agent_run_asked`, `agent_run_answered`, `agent_run_paused`, `agent_run_resumed`.

## On the phone: notices, and acting from the notification

Added 2026-11-13. A run that waits for a person tells exactly the people who can act, once per wait, in the inbox
("Needs action") and as a push, and the notice is settled for everyone when anyone acts.

| The run waits for | Who is told |
|---|---|
| Answers to an AI step's questions | Whoever started the run and the assignee |
| An approval the step gives to one person (owner, assignee, starter, a named person) | That person |
| An approval open to "anyone who may edit the task" | Of the people on the task (starter, owner, assignee), those who may edit it. Editors cannot be listed; anyone else who may edit finds the run on the task and under "Waiting for you" |

The push says only what kind of thing waits ("An AI result is waiting for your approval"), like every other push.

**Quick actions** (Me › Notifications › "Act from the notification", off by default) add buttons to those pushes:
**Approve** and **Open** for an approval, the two options for a single either/or question. Anything else (sending work
back needs a note, several questions need a form) opens the conversation. With it on, the push also names the task
and the step or the question. It is a choice because a notification's buttons can be pressed on a locked phone, and
because approving from a notification means approving without reading the result.

How a button is made safe (`work/quick-actions.ts`, table `agent_quick_actions`):

- The home module asks the work module for buttons as it sends the push (`POST work/internal/quick-actions`, the home
  module only), and only for a person with quick actions on. A button's token is therefore never in an event, the
  audit trail or a webhook: it is in the push payload, which Web Push encrypts to the device, and in the database as a
  SHA-256.
- A token is for one person, one wait and one action. It works once, for an hour. A new push about the same wait
  replaces the earlier buttons. A step whose work was sent back and waits again is another wait, so an old
  notification cannot approve newer work (409).
- Pressing a button makes the service worker call `POST work/quick-actions/redeem` on the app's own origin: the
  request carries the person's session as well as the token. A copied payload is worth nothing without that session,
  and a session alone still goes through the normal approve and answer calls. A token that is unknown, someone
  else's, used or expired answers the same 404.
- The action then runs `approveRun` / `answerRun` as that person, with the permissions they hold at that moment.
- Anything but a clear yes (signed out, already decided, expired, offline) opens the app on the run.

Buttons need a browser that shows notification actions (Chrome and Edge on Android and desktop). Safari on iPhone
shows the notification without them; a tap opens the conversation, which is laid out for a phone.

## Start, pause, continue, stop (on the task)

The task's Agent card (page and peek) puts **Bắt đầu chạy** right under the picked workflow, draws the run's stages
inline (the same `Graph.tsx` graph, compact and scrolling sideways; a stage opens the pipeline dialog on it) and has
**Tạm dừng / Tiếp tục** and **Dừng** (asked to confirm on the card). Same people as answering.

- `paused` (migration `work/006_agent_run_pause.sql`): pausing is allowed from `queued` or `running` only (else 409).
  The step in progress is not cut off: a server AI call finishes and its result is kept, a local agent's step finishes
  and is reported; then the run holds. The graph shows a pause badge on the line into the next stage.
- Continue (`paused` only, else 409) goes on from the next step: a server run is driven again (unless the call that was
  in flight at the pause is still going, which simply carries on); a local run goes back to its starter's queue, or
  stays with the runner if that runner is still on the step.
- Stop is cancel (409 once the run has ended). The local runner checks `GET /runner/runs/:id` every 4 s during a step
  and kills the step's process group when the run was stopped.
- Restarts: paused and waiting runs survive as they are; queued and running server runs are picked up again as the
  person who started them (`resumeServerRuns`, the step in progress starts over). A server run paused mid-step lost its
  call with the process, so that step goes back to pending and runs again on Continue.

## Cost

One small read per signed-in tab every 60 s while visible, shared by every component that shows it (plus when the tab
comes back and after an answer; `useOpenAsks.ts`), and none when AI is left out at deploy time; the conversation polls
only while its run is live (3 s while the AI works, 10 s while waiting for people). The conversation route loads its
own client code; the sidebar adds a few hundred bytes.

## Tests

`backend/server/src/modules/work/agent-ask.test.ts` (parser, prompt composition, answers) and
`backend/server/test/work/agent-questions.test.ts` (ask → answer → resume on both runners, permissions, round cap,
let-the-AI-decide, cancel).
