-- Task sync: tasks read from the company's own tool (Asana, ClickUp, Linear, Jira Cloud) so AI Insights can
-- compare tasks finished with and without AI where the team already works. Read-only on our side: a synced task
-- carries source = {type: "sync", system, connectionId, externalId, key, url} and edits are refused (tasks.ts).
CREATE TABLE IF NOT EXISTS sync_connections (
    id text PRIMARY KEY,
    provider text NOT NULL CHECK (provider IN ('asana', 'clickup', 'linear', 'jira')),
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
    -- Jira Cloud's site (https://acme.atlassian.net) and the account email its API token belongs to; null elsewhere.
    site text,
    account_email text,
    -- The token, AES-GCM (task-sync/secrets.ts); never returned by the API.
    secret_enc text NOT NULL,
    -- External project/list/team ids chosen to sync.
    scope text[] NOT NULL DEFAULT '{}',
    enabled boolean NOT NULL DEFAULT true,
    created_by text NOT NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    -- Incremental cursor: tasks updated after this are read on the next run (a few minutes of overlap are re-read).
    cursor_at timestamp with time zone,
    last_run_at timestamp with time zone,
    last_ok_at timestamp with time zone,
    last_error text,
    -- {"tasks": n, "created": n, "updated": n, "unmatched": n} of the last run and running totals.
    stats jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- One of our projects per external project, list or team.
CREATE TABLE IF NOT EXISTS sync_projects (
    connection_id text NOT NULL REFERENCES sync_connections (id) ON DELETE CASCADE,
    external_id text NOT NULL,
    project_id text NOT NULL,
    name text NOT NULL,
    PRIMARY KEY (connection_id, external_id)
);

-- One of our tasks per external task.
CREATE TABLE IF NOT EXISTS sync_items (
    connection_id text NOT NULL REFERENCES sync_connections (id) ON DELETE CASCADE,
    external_id text NOT NULL,
    task_id text NOT NULL UNIQUE,
    external_updated_at timestamp with time zone,
    PRIMARY KEY (connection_id, external_id)
);

-- Prompts and branches name the source key ("ENG-123"); Mine › AI looks synced tasks up by it.
CREATE INDEX IF NOT EXISTS tasks_sync_key_idx ON tasks USING btree (((source ->> 'key'::text))) WHERE ((source ->> 'type'::text) = 'sync'::text);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE sync_connections TO workspace_work_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE sync_projects TO workspace_work_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE sync_items TO workspace_work_rw;
