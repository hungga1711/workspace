# workspace AI Insights (browser extension)

Records what people do with ChatGPT, Claude, Gemini, Copilot (and Microsoft 365 Copilot), Perplexity, DeepSeek, Grok, Meta AI, Poe, Qwen, Kimi, Doubao, You.com, HuggingChat, Z.ai and Duck.ai for their
company, with a notice on every one of those pages. It sends each prompt (and the answer, when the company's policy
says so) to the company's workspace, where managers see topics and summaries in Công việc › AI and the person sees
everything recorded about them in Của tôi › AI.

## Sites

One entry per site in [`sites.js`](sites.js): its hosts, the composer, the send button and where an answer appears.
Adding a site is adding an entry there, its hosts to `manifest.json` (`host_permissions` and `content_scripts.matches`)
and its id to the server's sources (`backend/server/src/modules/ai/insight.ts`: `SOURCES`, `sourceFromHost`), plus its
name in `frontend/web/src/lib/ai-sites.ts`. Tests fail when these disagree (`e2e-extension/sites.spec.ts`,
`backend/server/test/ai/insight.test.ts`).

Sites change their pages without notice, so nothing depends on a selector alone. On every site the extension also
takes the text field the person is typing in as the composer (a textarea, a rich-text editor or a one-line input) and
a send-looking button next to it as the send button; Enter in the composer always counts. The safety net (warn, redact,
block) runs on all of them the same way.

How each entry was checked on 2026-11-11 (a page that opens without signing in was read in a headless browser; the
others sit behind a sign-in or a bot check and keep selectors from the sites' known markup):

| Site | Hosts | Checked on the live page |
|---|---|---|
| ChatGPT | chatgpt.com, chat.openai.com | No (bot check); selectors unchanged from the version in use |
| Claude | claude.ai | No (bot check); selectors unchanged from the version in use |
| Gemini | gemini.google.com | Yes: the composer (`.ql-editor`, a rich-text editor) |
| Copilot | copilot.com (copilot.microsoft.com redirects there) | Address only: the redirect was seen, the chat needs a sign-in |
| Microsoft 365 Copilot | m365.cloud.microsoft, copilot.cloud.microsoft | No (sign-in) |
| Perplexity | www.perplexity.ai, perplexity.ai | Yes: the composer (a rich-text editor) |
| DeepSeek | chat.deepseek.com | No (sign-in) |
| Grok | grok.com | No (bot check) |
| Meta AI | www.meta.ai, meta.ai | Yes: the composer (a one-line input) and the Send button |
| Poe | poe.com | No (sign-in) |
| Qwen | chat.qwen.ai | Yes: the composer (`textarea.message-input-textarea`) |
| Kimi | www.kimi.com, kimi.com, kimi.moonshot.cn, kimi.ai | Yes: the composer (`.chat-input-editor`) |
| Doubao | www.doubao.com | No (not offered in this region) |
| You.com | you.com | Yes: the composer (a one-line input) and its submit button |
| HuggingChat | huggingface.co/chat | Yes: the composer and the Send button |
| Z.ai | chat.z.ai | Yes: the composer (`#chat-input`) and `#send-message-button` |
| Duck.ai | duck.ai | Yes: the composer and its submit button |

"Checked" means the element was found on the page; sending a real prompt on a real account was not part of it.

The notice, the options page, the safety-net panel and the feedback chip follow the browser's language
(`_locales/en`, `vi`, `zh_CN`, `es`; English is the default).

- Install for everyone: Chrome/Edge enterprise policy `ExtensionInstallForcelist` (Google Admin console,
  Intune; see [enterprise-install.md](../../docs/extension/enterprise-install.md)), or load `frontend/browser-extension` unpacked for a pilot. `pnpm --filter @workspace/web ext:zip` builds
  `frontend/web/public/downloads/workspace-ai.zip` for the download link in AI › Kết nối and Của tôi › AI; CI and the Docker image
  build it from this folder, so the zip is never committed. Its version is `manifest.json` › `version`, kept equal to
  the workspace release.
- Connect: each person creates a connection code in workspace › AI › Kết nối (or Của tôi › AI) and pastes it into the
  extension. The code is `<app url>#aim_…`; creating a new one revokes the old one.
- Nothing is recorded before the code is pasted, and only when the person presses send.
- Task links: a prompt that names a task code (`T-157`) shows a "Link this chat to T-157?" chip once per
  conversation. Linking counts the chat for that task only if the person can see it in workspace; "Not this task"
  drops the suggestion. Ignored, it waits in Me › AI.

Documents: [what the extension sends](../../docs/extension/what-is-sent.md) (field by field), the
[privacy policy](../../docs/extension/privacy-policy.md) for the stores, and the [store listing kit](../../docs/extension/store-listing.md)
(Chrome Web Store, Firefox Add-ons, Edge: fields, permission justifications, reviewer notes, screenshots).

## Safety net for sensitive data

Before a prompt leaves, the extension checks it for ID numbers (CCCD/CMND, passport, US SSN, Singapore NRIC, UK NI
number, "id number …"), card numbers (Luhn), passwords, API keys and JWTs, bank details (STK, account and routing
numbers, IBAN with its check digits, SWIFT/BIC), contact lists (emails, Vietnamese and international phone numbers)
and the company's own keywords (Admin › AI). What happens is the company's
choice in Admin › AI, downloaded with every batch:

| Mode | What the person sees | What workspace receives |
|---|---|---|
| Warn (default) | "This looks like … Send anyway?" | the prompt if they send, and a `safety` event (`warn`, kinds) |
| Redact | a panel with the text where each part is replaced by `[CCCD]` or `[ID]`, `[CARD]`, `[SECRET]`, `[EMAIL]`, `[PHONE]`, `[STK]`, `[IBAN]` or `[ACCOUNT]`, `[KEYWORD]`; "Send the redacted text" puts it in the composer and sends it | the redacted prompt with `redactions` counts; never the removed parts |
| Block | an explanation; nothing is sent to the AI site | a `safety` event (`block`, kinds), no text |

The rules mirror `backend/server/src/modules/ai/insight.ts` (`detectSensitive`, `redactWithCounts`): the rule table
in `content.js` is a byte-for-byte copy of `SENSITIVE_RULES` there (and in `frontend/web/src/lib/sensitive.ts`), so
change all three together. Vietnamese forms keep the placeholders Vietnamese users know (`[CCCD]`, `[STK]`); the
international ones read `[ID]`, `[IBAN]`, `[ACCOUNT]`.

## Did AI help, and for which task

- After the first answer in a conversation, a small chip asks "Did AI help? Yes / Partly / No" (once per
  conversation, dismissible). The tap is stored on that conversation.
- Optional, off until the person ticks it on the options page: "Suggest the task I have open in workspace". The
  browser then asks for permission to read that one workspace origin, and `hint.js` copies the id of the task opened
  last (`localStorage["workspace.lastTaskSeen"]`, written by the web app). A prompt sent within two hours carries it
  as a hint, which the person confirms in Của tôi › AI before it counts for that task.

## Events (POST `<app url>/api/ai-monitor/events`, `Authorization: Bearer aim_…`)

```jsonc
{ "events": [
  { "url": "…", "conversation": "/c/…", "prompt": "…", "response": null, "model": "", "at": "…",
    "hint": { "taskId": "…", "seenAt": "…" }, "redactions": { "personal_id": 1 } },          // a turn (kind omitted)
  { "kind": "safety", "url": "…", "action": "warn" | "redact" | "block", "kinds": ["card"], "count": 1, "at": "…" },
  { "kind": "feedback", "url": "…", "conversation": "/c/…", "helpful": "yes" | "no" | "partly", "at": "…" }
] }
```

The answer is `{ accepted, captureResponses, sensitiveMode, keywords }`. A `403` means the company switched AI
Insights off: the extension drops what it queued, shows "not recording" and asks again later. A `link` event
(`{ kind: "link", conversation, code, decline }`) is the answer to "Link this chat to T-157?".

## Test

`pnpm --filter @workspace/web test:ext` loads this folder unpacked in headless Chromium against stand-in chat pages
served at every host in the registry and a fake events endpoint (`frontend/web/e2e-extension/`): a prompt is recorded
on Enter and on the send button on every host, block mode stops a card number on every site, and a capture made while
a batch is being sent is not lost.
