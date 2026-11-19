# Importing AI usage from a provider's dashboard

The browser extension sees AI use in the browser. People also use AI in desktop apps, on phones and through
tools the extension does not cover. Most AI providers' admin consoles can export usage or compliance data for a
company account; Admin › AI › **Import from a provider's dashboard** reads
those exports so they count in AI Insights too.

## What happens to the file

1. The admin picks a CSV or JSON file. The browser reads it; the file itself is never uploaded.
2. workspace guesses which column is which from the header names (below). The admin can change every choice.
3. The first 20 rows are shown as they will be imported.
4. Only the mapped fields of each row are sent, in chunks of 1,000 rows, to `POST /api/ai/insights/imports`.
5. Each row becomes one conversation in AI Insights, owned by the member whose email (or workspace user id)
   matches. Rows without a matching member, without a valid time, older than the retention period or dated in
   the future are skipped and counted.
6. Importing the same file again adds nothing: every row has a stable key built from the person, time, tool,
   model, title, prompt, count and tokens.
7. The log under the form lists recent imports; **Undo** removes every conversation one import added.

The person sees imported rows in Me › My AI like any other conversation (source "Imported from a provider").
Imported rows follow the same company policy as everything else: retention, what managers may read, the
sensitive-data flags, topics.

## Columns

| Field | Required | Header names recognised (case and punctuation ignored) | Notes |
|---|---|---|---|
| Email | one of email / user id | `email`, `user email`, `user_email`, `actor email`, `owner email`, anything starting with `email` | Matched to members case-insensitively |
| workspace user id | one of email / user id | `user id`, `member id`, `actor id` | Only useful for exports you produced yourself |
| Time | yes | `timestamp`, `time`, `date`, `datetime`, `created_at`, `created`, `occurred_at`, `event_time`, `day`, `usage_date`, `last_active` | ISO 8601 (`2026-10-20T08:15:00Z`), `2026-10-20 08:15`, a date, or Unix seconds / milliseconds |
| Tool | no | `tool`, `product`, `app`, `application`, `client`, `source`, `surface`, `feature`, `service` | Decides the source shown in AI Insights; unknown tools show as "Imported" |
| Model | no | `model`, `model name`, `model id`, `engine` | Also used to recognise the tool |
| Conversation title | no | `title`, `conversation title`, `name`, `subject`, `chat title` | Masked like any title |
| Prompt text | no | `prompt`, `message`, `content`, `text`, `input`, `query`, `request`, `user message` | Stored as the conversation's first prompt; classified and checked for sensitive data |
| Messages | no | `count`, `messages`, `message count`, `requests`, `prompts`, `conversations`, `interactions` | For aggregated exports (one row per person per day): the number of prompts that row stands for |
| Tokens | no | `tokens`, `total tokens`, `token count`, `usage tokens`, `input tokens` | Shown as imported usage |
| Cost (USD) | no | `cost`, `cost usd`, `amount`, `spend`, `price`, `usd` | `0.02`, `$0.02`, `0,02` and `1.234,56` all work; counted as "From provider files" in the weekly report |

## Accepted shapes

**CSV**: a header row, then one row per event or per person and day. Comma or semicolon separated, quoted
cells, CRLF or LF, an optional byte-order mark.

```csv
User Email,Timestamp,Product,Model,Message count,Cost (USD)
an.nguyen@example.com,2026-10-20T08:15:00Z,Chat assistant,gpt-4o,12,0.08
binh.tran@example.com,2026-10-20,Desktop app,,3,
```

**JSON**: an array of objects, or an object whose first array property holds them (`{"data": [...]}`,
`{"users": [...]}`). Nested objects are flattened to dotted names up to two levels (`user.email`).

```json
{
  "data": [
    { "user": { "email": "an.nguyen@example.com" }, "created_at": "2026-10-20T08:15:00Z", "model": "claude-sonnet", "messages": 4 },
    { "user": { "email": "binh.tran@example.com" }, "created_at": 1760947200, "product": "mobile", "messages": 1 }
  ]
}
```

## ChatGPT and Claude history exports

A whole chat-history export needs no column mapping; pick the ZIP (or `conversations.json`) and the page recognises it.

| Export | How to get it | What the page reads |
|---|---|---|
| ChatGPT ("Export data", Team or Enterprise workspace export) | ChatGPT settings › Data controls › Export, or the workspace admin console | `conversations.json` (each conversation's `mapping` of messages, `create_time`, `title`, model slug) and `user.json`/`users.json` for the email |
| Claude (Team export) | claude.ai › Settings › Privacy › Export data, or the organisation admin export | `conversations.json` (`chat_messages` with `sender`, `created_at`, `name`) and `users.json` (`uuid` → `email_address`) |

Each conversation becomes one row per UTC day on which the person wrote in it: the time of the first message, the
number of the person's messages that day, the title, the model, and the first message of the day. Assistant answers
are never sent. When the export has no email (a personal export with one user only, or none), the page asks which
person to count it for.

On the server the row is recorded like any import, plus:

- the first message is never stored: it is used for the title, topic, sensitive-data kinds and task codes, then
  dropped;
- task codes in the title or message (T-157) are kept as a suggestion the person can confirm in Me › My AI;
- the messages count in the daily charts at once, so Adoption shows the imported use straight away;
- undoing the import removes its conversations and takes their counts back out of the charts.

## Limits

- At most 2,000 rows per request (the page sends 1,000 at a time) and 1,000,000 rows per file.
- Only admins with `ai.policy.manage` can import or undo, and only while AI Insights is on.
- Text fields are cut to the same sizes as extension prompts (title 500, prompt 20,000 characters).
