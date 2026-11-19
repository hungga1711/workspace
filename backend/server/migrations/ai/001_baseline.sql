-- ai schema, baseline.
--
-- What each table is for, and why it is shaped this way: docs/database/ai.md. New changes go in new files
-- (002_*.sql, …); never edit this one once released.
--
-- The migration runner applies it with search_path = <schema>, public, pg_temp (backend/packages/service-kit/src/migrate.ts),
-- so names below are unqualified and the file works for any schema name. SECURITY DEFINER functions pin that
-- path (SET search_path FROM CURRENT) and are owned by workspace_maintenance (NOLOGIN); every other object belongs
-- to workspace_owner. The module reaches the schema through workspace_ai_rw, granted to its login role.
--
-- An installation holds one workspace (ADR 0023): tables that hold one row for it are keyed by `singleton`, a
-- column only `true` satisfies.

SET LOCAL check_function_bodies = false;

-- ── Schema access ────────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO workspace_ai_rw', current_schema());
  -- CREATE because a SECURITY DEFINER function can only be handed to a role that may create in its schema.
  EXECUTE format('GRANT USAGE, CREATE ON SCHEMA %I TO workspace_maintenance', current_schema());
END
$$;

-- ── Functions (SQL bodies are checked when called; check_function_bodies is off above) ───────────

-- Conversations older than the company's retention (180 days until an admin sets one), and the prompt counts of
-- those hours, so the charts never show prompts whose conversations are gone. Company-AI calls (feature <> '') stay:
-- ai_usage is kept too.
CREATE FUNCTION ai_prune_expired(lim integer) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
DECLARE n integer;
DECLARE keep interval := make_interval(days => coalesce((SELECT retention_days FROM ai_policy), 180));
BEGIN
  DELETE FROM ai_conversations WHERE id IN (SELECT id FROM ai_conversations WHERE last_at < now() - keep LIMIT lim);
  GET DIAGNOSTICS n = ROW_COUNT;
  DELETE FROM ai_hourly_stats WHERE feature = '' AND hour < now() - keep;
  RETURN n;
END
$$;

-- Who-viewed-what, safety events and the agent audit: one sweep each, `lim` rows a call, run daily by the ai module
-- with the AI_*_RETENTION_DAYS settings (365 by default).
CREATE FUNCTION ai_prune_views(days integer, lim integer) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
DECLARE n integer;
BEGIN
  DELETE FROM ai_content_views WHERE ctid IN (SELECT ctid FROM ai_content_views WHERE at < now() - make_interval(days => days) LIMIT lim);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

CREATE FUNCTION ai_prune_safety(days integer, lim integer) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
DECLARE n integer;
BEGIN
  DELETE FROM ai_safety_events WHERE ctid IN (SELECT ctid FROM ai_safety_events WHERE at < now() - make_interval(days => days) LIMIT lim);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

CREATE FUNCTION ai_prune_audit(days integer, lim integer) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
DECLARE n integer;
BEGIN
  DELETE FROM ai_audit WHERE ctid IN (SELECT ctid FROM ai_audit WHERE at < now() - make_interval(days => days) LIMIT lim);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

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

-- ── Tables ───────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE ai_audit (
    id text NOT NULL,
    actor_id text NOT NULL,
    agent_id text,
    tool text NOT NULL,
    allowed boolean NOT NULL,
    reason text,
    input jsonb NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_audit_pkey PRIMARY KEY (id)
);

CREATE TABLE ai_budget_alerts (
    scope text NOT NULL,
    scope_id text NOT NULL,
    period text NOT NULL,
    threshold integer NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_budget_alerts_pkey PRIMARY KEY (scope, scope_id, period, threshold)
);

CREATE TABLE ai_budgets (
    scope text NOT NULL,
    scope_id text DEFAULT ''::text NOT NULL,
    monthly_tokens bigint,
    monthly_usd numeric(12,2),
    updated_by text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_budgets_check CHECK (((monthly_tokens IS NOT NULL) OR (monthly_usd IS NOT NULL))),
    CONSTRAINT ai_budgets_check1 CHECK (((scope = 'workspace'::text) = (scope_id = ''::text))),
    CONSTRAINT ai_budgets_monthly_tokens_check CHECK ((monthly_tokens > 0)),
    CONSTRAINT ai_budgets_monthly_usd_check CHECK ((monthly_usd > (0)::numeric)),
    CONSTRAINT ai_budgets_scope_check CHECK ((scope = ANY (ARRAY['workspace'::text, 'department'::text, 'person'::text]))),
    CONSTRAINT ai_budgets_pkey PRIMARY KEY (scope, scope_id)
);

-- Running monthly spend per budget scope: recordUsage adds each call's tokens and cost here, so a budget check reads
-- one row per scope instead of summing the month of ai_usage_costed. Costs are frozen at record time (a later price
-- change does not rewrite past months), which is what an invoice does too.
CREATE TABLE ai_spend_month (
    month date NOT NULL,
    scope text NOT NULL,
    scope_id text NOT NULL,
    tokens bigint DEFAULT 0 NOT NULL,
    cost_usd numeric(14,6) DEFAULT 0 NOT NULL,
    CONSTRAINT ai_spend_month_pkey PRIMARY KEY (month, scope, scope_id),
    CONSTRAINT ai_spend_month_scope_check CHECK (scope = ANY (ARRAY['workspace'::text, 'department'::text, 'person'::text]))
);

CREATE TABLE ai_connections (
    id text NOT NULL,
    mode text NOT NULL,
    vendor text NOT NULL,
    name text NOT NULL,
    base_url text,
    api_key_enc text,
    key_hint text,
    model_fast text NOT NULL,
    model_smart text NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    tested_at timestamp with time zone,
    test_ok boolean,
    test_error text,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tools_ok boolean,
    CONSTRAINT ai_connections_mode_check CHECK ((mode = ANY (ARRAY['key'::text, 'api'::text, 'selfhost'::text]))),
    CONSTRAINT ai_connections_vendor_check CHECK ((vendor = ANY (ARRAY['openai'::text, 'anthropic'::text, 'gemini'::text, 'openai_compatible'::text]))),
    CONSTRAINT ai_connections_pkey PRIMARY KEY (id)
);

CREATE TABLE ai_content_views (
    id text NOT NULL,
    viewer_id text NOT NULL,
    user_id text NOT NULL,
    conversation_id text NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_content_views_pkey PRIMARY KEY (id)
);

CREATE TABLE ai_conversations (
    id text NOT NULL,
    user_id text NOT NULL,
    source text NOT NULL,
    external_key text,
    title text DEFAULT ''::text NOT NULL,
    model text DEFAULT ''::text NOT NULL,
    topic text DEFAULT 'other'::text NOT NULL,
    summary text DEFAULT ''::text NOT NULL,
    sensitive text[] DEFAULT '{}'::text[] NOT NULL,
    messages integer DEFAULT 0 NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    last_at timestamp with time zone DEFAULT now() NOT NULL,
    -- The person's one-tap "did AI help?" (ADR 0020).
    helpful text,
    helpful_at timestamp with time zone,
    -- The task this conversation helped with, and how the link was made: picked by the person, the task they had
    -- open in workspace when they sent the prompt (extension hint, confirmed), or a full-text suggestion they accepted.
    task_id text,
    task_link text,
    task_linked_at timestamp with time zone,
    -- The extension's hint, kept until the person confirms or dismisses it; never counted on its own.
    hint_task_id text,
    topic_by text DEFAULT 'keywords'::text NOT NULL,
    -- Rows from a provider's usage export (ai_imports), with the tokens and cost that row carried.
    import_id text,
    ext_tokens bigint,
    ext_cost_usd numeric(14,6),
    CONSTRAINT ai_conversations_helpful_check CHECK ((helpful IS NULL OR helpful = ANY (ARRAY['yes'::text, 'no'::text, 'partly'::text]))),
    CONSTRAINT ai_conversations_source_check CHECK ((source = ANY (ARRAY[
        'company'::text, 'chatgpt'::text, 'claude'::text, 'gemini'::text, 'copilot'::text,
        'perplexity'::text, 'deepseek'::text, 'grok'::text, 'mistral'::text, 'import'::text, 'other'::text]))),
    CONSTRAINT ai_conversations_task_link_check CHECK ((task_link IS NULL OR task_link = ANY (ARRAY['manual'::text, 'hint'::text, 'suggested'::text]))),
    CONSTRAINT ai_conversations_topic_by_check CHECK ((topic_by = ANY (ARRAY['keywords'::text, 'model'::text, 'person'::text]))),
    CONSTRAINT ai_conversations_pkey PRIMARY KEY (id)
);

CREATE TABLE ai_messages (
    id text NOT NULL,
    conversation_id text NOT NULL,
    role text NOT NULL,
    content text NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_messages_role_check CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text]))),
    CONSTRAINT ai_messages_pkey PRIMARY KEY (id)
);

CREATE TABLE ai_model_prices (
    provider text NOT NULL,
    model text NOT NULL,
    input_per_mtok numeric(12,4) NOT NULL,
    output_per_mtok numeric(12,4) NOT NULL,
    updated_by text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_model_prices_input_per_mtok_check CHECK ((input_per_mtok >= (0)::numeric)),
    CONSTRAINT ai_model_prices_output_per_mtok_check CHECK ((output_per_mtok >= (0)::numeric)),
    CONSTRAINT ai_model_prices_pkey PRIMARY KEY (provider, model)
);

CREATE TABLE ai_monitor_tokens (
    user_id text NOT NULL,
    token_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone,
    CONSTRAINT ai_monitor_tokens_pkey PRIMARY KEY (user_id),
    CONSTRAINT ai_monitor_tokens_token_hash_key UNIQUE (token_hash)
);

-- The company's AI policy: how much of a conversation is kept, for how long, and what happens when a prompt
-- carries sensitive data: warn (ask first), redact (replace with [CCCD], [CARD], [EMAIL]… and show the person the
-- redacted text before it is sent), or block.
CREATE TABLE ai_policy (
    detail text DEFAULT 'summary'::text NOT NULL,
    capture_responses boolean DEFAULT false NOT NULL,
    retention_days integer DEFAULT 180 NOT NULL,
    updated_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    sensitive_mode text DEFAULT 'warn'::text NOT NULL,
    singleton boolean DEFAULT true NOT NULL,
    CONSTRAINT ai_policy_detail_check CHECK ((detail = ANY (ARRAY['topic'::text, 'summary'::text, 'full'::text]))),
    CONSTRAINT ai_policy_pkey_one CHECK (singleton),
    CONSTRAINT ai_policy_retention_days_check CHECK (((retention_days >= 7) AND (retention_days <= 730))),
    CONSTRAINT ai_policy_sensitive_mode_check CHECK ((sensitive_mode = ANY (ARRAY['warn'::text, 'redact'::text, 'block'::text]))),
    CONSTRAINT ai_policy_pkey PRIMARY KEY (singleton)
);

-- The company's own words that must not leave it (client names, project codes), handled like the built-in kinds.
CREATE TABLE ai_keywords (
    id text NOT NULL,
    term text NOT NULL,
    label text DEFAULT ''::text NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_keywords_pkey PRIMARY KEY (id),
    CONSTRAINT ai_keywords_term_check CHECK (((length(term) >= 2) AND (length(term) <= 120)))
);

-- One row per warned, redacted or blocked send: counts per person and department, never the text.
CREATE TABLE ai_safety_events (
    id text NOT NULL,
    user_id text NOT NULL,
    source text NOT NULL,
    action text NOT NULL,
    kinds text[] DEFAULT '{}'::text[] NOT NULL,
    count integer DEFAULT 1 NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_safety_events_pkey PRIMARY KEY (id),
    CONSTRAINT ai_safety_events_action_check CHECK ((action = ANY (ARRAY['warn'::text, 'redact'::text, 'block'::text])))
);

-- A person asks for their AI data to be deleted; an admin sees the request and the person sees its state.
CREATE TABLE ai_erasure_requests (
    id text NOT NULL,
    user_id text NOT NULL,
    note text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    handled_by text,
    handled_at timestamp with time zone,
    CONSTRAINT ai_erasure_requests_pkey PRIMARY KEY (id),
    CONSTRAINT ai_erasure_requests_status_check CHECK ((status = ANY (ARRAY['open'::text, 'done'::text, 'declined'::text])))
);

-- Company topics. A row with builtin = true relabels (or adds keywords to) one of the built-in topics in insight.ts;
-- other rows are the company's own (key `c_<slug>`). Archived topics stop being assigned but keep their old rows.
CREATE TABLE ai_topics (
    key text NOT NULL,
    label_vi text DEFAULT ''::text NOT NULL,
    label_en text DEFAULT ''::text NOT NULL,
    keywords text[] DEFAULT '{}'::text[] NOT NULL,
    builtin boolean DEFAULT false NOT NULL,
    archived boolean DEFAULT false NOT NULL,
    updated_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_topics_pkey PRIMARY KEY (key),
    CONSTRAINT ai_topics_key_check CHECK ((key ~ '^[a-z][a-z0-9_]{1,39}$')),
    CONSTRAINT ai_topics_keywords_check CHECK ((cardinality(keywords) <= 60))
);

-- Prompts people chose to share, redacted before they are stored. The text is the person's own words after
-- redaction and their edits; the conversation it came from stays private.
CREATE TABLE ai_prompt_library (
    id text NOT NULL,
    author_id text NOT NULL,
    conversation_id text,
    title text NOT NULL,
    body text NOT NULL,
    topic text DEFAULT 'other'::text NOT NULL,
    uses integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, ((title || ' '::text) || body))) STORED,
    CONSTRAINT ai_prompt_library_pkey PRIMARY KEY (id),
    CONSTRAINT ai_prompt_library_title_check CHECK (((length(title) >= 1) AND (length(title) <= 120))),
    CONSTRAINT ai_prompt_library_body_check CHECK (((length(body) >= 1) AND (length(body) <= 8000)))
);

-- Imports from a provider's usage or compliance export: one log row per file, and the tokens and cost an imported
-- row carried (the company pays for those too; in-app AI cost stays in ai_usage).
CREATE TABLE ai_imports (
    id text NOT NULL,
    imported_by text NOT NULL,
    filename text DEFAULT ''::text NOT NULL,
    format text NOT NULL,
    mapping jsonb DEFAULT '{}'::jsonb NOT NULL,
    rows_total integer DEFAULT 0 NOT NULL,
    rows_imported integer DEFAULT 0 NOT NULL,
    rows_duplicate integer DEFAULT 0 NOT NULL,
    rows_unmatched integer DEFAULT 0 NOT NULL,
    rows_invalid integer DEFAULT 0 NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_imports_pkey PRIMARY KEY (id),
    CONSTRAINT ai_imports_format_check CHECK ((format = ANY (ARRAY['csv'::text, 'json'::text])))
);

-- The owner's weekly one-page report by email (Monday morning, workspace time). Off until an admin turns it on.
CREATE TABLE ai_report_settings (
    weekly_email boolean DEFAULT false NOT NULL,
    last_sent_week date,
    updated_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    singleton boolean DEFAULT true NOT NULL,
    CONSTRAINT ai_report_settings_pkey_one CHECK (singleton),
    CONSTRAINT ai_report_settings_pkey PRIMARY KEY (singleton)
);

-- Công việc › AI reads its daily and weekly charts and its cost from this rollup, not from ai_messages and ai_usage
-- (at a million rows those were sequential scans of half the table). One row per hour, person, tool and feature: a
-- prompt sent to any AI adds to `prompts` (feature = ''); a company-AI call adds to `calls` and the tokens
-- (source = 'app', feature, provider, model). Hours, not days, so the charts can still bucket by the workspace's time
-- zone at query time. Cost is not stored: it is tokens × ai_model_prices at read time, so a price edit still changes
-- past weeks the way it does in ai_usage_costed.
CREATE TABLE ai_hourly_stats (
    hour timestamp with time zone NOT NULL,
    user_id text NOT NULL,
    source text NOT NULL,
    feature text DEFAULT '' NOT NULL,
    provider text DEFAULT '' NOT NULL,
    model text DEFAULT '' NOT NULL,
    prompts integer DEFAULT 0 NOT NULL,
    calls integer DEFAULT 0 NOT NULL,
    input_tokens bigint DEFAULT 0 NOT NULL,
    output_tokens bigint DEFAULT 0 NOT NULL,
    CONSTRAINT ai_hourly_stats_pkey PRIMARY KEY (hour, user_id, source, feature, provider, model)
);

CREATE TABLE ai_usage (
    id text NOT NULL,
    user_id text NOT NULL,
    agent_id text,
    feature text NOT NULL,
    model text NOT NULL,
    input_tokens integer NOT NULL,
    output_tokens integer NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    provider text,
    department_id text,
    subject_type text,
    subject_id text,
    CONSTRAINT ai_usage_pkey PRIMARY KEY (id)
);

-- Events are delivered inside the server process (ADR 0021), so `dlq replay` (a separate process) requests a replay
-- instead of performing it: it sets replay_requested_at, and the server's replay job delivers the row and stamps
-- replayed_at. `dlq outbox-replay` queues outbox events here the same way, as the maintenance role.
CREATE TABLE dead_events (
    id bigint NOT NULL,
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
    CONSTRAINT dead_events_consumer_stream_entry_id_key UNIQUE (consumer, stream, entry_id),
    CONSTRAINT dead_events_pkey PRIMARY KEY (id)
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

CREATE TABLE workspace_settings (
    timezone text NOT NULL,
    version integer NOT NULL,
    singleton boolean DEFAULT true NOT NULL,
    CONSTRAINT workspace_settings_pkey_one CHECK (singleton),
    CONSTRAINT workspace_settings_pkey PRIMARY KEY (singleton)
);

-- ── Sequences and identity columns ───────────────────────────────────────────────────────────────

ALTER TABLE dead_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME dead_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

-- ── Foreign keys and other constraints ───────────────────────────────────────────────────────────

ALTER TABLE ONLY ai_messages
    ADD CONSTRAINT ai_messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id) ON DELETE CASCADE;

-- ── Indexes ──────────────────────────────────────────────────────────────────────────────────────

CREATE INDEX ai_audit_at_idx ON ai_audit USING btree (at DESC);
-- Agent activity lists audit rows by agent; the retention sweeps below read by time.
CREATE INDEX ai_audit_agent_idx ON ai_audit USING btree (agent_id, at DESC) WHERE (agent_id IS NOT NULL);
CREATE INDEX ai_audit_prune_idx ON ai_audit USING btree (at);
-- At most one default connection.
CREATE UNIQUE INDEX ai_connections_default_idx ON ai_connections USING btree ((true)) WHERE is_default;
CREATE INDEX ai_content_views_user_idx ON ai_content_views USING btree (user_id, at DESC);
-- Purging or erasing deletes views by conversation.
CREATE INDEX ai_content_views_conv_idx ON ai_content_views USING btree (conversation_id);
CREATE INDEX ai_content_views_at_idx ON ai_content_views USING btree (at);
CREATE UNIQUE INDEX ai_conversations_external_idx ON ai_conversations USING btree (user_id, source, external_key) WHERE (external_key IS NOT NULL);
CREATE INDEX ai_conversations_last_idx ON ai_conversations USING btree (last_at DESC);
CREATE INDEX ai_conversations_user_idx ON ai_conversations USING btree (user_id, last_at DESC);
CREATE INDEX ai_conversations_task_idx ON ai_conversations USING btree (task_id) WHERE (task_id IS NOT NULL);
CREATE INDEX ai_conversations_import_idx ON ai_conversations USING btree (import_id) WHERE (import_id IS NOT NULL);
-- The hourly jobs: the retention sweep and the topic batch.
CREATE INDEX ai_conversations_last_at_idx ON ai_conversations USING btree (last_at);
CREATE INDEX ai_conversations_topics_due_idx ON ai_conversations USING btree (last_at) WHERE (topic_by = 'keywords');
CREATE INDEX ai_erasure_requests_user_idx ON ai_erasure_requests USING btree (user_id, requested_at DESC);
CREATE INDEX ai_hourly_stats_user_idx ON ai_hourly_stats USING btree (user_id, hour);
-- The retention sweep deletes old prompt hours.
CREATE INDEX ai_hourly_stats_hour_idx ON ai_hourly_stats USING btree (hour) WHERE (feature = '');
CREATE UNIQUE INDEX ai_keywords_term_idx ON ai_keywords USING btree (lower(term));
CREATE INDEX ai_messages_conv_idx ON ai_messages USING btree (conversation_id, at);
-- The oversight charts scan messages by time.
CREATE INDEX ai_messages_at_idx ON ai_messages USING btree (at);
CREATE INDEX ai_prompt_library_tsv_idx ON ai_prompt_library USING gin (tsv);
CREATE INDEX ai_prompt_library_recent_idx ON ai_prompt_library USING btree (created_at DESC);
CREATE INDEX ai_safety_events_at_idx ON ai_safety_events USING btree (at DESC);
CREATE INDEX ai_safety_events_user_idx ON ai_safety_events USING btree (user_id, at DESC);
CREATE INDEX ai_safety_events_prune_idx ON ai_safety_events USING btree (at);
-- Agent activity and budget checks filter usage by agent.
CREATE INDEX ai_usage_agent_idx ON ai_usage USING btree (agent_id, at DESC);
CREATE INDEX ai_usage_at_idx ON ai_usage USING btree (at DESC);
CREATE INDEX ai_usage_department_at_idx ON ai_usage USING btree (department_id, at DESC) WHERE (department_id IS NOT NULL);
CREATE INDEX ai_usage_subject_idx ON ai_usage USING btree (subject_type, subject_id) WHERE (subject_id IS NOT NULL);
CREATE INDEX ai_usage_user_at_idx ON ai_usage USING btree (user_id, at DESC);
CREATE INDEX dead_events_waiting_idx ON dead_events USING btree (failed_at) WHERE (replayed_at IS NULL);
CREATE INDEX dead_events_replay_requested_idx ON dead_events (id) WHERE replay_requested_at IS NOT NULL AND replayed_at IS NULL;
CREATE INDEX outbox_created_idx ON outbox USING btree (created_at);
CREATE INDEX outbox_unpublished_idx ON outbox USING btree (created_at) WHERE (published_at IS NULL);
CREATE INDEX processed_events_processed_at_idx ON processed_events USING btree (processed_at);

-- ── Views ────────────────────────────────────────────────────────────────────────────────────────

CREATE VIEW ai_usage_costed WITH (security_invoker='true') AS
 SELECT u.id,
    u.user_id,
    u.agent_id,
    u.feature,
    u.model,
    u.input_tokens,
    u.output_tokens,
    u.at,
    u.provider,
    u.department_id,
    u.subject_type,
    u.subject_id,
        CASE
            WHEN (pr.model IS NOT NULL) THEN ((((u.input_tokens)::numeric * pr.input_per_mtok) + ((u.output_tokens)::numeric * pr.output_per_mtok)) / (1000000)::numeric)
            WHEN ((u.provider = 'local'::text) OR (u.model = 'local-extractive'::text) OR (cn.mode = 'selfhost'::text)) THEN (0)::numeric
            ELSE NULL::numeric
        END AS cost_usd
   FROM ((ai_usage u
     LEFT JOIN ai_connections cn ON ((u.provider = ('c_'::text || cn.id))))
     LEFT JOIN LATERAL ( SELECT p.model,
            p.input_per_mtok,
            p.output_per_mtok
           FROM ai_model_prices p
          WHERE ((p.provider = u.provider) AND ((u.model = p.model) OR starts_with(u.model, (p.model || '-'::text)) OR starts_with(u.model, (p.model || ':'::text))))
          ORDER BY (length(p.model)) DESC
         LIMIT 1) pr ON (true));

-- ── Triggers ─────────────────────────────────────────────────────────────────────────────────────

CREATE TRIGGER outbox_notify AFTER INSERT ON outbox FOR EACH STATEMENT EXECUTE FUNCTION outbox_notify();

-- ── Grants ───────────────────────────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION ai_prune_expired(lim integer) FROM PUBLIC;
GRANT ALL ON FUNCTION ai_prune_expired(lim integer) TO workspace_ai_rw;
REVOKE ALL ON FUNCTION ai_prune_views(days integer, lim integer) FROM PUBLIC;
GRANT ALL ON FUNCTION ai_prune_views(days integer, lim integer) TO workspace_ai_rw;
REVOKE ALL ON FUNCTION ai_prune_safety(days integer, lim integer) FROM PUBLIC;
GRANT ALL ON FUNCTION ai_prune_safety(days integer, lim integer) TO workspace_ai_rw;
REVOKE ALL ON FUNCTION ai_prune_audit(days integer, lim integer) FROM PUBLIC;
GRANT ALL ON FUNCTION ai_prune_audit(days integer, lim integer) TO workspace_ai_rw;
REVOKE ALL ON FUNCTION outbox_claim(lim integer, skip text[]) FROM PUBLIC;
GRANT ALL ON FUNCTION outbox_claim(lim integer, skip text[]) TO workspace_ai_rw;
REVOKE ALL ON FUNCTION outbox_mark_published(ids text[]) FROM PUBLIC;
GRANT ALL ON FUNCTION outbox_mark_published(ids text[]) TO workspace_ai_rw;
REVOKE ALL ON FUNCTION outbox_prune(keep_days integer, lim integer) FROM PUBLIC;
GRANT ALL ON FUNCTION outbox_prune(keep_days integer, lim integer) TO workspace_ai_rw;
REVOKE ALL ON FUNCTION outbox_waiting() FROM PUBLIC;
GRANT ALL ON FUNCTION outbox_waiting() TO workspace_ai_rw;
REVOKE ALL ON FUNCTION prune_processed_events(keep_days integer, lim integer) FROM PUBLIC;
GRANT ALL ON FUNCTION prune_processed_events(keep_days integer, lim integer) TO workspace_ai_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ai_audit TO workspace_ai_rw;
GRANT SELECT,DELETE ON TABLE ai_audit TO workspace_maintenance;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ai_budget_alerts TO workspace_ai_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ai_budgets TO workspace_ai_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ai_connections TO workspace_ai_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ai_content_views TO workspace_ai_rw;
GRANT SELECT,DELETE ON TABLE ai_content_views TO workspace_maintenance;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ai_conversations TO workspace_ai_rw;
GRANT SELECT,DELETE ON TABLE ai_conversations TO workspace_maintenance;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ai_erasure_requests TO workspace_ai_rw;
GRANT SELECT,DELETE ON TABLE ai_erasure_requests TO workspace_maintenance;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ai_hourly_stats TO workspace_ai_rw;
GRANT SELECT,DELETE ON TABLE ai_hourly_stats TO workspace_maintenance;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ai_imports TO workspace_ai_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ai_keywords TO workspace_ai_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ai_messages TO workspace_ai_rw;
GRANT SELECT,DELETE ON TABLE ai_messages TO workspace_maintenance;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ai_model_prices TO workspace_ai_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ai_monitor_tokens TO workspace_ai_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ai_policy TO workspace_ai_rw;
GRANT SELECT ON TABLE ai_policy TO workspace_maintenance;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ai_prompt_library TO workspace_ai_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ai_report_settings TO workspace_ai_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ai_safety_events TO workspace_ai_rw;
GRANT SELECT,DELETE ON TABLE ai_safety_events TO workspace_maintenance;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ai_spend_month TO workspace_ai_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ai_topics TO workspace_ai_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ai_usage TO workspace_ai_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ai_usage_costed TO workspace_ai_rw;
GRANT INSERT ON TABLE dead_events TO workspace_ai_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE dead_events TO workspace_maintenance;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE outbox TO workspace_ai_rw;
GRANT SELECT,DELETE,UPDATE ON TABLE outbox TO workspace_maintenance;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE processed_events TO workspace_ai_rw;
GRANT SELECT,DELETE ON TABLE processed_events TO workspace_maintenance;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE workspace_settings TO workspace_ai_rw;

-- ── SECURITY DEFINER functions run as workspace_maintenance ──────────────────────────────────────

ALTER FUNCTION ai_prune_expired(lim integer) OWNER TO workspace_maintenance;
ALTER FUNCTION ai_prune_views(days integer, lim integer) OWNER TO workspace_maintenance;
ALTER FUNCTION ai_prune_safety(days integer, lim integer) OWNER TO workspace_maintenance;
ALTER FUNCTION ai_prune_audit(days integer, lim integer) OWNER TO workspace_maintenance;
ALTER FUNCTION outbox_claim(lim integer, skip text[]) OWNER TO workspace_maintenance;
ALTER FUNCTION outbox_mark_published(ids text[]) OWNER TO workspace_maintenance;
ALTER FUNCTION outbox_prune(keep_days integer, lim integer) OWNER TO workspace_maintenance;
ALTER FUNCTION outbox_waiting() OWNER TO workspace_maintenance;
ALTER FUNCTION prune_processed_events(keep_days integer, lim integer) OWNER TO workspace_maintenance;

-- ── Tables added by later migrations get the usual read/write grants (narrow them there if needed) ────

DO $$
BEGIN
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE workspace_owner IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO workspace_ai_rw', current_schema());
END
$$;
