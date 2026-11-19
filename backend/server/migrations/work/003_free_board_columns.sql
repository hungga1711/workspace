-- Board columns are free lanes: a column is only a name, an order and an optional WIP limit. A task's
-- status is its own field, and it alone (with the due date) drives progress, done counts and overdue figures.
-- Moving a card between columns does not change its status, and changing a status does not move the card.
-- docs/database/work.md.

DROP TRIGGER IF EXISTS tasks_column_sync ON tasks;
DROP FUNCTION IF EXISTS work_task_column_sync();
DROP FUNCTION IF EXISTS work_column_for(text, text);

ALTER TABLE board_columns DROP CONSTRAINT IF EXISTS board_columns_status_check;
ALTER TABLE board_columns DROP COLUMN IF EXISTS status;

-- Where a card lands when it has no column of its project: the first (leftmost) column.
CREATE FUNCTION work_column_for(p_project text) RETURNS text
    LANGUAGE sql STABLE
    AS $$
  SELECT id FROM board_columns WHERE project_id = p_project ORDER BY position LIMIT 1
$$;

-- Keeps a top-level project task in a column of its own project; subtasks and tasks without a project have none.
CREATE FUNCTION work_task_column_sync() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.project_id IS NULL OR NEW.parent_id IS NOT NULL THEN
    NEW.column_id := NULL;
    RETURN NEW;
  END IF;
  IF NEW.column_id IS NULL OR NOT EXISTS (SELECT 1 FROM board_columns WHERE id = NEW.column_id AND project_id = NEW.project_id) THEN
    NEW.column_id := work_column_for(NEW.project_id);
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER tasks_column_sync BEFORE INSERT OR UPDATE OF column_id, project_id, parent_id ON tasks FOR EACH ROW EXECUTE FUNCTION work_task_column_sync();
