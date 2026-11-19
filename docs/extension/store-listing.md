# Store listing: Chrome Web Store and Firefox Add-ons

Everything to paste into the developer dashboards. The extension
has no build step: the folder [`frontend/browser-extension/`](../../frontend/browser-extension/) is the extension;
`pnpm --filter @workspace/web ext:zip` zips exactly the files the manifest uses.

Review takes days (Chrome) to weeks (Firefox, with source review), so submit at least two weeks before the release
you want to announce.

## Checklist

- [ ] `manifest.json` › `version` equals the workspace release being launched (`1.0.0`); the release workflow bumps it with the other manifests (`tooling/scripts/release.mjs`).
- [ ] `pnpm --filter @workspace/web ext:zip` → `frontend/web/public/downloads/workspace-ai.zip` (upload this).
- [ ] `pnpm --filter @workspace/web test:ext` green.
- [ ] Screenshots 1280×800 (Chrome accepts 1280×800 or 640×400; Firefox any size up to 2400×1800) from
      `docs/extension/screenshots/` (regenerate: `EXT_SHOTS=1 pnpm --filter @workspace/web test:ext`; see
      [screenshots/README.md](screenshots/README.md)).
- [ ] Promo tile 440×280 (Chrome, optional but shown in search): crop of `docs/assets/social-preview.png` with the
      extension name; marquee 1400×560 optional.
- [ ] Privacy policy URL live: `https://github.com/hungga1711/workspace/blob/main/docs/extension/privacy-policy.md`.
- [ ] Support URL: `https://github.com/hungga1711/workspace/discussions`.
- [ ] Developer account e-mail verified; for Chrome the one-time registration fee paid.
- [ ] After approval: put the store links in `frontend/browser-extension/README.md`, README "Install" and the
      download hint in Me › My AI (the zip stays for enterprise force-install and pilots).

## Chrome Web Store

**Name** (45 max): `workspace AI Insights`

**Summary** (132 max, 131 used):
`See how your team uses ChatGPT, Claude, Gemini and Copilot at work, with a visible notice and a filter that stops sensitive data.`

**Category:** Productivity › Workflow & Planning (fallback: Productivity › Tools)

**Language:** English (the extension's default locale is `en`); add Vietnamese, Simplified Chinese and Spanish as
listing languages with the fields at the end of this page. The package ships `_locales/en`, `vi`, `zh_CN` and `es`.

**Detailed description:**

```
workspace AI Insights is the browser part of workspace, open-source (MIT) work-management software that a company
installs on its own server. It lets a company see what its people do with AI chat tools and whether AI helps work
get done, without surveillance: nothing is recorded until each person connects the extension themselves, every
recorded page shows a notice, and each person sees everything recorded about them.

What it does
• On ChatGPT, Claude, Gemini, Copilot, Perplexity, DeepSeek, Grok, Meta AI, Poe, Qwen, Kimi, Doubao, You.com,
  HuggingChat, Z.ai and Duck.ai, it records the prompt you send (and
  the answer, only if your company's policy keeps answers) to your company's own workspace server.
• Sensitive-data filter: before a prompt leaves the browser it is checked for ID numbers (Vietnamese CCCD, passports, SSN, NRIC, NI), card numbers,
  passwords and API keys, bank accounts and IBANs, contact lists and your company's own keywords. Your company picks warn, redact or block. Redaction
  shows you the text that will be sent, with the sensitive parts replaced by [ID], [CARD], [SECRET], [EMAIL], [IBAN]…
• One tap after an answer: "Did AI help? Yes / Partly / No".
• Optional: link a conversation to the workspace task you had open, which you confirm in workspace.

What it never does
• Nothing is recorded before you paste the connection code from workspace › Me › My AI, and nothing before you press
  send. No keystrokes, drafts, screenshots, browsing history, other tabs or other sites.
• The only destination is your company's server. The extension's authors run no server and receive nothing. No
  analytics, no advertising, no remote code.
• A blocked prompt never leaves the browser; the parts removed by redaction are never sent anywhere.

Transparency
• A notice on every AI page where it runs says whether recording is on and what is recorded.
• workspace › Me › My AI shows you every recorded conversation and exactly what managers see of it, and lets you export or ask
  for deletion. Disconnect at any time with one button; that wipes everything the extension stored.

Requires a workspace server run by your company (https://github.com/hungga1711/workspace). What is sent, field by
field: https://github.com/hungga1711/workspace/blob/main/docs/extension/what-is-sent.md
```

**Single purpose:** Records the prompts a person sends on AI chat sites to their company's own workspace server,
after the person connects it, with a filter for sensitive data.

**Permission justifications**

| Permission | Why |
|---|---|
| `storage` | Keeps the server address and connection code the person pasted, the queue of unsent events (at most 500), the company's policy (keep answers, sensitive-data mode, keyword list) and the "Did AI help?" asked list. Nothing is synced. |
| `scripting` | Registers the optional task-hint script (`hint.js`) on the company's own workspace origin, only after the person ticks the option and the browser grants that origin; unregisters it when the option is cleared or the extension is disconnected. |
| Host `https://chatgpt.com/*`, `https://chat.openai.com/*` | Runs the content script on ChatGPT to catch the send action, read the prompt at that moment, show the notice and the safety-net panel. |
| Host `https://claude.ai/*` | Same, on Claude. |
| Host `https://gemini.google.com/*` | Same, on Gemini. |
| Host `https://copilot.microsoft.com/*`, `https://copilot.com/*`, `https://www.copilot.com/*` | Same, on Copilot (the old address redirects to the new one). |
| Host `https://m365.cloud.microsoft/*`, `https://copilot.cloud.microsoft/*` | Same, on Microsoft 365 Copilot. |
| Host `https://www.perplexity.ai/*`, `https://perplexity.ai/*` | Same, on Perplexity. |
| Host `https://chat.deepseek.com/*` | Same, on DeepSeek. |
| Host `https://grok.com/*` | Same, on Grok. |
| Host `https://www.meta.ai/*`, `https://meta.ai/*` | Same, on Meta AI. |
| Host `https://poe.com/*` | Same, on Poe. |
| Host `https://chat.qwen.ai/*` | Same, on Qwen. |
| Host `https://www.kimi.com/*`, `https://kimi.com/*`, `https://kimi.moonshot.cn/*`, `https://www.kimi.ai/*`, `https://kimi.ai/*` | Same, on Kimi. |
| Host `https://www.doubao.com/*`, `https://doubao.com/*` | Same, on Doubao. |
| Host `https://you.com/*`, `https://www.you.com/*` | Same, on You.com. |
| Host `https://huggingface.co/chat/*` | Same, on HuggingChat (only the chat, not the rest of Hugging Face). |
| Host `https://chat.z.ai/*` | Same, on Z.ai. |
| Host `https://duck.ai/*` | Same, on Duck.ai. |
| Optional host `https://*/*`, `http://*/*` | The company's workspace server has a different address for every company, unknown in advance. The extension never requests the wildcard: when the person ticks "Suggest the task I have open in workspace", it requests **only the one origin** from the connection code (`https://work.example.com/*`), and that origin is used solely to read the id of the last opened task. `http://*/*` covers a server on the company network without HTTPS (e.g. `http://192.168.1.20`) and local development; again only that one origin is ever requested. Without the option ticked, no optional permission is ever requested. |

**Remote code:** No. All code ships in the package; nothing is fetched or evaluated at runtime.

**Data usage disclosures** (Privacy practices tab):

- Collects: *Personally identifiable information* (prompts may contain whatever the person typed); *Authentication
  information* (the connection code, a bearer token for the company's server); *User activity* (the prompts sent on
  AI sites and the one-tap feedback). Not collected: health, financial and payment information (card numbers are
  detected and redacted or blocked on the device, never stored by design), location, web history, personal
  communications outside the AI sites, website content other than the prompt.
- Certifications: ☑ not sold to third parties; ☑ not used or transferred for purposes unrelated to the single
  purpose; ☑ not used or transferred to determine creditworthiness or for lending.
- Privacy policy URL: `https://github.com/hungga1711/workspace/blob/main/docs/extension/privacy-policy.md`

**Distribution:** Public. (For a company-only rollout, "Unlisted" plus `ExtensionInstallForcelist` works too.)

## Firefox Add-ons (AMO)

The same package. Firefox needs `browser_specific_settings.gecko.id` in the manifest for a listed add-on; add it
when submitting (e.g. `ai-insights@workspace`), keep `manifest_version: 3`. Firefox MV3 treats host permissions
as optional at install time: the listing should tell people to allow the AI sites when asked. The `scripting` and
`permissions` APIs are supported from Firefox 102+ (set `strict_min_version: "115.0"`).

**Name:** workspace AI Insights
**Summary** (250 max): Records what you send to AI chat sites (ChatGPT, Claude, Gemini, Copilot, Perplexity,
DeepSeek, Grok and others) to your company's own workspace server, with a notice on every page and a sensitive-data filter that
warns about, redacts or blocks sensitive data before it leaves the browser. Nothing is recorded until you connect it.
**Description:** the Chrome detailed description above.
**Categories:** Privacy & Security; Other
**Tags:** productivity, privacy, ai
**License:** MIT
**Privacy policy:** paste the text of `privacy-policy.md` (AMO wants the text, not a URL).
**Support site:** `https://github.com/hungga1711/workspace/discussions`

**Notes to reviewer:**

```
The extension is plain JavaScript with no build step, no bundler and no minification: the uploaded zip is exactly
the folder frontend/browser-extension/ of https://github.com/hungga1711/workspace (tag v<version>). No source
submission is needed; if required, upload the same zip.

It talks to exactly one server: the one in the connection code the user pastes on the options page
(POST <server>/api/ai-monitor/events). There is no default server and no server run by us. To test:
1. Run `pnpm --filter @workspace/web test:ext` in the repository: it loads the extension in headless Chromium
   against a fake chat page and a fake events endpoint, or
2. Open the options page, paste `https://example.com#aim_testtesttesttesttesttest`; the extension will report the
   code as invalid after one POST to example.com, which demonstrates the only network call it makes.
The optional host permission (https://*/*) is never requested as a wildcard; the options page requests one origin
(the user's company server) only when the "task hint" box is ticked (options.js, chrome.permissions.request).
Field-by-field list of what is sent: docs/extension/what-is-sent.md.
```

**Source code submission:** not required (no transpilation, minification or generated code). State this in the
"Do you need to submit source code?" step.

## Edge Add-ons

Microsoft Partner Center accepts the Chrome package unchanged. Reuse the Chrome fields; the privacy policy URL and
the permission justifications are asked in the same form.

## Other listing languages

The detailed description keeps the three parts of the English one ("What it does", "What it never does",
"Transparency"); translate it from the English text above.

**Tiếng Việt · Tóm tắt:** Xem đội của bạn dùng ChatGPT, Claude, Gemini và Copilot thế nào trong công việc, có thông
báo rõ ràng và bộ lọc chặn dữ liệu nhạy cảm.

**简体中文 · 摘要：** 了解团队在工作中如何使用 ChatGPT、Claude、Gemini 和 Copilot：页面上有明显提示，敏感数据在发送前被拦截。

**Español · Resumen:** Descubre cómo tu equipo usa ChatGPT, Claude, Gemini y Copilot en el trabajo, con un aviso
visible y un filtro que detiene los datos sensibles.

## Company-wide install

Most companies will not ask each person to visit the store: they push the extension with browser policy. See
[enterprise-install.md](enterprise-install.md) (Chrome and Edge, Windows registry, macOS profile, Google Admin
console, Intune).
