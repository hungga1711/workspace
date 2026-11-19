-- Flow instead of "% done". On a board, tasks are added at any time, so done ÷ total drops while a team
-- works well; the boss needs the pace: done and added per week, what is in progress, what has not moved for a week,
-- and how long work takes once started. Two timestamps on the task make that cheap without reading the activity log:
--   status_changed_at  the last time the status changed (what "stuck for 7 days" reads)
--   started_at         the first time the task left "todo" (cycle time = completed_at - started_at)
-- A trigger keeps both; it is named after tasks_column_sync so it sees the status that trigger settles on (BEFORE
-- triggers run in name order). docs/database/work.md.

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS status_changed_at timestamp with time zone;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS started_at timestamp with time zone;

CREATE OR REPLACE FUNCTION work_task_flow_stamp() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.status_changed_at := coalesce(NEW.status_changed_at, NEW.created_at, now());
    IF NEW.status IN ('in_progress', 'review') THEN
      NEW.started_at := coalesce(NEW.started_at, NEW.status_changed_at);
    END IF;
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.status_changed_at := now();
    -- Started once: going back to todo and on again keeps the first start, so cycle time counts the whole stretch.
    -- A task dragged straight from todo to done never started as far as the flow can tell: no cycle time for it.
    IF NEW.status IN ('in_progress', 'review') AND NEW.started_at IS NULL THEN
      NEW.started_at := now();
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS tasks_status_flow ON tasks;
CREATE TRIGGER tasks_status_flow BEFORE INSERT OR UPDATE OF status ON tasks FOR EACH ROW EXECUTE FUNCTION work_task_flow_stamp();

-- Backfill from the task's history where it has one (status edits and board moves), else the best guess the row
-- allows: done tasks changed status when they were completed; open ones when last touched.
WITH last_change AS (
  SELECT entity_id, max(at) AS at
    FROM activity
   WHERE entity_type = 'task' AND (action = 'moved' OR (action = 'updated' AND changes ? 'status'))
   GROUP BY entity_id
), first_start AS (
  SELECT entity_id, min(at) AS at
    FROM activity
   WHERE entity_type = 'task'
     AND ((action = 'moved' AND changes->>'to' IN ('in_progress', 'review'))
       OR (action = 'updated' AND changes->'status'->>'to' IN ('in_progress', 'review')))
   GROUP BY entity_id
)
UPDATE tasks t
   SET status_changed_at = coalesce(lc.at, CASE WHEN t.status = 'done' THEN t.completed_at END, t.updated_at, t.created_at),
       started_at = coalesce(fs.at, CASE WHEN t.status IN ('in_progress', 'review') THEN coalesce(lc.at, t.updated_at) END)
  FROM tasks t2
  LEFT JOIN last_change lc ON lc.entity_id = t2.id
  LEFT JOIN first_start fs ON fs.entity_id = t2.id
 WHERE t2.id = t.id AND t.status_changed_at IS NULL;

-- What the flow reads: work in flight by when it last moved, and arrivals by date within a project.
CREATE INDEX IF NOT EXISTS tasks_open_status_changed_idx ON tasks USING btree (status_changed_at) WHERE (status = ANY (ARRAY['in_progress'::text, 'review'::text]));
CREATE INDEX IF NOT EXISTS tasks_project_created_idx ON tasks USING btree (project_id, created_at);
CREATE INDEX IF NOT EXISTS tasks_project_completed_idx ON tasks USING btree (project_id, completed_at) WHERE (status = 'done'::text);

-- A project's weekly status update: the owner (or anyone who may edit the project) writes two lines and a health call;
-- the boss reads it instead of per-task progress check-ins. One row per post; the latest is the project's
-- current status. `suggested` marks text that started as the AI's draft (kept, so a report can tell).
CREATE TABLE IF NOT EXISTS project_updates (
    id text NOT NULL,
    project_id text NOT NULL,
    author_id text NOT NULL,
    health text NOT NULL,
    body text NOT NULL,
    suggested boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT project_updates_pkey PRIMARY KEY (id),
    CONSTRAINT project_updates_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT project_updates_health_check CHECK ((health = ANY (ARRAY['on_track'::text, 'at_risk'::text, 'off_track'::text]))),
    CONSTRAINT project_updates_body_check CHECK (((length(body) >= 1) AND (length(body) <= 2000)))
);
CREATE INDEX IF NOT EXISTS project_updates_project_idx ON project_updates USING btree (project_id, created_at DESC);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE project_updates TO workspace_work_rw;
