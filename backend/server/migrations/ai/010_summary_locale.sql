-- The language a conversation's one-line summary was written in. A summary without it is in Vietnamese; a reader
-- in another language sees the title instead.
ALTER TABLE ai_conversations ADD COLUMN IF NOT EXISTS summary_locale text;
UPDATE ai_conversations SET summary_locale = 'vi' WHERE summary <> '' AND summary_locale IS NULL;
