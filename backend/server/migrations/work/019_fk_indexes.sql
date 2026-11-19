-- Indexes behind foreign keys that had none: deleting a task or a run (ON DELETE CASCADE) and reading a task's
-- questions or a run's quick actions scanned the whole table.
CREATE INDEX IF NOT EXISTS task_agent_run_questions_task_idx ON task_agent_run_questions USING btree (task_id);
CREATE INDEX IF NOT EXISTS agent_quick_actions_run_idx ON agent_quick_actions USING btree (run_id);
