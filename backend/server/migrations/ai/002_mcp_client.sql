-- MCP client: the company's AI can use tools from external MCP servers (GitHub, Linear, Notion,
-- Sentry, a company's own server…) that an admin adds in Admin › Kết nối AI › Máy chủ MCP. docs/integrations/mcp-client.md.

-- One external server. Secrets (a header value, an OAuth client secret) are encrypted by the server before they
-- reach this table (secretBox "ai-mcp"); only their last characters are kept in clear for the admin page.
-- `slug` prefixes the server's tools for the model (`github__list_issues`), so it is short and unique.
-- `tools` is the server's tools/list as last read (name, title, description, input schema, read-only hint);
-- `tool_settings` the admin's choices per tool: { "<tool>": { "enabled": bool, "confirm": bool } }.
-- `audience`: who may use the server's tools in AI answers: everyone, the listed departments, or AI admins.
CREATE TABLE mcp_servers (
    id text NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    url text NOT NULL,
    preset text,
    auth text DEFAULT 'none'::text NOT NULL,
    header_name text,
    secret_enc text,
    secret_hint text,
    oauth_per_user boolean DEFAULT false NOT NULL,
    oauth_client_id text,
    oauth_client_secret_enc text,
    oauth_meta jsonb,
    audience text DEFAULT 'everyone'::text NOT NULL,
    department_ids text[] DEFAULT '{}'::text[] NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    server_info jsonb,
    tools jsonb DEFAULT '[]'::jsonb NOT NULL,
    tools_at timestamp with time zone,
    tool_settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    tested_at timestamp with time zone,
    test_ok boolean,
    test_error text,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mcp_servers_pkey PRIMARY KEY (id),
    CONSTRAINT mcp_servers_slug_key UNIQUE (slug),
    CONSTRAINT mcp_servers_slug_check CHECK (slug ~ '^[a-z0-9]{1,16}$'),
    CONSTRAINT mcp_servers_auth_check CHECK (auth = ANY (ARRAY['none'::text, 'header'::text, 'oauth'::text])),
    CONSTRAINT mcp_servers_audience_check CHECK (audience = ANY (ARRAY['everyone'::text, 'departments'::text, 'admins'::text]))
);

-- OAuth tokens for a server: the company's (user_id = '') or, for a server where each person connects their own
-- account (oauth_per_user), one row per person. Both tokens encrypted.
CREATE TABLE mcp_tokens (
    server_id text NOT NULL,
    user_id text DEFAULT ''::text NOT NULL,
    access_enc text NOT NULL,
    refresh_enc text,
    expires_at timestamp with time zone,
    scope text,
    connected_by text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mcp_tokens_pkey PRIMARY KEY (server_id, user_id),
    CONSTRAINT mcp_tokens_server_fkey FOREIGN KEY (server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE
);

-- An OAuth sign-in in progress (the consent popup): the PKCE verifier (encrypted) until the callback, ten minutes at most.
CREATE TABLE mcp_oauth_states (
    state text NOT NULL,
    server_id text NOT NULL,
    user_id text NOT NULL,
    for_company boolean NOT NULL,
    verifier_enc text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mcp_oauth_states_pkey PRIMARY KEY (state),
    CONSTRAINT mcp_oauth_states_server_fkey FOREIGN KEY (server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE
);

-- Every call to an external tool: who, which server and tool, the outcome and how long it took. Never the
-- arguments or the result (they can hold anything); kept like the agent audit (AI_AUDIT_RETENTION_DAYS).
CREATE TABLE mcp_calls (
    id text NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    user_id text NOT NULL,
    agent_id text,
    server_id text,
    server_name text NOT NULL,
    tool text NOT NULL,
    feature text NOT NULL,
    outcome text NOT NULL,
    ms integer DEFAULT 0 NOT NULL,
    CONSTRAINT mcp_calls_pkey PRIMARY KEY (id),
    CONSTRAINT mcp_calls_outcome_check CHECK (outcome = ANY (ARRAY['ok'::text, 'error'::text, 'timeout'::text, 'denied'::text, 'declined'::text, 'auth'::text]))
);
CREATE INDEX mcp_calls_at_idx ON mcp_calls USING btree (at DESC);
CREATE INDEX mcp_calls_server_idx ON mcp_calls USING btree (server_id, at DESC);

-- A chat answer waiting for the person to approve a tool that asks before it runs: the conversation so far (the
-- model's messages) and the call, until they answer (or an hour passes).
CREATE TABLE mcp_pending (
    id text NOT NULL,
    user_id text NOT NULL,
    conversation_id text,
    server_id text NOT NULL,
    tool text NOT NULL,
    state jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mcp_pending_pkey PRIMARY KEY (id)
);
CREATE INDEX mcp_pending_user_idx ON mcp_pending USING btree (user_id, created_at DESC);

-- The external tools an answer used, shown as chips under it when the conversation is opened again.
ALTER TABLE ai_messages ADD COLUMN tool_calls jsonb;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE mcp_servers TO workspace_ai_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE mcp_tokens TO workspace_ai_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE mcp_oauth_states TO workspace_ai_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE mcp_calls TO workspace_ai_rw;
GRANT SELECT,DELETE ON TABLE mcp_calls TO workspace_maintenance;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE mcp_pending TO workspace_ai_rw;
