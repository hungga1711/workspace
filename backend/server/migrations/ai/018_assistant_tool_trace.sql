-- The ask panel: a question keeps the tools its answer ran, with their input and the start of what came
-- back (`tool_trace`), so the next question in the conversation can refine the same lookup ("only Engineering",
-- "compared with last month"). Read only into the model's context; never shown in the browser.
ALTER TABLE ai_messages ADD COLUMN IF NOT EXISTS tool_trace jsonb;
