-- Workflows that start by themselves (src/modules/work/workflows/triggers.ts and workflow-triggers.ts): a
-- workflow's config lists its triggers (a task moved or created, a schedule, an address a system outside posts to,
-- linked work that changed). `triggered` marks the few workflows that have any, so a task change costs one indexed
-- read when none does.
ALTER TABLE agent_workflows ADD COLUMN IF NOT EXISTS triggered boolean DEFAULT false NOT NULL;
CREATE INDEX IF NOT EXISTS agent_workflows_triggered_idx ON agent_workflows USING btree (id) WHERE (triggered AND NOT archived);

-- What started a run when it was not a person pressing Run: { kind, id, depth, origin?, detail?, payload? }.
ALTER TABLE task_agent_runs ADD COLUMN IF NOT EXISTS trigger jsonb;

-- Every time a trigger fired, and what came of it. A row is written in the transaction that caused it ('pending'),
-- then taken by the trigger job: 'started' with its run, or 'refused' with the reason (a run already in progress, the
-- person it acts as may not edit the task, the workflow's own doing, over the hourly cap). `slot` makes a schedule fire
-- once per day; `origin_workflow_id` and `depth` carry where a fire came from, so a workflow never starts itself and a
-- chain of workflows ends.
CREATE TABLE IF NOT EXISTS workflow_trigger_fires (
    id text NOT NULL,
    workflow_id text NOT NULL,
    trigger_id text NOT NULL,
    kind text NOT NULL,
    task_id text,
    status text DEFAULT 'pending'::text NOT NULL,
    reason text,
    detail text,
    payload text,
    run_id text,
    origin_workflow_id text,
    depth integer DEFAULT 0 NOT NULL,
    slot text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    done_at timestamp with time zone,
    CONSTRAINT workflow_trigger_fires_pkey PRIMARY KEY (id),
    CONSTRAINT workflow_trigger_fires_workflow_id_fkey FOREIGN KEY (workflow_id) REFERENCES agent_workflows(id) ON DELETE CASCADE,
    CONSTRAINT workflow_trigger_fires_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'started'::text, 'refused'::text]))),
    CONSTRAINT workflow_trigger_fires_kind_check CHECK ((kind = ANY (ARRAY['task'::text, 'schedule'::text, 'hook'::text, 'linked'::text])))
);
CREATE UNIQUE INDEX IF NOT EXISTS workflow_trigger_fires_slot_key ON workflow_trigger_fires USING btree (workflow_id, trigger_id, slot) WHERE (slot IS NOT NULL);
CREATE INDEX IF NOT EXISTS workflow_trigger_fires_pending_idx ON workflow_trigger_fires USING btree (created_at) WHERE (status = 'pending'::text);
CREATE INDEX IF NOT EXISTS workflow_trigger_fires_workflow_idx ON workflow_trigger_fires USING btree (workflow_id, created_at DESC);
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE workflow_trigger_fires TO workspace_work_rw;

-- The secret address of a workflow's "from another system" trigger: only the token's hash is kept; the address is
-- shown once, when it is made.
CREATE TABLE IF NOT EXISTS workflow_hooks (
    workflow_id text NOT NULL,
    trigger_id text NOT NULL,
    token_hash text NOT NULL,
    hint text NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    CONSTRAINT workflow_hooks_pkey PRIMARY KEY (workflow_id, trigger_id),
    CONSTRAINT workflow_hooks_token_hash_key UNIQUE (token_hash),
    CONSTRAINT workflow_hooks_workflow_id_fkey FOREIGN KEY (workflow_id) REFERENCES agent_workflows(id) ON DELETE CASCADE
);
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE workflow_hooks TO workspace_work_rw;
