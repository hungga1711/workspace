-- identity schema, baseline.
--
-- What each table is for, and why it is shaped this way: docs/database/identity.md. New changes go in new files
-- (002_*.sql, …); never edit this one once released.
--
-- The migration runner applies it with search_path = <schema>, public, pg_temp (backend/packages/service-kit/src/migrate.ts),
-- so names below are unqualified and the file works for any schema name. SECURITY DEFINER functions pin that
-- path (SET search_path FROM CURRENT) and are owned by workspace_maintenance (NOLOGIN); every other
-- object belongs to workspace_owner. The module reaches the schema through workspace_identity_rw, granted to its login role.

SET LOCAL check_function_bodies = false;

-- ── Schema access ────────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO workspace_identity_rw', current_schema());
  -- CREATE because a SECURITY DEFINER function can only be handed to a role that may create in its schema.
  EXECUTE format('GRANT USAGE, CREATE ON SCHEMA %I TO workspace_maintenance', current_schema());
END
$$;

-- ── Functions (SQL bodies are checked when called; check_function_bodies is off above) ───────────

CREATE FUNCTION outbox_claim(lim integer, skip text[]) RETURNS TABLE(id text, aggregatetype text, payload jsonb)
    LANGUAGE sql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
  SELECT o.id, o.aggregatetype, o.payload FROM outbox o
   WHERE o.published_at IS NULL AND NOT (o.aggregatetype = ANY (coalesce(skip, '{}'::text[])))
   ORDER BY o.created_at
   LIMIT lim
   FOR UPDATE SKIP LOCKED
$$;

CREATE FUNCTION outbox_mark_published(ids text[]) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
DECLARE n integer;
BEGIN
  UPDATE outbox SET published_at = now() WHERE id = ANY (ids) AND published_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

CREATE FUNCTION outbox_notify() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM pg_notify('workspace_outbox_' || TG_TABLE_SCHEMA, '');
  RETURN NULL;
END
$$;

CREATE FUNCTION outbox_prune(keep_days integer, lim integer) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
DECLARE n integer;
BEGIN
  DELETE FROM outbox o
   USING (SELECT id FROM outbox
           WHERE published_at IS NOT NULL AND created_at < now() - make_interval(days => greatest(keep_days, 1))
           LIMIT lim) old
   WHERE o.id = old.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

CREATE FUNCTION outbox_waiting() RETURNS integer
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
  SELECT count(*)::integer FROM outbox WHERE published_at IS NULL
$$;

-- The dedupe ledger of identity's consumer (identity-org), pruned daily like every consuming module's.
CREATE FUNCTION prune_processed_events(keep_days integer, lim integer) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
DECLARE n integer;
BEGIN
  -- Never shorter than eight days, whatever the caller asks (a replay can be days old).
  DELETE FROM processed_events p
   USING (SELECT consumer, event_id FROM processed_events
           WHERE processed_at < now() - make_interval(days => greatest(keep_days, 8))
           LIMIT lim) old
   WHERE p.consumer = old.consumer AND p.event_id = old.event_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

-- A personal API key acts as the person who made it, so it ends with their sessions when the account may be in
-- someone else's hands (password reset, "sign out everywhere", an admin's sign-out or two-step reset, disabling).
-- The maintenance role may only touch revoked_at.
CREATE FUNCTION revoke_personal_api_keys(uid text) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
DECLARE n integer;
BEGIN
  UPDATE api_keys SET revoked_at = now() WHERE personal AND created_by = uid AND revoked_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

-- ── Tables ───────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE account_tokens (
    token_hash text NOT NULL,
    user_id text NOT NULL,
    email text NOT NULL,
    purpose text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT account_tokens_purpose_check CHECK ((purpose = ANY (ARRAY['reset'::text, 'activate'::text]))),
    CONSTRAINT account_tokens_pkey PRIMARY KEY (token_hash)
);

CREATE TABLE agent_grants (
    agent_id text NOT NULL,
    permission text NOT NULL,
    scope text NOT NULL,
    CONSTRAINT agent_grants_scope_check CHECK ((scope = ANY (ARRAY['SELF'::text, 'TEAM'::text, 'DEPARTMENT'::text, 'WORKSPACE'::text]))),
    CONSTRAINT agent_grants_pkey PRIMARY KEY (agent_id, permission)
);

CREATE TABLE agents (
    id text NOT NULL,
    name text NOT NULL,
    owner_user_id text NOT NULL,
    status text NOT NULL,
    monthly_budget_tokens bigint DEFAULT 0 NOT NULL,
    allowed_tools text[] DEFAULT '{}'::text[] NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    CONSTRAINT agents_status_check CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text]))),
    CONSTRAINT agents_pkey PRIMARY KEY (id),
    CONSTRAINT agents_name_key UNIQUE (name)
);

-- Workspace keys act as a service principal; a personal key (MCP clients, scripts) acts as the person who made it,
-- with their own scopes, limited to the permissions picked for the key, and stops working once they are no longer
-- an active member.
CREATE TABLE api_keys (
    id text NOT NULL,
    name text NOT NULL,
    prefix text NOT NULL,
    key_hash text NOT NULL,
    permissions text[] NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone,
    personal boolean DEFAULT false NOT NULL,
    CONSTRAINT api_keys_key_hash_key UNIQUE (key_hash),
    CONSTRAINT api_keys_pkey PRIMARY KEY (id)
);

CREATE TABLE audit_log (
    id text NOT NULL,
    actor text NOT NULL,
    action text NOT NULL,
    resource text NOT NULL,
    resource_id text NOT NULL,
    source text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT audit_log_pkey PRIMARY KEY (id)
);

CREATE TABLE auth_challenges (
    token_hash text NOT NULL,
    user_id text NOT NULL,
    ip text,
    user_agent text,
    attempts integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    CONSTRAINT auth_challenges_pkey PRIMARY KEY (token_hash)
);

CREATE TABLE auth_events (
    id bigint NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    type text NOT NULL,
    user_id text,
    email text,
    ip text,
    user_agent text,
    error text,
    CONSTRAINT auth_events_pkey PRIMARY KEY (id)
);

CREATE TABLE auth_keys (
    kid text NOT NULL,
    private_enc text NOT NULL,
    public_jwk jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    retires_at timestamp with time zone,
    CONSTRAINT auth_keys_pkey PRIMARY KEY (kid)
);

CREATE TABLE auth_recovery_codes (
    user_id text NOT NULL,
    code_hash text NOT NULL,
    used_at timestamp with time zone,
    CONSTRAINT auth_recovery_codes_pkey PRIMARY KEY (user_id, code_hash)
);

CREATE TABLE auth_refresh_tokens (
    token_hash text NOT NULL,
    session_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    CONSTRAINT auth_refresh_tokens_pkey PRIMARY KEY (token_hash)
);

CREATE TABLE auth_sessions (
    id text NOT NULL,
    user_id text NOT NULL,
    method text NOT NULL,
    mfa boolean DEFAULT false NOT NULL,
    idp text,
    ip text,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    revoke_reason text,
    CONSTRAINT auth_sessions_method_check CHECK ((method = ANY (ARRAY['password'::text, 'sso'::text]))),
    CONSTRAINT auth_sessions_pkey PRIMARY KEY (id)
);

-- Dead letters for identity's consumer (identity-org): events are delivered inside the server process (ADR 0021),
-- so a failed one is kept only here. replay_requested_at: `dlq replay` / `dlq outbox-replay` ask the running server
-- to deliver the row again.
CREATE TABLE dead_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    consumer text NOT NULL,
    stream text NOT NULL,
    entry_id text NOT NULL,
    event_id text,
    event_type text,
    reason text NOT NULL,
    event text NOT NULL,
    failed_at timestamp with time zone DEFAULT now() NOT NULL,
    replayed_at timestamp with time zone,
    replay_requested_at timestamp with time zone,
    CONSTRAINT dead_events_consumer_stream_entry_id_key UNIQUE (consumer, stream, entry_id)
);

-- Profile photos: one small square image per member (the browser crops and resizes it to 256 px WebP or JPEG, at
-- most 64 KB), kept next to the member row instead of in object storage. It is drawn on every screen, so it is served
-- from a versioned, long-cached URL (`members/:id/avatar?v=<avatar_version>`) rather than short-lived signed links.
CREATE TABLE member_avatars (
    user_id text NOT NULL,
    content_type text NOT NULL CHECK (content_type IN ('image/webp', 'image/jpeg', 'image/png')),
    image bytea NOT NULL CHECK (octet_length(image) BETWEEN 1 AND 65536),
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT member_avatars_pkey PRIMARY KEY (user_id)
);

CREATE TABLE member_roles (
    user_id text NOT NULL,
    role_id text NOT NULL,
    CONSTRAINT member_roles_pkey PRIMARY KEY (user_id, role_id)
);

-- avatar_version: the directory ships it with each name. 0 = no photo (initials); otherwise it changes with every
-- new photo, so a browser never shows a stale cached image.
CREATE TABLE members (
    user_id text NOT NULL,
    email text NOT NULL,
    display_name text NOT NULL,
    status text NOT NULL,
    department_id text,
    is_owner boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    external_id text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone,
    avatar_version integer DEFAULT 0 NOT NULL,
    CONSTRAINT members_status_check CHECK ((status = ANY (ARRAY['invited'::text, 'active'::text, 'disabled'::text]))),
    CONSTRAINT members_pkey PRIMARY KEY (user_id),
    CONSTRAINT members_email_key UNIQUE (email)
);

CREATE TABLE outbox (
    id text NOT NULL,
    aggregatetype text NOT NULL,
    aggregateid text NOT NULL,
    type text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    published_at timestamp with time zone,
    CONSTRAINT outbox_pkey PRIMARY KEY (id)
);

CREATE TABLE processed_events (
    consumer text NOT NULL,
    event_id text NOT NULL,
    processed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT processed_events_pkey PRIMARY KEY (consumer, event_id)
);

CREATE TABLE role_grants (
    role_id text NOT NULL,
    permission text NOT NULL,
    scope text NOT NULL,
    CONSTRAINT role_grants_scope_check CHECK ((scope = ANY (ARRAY['SELF'::text, 'TEAM'::text, 'DEPARTMENT'::text, 'WORKSPACE'::text, 'PLATFORM'::text]))),
    CONSTRAINT role_grants_pkey PRIMARY KEY (role_id, permission)
);

CREATE TABLE roles (
    id text NOT NULL,
    name text NOT NULL,
    system boolean DEFAULT false NOT NULL,
    CONSTRAINT roles_pkey PRIMARY KEY (id),
    CONSTRAINT roles_name_key UNIQUE (name)
);

-- The workspace's single sign-on (one identity provider): one row, keyed by `singleton`.
CREATE TABLE sso_configs (
    alias text NOT NULL,
    display_name text NOT NULL,
    issuer text NOT NULL,
    client_id text NOT NULL,
    domains text[] DEFAULT '{}'::text[] NOT NULL,
    verified_domains text[] DEFAULT '{}'::text[] NOT NULL,
    verify_token text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    jit boolean DEFAULT true NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    enforce boolean DEFAULT false NOT NULL,
    client_secret_enc text,
    singleton boolean DEFAULT true NOT NULL,
    CONSTRAINT sso_configs_pkey_one CHECK (singleton),
    CONSTRAINT sso_configs_alias_key UNIQUE (alias),
    CONSTRAINT sso_configs_pkey PRIMARY KEY (singleton)
);

CREATE TABLE sso_states (
    state_hash text NOT NULL,
    alias text NOT NULL,
    nonce text NOT NULL,
    code_verifier text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    CONSTRAINT sso_states_pkey PRIMARY KEY (state_hash)
);

CREATE TABLE team_members (
    team_id text NOT NULL,
    user_id text NOT NULL,
    CONSTRAINT team_members_pkey PRIMARY KEY (team_id, user_id)
);

CREATE TABLE teams (
    id text NOT NULL,
    name text NOT NULL,
    CONSTRAINT teams_pkey PRIMARY KEY (id)
);

CREATE TABLE user_identities (
    alias text NOT NULL,
    subject text NOT NULL,
    user_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_identities_pkey PRIMARY KEY (alias, subject)
);

-- password_must_change: a password someone else set (invite with a password, an admin reset) must be replaced before
-- the account is used: the gateway refuses everything but the change-password screen while this is true.
CREATE TABLE users (
    id text NOT NULL,
    email text NOT NULL,
    given_name text DEFAULT ''::text NOT NULL,
    family_name text DEFAULT ''::text NOT NULL,
    password_hash text,
    password_changed_at timestamp with time zone,
    enabled boolean DEFAULT true NOT NULL,
    sso_only boolean DEFAULT false NOT NULL,
    auth_version integer DEFAULT 1 NOT NULL,
    totp_secret_enc text,
    totp_pending_enc text,
    totp_enabled boolean DEFAULT false NOT NULL,
    totp_last_step bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    password_must_change boolean DEFAULT false NOT NULL,
    CONSTRAINT users_pkey PRIMARY KEY (id)
);

-- The workspace's own settings (its name for emails, the two-step sign-in policy): one row, keyed by `singleton`.
CREATE TABLE workspace_settings (
    workspace_name text,
    require_mfa boolean DEFAULT false NOT NULL,
    singleton boolean DEFAULT true NOT NULL,
    CONSTRAINT workspace_settings_one CHECK (singleton),
    CONSTRAINT workspace_settings_pkey PRIMARY KEY (singleton)
);

-- ── Sequences and identity columns ───────────────────────────────────────────────────────────────

CREATE SEQUENCE auth_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE auth_events_id_seq OWNED BY auth_events.id;

ALTER TABLE ONLY auth_events ALTER COLUMN id SET DEFAULT nextval('auth_events_id_seq'::regclass);

-- ── Foreign keys and other constraints ───────────────────────────────────────────────────────────

ALTER TABLE ONLY agent_grants
    ADD CONSTRAINT agent_grants_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE;

ALTER TABLE ONLY auth_challenges
    ADD CONSTRAINT auth_challenges_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY auth_recovery_codes
    ADD CONSTRAINT auth_recovery_codes_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY auth_refresh_tokens
    ADD CONSTRAINT auth_refresh_tokens_session_id_fkey FOREIGN KEY (session_id) REFERENCES auth_sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY auth_sessions
    ADD CONSTRAINT auth_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY member_avatars
    ADD CONSTRAINT member_avatars_member_fk FOREIGN KEY (user_id) REFERENCES members(user_id) ON DELETE CASCADE;

ALTER TABLE ONLY member_roles
    ADD CONSTRAINT member_roles_role_id_fkey FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE;

ALTER TABLE ONLY member_roles
    ADD CONSTRAINT member_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES members(user_id) ON DELETE CASCADE;

ALTER TABLE ONLY role_grants
    ADD CONSTRAINT role_grants_role_id_fkey FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE;

ALTER TABLE ONLY team_members
    ADD CONSTRAINT team_members_team_id_fkey FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE;

ALTER TABLE ONLY team_members
    ADD CONSTRAINT team_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES members(user_id) ON DELETE CASCADE;

ALTER TABLE ONLY user_identities
    ADD CONSTRAINT user_identities_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- ── Indexes ──────────────────────────────────────────────────────────────────────────────────────

CREATE INDEX account_tokens_user_idx ON account_tokens USING btree (user_id, purpose) WHERE (used_at IS NULL);
CREATE INDEX api_keys_creator_idx ON api_keys USING btree (created_by) WHERE personal;
CREATE INDEX audit_log_at_idx ON audit_log USING btree (at DESC);
CREATE INDEX auth_events_at_idx ON auth_events USING btree (at DESC);
CREATE INDEX auth_events_email_idx ON auth_events USING btree (lower(email), at DESC);
CREATE INDEX auth_events_user_idx ON auth_events USING btree (user_id, at DESC);
CREATE INDEX auth_refresh_tokens_session_idx ON auth_refresh_tokens USING btree (session_id);
CREATE INDEX auth_sessions_user_idx ON auth_sessions USING btree (user_id) WHERE (revoked_at IS NULL);
CREATE INDEX dead_events_replay_requested_idx ON dead_events USING btree (id) WHERE ((replay_requested_at IS NOT NULL) AND (replayed_at IS NULL));
CREATE INDEX dead_events_waiting_idx ON dead_events USING btree (failed_at) WHERE (replayed_at IS NULL);
CREATE INDEX member_roles_role_idx ON member_roles USING btree (role_id);
CREATE UNIQUE INDEX members_external_id ON members USING btree (external_id) WHERE (external_id IS NOT NULL);
CREATE INDEX outbox_created_idx ON outbox USING btree (created_at);
CREATE INDEX outbox_unpublished_idx ON outbox USING btree (created_at) WHERE (published_at IS NULL);
CREATE INDEX user_identities_user_idx ON user_identities USING btree (user_id);
CREATE UNIQUE INDEX users_email_idx ON users USING btree (lower(email));

-- ── Triggers ─────────────────────────────────────────────────────────────────────────────────────

CREATE TRIGGER outbox_notify AFTER INSERT ON outbox FOR EACH STATEMENT EXECUTE FUNCTION outbox_notify();

-- ── Grants ───────────────────────────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION outbox_claim(lim integer, skip text[]) FROM PUBLIC;
GRANT ALL ON FUNCTION outbox_claim(lim integer, skip text[]) TO workspace_identity_rw;
REVOKE ALL ON FUNCTION outbox_mark_published(ids text[]) FROM PUBLIC;
GRANT ALL ON FUNCTION outbox_mark_published(ids text[]) TO workspace_identity_rw;
REVOKE ALL ON FUNCTION outbox_prune(keep_days integer, lim integer) FROM PUBLIC;
GRANT ALL ON FUNCTION outbox_prune(keep_days integer, lim integer) TO workspace_identity_rw;
REVOKE ALL ON FUNCTION outbox_waiting() FROM PUBLIC;
GRANT ALL ON FUNCTION outbox_waiting() TO workspace_identity_rw;
REVOKE ALL ON FUNCTION prune_processed_events(keep_days integer, lim integer) FROM PUBLIC;
GRANT ALL ON FUNCTION prune_processed_events(keep_days integer, lim integer) TO workspace_identity_rw;
REVOKE ALL ON FUNCTION revoke_personal_api_keys(uid text) FROM PUBLIC;
GRANT ALL ON FUNCTION revoke_personal_api_keys(uid text) TO workspace_identity_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE account_tokens TO workspace_identity_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE agent_grants TO workspace_identity_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE agents TO workspace_identity_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE api_keys TO workspace_identity_rw;
GRANT SELECT ON TABLE api_keys TO workspace_maintenance;
GRANT UPDATE (revoked_at) ON TABLE api_keys TO workspace_maintenance;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE audit_log TO workspace_identity_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE auth_challenges TO workspace_identity_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE auth_events TO workspace_identity_rw;
GRANT USAGE ON SEQUENCE auth_events_id_seq TO workspace_identity_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE auth_keys TO workspace_identity_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE auth_recovery_codes TO workspace_identity_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE auth_refresh_tokens TO workspace_identity_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE auth_sessions TO workspace_identity_rw;
-- Dead letters: the module may only insert; the maintenance role reads, replays and prunes.
GRANT INSERT ON TABLE dead_events TO workspace_identity_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE dead_events TO workspace_maintenance;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE member_avatars TO workspace_identity_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE member_roles TO workspace_identity_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE members TO workspace_identity_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE outbox TO workspace_identity_rw;
GRANT SELECT,DELETE,UPDATE ON TABLE outbox TO workspace_maintenance;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE processed_events TO workspace_identity_rw;
GRANT SELECT,DELETE ON TABLE processed_events TO workspace_maintenance;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE role_grants TO workspace_identity_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE roles TO workspace_identity_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE sso_configs TO workspace_identity_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE sso_states TO workspace_identity_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE team_members TO workspace_identity_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE teams TO workspace_identity_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE user_identities TO workspace_identity_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE users TO workspace_identity_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE workspace_settings TO workspace_identity_rw;

-- ── SECURITY DEFINER functions run as workspace_maintenance ──────────────────────────────────────

ALTER FUNCTION outbox_claim(lim integer, skip text[]) OWNER TO workspace_maintenance;
ALTER FUNCTION outbox_mark_published(ids text[]) OWNER TO workspace_maintenance;
ALTER FUNCTION outbox_prune(keep_days integer, lim integer) OWNER TO workspace_maintenance;
ALTER FUNCTION outbox_waiting() OWNER TO workspace_maintenance;
ALTER FUNCTION prune_processed_events(keep_days integer, lim integer) OWNER TO workspace_maintenance;
ALTER FUNCTION revoke_personal_api_keys(uid text) OWNER TO workspace_maintenance;

-- ── Tables added by later migrations get the usual read/write grants (narrow them there if needed) ────

DO $$
BEGIN
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE workspace_owner IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO workspace_identity_rw', current_schema());
END
$$;
