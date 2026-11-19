-- Nobody but the person reads their prompts any more: the read policy is "topic" or "summary" (the one line the
-- AI wrote). An installation that had chosen "full" becomes "summary", and the log of who opened a conversation's
-- text ends with the feature (its table stays: dropping it is not needed and the rows expire with retention).
UPDATE ai_policy SET detail = 'summary' WHERE detail = 'full';
ALTER TABLE ai_policy DROP CONSTRAINT IF EXISTS ai_policy_detail_check;
ALTER TABLE ai_policy ADD CONSTRAINT ai_policy_detail_check CHECK (detail = ANY (ARRAY['topic'::text, 'summary'::text]));
