-- An answer's charts and tables: drawn from the data its workspace tools read, kept with the message so
-- the conversation shows them again when it is opened later.
ALTER TABLE ai_messages ADD COLUMN IF NOT EXISTS blocks jsonb;
