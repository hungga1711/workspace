-- What an agent does inside a step, as it happens (src/modules/work/workflows/activity.ts): a line per
-- action (a file read, a command, a search, a tool of the company's AI), what the agent said between them, how each
-- action ended, and the answer as it is being written ('draft', one row per step, replaced as it grows). A table of its
-- own, not the run's `steps` JSONB: a coding agent takes hundreds of actions in a step, and the pipeline asks only for
-- the lines after the last one it has. Kept to the latest lines per step (activity.ts STEP_MAX).
CREATE TABLE IF NOT EXISTS task_agent_run_events (
    id bigint GENERATED ALWAYS AS IDENTITY,
    run_id text NOT NULL,
    step integer NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    kind text NOT NULL,
    tool text,
    text text DEFAULT ''::text NOT NULL,
    detail text,
    CONSTRAINT task_agent_run_events_pkey PRIMARY KEY (id),
    CONSTRAINT task_agent_run_events_run_id_fkey FOREIGN KEY (run_id) REFERENCES task_agent_runs(id) ON DELETE CASCADE,
    CONSTRAINT task_agent_run_events_kind_check CHECK ((kind = ANY (ARRAY['start'::text, 'say'::text, 'tool'::text, 'result'::text, 'error'::text, 'note'::text, 'draft'::text])))
);
CREATE INDEX IF NOT EXISTS task_agent_run_events_step_idx ON task_agent_run_events USING btree (run_id, step, id);
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE task_agent_run_events TO workspace_work_rw;
