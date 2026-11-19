-- Agent workflows as a harness: a workflow says what it asks for at Run (inputs), where its steps
-- run (the company's AI, a sandbox on a runner, the assignee's computer), what every AI step reads (resources), its
-- limits (guardrails) and where the result goes (output). All of it is one JSONB document, `config`
-- (src/modules/work/workflows/model.ts); `runner` stays as how a run is driven (server | local), derived from it.
ALTER TABLE agent_workflows ADD COLUMN IF NOT EXISTS config jsonb DEFAULT '{}'::jsonb NOT NULL;

-- Departments, not only engineering.
ALTER TABLE agent_workflows DROP CONSTRAINT IF EXISTS agent_workflows_category_check;
ALTER TABLE agent_workflows ADD CONSTRAINT agent_workflows_category_check CHECK ((category = ANY (ARRAY[
    'coding'::text, 'product'::text, 'marketing'::text, 'sales'::text, 'support'::text, 'hr'::text, 'finance'::text,
    'legal'::text, 'operations'::text, 'creative'::text, 'research'::text, 'other'::text])));

-- A run keeps what it was started with (inputs, the config at that moment), what its runner prepared (env), what it
-- handed back (artifacts) and what it spent (usage). `host`: whose runner takes a local run ('person' the starter's,
-- 'company' a shared one). `heartbeat_at`/`requeues`: a runner that goes away gives the run back (watchdog).
ALTER TABLE task_agent_runs ADD COLUMN IF NOT EXISTS inputs jsonb DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE task_agent_runs ADD COLUMN IF NOT EXISTS config jsonb DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE task_agent_runs ADD COLUMN IF NOT EXISTS env jsonb;
ALTER TABLE task_agent_runs ADD COLUMN IF NOT EXISTS artifacts jsonb DEFAULT '[]'::jsonb NOT NULL;
ALTER TABLE task_agent_runs ADD COLUMN IF NOT EXISTS usage jsonb DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE task_agent_runs ADD COLUMN IF NOT EXISTS host text DEFAULT 'person'::text NOT NULL;
ALTER TABLE task_agent_runs ADD COLUMN IF NOT EXISTS heartbeat_at timestamp with time zone;
ALTER TABLE task_agent_runs ADD COLUMN IF NOT EXISTS requeues integer DEFAULT 0 NOT NULL;
ALTER TABLE task_agent_runs DROP CONSTRAINT IF EXISTS task_agent_runs_host_check;
ALTER TABLE task_agent_runs ADD CONSTRAINT task_agent_runs_host_check CHECK ((host = ANY (ARRAY['person'::text, 'company'::text])));
-- A company runner asks for "queued runs for the company's runners".
CREATE INDEX IF NOT EXISTS task_agent_runs_company_queue_idx ON task_agent_runs USING btree (created_at) WHERE ((runner = 'local'::text) AND (status = 'queued'::text) AND (host = 'company'::text));
-- The watchdog reads the few runs in flight.
CREATE INDEX IF NOT EXISTS task_agent_runs_in_flight_idx ON task_agent_runs USING btree (updated_at) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text]));

-- Runners seen lately: which computers take sandbox and computer runs. A row per person, device and kind (personal or
-- company); the runner refreshes it as it asks for work.
CREATE TABLE IF NOT EXISTS agent_runners (
    id text NOT NULL,
    user_id text NOT NULL,
    device text NOT NULL,
    shared boolean DEFAULT false NOT NULL,
    docker boolean DEFAULT false NOT NULL,
    agent text DEFAULT ''::text NOT NULL,
    os text DEFAULT ''::text NOT NULL,
    version text DEFAULT ''::text NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_runners_pkey PRIMARY KEY (id),
    CONSTRAINT agent_runners_device_key UNIQUE (user_id, device, shared)
);
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE agent_runners TO workspace_work_rw;

-- A workflow's own files (reference material every run reads): attached_type 'workflow', attached_id the workflow's
-- id, or 'draft:<user>' until the workflow that lists them is saved.
ALTER TABLE files DROP CONSTRAINT IF EXISTS files_attached_type_check;
ALTER TABLE files ADD CONSTRAINT files_attached_type_check CHECK ((attached_type = ANY (ARRAY['document'::text, 'task'::text, 'chat'::text, 'drive'::text, 'whiteboard'::text, 'workflow'::text])));
