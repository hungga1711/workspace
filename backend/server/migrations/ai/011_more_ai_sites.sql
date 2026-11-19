-- The extension reads more AI sites (Meta AI, Poe, Qwen, Kimi, Doubao, You.com, HuggingChat, Z.ai, Duck.ai):
-- frontend/browser-extension/sites.js and ai/insight.ts SOURCES name them; a conversation's source may be any of them.
ALTER TABLE ai_conversations DROP CONSTRAINT IF EXISTS ai_conversations_source_check;
ALTER TABLE ai_conversations ADD CONSTRAINT ai_conversations_source_check CHECK (source = ANY (ARRAY[
  'company', 'chatgpt', 'claude', 'gemini', 'copilot', 'perplexity', 'deepseek', 'grok', 'mistral',
  'meta', 'poe', 'qwen', 'kimi', 'doubao', 'you', 'huggingchat', 'zai', 'duckai', 'import', 'other']));
