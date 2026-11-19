-- Subtasks left behind when their parent was deleted (deleteTask removed only the parent row) surfaced as loose
-- tasks. Remove them (any depth), then let the database keep it that way: a parent row going takes its subtasks.
WITH RECURSIVE orphan AS (
  SELECT t.id FROM tasks t WHERE t.parent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tasks p WHERE p.id = t.parent_id)
  UNION ALL
  SELECT t.id FROM tasks t JOIN orphan o ON t.parent_id = o.id
)
DELETE FROM tasks WHERE id IN (SELECT id FROM orphan);

ALTER TABLE tasks ADD CONSTRAINT tasks_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES tasks(id) ON DELETE CASCADE;
