# AI on people's computers

A company's people already have AI on their own computers: a command-line agent (Claude Code, Codex, Gemini CLI…)
or a local model (Ollama, LM Studio…). workspace connects it **once per computer**, with one pasted line, for four
things. None of them needs a cloud key, and three need no company AI at all.

| What | How it works | Needs |
|---|---|---|
| **Run workflows** | A task's agent workflow, started with Run, is done by the AI on the assignee's computer (`workspace-runner.mjs`). | A connected computer with any AI |
| **Ask AI** | The assistant answers with the company's AI (everyone's default: a model server on the workspace server, or the AI on an admin's own connected computer), or, for a person's own questions, the AI on their own computer. | Admin › AI: one click on what was found; each person: AI › Connect › "My questions go to" |
| **Track tokens** | Daily token counts per tool and model, and per task when a branch or folder names one (`workspace-usage.mjs`). Counts only. | A connected computer |
| **Stop sensitive data** | ID numbers, cards, secrets, bank details and the company's keywords are checked before text reaches an AI: in the browser (the extension) and on the computer. | AI Insights on (Admin › AI) |

## Connecting a computer (each person)

AI › Connect › **Connect this computer** creates a personal key for that computer and shows one line:

```bash
curl -fsSL https://work.example.com/runner/workspace-connect.mjs -o workspace-connect.mjs && node workspace-connect.mjs "https://work.example.com#wos_…"
```

`workspace-connect.mjs` (Node 22+, no dependencies) then:

1. looks for the AI on the computer, so nobody picks from a list or types an address;
2. tells the workspace what it found, every minute (the page shows the computer within seconds);
3. keeps the workflow runner and the token collector running, and restarts them if they stop;
4. adds the safety-net hook to Claude Code (`--no-guard` skips it);
5. answers the questions the workspace sends to this computer: its owner's own, when they chose its AI for them, and
   everyone's, when an admin chose it for the assistant.

Ticking "Start with the computer" adds `--install` (macOS LaunchAgent, Linux systemd user unit, Windows scheduled
task); without it the program runs in the window it was pasted in. `--status` prints what was found, `--uninstall`
removes the autostart, the hook and the saved code. Everything it keeps is in `~/.workspace-ai`.

**Disconnect** on the page forgets the computer and revokes the key it signed in with; its program stops by itself.

## Which AI is found

Two registries at the top of `frontend/web/public/runner/workspace-connect.mjs`. Adding a kind is adding an entry.

| Kind | Found by | Workflows | Answers | Tokens | Safety net |
|---|---|---|---|---|---|
| Claude Code | `claude` on PATH | yes | yes | its own logs | prompts typed in it (hook) and workflow steps |
| Codex | `codex` on PATH | yes | yes | its own logs | workflow steps only |
| Gemini CLI | `gemini` on PATH | yes | yes | its own logs | workflow steps only |
| opencode | `opencode` on PATH | yes | yes | its own logs | workflow steps only |
| Cursor Agent, Qwen Code, GitHub Copilot CLI | `cursor-agent`, `qwen`, `copilot` on PATH | yes | yes | not read | workflow steps only |
| Ollama, LM Studio, Jan, llama.cpp / LocalAI, GPT4All, vLLM, KoboldCpp, text-generation-webui | their usual port answering `/v1/models` on 127.0.0.1 | yes | yes | counted by the connect program for the answers it asked for | nothing leaves the computer |

- A person with several picks which one runs workflows (AI › Connect, on the computer's row); otherwise the first
  command-line agent, else the first model server.
- "Workflow steps only": the step's text is checked before it is handed to an AI outside the computer (blocked or
  redacted by the company's rule). Prompts a person types directly into those tools are not checked: only Claude Code
  offers a hook that can stop a prompt.
- A model server keeps no usage log, so only the answers workspace asked it for are counted (tool "Local model");
  what a person does in the server's own app is not.

## Ask AI: what an admin sees (Admin › AI)

**AI on computers** lists what is already running, each with a **Use** button:

- *On this server*: model servers the workspace server reaches on its own machine or the Docker host
  (`GET ai/connections/discover`). Use creates an ordinary self-hosted connection.
- *On your computer*: the AI found on the admin's own connected computers. Use creates a `device` connection
  (`POST ai/local/connect/use`): the assistant's questions are handed to that computer and it answers
  (`device-hub.ts`). Only the admin's own computer can be chosen, because everyone's questions go there; it must stay
  on. It answers with text only (no tools, no images), like a small model, and the gateway falls back to the next
  connection when it is off.

API keys and other addresses stay where they were, in the list under that card.

## Ask AI: each person's own AI (AI › Connect)

The company's AI is everyone's default, not everyone's only choice. Under **Ask AI**, "My questions go to" lists the
company's AI and every AI found on the person's own computers (each model of a model server on its own). A choice
(`PUT/DELETE ai/local/connect/personal`, table `ai_personal_choice`) sends that person's own questions to their
computer, text only like any computer's AI; their usage is still metered as theirs (provider `device`). While the
computer is off, the company's AI answers and the card says so. Nobody else's question, and no background job, ever
goes to it (`personal-ai.ts`). Admin › AI › "People's own AI" turns it off for everyone (`ai_policy.allow_personal_ai`;
choices are kept).

## Answers as they are written

Ask (AI › Ask) shows an answer as it is written. A question for a computer carries `stream: true`; while its AI writes, the
connect program sends the answer so far at most every 300 ms (`POST ai/local/connect/jobs/:id/part { text }`, the whole
text each time; reasoning between `<think>` tags is left out on the server), then the finished answer as before. Model
servers stream through their OpenAI API; Claude Code through `--output-format stream-json --include-partial-messages`
(an older version without it answers at the end); other command-line agents show their output as they print it.
When the person presses stop, the answer to the next `part` is `{ stop: true }`: the program stops its AI (the process,
or the request to the model server) and sends nothing more. A program from before this answers at the end, as before.

## The safety net on a computer

`POST ai/local/guard { tool, text }` applies the same rules as the extension (`insight.ts`: `detectSensitive`,
`redactWithCounts`) and the same company setting:

| Company rule | Prompt typed in Claude Code | Workflow step sent to a cloud agent |
|---|---|---|
| Warn | goes through, counted as a warning (a terminal hook cannot ask "send anyway?") | goes through, counted |
| Redact | stopped; the redacted text is shown to send instead | the redacted text is sent |
| Block | stopped | the step fails with the reason |

Each case is one row in `ai_safety_events` (source `local`), with kinds and a count, never the text. When the
workspace cannot be reached the text goes through: a server that is down must not stop anyone's work.

## What is sent

- The heartbeat: computer name, operating system, which AI was found (names and model names), and whether the three
  helpers run. No paths, no file names.
- Token counts: see `workspace-usage.mjs` (daily totals per tool and model; a task code when a branch or folder
  names one).
- Workflow steps: as before, the step's output and log go back to the task.
- The guard: the text to check goes to the company's own workspace server, is checked, and is not stored.

Code: `backend/server/src/modules/ai/local-connect.ts`, `device-hub.ts`; `frontend/web/src/components/ai-hub/ConnectView.tsx`,
`components/admin/AiLocalAdmin.tsx`; migration `ai/012_local_connect.sql`. Tests: `backend/server/test/ai/local-connect.test.ts`,
`frontend/web/e2e/ai-connect.spec.ts`.
