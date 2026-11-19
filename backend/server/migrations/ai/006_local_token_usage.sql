-- Token use on people's own computers: coding agents such as Claude Code and Codex keep their sessions as
-- local logs; workspace-usage.mjs reads only the token counts in them and sends daily totals per tool and model.
-- Never prompt text, file paths or project names. A sync sends whole days again, so a row is replaced, not added to.
CREATE TABLE IF NOT EXISTS ai_local_usage (
    user_id text NOT NULL,
    device text NOT NULL,
    tool text NOT NULL,
    model text NOT NULL,
    day date NOT NULL,
    input_tokens bigint DEFAULT 0 NOT NULL,
    output_tokens bigint DEFAULT 0 NOT NULL,
    cache_read_tokens bigint DEFAULT 0 NOT NULL,
    cache_write_tokens bigint DEFAULT 0 NOT NULL,
    reasoning_tokens bigint DEFAULT 0 NOT NULL,
    turns integer DEFAULT 0 NOT NULL,
    sessions integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_local_usage_pkey PRIMARY KEY (user_id, device, tool, model, day)
);
CREATE INDEX IF NOT EXISTS ai_local_usage_day_idx ON ai_local_usage USING btree (day, user_id);

-- Each computer that sends: when it last did (the person sees and removes their own).
CREATE TABLE IF NOT EXISTS ai_local_devices (
    user_id text NOT NULL,
    device text NOT NULL,
    time_zone text DEFAULT ''::text NOT NULL,
    first_at timestamp with time zone DEFAULT now() NOT NULL,
    last_sync_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_local_devices_pkey PRIMARY KEY (user_id, device)
);

-- Sessions that named a task (T-123 in the branch or folder): what was already reported to work as AI help on that
-- task, so a later sync reports only the tokens added since. The key is a hash of the session id.
CREATE TABLE IF NOT EXISTS ai_local_sessions (
    user_id text NOT NULL,
    session_key text NOT NULL,
    tool text NOT NULL,
    task_id text NOT NULL,
    tokens bigint DEFAULT 0 NOT NULL,
    first_at timestamp with time zone NOT NULL,
    last_at timestamp with time zone NOT NULL,
    CONSTRAINT ai_local_sessions_pkey PRIMARY KEY (user_id, session_key)
);
CREATE INDEX IF NOT EXISTS ai_local_sessions_task_idx ON ai_local_sessions USING btree (task_id);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ai_local_usage TO workspace_ai_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ai_local_devices TO workspace_ai_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ai_local_sessions TO workspace_ai_rw;
GRANT SELECT,DELETE ON TABLE ai_local_usage TO workspace_maintenance;
GRANT SELECT,DELETE ON TABLE ai_local_devices TO workspace_maintenance;
GRANT SELECT,DELETE ON TABLE ai_local_sessions TO workspace_maintenance;
