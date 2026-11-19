-- MCP server: OAuth 2.1 for remote MCP clients (Claude, ChatGPT, Cursor, VS Code connect with just the
-- URL) and the log of MCP tool calls an admin reads in Admin › AI agents. docs/database/identity.md, docs/integrations/mcp.md.
--
-- Clients register themselves (RFC 7591), a signed-in person approves one on the consent page, and the grant then acts
-- as that person with the permissions they ticked, like a personal API key. Codes and tokens are stored as SHA-256
-- hashes only.

-- A registered client (dynamic client registration). Public clients (auth_method 'none', PKCE) are the norm; a client
-- that asks for a secret gets one, stored hashed.
CREATE TABLE IF NOT EXISTS oauth_clients (
    id text NOT NULL,
    name text NOT NULL,
    redirect_uris text[] NOT NULL,
    client_uri text,
    auth_method text DEFAULT 'none'::text NOT NULL,
    secret_hash text,
    software_id text,
    software_version text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    CONSTRAINT oauth_clients_auth_method_check CHECK ((auth_method = ANY (ARRAY['none'::text, 'client_secret_post'::text, 'client_secret_basic'::text]))),
    CONSTRAINT oauth_clients_pkey PRIMARY KEY (id)
);

-- One approval: a person let a client act as them with these permissions (narrowed to what they hold at each call).
-- At most one live grant per person and client; approving again replaces it.
CREATE TABLE IF NOT EXISTS oauth_grants (
    id text NOT NULL,
    client_id text NOT NULL,
    user_id text NOT NULL,
    permissions text[] NOT NULL,
    resource text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone,
    CONSTRAINT oauth_grants_pkey PRIMARY KEY (id),
    CONSTRAINT oauth_grants_client_id_fkey FOREIGN KEY (client_id) REFERENCES oauth_clients(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS oauth_grants_user_idx ON oauth_grants USING btree (user_id) WHERE (revoked_at IS NULL);

-- Authorization codes: ten minutes, used once, bound to the redirect URI and the PKCE challenge (S256).
CREATE TABLE IF NOT EXISTS oauth_codes (
    code_hash text NOT NULL,
    grant_id text NOT NULL,
    redirect_uri text NOT NULL,
    code_challenge text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    CONSTRAINT oauth_codes_pkey PRIMARY KEY (code_hash),
    CONSTRAINT oauth_codes_grant_id_fkey FOREIGN KEY (grant_id) REFERENCES oauth_grants(id) ON DELETE CASCADE
);

-- Access tokens (an hour) and refresh tokens (rotated on every use; a reused one revokes the whole grant).
CREATE TABLE IF NOT EXISTS oauth_tokens (
    token_hash text NOT NULL,
    grant_id text NOT NULL,
    kind text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT oauth_tokens_kind_check CHECK ((kind = ANY (ARRAY['access'::text, 'refresh'::text]))),
    CONSTRAINT oauth_tokens_pkey PRIMARY KEY (token_hash),
    CONSTRAINT oauth_tokens_grant_id_fkey FOREIGN KEY (grant_id) REFERENCES oauth_grants(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS oauth_tokens_grant_idx ON oauth_tokens USING btree (grant_id);
CREATE INDEX IF NOT EXISTS oauth_tokens_expires_idx ON oauth_tokens USING btree (expires_at);

-- Every MCP tool call: who, through which credential and client, which tool, when, and whether it worked. Never the
-- arguments or the answer. Kept 180 days (auth-prune).
CREATE TABLE IF NOT EXISTS mcp_calls (
    id text NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    user_id text,
    via text NOT NULL,
    credential_id text,
    client_name text,
    tool text NOT NULL,
    ok boolean NOT NULL,
    error text,
    duration_ms integer DEFAULT 0 NOT NULL,
    CONSTRAINT mcp_calls_via_check CHECK ((via = ANY (ARRAY['oauth'::text, 'personal_key'::text, 'workspace_key'::text, 'session'::text]))),
    CONSTRAINT mcp_calls_pkey PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS mcp_calls_at_idx ON mcp_calls USING btree (at DESC);
CREATE INDEX IF NOT EXISTS mcp_calls_user_idx ON mcp_calls USING btree (user_id, at DESC);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE oauth_clients TO workspace_identity_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE oauth_grants TO workspace_identity_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE oauth_codes TO workspace_identity_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE oauth_tokens TO workspace_identity_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE mcp_calls TO workspace_identity_rw;
