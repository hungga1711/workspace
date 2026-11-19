-- Workflow results under the workflow's own name: a comment a run posts keeps the person
-- who started it as author_id (permissions, notifications, audit stay theirs), and `agent` names what wrote it, so
-- the task shows "Workflow · <name>" with a bot mark instead of that person's face.
ALTER TABLE task_comments ADD COLUMN IF NOT EXISTS agent text;
ALTER TABLE task_comments DROP CONSTRAINT IF EXISTS task_comments_agent_check;
ALTER TABLE task_comments ADD CONSTRAINT task_comments_agent_check CHECK (agent IS NULL OR (length(agent) BETWEEN 1 AND 200));

-- Results posted before this carried the name on their first line ("🤖 <workflow>"): move it to the column.
UPDATE task_comments
   SET agent = left(btrim(substring(body FROM '^🤖 ([^\n]*)')), 200),
       body = CASE WHEN position(E'\n' IN body) > 0 THEN coalesce(nullif(btrim(substring(body FROM position(E'\n' IN body) + 1)), ''), '✓') ELSE '✓' END
 WHERE agent IS NULL AND body LIKE '🤖 %' AND btrim(substring(body FROM '^🤖 ([^\n]*)')) <> '';
