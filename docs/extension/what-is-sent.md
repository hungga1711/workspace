# What the browser extension sends

The workspace AI Insights extension records prompts a person sends on AI chat sites and delivers them to the
company's own workspace server. This page lists exactly what leaves the browser, when, and what never does. It is
written from the code in [`frontend/browser-extension/`](../../frontend/browser-extension/) (`content.js`,
`background.js`, `hint.js`); if the two ever disagree, the code is right and this page has a bug.

Principles behind it: [ADR 0020](../adr/0020-ai-insights-principles.md). The feature as a whole, who sees what and
the policy templates: [docs/ai-insights.md](../ai-insights.md).

## When it runs

- **Only on these sites**, listed in `manifest.json` and `sites.js`: chatgpt.com, chat.openai.com, claude.ai,
  gemini.google.com, copilot.com and copilot.microsoft.com, m365.cloud.microsoft, copilot.cloud.microsoft,
  perplexity.ai, chat.deepseek.com, grok.com, meta.ai, poe.com, chat.qwen.ai, kimi.com (kimi.ai, kimi.moonshot.cn),
  doubao.com, you.com, huggingface.co/chat, chat.z.ai, duck.ai. On every other site the extension has no content
  script and reads nothing.
- **Only after the person connects it.** Until a connection code from workspace › Me › My AI is pasted into the
  extension, nothing is queued or sent. The code is `<company server URL>#aim_…`; it is stored in the browser's
  extension storage and nowhere else.
- **Only when the person presses send** (the site's send button or Enter in the composer). Typing, editing, pasting
  and deleting are not recorded; the text is read from the composer at the moment of sending.
- **A notice is on every page it runs on**: a small pill in the bottom-right corner that says whether recording is
  on, what is recorded, and links to the person's own Me › My AI page.

## Where it goes

Every event is sent to one address only: the company's workspace server from the connection code, as
`POST <server>/api/ai-monitor/events` with `Authorization: Bearer aim_…`. Events are queued in extension storage
(at most 500) and sent in batches of 20; if the server is offline they wait for the next send or browser start.
The project maintainers run no server and receive nothing.

## The four event kinds

### A turn (a prompt the person sent)

```jsonc
{
  "url": "https://chatgpt.com/c/abc123",          // the page address without the #fragment
  "conversation": "/c/abc123",                     // the page path; one conversation per page id
  "prompt": "Draft a reply to the customer about…", // the text as it was actually sent, at most 20 000 characters
  "response": null,                                // the answer, only if the company policy keeps answers (see below)
  "model": "",                                     // always empty today
  "at": "2026-10-26T08:12:33.000Z",
  "hint": { "taskId": "task_01HV…", "seenAt": "2026-10-26T07:58:00.000Z" }, // only with the optional task hint
  "redactions": { "personal_id": 1, "contacts": 1 } // only when the company policy redacted something: counts, never the removed text
}
```

- When the company policy is **redact**, `prompt` is the redacted text the person saw and approved in the panel
  (`[CCCD]` or `[ID]`, `[CARD]`, `[SECRET]`, `[EMAIL]`, `[PHONE]`, `[STK]`, `[IBAN]` or `[ACCOUNT]`, `[KEYWORD]`). The original is not sent to
  workspace and, because the extension replaces the composer text before the site's send goes through, not to the
  AI site either.
- **Answers** are sent only if the company turned on "keep answers" (`captureResponses`). They arrive as a second
  turn with an empty `prompt` and the `response` (at most 40 000 characters), once the answer has stopped changing
  for three seconds (at most two minutes after the prompt).
- The **hint** is present only if the person ticked "Suggest the task I have open in workspace" on the options page
  and opened a task in workspace within the last two hours. It is the task id only; the person confirms or rejects
  the link in Me › My AI before it counts.

### A safety event (the sensitive-data filter acted)

```jsonc
{ "kind": "safety", "url": "https://claude.ai/chat/…", "action": "warn", "kinds": ["card"], "count": 1, "at": "…" }
```

`action` is `warn` (the person was asked and may have sent anyway), `redact` or `block`. `kinds` names what was
found (`personal_id`, `card`, `secret`, `contacts`, `bank_account`, `keyword`; the detectors cover Vietnamese and international formats: US SSN, UK National Insurance, Singapore NRIC, Chinese resident ID (with its check character), Spanish DNI/NIE (with the check letter), Mexican CURP and RFC, Brazilian CPF (with check digits), cards by Luhn, IBAN by mod 97, SWIFT/BIC, and mobile numbers from Vietnam, China and any number written with a country code). The text is not included. The
detection runs in the browser; a blocked prompt never leaves it.

### Feedback (one tap on "Did AI help?")

```jsonc
{ "kind": "feedback", "url": "https://gemini.google.com/app/…", "conversation": "/app/…", "helpful": "partly", "at": "…" }
```

Asked once per conversation after its first answer; dismissing the chip sends nothing.

### Link (one tap on "Link this chat to T-157?")

Shown once per conversation when a sent prompt names a task code. Only the code the person already typed goes back,
with their answer:

```json
{ "kind": "link", "url": "https://claude.ai/chat/…", "conversation": "/chat/…", "code": "T-157", "decline": false, "at": "…" }
```

workspace links the conversation only if the person can read that task; `"decline": true` drops the suggestion.

## What comes back

Every batch is answered with the company's current policy, which the extension stores and applies from then on:

```json
{ "accepted": 3, "captureResponses": false, "sensitiveMode": "redact", "keywords": ["Sao Mai", "Project Delta"] }
```

`keywords` are the company's own terms (client names, project codes) to watch for; at most 500. A `401` or `404`
means the code was revoked or the server changed, and the extension marks itself disconnected.

## What is never sent

- Page content other than the prompt the person sent: other messages, the sidebar, documents, images, files.
- Keystrokes, drafts that were not sent, clipboard contents, time on page, idle time, screenshots.
- Anything from other tabs or other sites. The optional task hint reads one value (`workspace.lastTaskSeen`) from
  the company's own workspace page and only after the person granted that origin on the options page.
- The parts removed by redaction, or any text at all from a warned or blocked prompt.
- Browser history, cookies, sign-in details of the AI site, the AI site's own identifiers (other than the page path).
- Anything to the project maintainers or to a third party. The only destination is the server in the connection code.

## Who sees it, and how to stop

- The person sees exactly what managers see about them in workspace › Me › My AI, can export all their data as JSON and
  can ask for it to be deleted (handled by an admin). Managers see what the company policy allows: topic only, or
  the topic and a one-line summary written by AI. Nobody but the person can read their prompts.
- Retention is set by the company (default 180 days); older records are pruned hourly on the server.
- **Disconnect**: open the extension and press *Disconnect*. That removes the server address, the code, the queue,
  the policy and the task hint from the browser; the pill on AI pages then says it is not connected. Creating a new
  code in Me › My AI revokes the old one. Removing the extension from the browser removes its storage with it.

Privacy policy for the store listing: [privacy-policy.md](privacy-policy.md).

---

## Tiếng Việt: tiện ích gửi đi những gì

- **Chỉ chạy** trên các trang chat AI liệt kê trong `manifest.json` (ChatGPT, Claude, Gemini, Copilot, Perplexity,
  DeepSeek, Grok, Meta AI, Poe, Qwen, Kimi, Doubao, You.com, HuggingChat, Z.ai, Duck.ai). Trang khác không có script nào của tiện ích.
- **Chỉ sau khi bạn tự kết nối** bằng mã lấy ở workspace › Của tôi › AI, và **chỉ lúc bạn bấm gửi**. Gõ, sửa, dán
  mà chưa gửi thì không ghi. Trang nào đang ghi đều có thông báo ở góc dưới bên phải.
- **Chỉ gửi về một nơi**: máy chủ workspace của công ty trong mã kết nối. Người làm dự án không nhận gì.
- **Ba loại sự kiện**: câu bạn gửi (đúng nội dung đã gửi, đã che nếu chính sách là che; câu trả lời chỉ khi công ty
  bật giữ câu trả lời); sự kiện an toàn (chỉ loại dữ liệu và số lần, không có nội dung); một chạm "AI có giúp không?".
- **Không bao giờ gửi**: nội dung khác trên trang, phím gõ, bản nháp, clipboard, ảnh màn hình, tab khác, phần đã bị
  che, lịch sử trình duyệt, cookie.
- **Bạn thấy đúng những gì quản lý thấy** trong Của tôi › AI (chủ đề và câu tóm tắt do AI viết, không ai đọc được
  câu hỏi của bạn), xuất JSON, yêu cầu xoá. **Ngắt kết nối**
  bằng nút *Ngắt kết nối* trong tiện ích; mọi thứ lưu trong trình duyệt bị xoá ngay.
