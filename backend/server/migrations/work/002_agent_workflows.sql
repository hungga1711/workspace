-- Agent workflows: a task can be handed to a pipeline of AI steps that runs on the server (the
-- company's AI) or on the assignee's computer (a local runner driving their own coding agents). docs/database/work.md.

-- A workflow: ordered steps. Each step is { key, title, kind: "ai" | "command" | "approval", prompt?, command? }.
-- `runner` says where it runs; a local workflow only starts when the assignee presses Run.
CREATE TABLE agent_workflows (
    id text NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    category text DEFAULT 'other'::text NOT NULL,
    runner text DEFAULT 'server'::text NOT NULL,
    steps jsonb DEFAULT '[]'::jsonb NOT NULL,
    template text,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    archived boolean DEFAULT false NOT NULL,
    CONSTRAINT agent_workflows_name_check CHECK (((length(name) >= 1) AND (length(name) <= 120))),
    CONSTRAINT agent_workflows_runner_check CHECK ((runner = ANY (ARRAY['server'::text, 'local'::text]))),
    CONSTRAINT agent_workflows_category_check CHECK ((category = ANY (ARRAY['coding'::text, 'marketing'::text, 'creative'::text, 'research'::text, 'other'::text])))
);
ALTER TABLE ONLY agent_workflows ADD CONSTRAINT agent_workflows_pkey PRIMARY KEY (id);

-- Which workflow a task is handed to (at most one).
ALTER TABLE tasks ADD COLUMN workflow_id text;
ALTER TABLE ONLY tasks ADD CONSTRAINT tasks_workflow_id_fkey FOREIGN KEY (workflow_id) REFERENCES agent_workflows(id) ON DELETE SET NULL;

-- One run of a workflow on a task. `steps` mirrors the workflow at start time, each with its own status, output
-- and log, so a later edit of the workflow never rewrites history.
CREATE TABLE task_agent_runs (
    id text NOT NULL,
    task_id text NOT NULL,
    workflow_id text,
    workflow_name text NOT NULL,
    runner text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    current_step integer DEFAULT 0 NOT NULL,
    steps jsonb DEFAULT '[]'::jsonb NOT NULL,
    error text,
    started_by text NOT NULL,
    claimed_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    CONSTRAINT task_agent_runs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'waiting_approval'::text, 'done'::text, 'failed'::text, 'cancelled'::text])))
);
ALTER TABLE ONLY task_agent_runs ADD CONSTRAINT task_agent_runs_pkey PRIMARY KEY (id);
ALTER TABLE ONLY task_agent_runs ADD CONSTRAINT task_agent_runs_task_id_fkey FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE;
CREATE INDEX task_agent_runs_task_idx ON task_agent_runs USING btree (task_id, created_at DESC);
-- A local runner asks for "my queued local runs": started by me, not yet claimed.
CREATE INDEX task_agent_runs_local_queue_idx ON task_agent_runs USING btree (started_by, created_at) WHERE ((runner = 'local'::text) AND (status = 'queued'::text));

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE agent_workflows TO workspace_work_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE task_agent_runs TO workspace_work_rw;
