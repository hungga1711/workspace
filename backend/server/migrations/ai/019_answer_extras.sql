-- What an answer did, what limits it and what to ask next (steps, notes, followUps; progress.ts), kept with the
-- answer so the conversation shows them again when it is opened later, as the stream showed them.
ALTER TABLE ai_messages ADD COLUMN IF NOT EXISTS extras jsonb;
