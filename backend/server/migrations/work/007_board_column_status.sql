-- Board columns stand for a status (reverses 003_free_board_columns). With free lanes, teams moved
-- cards by column while progress, the people view, AI Insights and every report read the task's status, so a card in
-- "Review" could still count as "To do". Now each column names one status (todo, in_progress, review, done):
-- moving a card sets its status, and changing a status moves the card. Cancelled has no column: a cancelled task
-- stays where it was. docs/database/work.md.

ALTER TABLE board_columns ADD COLUMN status text;

-- Existing columns: the status their name says (vi and en, the defaults and common custom names), else by position:
-- the first column is to do, the last done, anything between in progress.
WITH ranked AS (
  SELECT id,
         lower(name) AS n,
         row_number() OVER (PARTITION BY project_id ORDER BY position) AS pos,
         count(*) OVER (PARTITION BY project_id) AS total
    FROM board_columns
)
UPDATE board_columns b
   SET status = CASE
         WHEN r.n ~ '(done|xong|hoàn thành|hoàn tất|complete|closed|đóng|released|shipped)' THEN 'done'
         WHEN r.n ~ '(review|duyệt|kiểm tra|qa|test|chờ)' THEN 'review'
         WHEN r.n ~ '(progress|doing|đang|in dev|wip)' THEN 'in_progress'
         WHEN r.n ~ '(to ?do|backlog|cần làm|chưa|mới|new|open)' THEN 'todo'
         WHEN r.pos = 1 THEN 'todo'
         WHEN r.pos = r.total THEN 'done'
         ELSE 'in_progress'
       END
  FROM ranked r
 WHERE r.id = b.id;

ALTER TABLE board_columns ALTER COLUMN status SET NOT NULL;
ALTER TABLE board_columns ADD CONSTRAINT board_columns_status_check CHECK (status = ANY (ARRAY['todo', 'in_progress', 'review', 'done']));

-- The column a status lands in: the leftmost column of that status; review falls back to in progress, cancelled to
-- done, anything else to the first to-do column.
CREATE FUNCTION work_column_for(p_project text, p_status text) RETURNS text
    LANGUAGE sql STABLE
    AS $$
  SELECT id FROM board_columns
   WHERE project_id = p_project
   ORDER BY CASE
              WHEN status = p_status THEN 0
              WHEN p_status = 'review' AND status = 'in_progress' THEN 1
              WHEN p_status = 'cancelled' AND status = 'done' THEN 1
              WHEN status = 'todo' THEN 2
              ELSE 3
            END, position
   LIMIT 1
$$;

-- Repairs tasks whose column and status disagree (left over from free lanes). Whichever changed last wins: if the
-- card was dragged across columns after its status last changed, the status follows the column; otherwise the card
-- moves to its status's column. Cancelled tasks keep their status. Runs once below; kept as a function so the rule
-- is tested (test/work/work.test.ts) and can be rerun after a restore from an older backup.
CREATE FUNCTION work_repair_column_drift(OUT by_column int, OUT by_status int)
    LANGUAGE plpgsql
    AS $$
BEGIN
  CREATE TEMP TABLE drift ON COMMIT DROP AS
  SELECT t.id, bc.status AS col_status,
         (SELECT max(a.at) FROM activity a
           WHERE a.entity_type = 'task' AND a.entity_id = t.id AND a.action = 'moved' AND a.changes ? 'column') AS col_at,
         (SELECT max(a.at) FROM activity a
           WHERE a.entity_type = 'task' AND a.entity_id = t.id
             AND ((a.action = 'moved' AND NOT a.changes ? 'column') OR (a.action = 'updated' AND a.changes ? 'status'))) AS status_at
    FROM tasks t
    JOIN board_columns bc ON bc.id = t.column_id
   WHERE t.parent_id IS NULL AND t.status <> 'cancelled' AND t.status <> bc.status;

  UPDATE tasks t
     SET status = d.col_status,
         completed_at = CASE WHEN d.col_status = 'done' THEN coalesce(t.completed_at, t.updated_at) END,
         blocked_reason = CASE WHEN d.col_status = 'done' THEN NULL ELSE t.blocked_reason END,
         version = t.version + 1
    FROM drift d
   WHERE d.id = t.id AND d.col_at IS NOT NULL AND (d.status_at IS NULL OR d.col_at > d.status_at);
  GET DIAGNOSTICS by_column = ROW_COUNT;

  UPDATE tasks t
     SET column_id = work_column_for(t.project_id, t.status),
         version = t.version + 1
    FROM drift d
   WHERE d.id = t.id AND NOT (d.col_at IS NOT NULL AND (d.status_at IS NULL OR d.col_at > d.status_at));
  GET DIAGNOSTICS by_status = ROW_COUNT;

  DROP TABLE drift;
END $$;

DO $$
DECLARE
  r record;
BEGIN
  SELECT * INTO r FROM work_repair_column_drift();
  RAISE NOTICE 'board columns: % tasks took their column''s status, % tasks moved to their status''s column', r.by_column, r.by_status;
END $$;

-- Keeps column and status in step on every write (moves, edits, imports, scripts). A move to another column sets the
-- column's status unless the task is cancelled; a status or project change moves the card unless its current column
-- already has that status. completed_at and blocked_reason follow a status set here, as they do in the app.
CREATE OR REPLACE FUNCTION work_task_column_sync() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  col_status text;
BEGIN
  IF NEW.project_id IS NULL OR NEW.parent_id IS NOT NULL THEN
    NEW.column_id := NULL;
    RETURN NEW;
  END IF;
  IF NEW.column_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.column_id IS DISTINCT FROM OLD.column_id) THEN
    SELECT status INTO col_status FROM board_columns WHERE id = NEW.column_id AND project_id = NEW.project_id;
    IF col_status IS NULL THEN
      NEW.column_id := work_column_for(NEW.project_id, NEW.status);
    ELSIF NEW.status <> 'cancelled' THEN
      NEW.status := col_status;
    END IF;
  ELSIF NEW.column_id IS NULL OR TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    SELECT status INTO col_status FROM board_columns WHERE id = NEW.column_id AND project_id = NEW.project_id;
    IF col_status IS NULL OR (col_status <> NEW.status AND NEW.status <> 'cancelled') THEN
      NEW.column_id := work_column_for(NEW.project_id, NEW.status);
    END IF;
  END IF;
  IF NEW.status = 'done' THEN
    NEW.completed_at := coalesce(NEW.completed_at, now());
  ELSE
    NEW.completed_at := NULL;
  END IF;
  IF NEW.status IN ('done', 'cancelled') THEN
    NEW.blocked_reason := NULL;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS tasks_column_sync ON tasks;
CREATE TRIGGER tasks_column_sync BEFORE INSERT OR UPDATE OF status, column_id, project_id, parent_id ON tasks FOR EACH ROW EXECUTE FUNCTION work_task_column_sync();

-- The one-argument helper from free lanes is replaced by work_column_for(project, status).
DROP FUNCTION IF EXISTS work_column_for(text);
