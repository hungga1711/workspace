# AI Insights

AI Insights shows a company what its people do with AI, with what data, and whether the work gets done better. It
covers the company's own AI (the AI assistant and the AI features inside workspace) and popular AI chat tools used in the
browser, recorded by the workspace browser extension.

It is built to be the opposite of employee-monitoring software. The rules are in
[ADR 0020](adr/0020-ai-insights-principles.md); this page explains how they work in practice. For the notice to
staff, an internal AI policy and an impact assessment, start from the [templates](ai-insights/templates/).

- [What it records, and what it does not](#what-it-records-and-what-it-does-not)
- [Turning it on](#turning-it-on)
- [What each person sees: Me › My AI](#what-each-person-sees-me--my-ai)
- [What managers and owners see: AI › AI adoption](#what-managers-and-owners-see-ai--ai-adoption)
- [Safety net for sensitive data](#safety-net-for-sensitive-data)
- [Linking AI use to tasks](#linking-ai-use-to-tasks)
- [Did AI help?](#did-ai-help)
- [Topics](#topics)
- [Prompt library and skills map](#prompt-library-and-skills-map)
- [Importing from AI vendors' admin consoles](#importing-from-ai-vendors-admin-consoles)
- [Weekly report](#weekly-report)
- [Without a model, and with one](#without-a-model-and-with-one)
- [Retention, export and deletion](#retention-export-and-deletion)

## What it records, and what it does not

| Recorded | Never recorded |
|---|---|
| The prompt a person sends on a listed AI chat site, at the moment they press send | Screenshots or screen video |
| The answer, only if the company policy turns on "capture responses" (off by default) | Keystrokes, typing speed, mouse movement |
| The site, the model name when the page shows it, the time | Idle time, active time, "productivity" scores |
| Topic, sensitive-data kinds found, one-line summary (if a model is connected) | Other websites, browsing history, other tabs |
| Which task the conversation served, when the person links or confirms it | Text typed and deleted before sending |
| "Did AI help?" when the person answers | The text that the safety net redacted or blocked |
| Safety-net events: who, which site, what kind, how many | Anything before the person connects the extension |

Listed sites: the major AI chat assistants (the extension's `manifest.json` has the exact list). Company-AI use
inside workspace is recorded in the same store with the source `company`.

## Turning it on

1. An admin switches on **AI Insights** in Admin › AI (or at `/setup`). It is off by default. While it is off, the
   gateway answers the extension with `403 monitoring_off` and installed extensions show "not connected".
2. The admin sets the policy: how much managers may read (`topic` or `summary`; nobody reads prompts, [ADR 0027](adr/0027-nobody-reads-prompts.md)), whether answers are captured,
   how long data is kept (7–730 days, default 180), and the safety-net mode. Every policy change notifies everyone.
3. The company publishes a notice to staff (template in [templates/](ai-insights/templates/)) and installs the
   extension: enterprise browser policy for everyone, or the download link in Me › My AI.
4. Each person creates a connection code in **Me › My AI** and pastes it into the extension. Nothing is recorded
   before that. A new code revokes the old one. The person can disconnect at any time.
5. Every page the extension records shows a small notice in the corner.

## What each person sees: Me › My AI

Me › My AI is meant to be useful to the person, not a privacy disclaimer:

- **This week**: what they used AI for, by topic, with the number of conversations per topic and per tool.
- **Tasks AI helped with**: tasks linked to their AI use, and how much faster those finished than their tasks
  without AI (median days to done).
- **Their own warnings**: sensitive data the safety net caught in their prompts, by kind, and what happened
  (warned, redacted, blocked).
- **What managers see**: the very rows a manager reads about them (tool, topic, count and, under `summary`, the
  one line the AI wrote), so it is never a guess. Nobody but the person can read their prompts.
- **Export**: all their AI data as one JSON file.
- **Ask for deletion**: a request admins see and handle; the person sees its state.
- The current policy in plain words, and their extension's connection status.

## What managers and owners see: AI › AI adoption

Managers see their reporting line; admins (holders of `ai.policy.manage`) see everyone.

- Tools, topics, departments and people; company-AI use per feature; cost per person, department and week.
- Sensitive-data warnings and safety-net counts per person and department, never the redacted text.
- **Does AI help?** Tasks finished with AI help against tasks finished without: done, on time, median days to done,
  and the share of conversations rated "helped". It is a correlation (people pick AI for some kinds of tasks); the
  page says so and keeps the per-person view next to it.
- What a manager or admin sees of a conversation depends on the policy, and is never the prompt itself
  ([ADR 0027](adr/0027-nobody-reads-prompts.md)):
  - `topic`: topic, tool and time only.
  - `summary` (default): plus the one-line summary the AI wrote. It exists only when a hosted model is connected;
    without one the conversation shows its topic. The title is not shown: it is cut from the person's first prompt.
- The skills map and the weekly report (below).

## Safety net for sensitive data

The extension checks a prompt in the browser before it is sent, with the same rules the server uses
(`backend/server/src/modules/ai/insight.ts`): personal ID numbers (Vietnamese CCCD/CMND, passports, US SSN,
Singapore NRIC, UK NI numbers, "id number …"), card numbers (Luhn-checked), secrets (passwords, API keys of the
common providers, JWTs, private keys), bank details (Vietnamese STK, account and routing numbers, IBAN with its
check digits, SWIFT/BIC), contact lists (three or more emails or phone numbers, Vietnamese or international), plus
the **company's own keywords** (client names, project codes) that an admin keeps in Admin › AI. The extension downloads the keyword list when it connects and refreshes it with each
batch.

The company picks one mode (`ai_policy.sensitive_mode`):

| Mode | What the person sees |
|---|---|
| `warn` (default) | A warning naming the kinds found; they choose to send anyway or cancel. |
| `redact` | The prompt with the sensitive parts replaced by placeholders such as `[CCCD]` or `[ID]`, `[CARD]`, `[EMAIL]`, `[PHONE]`, `[SECRET]`, `[IBAN]`, `[ACCOUNT]`, shown to them before they press send. |
| `block` | The prompt is not sent; the warning says why. |

Each warned, redacted or blocked send is stored in `ai_safety_events` as person, site, action, kinds and count.
The redacted or blocked text itself is never stored or sent to the server.

Detection is heuristic: it catches common patterns, not everything, and it can flag harmless text.

## Linking AI use to tasks

AI › AI adoption compares tasks done with AI help against tasks done without ([ADR 0011](adr/0011-ai-usage-linked-to-work.md)).
Company-AI features know their task. For AI chat in the browser, three ways add up:

1. **Manual**: the person links a conversation to one of their tasks (from the extension's notice; the
   conversation list that used to offer this in Me › My AI was removed on 2026-11-11).
2. **Hint**: workspace remembers the task the person last opened (in the browser's local storage); when the person
   allows it, the extension sends that task id with the prompt as a hint. An unconfirmed hint is never counted.
3. **Suggestion**: workspace matches the conversation's prompts against the person's open task titles with
   Postgres full-text search and suggests a task. Only a suggestion; the person confirms.

When a link is made, the ai module emits `ai.usage.recorded.v1` with `source: "extension"`, so the work module counts the
task in `task_ai_assists` and in `followup/outcomes` like company-AI help.

## Did AI help?

After a conversation the extension shows one small question, "Did AI help? yes / no / partly". The company
assistant inside workspace asks the same. One tap, never required. The answer is stored on the conversation
(`ai_conversations.helpful`) and feeds the "helped" share in AI › AI adoption and the skills map.

## Topics

Every conversation gets a topic (code, writing, analysis, translation, research, sales, HR, design, planning,
other). Without a model, topics come from keywords in Vietnamese and English. Admins can add and edit topics that
fit the business in Admin › AI (name in both languages and keywords). When the company has connected its own model,
conversations are classified in an hourly batch, not in real time, to keep cost low; the keyword topic stays as the
fallback.

## Prompt library and skills map

- **Prompt library**: on one of their own conversations a person can press "Share this prompt". The prompt is
  redacted with the safety-net rules, they review it, and it goes into a shared library with search and a use
  count. Nothing is shared without that press.
- **Skills map** (managers): per department, people who use AI often and whose conversations are often rated
  "helped", suggested as mentors for colleagues. It lists possible mentors; it is not a ranking.

## Importing from AI vendors' admin consoles

Business plans of AI tools let an admin download usage or compliance exports. Admin › AI › "Import from a provider's
dashboard" reads such a CSV or JSON file, lets the admin map its columns (person e-mail, time, tool, model, prompt
or title, tokens) and records the rows with the source `import`. It also takes a whole **ChatGPT or Claude history
export** (the ZIP or its `conversations.json`, with `users.json` for the emails) without any mapping: one row per
conversation and day with the person's message count and the conversation title, task codes in titles or prompts
noted for linking. Only each day's first message travels to the server; it is used for the title, topic,
sensitive-data kinds and task codes, then dropped. Format and mapping: [ai-insights/provider-import.md](ai-insights/provider-import.md).

## Weekly report

AI › Adoption › **Weekly report** produces one page (HTML, printable to PDF): what AI was used for, which people and
departments, whether it helped, cost, sensitive-data warnings, and three suggested actions. It is also e-mailed to
the people who manage AI: a first report 7 days after the install, then every Monday from 08:00 in the workspace's
time zone, each in the recipient's language (English, Tiếng Việt, 中文, Español). It is on by default; turn it off in
Admin › AI. When there is too little data to compare work with and without AI, the email says so instead of
showing a ratio.

## Without a model, and with one

AI Insights works without any AI provider: recording, topics by keyword, sensitive-data detection and the safety
net, task links and suggestions, helpful ratings, the prompt library, the skills map, imports and the weekly report
all run on the server alone.

With a model connected in Admin › AI connections (the company's own key, API or self-hosted model), it adds one-line
summaries and model-based topics in the hourly batch. Nothing is sent to a model the company did not configure.

## Retention, export and deletion

- Conversations older than the policy's retention are deleted every hour. The side tables (safety-net events, the agent
  audit, and `ai_content_views` from before 2026-11-11, when admins could still open text) are kept 365 days by default (`AI_VIEWS_RETENTION_DAYS`,
  `AI_SAFETY_RETENTION_DAYS`, `AI_AUDIT_RETENTION_DAYS`).
- Each person can export everything about them (JSON) and ask for deletion in Me › My AI.
- Admins can delete all AI Insights data of the company in Admin › AI; switching AI Insights off stops recording.
- Data lives in the `ai` schema of the company's own Postgres; see [database/ai.md](database/ai.md), and
  back it up with the rest of the database.
