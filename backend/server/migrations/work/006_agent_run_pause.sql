-- Pause and continue: a run can be held by the people on the task. A paused run lets the step in
-- progress finish, then waits for Continue; it survives a server restart (workflows.ts failInterruptedRuns).
ALTER TABLE task_agent_runs DROP CONSTRAINT IF EXISTS task_agent_runs_status_check;
ALTER TABLE task_agent_runs ADD CONSTRAINT task_agent_runs_status_check
    CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'waiting_approval'::text, 'waiting_input'::text, 'paused'::text, 'done'::text, 'failed'::text, 'cancelled'::text])));
