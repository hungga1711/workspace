-- The assistant with workspace tools: an answer keeps what it read or changed (`sources`, shown as
-- citations when the conversation is opened again), and a confirm card can belong to a place outside Hỏi đáp
-- (`context`: a task's comments, where the answer is posted as a comment once the person decides).
ALTER TABLE ai_messages ADD COLUMN IF NOT EXISTS sources jsonb;
ALTER TABLE mcp_pending ADD COLUMN IF NOT EXISTS context jsonb;
