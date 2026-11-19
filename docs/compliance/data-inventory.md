# Data inventory

> Not legal advice. Check every row against your installation and fill in the `[brackets]`.

**Controller:** [company] · **Installation:** [URL] · **Server location and operator:** [country, provider] ·
**Backups:** [where, how long] · **Reviewed:** [date]

workspace is self-hosted: one installation per company, data in the company's own PostgreSQL (one schema per module)
and file storage (local disk or the company's S3 bucket). The workspace project and its authors receive nothing.

## Personal data by area

| Area | Data | Stored in | Who can see it | Kept for |
|---|---|---|---|---|
| Accounts | Name, work email, phone (optional), photo, job title, department, manager, role, sign-in history, sessions, 2FA status | `identity`, `employee` | The person; admins; colleagues see the directory fields | Until the account is erased; sessions `AUTH_SESSION_MAX_DAYS` (90); audit `AUDIT_LOG_RETENTION_DAYS` (730) |
| Work | Tasks, comments, history, documents, whiteboards, files, projects, goals | `work`, file storage | Per project and space permissions | Until deleted; task activity `TASK_ACTIVITY_RETENTION_DAYS` (365) |
| Chat and meetings | Messages, files, reactions, read state; meeting recordings if enabled | `chat`, file storage | Channel members | Until deleted; recordings `MEET_RECORDING_RETENTION_DAYS` (365) |
| Time and leave | Check-in/out times, missed check-outs, corrections, leave requests and balances, approvals | `employee` | The person, their managers, HR | [policy, often payroll retention: e.g. 6 years UK, 3–4 years US, 5 years VN] |
| Notifications | Notification items, email digests, push subscriptions | `home` | The person | Read `NOTIFICATIONS_READ_RETENTION_DAYS` (90), unread 180 |
| AI Insights (optional, off until switched on) | Prompts sent on listed AI sites after the person connects the extension; answers only if "capture answers" is on; site, model, time, topic, sensitive-data kinds found, task links, "did AI help?" answers; company-AI use in the app; imported ChatGPT/Claude history (per-day message counts and titles; each day's first message is read for the topic and dropped) | `ai` | The person (Me › My AI); managers at the read-policy level (topic, or topic and the AI's one-line summary); nobody else reads prompts ([ADR 0027](../adr/0027-nobody-reads-prompts.md)) | Policy retention, 7–730 days (default 180), deleted hourly; safety events `AI_SAFETY_RETENTION_DAYS` (365) |
| Local AI usage (optional) | Daily token counts per device from coding tools (Claude Code, Codex), task codes from branch or folder names; no prompt text | `ai` | The person; AI admins | Policy retention |
| Browser errors | Error message, stack, page, browser, user id | `platform` | Admins | `CLIENT_ERRORS_RETENTION_DAYS` (30) |
| Weekly AI report email | Counts only, no conversation text; sent to people who manage AI | email provider | Recipients | Your mail provider's retention |

## Processors and transfers

| Processor | What | Where | Agreement |
|---|---|---|---|
| [Hosting provider] | Server, database, backups | [country] | [DPA link] |
| [Email provider (SMTP)] | Invitations, password resets, digests, AI report | [country] | [DPA link] |
| [AI model provider, if connected] | Text sent to the company AI (assistant, summaries, workflows) | [country] | [DPA, zero-retention terms] |
| [S3 storage, if used] | Files | [country] | [DPA link] |

## People's rights

Each person can see their AI data and exactly what managers see of it (Me › My AI), export it as JSON, ask for deletion, and disconnect the
extension at any time. Admins can erase AI Insights data for the whole company (Admin › AI › Danger zone). Requests for
other data: [contact, process, response time].
