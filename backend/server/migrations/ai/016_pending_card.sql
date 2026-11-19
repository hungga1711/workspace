-- A confirm card is kept with the paused answer: opening the conversation again shows the card still
-- waiting, and a card left unanswered becomes a line in the conversation saying the change was not made.
ALTER TABLE mcp_pending ADD COLUMN IF NOT EXISTS card jsonb;
