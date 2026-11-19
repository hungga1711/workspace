/**
 * The AI sites the browser extension reads, by the name people know them. The extension's own registry
 * (frontend/browser-extension/sites.js) is the source; `e2e-extension/sites.spec.ts` fails when this list falls behind.
 */
export const AI_SITES = [
  "ChatGPT",
  "Claude",
  "Gemini",
  "Copilot",
  "Microsoft 365 Copilot",
  "Perplexity",
  "DeepSeek",
  "Grok",
  "Meta AI",
  "Poe",
  "Qwen",
  "Kimi",
  "Doubao",
  "You.com",
  "HuggingChat",
  "Z.ai",
  "Duck.ai",
] as const;
