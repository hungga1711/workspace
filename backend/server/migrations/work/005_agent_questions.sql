-- Agent questions: an AI step can stop and ask the people on the task before it acts, like a coding
-- agent asking what is unclear. The run waits in `waiting_input`; its questions and the answers live here, with the
-- run, never as chat channels or messages (the chat sidebar shows a temporary, derived item while a round is open).
-- docs/architecture/agent-questions.md.

ALTER TABLE task_agent_runs DROP CONSTRAINT IF EXISTS task_agent_runs_status_check;
ALTER TABLE task_agent_runs ADD CONSTRAINT task_agent_runs_status_check
    CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'waiting_approval'::text, 'waiting_input'::text, 'done'::text, 'failed'::text, 'cancelled'::text])));

-- One round of questions on one step of a run. `questions` is [{ id, text, kind: "text" | "choice", options?, required? }],
-- `answers` { questionId: text }. A round is open while closed_at is null; it closes answered, skipped ("let the AI
-- decide") or cancelled (the run was cancelled). `task_id` is copied from the run so the open list can check who may
-- see the task without another join.
CREATE TABLE IF NOT EXISTS task_agent_run_questions (
    id text NOT NULL,
    run_id text NOT NULL,
    task_id text NOT NULL,
    step_index integer NOT NULL,
    round integer NOT NULL,
    questions jsonb NOT NULL,
    answers jsonb,
    outcome text,
    asked_at timestamp with time zone DEFAULT now() NOT NULL,
    answered_by text,
    answered_at timestamp with time zone,
    closed_at timestamp with time zone,
    CONSTRAINT task_agent_run_questions_pkey PRIMARY KEY (id),
    CONSTRAINT task_agent_run_questions_round_key UNIQUE (run_id, step_index, round),
    CONSTRAINT task_agent_run_questions_run_id_fkey FOREIGN KEY (run_id) REFERENCES task_agent_runs(id) ON DELETE CASCADE,
    CONSTRAINT task_agent_run_questions_task_id_fkey FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    CONSTRAINT task_agent_run_questions_outcome_check CHECK ((outcome IS NULL OR outcome = ANY (ARRAY['answered'::text, 'skipped'::text, 'cancelled'::text])))
);
-- The open rounds (the sidebar's "AI is asking" and a task's card): few at any time.
CREATE INDEX IF NOT EXISTS task_agent_run_questions_open_idx ON task_agent_run_questions USING btree (asked_at) WHERE (closed_at IS NULL);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE task_agent_run_questions TO workspace_work_rw;
