// workspace AI Insights: the AI sites the extension knows, one entry each. Adding a site is adding an entry here,
// its hosts to manifest.json (host_permissions and content_scripts.matches) and its id to the server's sources
// (backend/server/src/modules/ai/insight.ts: SOURCES and sourceFromHost); `e2e-extension/sites.spec.ts` fails
// when the three disagree.
//
//   id      the source name the workspace stores (several hosts may share one: both Copilots are "copilot")
//   hosts   exact host names
//   path    only pages under this path (a site that is more than its chat, e.g. huggingface.co/chat)
//   input   the composer, when the focused field is not it
//   send    the send button
//   answer  an answer's element (the last one on the page is read once it stops changing)
//
// Selectors drift when a site is redesigned, so nothing depends on them alone: content.js also takes the focused
// text field as the composer and a send-looking button next to it as the send button (see `genericSend` there).
const WORKSPACE_AI_SITES = [
  {
    id: "chatgpt",
    name: "ChatGPT",
    hosts: ["chatgpt.com", "chat.openai.com"],
    input: "#prompt-textarea, form textarea",
    send: "[data-testid='send-button'], button[aria-label*='Send']",
    answer: "[data-message-author-role='assistant']",
  },
  {
    id: "claude",
    name: "Claude",
    hosts: ["claude.ai"],
    input: "div[contenteditable='true'].ProseMirror, div[contenteditable='true']",
    send: "button[aria-label*='Send']",
    answer: "[data-is-streaming], .font-claude-message, .font-claude-response",
  },
  {
    id: "gemini",
    name: "Gemini",
    hosts: ["gemini.google.com"],
    input: "rich-textarea .ql-editor, div[contenteditable='true'][role='textbox']",
    send: "button.send-button, button[aria-label*='Send']",
    answer: "message-content, model-response",
  },
  {
    // copilot.microsoft.com now redirects to copilot.com; both stay listed for people on an older link.
    id: "copilot",
    name: "Copilot",
    hosts: ["copilot.microsoft.com", "copilot.com", "www.copilot.com"],
    input: "textarea#userInput, textarea",
    send: "button[data-testid='submit-button'], button[aria-label*='Submit'], button[aria-label*='Send']",
    answer: "[data-content='ai-message']",
  },
  {
    id: "copilot",
    name: "Microsoft 365 Copilot",
    hosts: ["m365.cloud.microsoft", "copilot.cloud.microsoft"],
    input: "[role='textbox'][contenteditable='true'], textarea",
    send: "button[aria-label*='Send'], button[type='submit']",
    answer: "[data-testid='copilot-message-reply-div'], [data-testid='markdown-reply']",
  },
  {
    id: "perplexity",
    name: "Perplexity",
    hosts: ["www.perplexity.ai", "perplexity.ai"],
    input: "#ask-input, div[contenteditable='true'][role='textbox'], textarea",
    send: "button[data-testid='submit-button'], button[aria-label*='Submit']",
    answer: "[id^='markdown-content'], .prose",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    hosts: ["chat.deepseek.com"],
    input: "textarea#chat-input, textarea",
    send: "button[aria-label*='Send'], div[role='button'][aria-disabled='false']:has(svg)",
    answer: ".ds-markdown",
  },
  {
    id: "grok",
    name: "Grok",
    hosts: ["grok.com"],
    input: "textarea, div[contenteditable='true']",
    send: "button[type='submit'], button[aria-label*='Submit']",
    answer: ".response-content-markdown, .message-bubble",
  },
  {
    // The composer is a plain text input (aria-label "Ask Meta AI"), not a textarea.
    id: "meta",
    name: "Meta AI",
    hosts: ["www.meta.ai", "meta.ai"],
    input: "input[aria-label*='Meta AI'], textarea, div[contenteditable='true']",
    send: "button[aria-label='Send'], button[aria-label*='Send']",
    answer: "[data-message-author-role='assistant'], [data-testid*='assistant'], .markdown",
  },
  {
    id: "poe",
    name: "Poe",
    hosts: ["poe.com"],
    input: "textarea[class*='GrowingTextArea'], textarea",
    send: "button[class*='sendButton'], button[data-button-send], button[aria-label*='Send']",
    answer: "[class*='Message_leftSideMessageBubble'], [class*='botMessageBubble'] [class*='Markdown']",
  },
  {
    id: "qwen",
    name: "Qwen",
    hosts: ["chat.qwen.ai"],
    input: "textarea.message-input-textarea, textarea#chat-input, textarea",
    send: "button#send-message-button, button.send-button, button[type='submit']",
    answer: ".response-message-content, .markdown-content-container, .markdown-prose",
  },
  {
    id: "kimi",
    name: "Kimi",
    hosts: ["www.kimi.com", "kimi.com", "kimi.moonshot.cn", "www.kimi.ai", "kimi.ai"],
    input: ".chat-input-editor, div[contenteditable='true'][role='textbox']",
    send: ".send-button-container, .send-button, button[aria-label*='Send']",
    answer: ".segment-assistant .markdown, .markdown-container",
  },
  {
    id: "doubao",
    name: "Doubao",
    hosts: ["www.doubao.com", "doubao.com"],
    input: "textarea[data-testid='chat_input_input'], textarea",
    send: "button[data-testid='chat_input_send_button'], #flow-end-msg-send",
    answer: "[data-testid='receive_message'] [data-testid='message_text_content'], [data-testid='receive_message']",
  },
  {
    // The composer is a text input (aria-label "Search query") in a form with a submit button.
    id: "you",
    name: "You.com",
    hosts: ["you.com", "www.you.com"],
    input: "input[aria-label='Search query'], textarea#search-input-textarea, textarea",
    send: "button[type='submit']",
    answer: "[data-testid='youchat-answer'], [data-testid='youchat-text']",
  },
  {
    id: "huggingchat",
    name: "HuggingChat",
    hosts: ["huggingface.co"],
    path: "/chat",
    input: "textarea[placeholder], textarea",
    send: "button[type='submit'][aria-label*='Send'], form button[type='submit']",
    answer: "[data-message-role='assistant'], .prose",
  },
  {
    id: "zai",
    name: "Z.ai",
    hosts: ["chat.z.ai"],
    input: "textarea#chat-input, textarea",
    send: "#send-message-button, button[type='submit']",
    answer: ".chat-assistant .markdown-prose, #response-content-container, .markdown-prose",
  },
  {
    id: "duckai",
    name: "Duck.ai",
    hosts: ["duck.ai"],
    input: "textarea[aria-label], textarea",
    send: "button[type='submit'][aria-label]",
    answer: "[data-activity-type='assistant'], [heading^='GPT'], [heading^='Claude'], .markdown",
  },
];
// The service worker (no window) and tests (`require`) read the same list.
if (typeof module !== "undefined") module.exports = { WORKSPACE_AI_SITES };
