# Agent workflows: a harness around the AI

Rebuilt 2026-11-12. A workflow is not only a list of prompts. It is everything around the model that decides whether
its work can be trusted: what it is given, where it runs, what it may read, how its result is checked, when it must
stop, and where the result goes. Questions an AI step asks people are in [agent-questions.md](agent-questions.md).

Code: `backend/server/src/modules/work/workflows.ts` (the run engine, the server's driver and the runner protocol) and
`workflows/` beside it (`model.ts` the model and its validation, `templates.ts` the ready-made workflows, `render.ts`
prompt assembly and verdicts, `resources.ts` the reference material), `http/workflows.controller.ts` (the API), `frontend/web/public/runner/workspace-runner.mjs` (the runner),
`frontend/web/src/components/workflows/` (the UI). A deployment that leaves AI out (`ai` in `DISABLED_FEATURES`) has
no workflows: the gateway answers 404 for `workflows`, `runs`, `runner` and `agent-questions` (`DEPLOY_ROUTES` in
`backend/server/src/modules/gateway/gateway.ts`).

## The model

| Part | What it holds | Why |
|---|---|---|
| **Inputs** | A short form asked when a run starts: text, long text, choice, number, date | The same workflow serves many tasks; what differs per run is asked once, not buried in a prompt |
| **Environment** | `assistant`, `sandbox` or `computer` (below) | Where code may run and what it can reach is a decision, not a side effect |
| **Resources** | Standing instructions (Markdown notes), workspace pages, files (uploaded, or already in the workspace's Drive), other tasks, links (a web page, or a Google Docs / Sheets / Slides / Drive file shared with anyone who has the link), the task's own context | Every AI step reads the company's rules and material instead of guessing them |
| **Steps** | `ai`, `command`, `check`, `approval`, `status` | The pipeline |
| **Guardrails** | Working minutes per run and per step, a token budget, whether the AI may stop to ask | A run never works or waits without end |
| **Output** | Comment on the task, a page in Docs, files attached to the task, subtasks, a task status | The result lands where the work is |

Stored as `agent_workflows.steps` and `agent_workflows.config` (jsonb). `normalizeConfig` turns whatever is stored into
a complete config; `validateWorkflow` refuses what could not run and names the step.

### Steps

| Kind | What it does |
|---|---|
| `ai` | The instruction goes to a model. Options: `model`, `role`, `tools` (company MCP tools), `resources: false`, `ask: false`, `maxOutput`, `timeoutMin`, `retries` |
| `command` | A shell command in the run's working folder. Sandbox and computer only |
| `check` | A verdict on the last result. With `criteria` (one requirement per line) an AI judges; with `command` (runner) the exit code decides. A failed check **sends the work back** to the step that made it, with the issues, up to `attempts` times; after that `onFail` is `stop` (the run fails) or `continue` (it goes on with the issues on record, usually to a person) |
| `approval` | Waits for a person: `editors` (anyone who may edit the task), `owner`, `assignee`, `starter`, or one named person. They approve, or send the work back with a note |
| `status` | Moves the task |

Placeholders in an instruction, filled by `render.ts` for both runners:

| Placeholder | Filled with |
|---|---|
| `{{task}}` | The task (code, title, description) and its workspace context |
| `{{previous}}` | The last result before this step, then any note an approver gave since |
| `{{steps.<key>}}` | The result of any earlier `ai` or `command` step |
| `{{input.<key>}}`, `{{inputs}}` | One input's value, or all of them |
| `{{resources}}` | The workflow's resources. When not placed, they are added before the instruction (unless the step has `resources: false`) |
| `{{answers}}` | People's answers to the run's questions |

An instruction that places neither `{{task}}`, `{{previous}}` nor a `{{steps.<key>}}` gets the task after it, so a
plain sentence ("Draft a reply to the customer") works. In the editor people never type these: references are picked
from a menu (`@`) and drawn as chips (`studio/PromptEditor.tsx`).

The last result of the run is the deliverable: it is what `output` posts, saves and turns into subtasks. Checks and
approvals make no result, so the deliverable is always the work itself.

### Environments

| Kind | Runs on | Commands | For |
|---|---|---|---|
| `assistant` | The server, with the company's AI, as the person who started the run | No | Writing, analysis and review that needs no files or tools beyond the company's connected ones |
| `sandbox` | A runner: a fresh folder per run, in a Docker container when `isolation` is `container` | Yes | Work on files or a repository that should not touch anyone's own computer |
| `computer` | The assignee's own working folder, with their coding agent and their credentials | Yes | Engineering work that ends in a branch and a pull request |

A sandbox names its `host`: `person` (a computer of whoever starts the run) or `company` (a runner the company keeps,
which takes runs anyone starts). A container sandbox also sets `image`, `network` (`on` or `off`), `cpus`, `memoryMb`,
the names of environment variables passed in (`env`, never values) and optionally `agent`, the agent's command inside
the image. Any sandbox may set a git `repo` and `branch` to clone, a `setup` command run once, and `keep`.

A workflow that asks for a container is never run in less: a runner without Docker fails the run at preparation and
says why.

## Reading resources

`resources.ts` builds one reference block per AI step (and per AI-judged check), as the person who started the run:
a page, Drive file or task they cannot open is left out and named as unavailable (a task by its code only). Text is
read from plain text and data files, PDF (unpdf) and Word, Excel and PowerPoint (`extract.ts`, a small zip reader);
other files are listed by name and, on a runner, downloaded into `assets`. Links are fetched by `links.ts` behind the
same fence as link previews (public addresses only, redirects re-checked, size and time caps); a Google link is read
through its export address, and one that is not shared says so. The block has a budget (`RESOURCES_MAX`): the
standing instructions whole, the other sources an equal share of the rest. `POST workflows/links/check` lets the
editor tell at once whether a pasted link can be read.

## Time estimates

With `config.estimate` on (the default) a run carries how long it should take: each step's average working time
over the workflow's last 20 runs that ended `done`, or a typical time by kind of step until it has run (`typicalSeconds`). The
estimate is fixed when the run starts; the run's DTO adds what is left and, while nothing waits for people, when it
should be done. `GET workflows/:id/estimate` gives the same before a run.

## A run

`task_agent_runs` holds one run: its copy of the steps (each with state, input, output, log, timings, what ran and a
history of every attempt), the inputs given, the config as it was at the start, the environment's preparation, the
artifacts handed back and the usage so far. Editing a workflow never rewrites a run.

States: `queued → running → done | failed | cancelled`, with `waiting_approval`, `waiting_input` and `paused` in
between. A failed run can be run again from the step that failed.

What keeps a run honest:

- **Checks send work back.** A failed check resets the step that made the result with the issues attached; that step
  and everything after it run again. Each verdict stays in the step's history.
- **Retries.** An `ai` or `command` step with `retries` runs again after a model error or a non-zero exit.
- **Limits.** A step is stopped after its minutes; the run fails when its working time (waiting for people does not
  count) or its tokens pass the guardrails.
- **Restarts.** A server run in flight when the process stops is picked up again by the `agent-runs-watch` job
  (`watchRuns`, first 20 s after start, then every minute), as the person who started it; the step that was running
  starts over. A runner that goes silent loses its claim and the run goes back to the queue.
- **People.** Any AI step may ask (within the caps of agent-questions.md) unless the guardrail or the step says never.

## Triggers: a workflow that starts by itself

Added 2026-11-13. A run always starts when someone presses Run on a task (or, with `autoStart`, when the workflow is
put on one). `config.triggers` (up to six) lets it also start by itself:

| Kind | Fires when | The task it runs on |
|---|---|---|
| `task` | A task is created, or moves to a chosen status, in chosen projects and with one of chosen labels (none chosen = any). Subtasks and tasks synced from another tool never fire it | That task: the workflow is put on it |
| `schedule` | Every day, or on chosen weekdays, at a time in the workspace's time zone. Missed while the server was down, it still fires up to six hours late, once per day | A new task, named from a title (`{date}` is the day), in a chosen project or as the acting person's own task |
| `hook` | A system outside posts to the workflow's secret address (below) | A new task, made the same way |
| `linked` | A pull or merge request linked to a task (the [integrations hub](../integrations/hub.md)) is first seen open, or seen merged | That task |

Triggers exist only where a run can start with nobody at a computer: the company's AI, or a sandbox on a company
computer. A workflow that runs on a person's own computer keeps none (`normalizeConfig` drops them, the editor says
why). A workflow with a trigger may not have a required input without a default: nobody is there to answer.

**Who the run acts as.** `config.runAs`, set by the server on save (`saveWorkflow`): whoever saved the triggers.
Only someone with `ai.agent.manage` may name another person (an edit by anyone else keeps the person already set),
so editing a workflow never borrows a colleague's access. At fire time that
person is resolved again (a disabled account refuses the fire) and the run starts through the same `startRun` as a
person's Run: they must be able to read and edit the task, the workflow's guardrails apply, and the AI budget is theirs.

**How a fire happens** (`workflows/triggers.ts` the model, `workflow-triggers.ts` the firing). What happened is
written down where it happened, as a `workflow_trigger_fires` row: in the task's own transaction (`tasks.ts`
`onTaskChange`), when a schedule comes due, when a post arrives, when the hub sees a linked request change
(`linkedWorkChanged`). The `workflow-triggers` job (every 10 s, `WORKFLOW_TRIGGERS_INTERVAL_MS`) then starts what is
pending, each in its own transaction. A fire ends `started` with its run, or `refused` with the reason; the
workflow's page lists the latest of both, and the task's history says what started a run.

**What can never happen:**

- *A second run on a task.* `startRun` refuses while one is in progress; the fire is recorded as refused. Two
  workflows waiting for the same change: the first starts, the second is refused.
- *A loop.* Every task change a run makes (a status step, the final move, the task a trigger creates) carries its
  workflow and how deep in a chain it is. A fire that comes from the same workflow is refused ("its own doing"), a
  chain of workflows starting each other ends after three links, and a workflow starts by trigger at most 20 times an
  hour (`TRIGGER_LIMITS`).

**The address for a system outside.** `POST /api/hooks/<token>` on the app's address, no sign-in: the token (`wfh_…`,
192 random bits) is the credential. It is made on the workflow's page by someone who may edit the workflow, shown
once, and stored as a SHA-256 hash; making a new one or removing the trigger stops the old one. The gateway
(`backend/server/src/modules/gateway/gateway.ts`) accepts JSON or text up to 64 KB, 60 posts an hour per address and
120 per caller IP, forwards to the work module's `internal/workflow-hooks/:token`, and answers 202 (or 404 for any
address it does not know). What was posted is cut to 8,000 characters and travels with the run as information: every AI step
reads it inside an `<untrusted_content>` frame it cannot close, told that it is never instructions. Give such a
workflow a check or an approval before anything it writes reaches people.

`GET workflows/:id/triggers` returns who the runs act as, the addresses (never the token) and the latest 20 fires.

## What the agent is doing, live

Added 2026-11-13. While a step runs, the pipeline shows what the agent does, a line per action, and keeps the lines
in the step's Log afterwards. They live in `task_agent_run_events` (`workflows/activity.ts`), not in the run's JSON:
a coding agent takes hundreds of actions in one step, and the page asks only for the lines after the last one it has
(`GET runs/:id/activity?step=<n>&after=<id>`, for anyone who may read the task). The latest 1,500 lines per step stay.

| Kind | What it is | Written by |
|---|---|---|
| `start` | The step begins an attempt; a command step's line is the command | The engine (`advance`) |
| `say` | The agent's own words between two actions | Runner |
| `tool` | An action: the tool's name and what it acts on (a file, a command, a pattern, a company tool's arguments) | Runner, ai module |
| `result`, `error` | How the action ended; `detail` holds what a command printed, or the error | Runner, ai module, the engine when a step fails |
| `note` | A line from whoever drives the step (turns and time at the end) | Runner |
| `draft` | The answer as it is being written: one per step, replaced as it grows, removed when the step ends | ai module |

Where the lines come from:

- **Claude Code on a runner.** The runner starts it with `--output-format stream-json --verbose` and reads each line:
  tool calls become `tool` lines, their results `result` or `error`, text `say`. The step's result is the agent's last
  words, and the model that answered is recorded. Only a command's output is sent as `detail`; for a file the agent
  read, only its length is said, so file contents stay on the computer. An older Claude Code without these options
  runs as before.
- **Any other agent on a runner** may write lines on stderr: `::workspace-activity:: {"kind":"tool","tool":"search","text":"…"}`.
  They never become part of the result. `WORKSPACE_ACTIVITY=1` is set in the agent's environment.
  `workspace-connect.mjs --complete` passes Claude Code's own lines on this way (`::workspace-claude::`).
- **The company's AI** (`assistant`). The work module sends the run and the step with `/workflows/step`; the ai module
  reports each tool call and its outcome at once and the answer being written every two seconds
  (`POST work/internal/runs/:id/activity`, the ai module only). Lines for a step that is no longer at work are dropped.

`GET tasks/:ref/runs` adds `doing` to a run at work: the latest action, words or draft of its current attempt, which
the task's card shows under the step.

### The run's timeline

The pipeline's **Timeline** shows a whole run as one list in the order things happened: who started it and with what,
the environment, each step's attempts with the agent's lines, verdicts and work sent back, questions and answers,
approvals, retries, what was delivered. `run/timeline.ts` builds it from the run (its steps' `history`, its rounds of
questions) and from `GET runs/:id/timeline?after=<id>` (every step's lines in order, 1,000 a page, drafts left out).
Play walks through it at the run's own pace, with no wait longer than a second and a half (`playClock`); a quiet
stretch over a minute is one line that says how long, and whether people were being waited for. Reduced motion shows
the timeline and its bar without Play. "Copy link" gives the task's address with `?run=<id>&at=<ms>`; the task's Agent
card opens the pipeline on that moment.

## Runner protocol (v2)

One program, `workspace-runner.mjs`, signed in with a personal API key. It executes; the server decides. Every
instruction is rendered by the server, so a step reads the same on the server and on a computer.

| Call (under `/api/work/`) | What happens |
|---|---|
| `POST runner/claim` `{ device, protocol: 2, shared, docker, agent, os, version }` | The runner says what it has (Docker, its agent); the server keeps it in `agent_runners` so the pages show which computers are connected. It is handed the oldest queued run it may take: the caller's own, or, for a company runner (`shared`, a person with `ai.agent.manage`), any run whose sandbox host is `company` (a container run only when the runner has Docker). A run that already has a sandbox on another computer waits for that computer. Back: the run, its environment, whether it is coming back (`resumed`), and download addresses for its assets |
| `POST runner/runs/:id/env` | The runner reports preparing the environment: the folder, the container, the clone, the assets, the setup command, and what isolation it actually gave. `failed` ends the run with the reason |
| `POST runner/runs/:id/next` | The server moves past approvals and status steps itself and returns the next step to execute, fully rendered (the instruction or command, the model, the time limit); `collect` when the run is over but for the files of its `out` folder; else the run's status (waiting, paused, done) |
| `POST runner/runs/:id/step` | `log` lines while a step runs, with `activity` (what the agent did since the last report, above), then `done` or `failed` with the output, the exit code and whether it timed out; `ask` for an agent's explicit questions |
| `POST runner/runs/:id/artifacts`, `…/artifacts/:fileId/confirm`, `…/collected` | An upload address for one file of the run's `out` folder (attached to the task as the person the run acts for), its confirmation, and "everything is handed back", after which `next` delivers the result and finishes the run |
| `GET runner/runs/:id` | The run's status and the runner's sign of life: `cancelled` ends the step's process, `paused` lets it finish |

A company runner acts for the person who started each run (their principal is resolved from the identity module), so
comments, task moves and files are theirs, never the runner owner's. The minute's watch (`watchRuns`) picks up server
runs nobody drives (`resumeServerRuns`) and takes back runs whose runner has been silent for 150 seconds
(`reclaimSilentRuns`; twice, then the run fails).

Runners that do not send `protocol: 2` get no runs and are told to update (`RUNNER_PROTOCOL`; an older script of the
same protocol is told a newer one exists, `RUNNER_VERSION`); `workspace-connect.mjs` downloads the current runner on
start. Both scripts are served from `frontend/web/public/runner/`.

## Sandbox layout

```
<runner home>/sandbox/<run id>/
  work/     the working folder of every step (the cloned repository, when the workflow names one)
  assets/   the workflow's files and, with "task files" on, the task's attachments. Read-only in a container
  out/      what the run hands back; attached to the task when the workflow's output says so
```

In a container the folder is mounted at `/run` (`/run/work`, `/run/assets` read-only, `/run/out`); the relative paths
`../assets` and `../out` work in both, and `WORKSPACE_ASSETS` and `WORKSPACE_OUT` hold the absolute ones
(`WORKSPACE_TASK` the task's code). Only the variables the workflow lists by name pass from the runner into the
container. While a run waits for people the container is stopped and the folder kept; the same computer takes the run
back. On the assignee's own computer the working folder is theirs, and assets and `out` are in a temporary folder
whose path the instruction gives. Commands and checks run inside the container. AI
steps run inside it when the workflow names the agent's command in the image; otherwise the runner's own agent works
in the folder, and the run records that it did.

The folder is removed when the run ends unless the workflow keeps it.

## Performance

AI › Workflows › Performance and the line under a workflow's title (added 2026-11-13) answer what the workflows cost
and where they lose time. `workflows/insights.ts` counts everything from the runs themselves, by rules, for a window of
7, 30 or 90 days (`GET workflows/insights?days=&workflowId=`): one bounded read of the newest 3,000 runs, each step
cut down in SQL to its figures (never its text), every run filtered by who may read its task.

- **Tokens** are summed per attempt, so a step that was sent back counts every time it ran, and are kept per model.
  A step that answered without a token count (an agent on someone's computer) is "unknown", never zero.
- **Money** is not computed in the work module. The page asks the ai module what the models cost (`POST ai/spend/quote`:
  the company's price, else the public list price, else null) and multiplies. It is always shown as an estimate, and
  as "unknown" when no model has a price.
- **Time** is split into working and waiting for people (an approval's whole time, an AI step's wait for answers).
- **Suggestions** are rules with thresholds in one place (`RULES`), and need at least four runs: a check that fails in
  half the runs, a step that fails in 30%, a run that waits for people twice as long as it works, a step that takes
  70% of the tokens or 60% of the working time, and a step of the company's AI that writes short answers with the
  main model (the fast model may do).

## Templates

`templates.ts` ships ready-made workflows for engineering, product, operations, marketing, sales, support, HR,
finance, legal and research, in English and Vietnamese (Chinese and Spanish read the English text). They follow four
rules, enforced by `templates.test.ts`:

1. A later step reads what it needs with `{{steps.<key>}}`; nothing is carried along by "keep the text above".
2. The last AI step returns only the deliverable, and only lines meant as subtasks are checkboxes.
3. No AI result reaches the task unlooked at: a check or an approval follows the last AI step.
4. A check's criteria stand on their own. The judge also reads the workflow's reference material and the criteria may
   use `{{input.<key>}}`, but what must be compared with an earlier step's source is corrected first by an AI "verify"
   step that reads it.

## Changing it

- New step field: `model.ts` (`WorkflowStep`, `normalizeSteps`, `validateWorkflow`), the engine, the runner if it
  executes it, the editor, and `frontend/web/src/components/workflows/types.ts`.
- New template: add it to `TEMPLATES` with English and Vietnamese texts; the tests check its placeholders and shape.
- New coding agent for the runner: add an entry to `AGENTS` at the top of `workspace-connect.mjs`.
