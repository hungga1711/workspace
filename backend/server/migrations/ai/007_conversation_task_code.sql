-- A task code the person typed in a prompt (T-157), kept until it is resolved against tasks they can see.
-- The ai module cannot read work's tasks, so the code waits here and becomes hint_task_id once work
-- confirms the person may read that task; it is only ever a suggestion until they confirm the link.
ALTER TABLE ai_conversations ADD COLUMN IF NOT EXISTS hint_task_code text;
