-- platform schema, baseline.
--
-- What each table is for, and why it is shaped this way: docs/database/platform.md. New changes go in new files
-- (002_*.sql, …); never edit this one once released.
--
-- The migration runner applies it with search_path = <schema>, public, pg_temp (backend/packages/service-kit/src/migrate.ts),
-- so names below are unqualified and the file works for any schema name. SECURITY DEFINER functions pin that
-- path (SET search_path FROM CURRENT) and are owned by workspace_maintenance (NOLOGIN); every other object
-- belongs to workspace_owner. The module reaches the schema through workspace_platform_rw, granted to its login role.
--
-- An installation holds one workspace (ADR 0023): `workspace` and `workspace_config` are one row each, keyed by
-- `singleton`, a key only `true` satisfies.

SET LOCAL check_function_bodies = false;

-- ── Schema access ────────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO workspace_platform_rw', current_schema());
  -- CREATE because a SECURITY DEFINER function can only be handed to a role that may create in its schema.
  EXECUTE format('GRANT USAGE, CREATE ON SCHEMA %I TO workspace_maintenance', current_schema());
END
$$;

-- ── Functions (SQL bodies are checked when called; check_function_bodies is off above) ───────────

-- Admin audit entries older than keep_days, oldest first, at most lim rows (the retention job).
CREATE FUNCTION audit_log_prune(keep_days integer, lim integer) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
DECLARE n integer;
BEGIN
  DELETE FROM audit_log a
   USING (SELECT id FROM audit_log WHERE at < now() - make_interval(days => greatest(keep_days, 1)) ORDER BY at LIMIT lim) old
   WHERE a.id = old.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

-- Due deliveries for the webhook job, each pushed two minutes ahead so a second runner skips it meanwhile.
CREATE FUNCTION claim_webhook_deliveries(lim integer) RETURNS TABLE(id text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
  UPDATE webhook_deliveries d SET next_attempt_at = now() + interval '2 minutes'
   WHERE d.id IN (SELECT x.id FROM webhook_deliveries x WHERE x.status = 'pending' AND x.next_attempt_at <= now()
                   ORDER BY x.next_attempt_at LIMIT lim FOR UPDATE SKIP LOCKED)
  RETURNING d.id
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

-- Settled deliveries older than keep_days, except the newest delivery of each webhook, which Admin › Webhooks
-- shows as "last delivery" however old it is.
CREATE FUNCTION webhook_deliveries_prune(keep_days integer, lim integer) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
DECLARE n integer;
BEGIN
  DELETE FROM webhook_deliveries d
   USING (SELECT x.id FROM webhook_deliveries x
           WHERE x.status <> 'pending' AND x.created_at < now() - make_interval(days => greatest(keep_days, 1))
             AND EXISTS (SELECT 1 FROM webhook_deliveries y WHERE y.webhook_id = x.webhook_id AND y.created_at > x.created_at)
           ORDER BY x.created_at LIMIT lim) old
   WHERE d.id = old.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

-- ── Tables ───────────────────────────────────────────────────────────────────────────────────────

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

-- Events a consumer gave up on. `dlq replay` (a separate process) sets replay_requested_at; the server's replay job
-- delivers the row and stamps replayed_at (events are delivered inside the server process, ADR 0021).
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

CREATE TABLE master_data (
    kind text NOT NULL,
    code text NOT NULL,
    label jsonb NOT NULL,
    active boolean DEFAULT true NOT NULL,
    version integer NOT NULL,
    CONSTRAINT master_data_pkey PRIMARY KEY (kind, code)
);

CREATE TABLE master_data_versions (
    kind text NOT NULL,
    version integer NOT NULL,
    CONSTRAINT master_data_versions_pkey PRIMARY KEY (kind)
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

CREATE TABLE webhook_deliveries (
    id text NOT NULL,
    webhook_id text NOT NULL,
    event_id text NOT NULL,
    event_type text NOT NULL,
    body jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    response_status integer,
    error text,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    delivered_at timestamp with time zone,
    CONSTRAINT webhook_deliveries_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'succeeded'::text, 'failed'::text]))),
    CONSTRAINT webhook_deliveries_pkey PRIMARY KEY (id),
    CONSTRAINT webhook_deliveries_webhook_id_event_id_key UNIQUE (webhook_id, event_id)
);

CREATE TABLE webhooks (
    id text NOT NULL,
    url text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    events text[] NOT NULL,
    secret text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    failure_count integer DEFAULT 0 NOT NULL,
    disabled_reason text,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT webhooks_pkey PRIMARY KEY (id)
);

-- The installation's workspace, created at first-run setup.
CREATE TABLE workspace (
    singleton boolean DEFAULT true NOT NULL,
    name text NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_one CHECK (singleton),
    CONSTRAINT workspace_status_check CHECK ((status = ANY (ARRAY['provisioning'::text, 'active'::text, 'suspended'::text]))),
    CONSTRAINT workspace_pkey PRIMARY KEY (singleton)
);

-- Its settings; `version` orders the snapshots other modules project (platform.workspace.config_changed.v1).
CREATE TABLE workspace_config (
    singleton boolean DEFAULT true NOT NULL,
    version integer NOT NULL,
    config jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_config_one CHECK (singleton),
    CONSTRAINT workspace_config_pkey PRIMARY KEY (singleton)
);

-- The workspace's logo (Admin › Cài đặt), stored in the database like member photos: small (≤ 256 KB, checked by the
-- module), one row, and served by the gateway without sign-in so the sign-in page can show it.
-- config.branding.logoUrl points at it with a version (`/api/workspace-logo?v=N`) so browsers may cache each one.
CREATE TABLE workspace_logo (
    singleton boolean DEFAULT true NOT NULL,
    content_type text NOT NULL,
    image bytea NOT NULL,
    version integer NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_logo_one CHECK (singleton),
    CONSTRAINT workspace_logo_pkey PRIMARY KEY (singleton),
    CONSTRAINT workspace_logo_type CHECK (content_type = ANY (ARRAY['image/png'::text, 'image/jpeg'::text, 'image/webp'::text, 'image/svg+xml'::text]))
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

-- ── Foreign keys ─────────────────────────────────────────────────────────────────────────────────

-- The settings belong to the workspace row: it exists first (signup) and is never removed.
ALTER TABLE ONLY workspace_config
    ADD CONSTRAINT workspace_config_workspace_fkey FOREIGN KEY (singleton) REFERENCES workspace(singleton);

-- ── Indexes ──────────────────────────────────────────────────────────────────────────────────────

CREATE INDEX audit_log_at_idx ON audit_log USING btree (at);
CREATE INDEX dead_events_replay_requested_idx ON dead_events USING btree (id) WHERE ((replay_requested_at IS NOT NULL) AND (replayed_at IS NULL));
CREATE INDEX dead_events_waiting_idx ON dead_events USING btree (failed_at) WHERE (replayed_at IS NULL);
CREATE INDEX outbox_created_idx ON outbox USING btree (created_at);
CREATE INDEX outbox_unpublished_idx ON outbox USING btree (created_at) WHERE (published_at IS NULL);
CREATE INDEX processed_events_processed_at_idx ON processed_events USING btree (processed_at);
CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries USING btree (next_attempt_at) WHERE (status = 'pending'::text);
CREATE INDEX webhook_deliveries_hook_idx ON webhook_deliveries USING btree (webhook_id, created_at DESC);
-- Only settled deliveries are pruned; pending ones are retried until they settle.
CREATE INDEX webhook_deliveries_settled_idx ON webhook_deliveries USING btree (created_at) WHERE (status <> 'pending'::text);

-- ── Triggers ─────────────────────────────────────────────────────────────────────────────────────

CREATE TRIGGER outbox_notify AFTER INSERT ON outbox FOR EACH STATEMENT EXECUTE FUNCTION outbox_notify();

-- ── Grants ───────────────────────────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION audit_log_prune(keep_days integer, lim integer) FROM PUBLIC;
GRANT ALL ON FUNCTION audit_log_prune(keep_days integer, lim integer) TO workspace_platform_rw;
REVOKE ALL ON FUNCTION claim_webhook_deliveries(lim integer) FROM PUBLIC;
GRANT ALL ON FUNCTION claim_webhook_deliveries(lim integer) TO workspace_platform_rw;
REVOKE ALL ON FUNCTION outbox_claim(lim integer, skip text[]) FROM PUBLIC;
GRANT ALL ON FUNCTION outbox_claim(lim integer, skip text[]) TO workspace_platform_rw;
REVOKE ALL ON FUNCTION outbox_mark_published(ids text[]) FROM PUBLIC;
GRANT ALL ON FUNCTION outbox_mark_published(ids text[]) TO workspace_platform_rw;
REVOKE ALL ON FUNCTION outbox_prune(keep_days integer, lim integer) FROM PUBLIC;
GRANT ALL ON FUNCTION outbox_prune(keep_days integer, lim integer) TO workspace_platform_rw;
REVOKE ALL ON FUNCTION outbox_waiting() FROM PUBLIC;
GRANT ALL ON FUNCTION outbox_waiting() TO workspace_platform_rw;
REVOKE ALL ON FUNCTION prune_processed_events(keep_days integer, lim integer) FROM PUBLIC;
GRANT ALL ON FUNCTION prune_processed_events(keep_days integer, lim integer) TO workspace_platform_rw;
REVOKE ALL ON FUNCTION webhook_deliveries_prune(keep_days integer, lim integer) FROM PUBLIC;
GRANT ALL ON FUNCTION webhook_deliveries_prune(keep_days integer, lim integer) TO workspace_platform_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE audit_log TO workspace_platform_rw;
GRANT SELECT,DELETE ON TABLE audit_log TO workspace_maintenance;
GRANT INSERT ON TABLE dead_events TO workspace_platform_rw;
-- INSERT: `dlq outbox-replay` queues outbox events here as the maintenance role.
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE dead_events TO workspace_maintenance;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE master_data TO workspace_platform_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE master_data_versions TO workspace_platform_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE outbox TO workspace_platform_rw;
GRANT SELECT,DELETE,UPDATE ON TABLE outbox TO workspace_maintenance;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE processed_events TO workspace_platform_rw;
GRANT SELECT,DELETE ON TABLE processed_events TO workspace_maintenance;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE webhook_deliveries TO workspace_platform_rw;
GRANT SELECT,DELETE,UPDATE ON TABLE webhook_deliveries TO workspace_maintenance;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE webhooks TO workspace_platform_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE workspace TO workspace_platform_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE workspace_config TO workspace_platform_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE workspace_logo TO workspace_platform_rw;

-- ── SECURITY DEFINER functions run as workspace_maintenance ──────────────────────────────────────

ALTER FUNCTION audit_log_prune(keep_days integer, lim integer) OWNER TO workspace_maintenance;
ALTER FUNCTION claim_webhook_deliveries(lim integer) OWNER TO workspace_maintenance;
ALTER FUNCTION outbox_claim(lim integer, skip text[]) OWNER TO workspace_maintenance;
ALTER FUNCTION outbox_mark_published(ids text[]) OWNER TO workspace_maintenance;
ALTER FUNCTION outbox_prune(keep_days integer, lim integer) OWNER TO workspace_maintenance;
ALTER FUNCTION outbox_waiting() OWNER TO workspace_maintenance;
ALTER FUNCTION prune_processed_events(keep_days integer, lim integer) OWNER TO workspace_maintenance;
ALTER FUNCTION webhook_deliveries_prune(keep_days integer, lim integer) OWNER TO workspace_maintenance;

-- ── Tables added by later migrations get the usual read/write grants (narrow them there if needed) ────

DO $$
BEGIN
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE workspace_owner IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO workspace_platform_rw', current_schema());
END
$$;

-- ── Reference data ───────────────────────────────────────────────────────────────────────────────

INSERT INTO master_data (kind, code, label, active, version) VALUES ('currency', 'VND', '{"en": "Vietnamese dong", "vi": "Đồng Việt Nam"}', true, 1);
INSERT INTO master_data (kind, code, label, active, version) VALUES ('currency', 'USD', '{"en": "US dollar", "vi": "Đô la Mỹ"}', true, 1);
INSERT INTO master_data (kind, code, label, active, version) VALUES ('currency', 'SGD', '{"en": "Singapore dollar", "vi": "Đô la Singapore"}', true, 1);
INSERT INTO master_data (kind, code, label, active, version) VALUES ('country', 'VN', '{"en": "Vietnam", "vi": "Việt Nam"}', true, 1);
INSERT INTO master_data (kind, code, label, active, version) VALUES ('country', 'SG', '{"en": "Singapore", "vi": "Singapore"}', true, 1);
INSERT INTO master_data (kind, code, label, active, version) VALUES ('country', 'TH', '{"en": "Thailand", "vi": "Thái Lan"}', true, 1);
INSERT INTO master_data (kind, code, label, active, version) VALUES ('timezone', 'Asia/Ho_Chi_Minh', '{"en": "Ho Chi Minh City", "vi": "TP. Hồ Chí Minh"}', true, 1);
INSERT INTO master_data (kind, code, label, active, version) VALUES ('timezone', 'Asia/Singapore', '{"en": "Singapore", "vi": "Singapore"}', true, 1);
INSERT INTO master_data (kind, code, label, active, version) VALUES ('language', 'vi', '{"en": "Vietnamese", "vi": "Tiếng Việt"}', true, 1);
INSERT INTO master_data (kind, code, label, active, version) VALUES ('language', 'en', '{"en": "English", "vi": "Tiếng Anh"}', true, 1);
INSERT INTO master_data (kind, code, label, active, version) VALUES ('leave_type', 'annual', '{"en": "Annual leave", "vi": "Nghỉ phép năm"}', true, 1);
INSERT INTO master_data (kind, code, label, active, version) VALUES ('leave_type', 'sick', '{"en": "Sick leave", "vi": "Nghỉ ốm"}', true, 1);
INSERT INTO master_data (kind, code, label, active, version) VALUES ('leave_type', 'unpaid', '{"en": "Unpaid leave", "vi": "Nghỉ không lương"}', true, 1);
INSERT INTO master_data (kind, code, label, active, version) VALUES ('job_level', 'L1', '{"en": "Junior", "vi": "Nhân viên"}', true, 1);
INSERT INTO master_data (kind, code, label, active, version) VALUES ('job_level', 'L2', '{"en": "Senior", "vi": "Chuyên viên"}', true, 1);
INSERT INTO master_data (kind, code, label, active, version) VALUES ('job_level', 'L3', '{"en": "Lead", "vi": "Trưởng nhóm"}', true, 1);
INSERT INTO master_data (kind, code, label, active, version) VALUES ('industry', 'tech', '{"en": "Technology", "vi": "Công nghệ"}', true, 1);
INSERT INTO master_data (kind, code, label, active, version) VALUES ('industry', 'retail', '{"en": "Retail", "vi": "Bán lẻ"}', true, 1);
INSERT INTO master_data (kind, code, label, active, version) VALUES ('notification_type', 'mention', '{"en": "Mention", "vi": "Nhắc tên"}', true, 1);
INSERT INTO master_data (kind, code, label, active, version) VALUES ('notification_type', 'approval', '{"en": "Approval", "vi": "Phê duyệt"}', true, 1);
INSERT INTO master_data_versions (kind, version) VALUES ('notification_type', 1);
INSERT INTO master_data_versions (kind, version) VALUES ('job_level', 1);
INSERT INTO master_data_versions (kind, version) VALUES ('currency', 1);
INSERT INTO master_data_versions (kind, version) VALUES ('country', 1);
INSERT INTO master_data_versions (kind, version) VALUES ('industry', 1);
INSERT INTO master_data_versions (kind, version) VALUES ('leave_type', 1);
INSERT INTO master_data_versions (kind, version) VALUES ('timezone', 1);
INSERT INTO master_data_versions (kind, version) VALUES ('language', 1);
