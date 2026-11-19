-- The author's own wording of a shared prompt. Others read the redacted title, body and description;
-- the author keeps seeing and editing what they wrote. Null when nothing was redacted.
ALTER TABLE ai_prompt_library ADD COLUMN IF NOT EXISTS original_title text;
ALTER TABLE ai_prompt_library ADD COLUMN IF NOT EXISTS original_body text;
ALTER TABLE ai_prompt_library ADD COLUMN IF NOT EXISTS original_description text;
