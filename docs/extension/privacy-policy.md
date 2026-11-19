# Privacy policy: workspace AI Insights browser extension

Last updated: 2026-10-26. Applies to the extension published as "workspace AI Insights" for Chrome, Edge and
Firefox, built from [`frontend/browser-extension/`](../../frontend/browser-extension/) in this repository.

## Who this policy is about

The extension is part of [workspace](../../README.md), open-source (MIT) work-management software that a company
installs on its own server. The extension sends data to **that company's server only**. The people who maintain
the workspace project do not run a server for it, do not receive any data from the extension, and cannot see what
any installation records. When this policy says "the company", it means the organisation that runs the workspace
server you connected the extension to; that organisation is the data controller.

## What the extension collects

Only after you paste a connection code from your company's workspace (Me › My AI) into the extension, and only on the
AI chat sites listed in the extension's manifest (ChatGPT, Claude, Gemini, Copilot, Perplexity, DeepSeek, Grok, Meta AI,
Poe, Qwen, Kimi, Doubao, You.com, HuggingChat, Z.ai, Duck.ai):

- **The prompts you send** on those sites, as sent (if the company policy redacts sensitive data, the redacted
  version), with the page address, the conversation's page path and the time.
- **The AI's answers**, only if the company has turned on "keep answers" in its policy.
- **Safety-net events**: that a prompt was warned about, redacted or blocked, which kinds of sensitive data were
  found (ID number, card number, secret, contact details, bank account, company keyword) and a count. Not the text.
- **Your one-tap answer** to "Did AI help? Yes / Partly / No", if you give one.
- **An optional task hint**: if you tick "Suggest the task I have open in workspace" and grant the browser permission
  for your company's workspace address, the id of the task you last opened there. Nothing else from that page.

The full list of fields, with examples, is in [what-is-sent.md](what-is-sent.md).

## What it does not collect

Nothing before you press send; nothing on other websites; no keystrokes, drafts, clipboard, screenshots, browsing
history, cookies, time on page or idle time; no part of a prompt that was redacted or blocked; nothing about the AI
site's account you are signed in to.

## Why

So that the company can see what AI is used for, whether company data is going into outside AI tools, and whether AI
helps work get done, and so that you can see the same about yourself. The company's reasons and rules are in the
notice and policy it gives you (templates: [docs/ai-insights/templates/](../ai-insights/templates/)).

## Where the data goes and who sees it

- Data is sent over HTTPS to the workspace server named in your connection code and stored there. It is not sent to
  the extension's authors, to the AI site, or to any third party by the extension.
- On that server, you see everything recorded about you in Me › My AI, including exactly what managers see.
  Managers and admins see what the company policy allows: the topic only, or the topic and a one-line summary. Nobody
  but you can read your prompts.
- If the company connects its own AI model to workspace, recorded prompts may be sent to that model, on the
  company's account, to produce summaries and topics. The extension itself never calls an AI model.

## Retention and your choices

- The company sets how long records are kept (default 180 days); older records are deleted automatically.
- In Me › My AI you can export everything recorded about you as JSON and request deletion, which an admin carries out.
- You can disconnect at any time with the *Disconnect* button in the extension. This deletes the server address, the
  connection code, the unsent queue, the policy and the task hint from your browser. Removing the extension does the
  same.

## Data stored in the browser

The extension keeps in the browser's extension storage: the server address and connection code, up to 500 unsent
events, the company's current policy (whether answers are kept, the sensitive-data mode, the keyword list), the
task-hint setting and last task id, and a list of conversations where "Did AI help?" was already asked. None of this
is synced to any account.

## No sale, no advertising, no tracking

The extension contains no analytics, advertising or tracking code, loads no remote code, and sells or shares no data.

## Changes and contact

Changes to this policy are made in this file in the repository, with its history visible in Git. Questions and
reports: open an issue or discussion in the repository, or report a security problem privately as described in
[SECURITY.md](../../SECURITY.md). For questions about how your company uses the data, contact your company.
