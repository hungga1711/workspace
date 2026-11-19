-- employee schema, baseline.
--
-- What each table is for, and why it is shaped this way: docs/database/employee.md. New changes go in new files
-- (002_*.sql, …); never edit this one once released.
--
-- The migration runner applies it with search_path = <schema>, public, pg_temp (backend/packages/service-kit/src/migrate.ts),
-- so names below are unqualified and the file works for any schema name. SECURITY DEFINER functions pin that
-- path (SET search_path FROM CURRENT) and are owned by workspace_maintenance (NOLOGIN); every other object belongs
-- to workspace_owner. The module reaches the schema through workspace_employee_rw, granted to its login role.

SET LOCAL check_function_bodies = false;

-- ── Schema access ────────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO workspace_employee_rw', current_schema());
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

CREATE TABLE announcement_reads (
    announcement_id text NOT NULL,
    user_id text NOT NULL,
    read_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT announcement_reads_pkey PRIMARY KEY (announcement_id, user_id)
);

CREATE TABLE announcements (
    id text NOT NULL,
    title text NOT NULL,
    body text DEFAULT ''::text NOT NULL,
    category text DEFAULT 'general'::text NOT NULL,
    author_id text NOT NULL,
    department_ids text[] DEFAULT '{}'::text[] NOT NULL,
    pinned boolean DEFAULT false NOT NULL,
    event_at timestamp with time zone,
    link_url text,
    publish_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT announcements_category_check CHECK ((category = ANY (ARRAY['general'::text, 'event'::text, 'policy'::text, 'learning'::text, 'wellness'::text, 'celebration'::text, 'program'::text]))),
    CONSTRAINT announcements_pkey PRIMARY KEY (id)
);

-- One row per check-in (a day may hold several, and a night shift ends the next day), with its lateness.
CREATE TABLE attendance (
    id text NOT NULL,
    user_id text NOT NULL,
    day date NOT NULL,
    check_in timestamp with time zone NOT NULL,
    check_out timestamp with time zone,
    source text DEFAULT 'web'::text NOT NULL,
    late_minutes integer DEFAULT 0 NOT NULL,
    corrected_by text,
    corrected_at timestamp with time zone,
    correction_note text,
    CONSTRAINT attendance_check CHECK (((check_out IS NULL) OR (check_out >= check_in))),
    CONSTRAINT attendance_source_check CHECK ((source = ANY (ARRAY['web'::text, 'mobile'::text, 'admin'::text]))),
    CONSTRAINT attendance_pkey PRIMARY KEY (id)
);

-- Self-service corrections of a check-in, decided by the person's manager.
CREATE TABLE attendance_corrections (
    id text NOT NULL,
    user_id text NOT NULL,
    day date NOT NULL,
    check_in timestamp with time zone NOT NULL,
    check_out timestamp with time zone,
    reason text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    approver_id text,
    decided_by text,
    decided_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT attendance_corrections_check CHECK (((check_out IS NULL) OR (check_out >= check_in))),
    CONSTRAINT attendance_corrections_reason_check CHECK (((length(reason) >= 1) AND (length(reason) <= 300))),
    CONSTRAINT attendance_corrections_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'cancelled'::text]))),
    CONSTRAINT attendance_corrections_pkey PRIMARY KEY (id)
);

CREATE TABLE code_counters (
    entity text NOT NULL,
    value bigint NOT NULL,
    CONSTRAINT code_counters_pkey PRIMARY KEY (entity)
);

CREATE TABLE compensation (
    user_id text NOT NULL,
    base_salary numeric(14,2) NOT NULL,
    currency text NOT NULL,
    effective_from date NOT NULL,
    CONSTRAINT compensation_base_salary_check CHECK ((base_salary >= (0)::numeric)),
    CONSTRAINT compensation_pkey PRIMARY KEY (user_id, effective_from)
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

CREATE TABLE delegations (
    user_id text NOT NULL,
    delegate_id text NOT NULL,
    until_date date NOT NULL,
    CONSTRAINT delegations_pkey PRIMARY KEY (user_id)
);

CREATE TABLE departments (
    id text NOT NULL,
    name text NOT NULL,
    head_id text,
    CONSTRAINT departments_pkey PRIMARY KEY (id),
    CONSTRAINT departments_name_key UNIQUE (name)
);

-- People settings of the workspace (one row): work week, shift, lateness and the start-of-year leave grant.
CREATE TABLE employee_settings (
    singleton boolean DEFAULT true NOT NULL,
    work_week smallint[] DEFAULT '{1,2,3,4,5}'::smallint[] NOT NULL,
    shift_start time without time zone,
    shift_end time without time zone,
    late_after_min integer DEFAULT 0 NOT NULL,
    leave_auto_grant boolean DEFAULT false NOT NULL,
    leave_type_code text DEFAULT 'annual'::text NOT NULL,
    leave_default_days numeric(5,1) DEFAULT 12 NOT NULL,
    leave_prorate boolean DEFAULT true NOT NULL,
    leave_seniority boolean DEFAULT false NOT NULL,
    leave_carry_over_max numeric(5,1) DEFAULT 0 NOT NULL,
    leave_last_granted_year integer,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT employee_settings_late_check CHECK (((late_after_min >= 0) AND (late_after_min <= 240))),
    CONSTRAINT employee_settings_pkey_one CHECK (singleton),
    CONSTRAINT employee_settings_pkey PRIMARY KEY (singleton)
);

CREATE TABLE employees (
    user_id text NOT NULL,
    code text NOT NULL,
    display_name text NOT NULL,
    title text DEFAULT ''::text NOT NULL,
    department_id text,
    manager_id text,
    job_level text,
    hire_date date,
    location text DEFAULT ''::text NOT NULL,
    phone text DEFAULT ''::text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT employees_check CHECK (((manager_id IS NULL) OR (manager_id <> user_id))),
    CONSTRAINT employees_pkey PRIMARY KEY (user_id),
    CONSTRAINT employees_code_key UNIQUE (code)
);

CREATE TABLE holidays (
    day date NOT NULL,
    name text NOT NULL,
    CONSTRAINT holidays_name_check CHECK (((length(name) >= 1) AND (length(name) <= 100))),
    CONSTRAINT holidays_pkey PRIMARY KEY (day)
);

CREATE TABLE leave_balances (
    user_id text NOT NULL,
    leave_type text NOT NULL,
    year integer NOT NULL,
    entitled_days numeric(5,1) NOT NULL,
    used_days numeric(5,1) DEFAULT 0 NOT NULL,
    CONSTRAINT leave_balances_check CHECK ((used_days <= entitled_days)),
    CONSTRAINT leave_balances_pkey PRIMARY KEY (user_id, leave_type, year)
);

CREATE TABLE leave_requests (
    id text NOT NULL,
    user_id text NOT NULL,
    leave_type text NOT NULL,
    start_date date NOT NULL,
    end_date date NOT NULL,
    days numeric(5,1) NOT NULL,
    reason text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    approver_id text,
    decided_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    on_behalf_of text,
    -- Who decided and what they wrote: HR can decide anyone's request from Admin › Nghỉ phép › Đơn nghỉ, so the
    -- routed approver is not always the decider.
    decided_by text,
    decision_note text,
    CONSTRAINT leave_requests_check CHECK ((end_date >= start_date)),
    CONSTRAINT leave_requests_days_check CHECK ((days > (0)::numeric)),
    CONSTRAINT leave_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'cancelled'::text]))),
    CONSTRAINT leave_requests_pkey PRIMARY KEY (id)
);

-- The workspace's own leave types. The built-ins (annual, sick, unpaid) are written the first time anyone reads
-- them, so a new workspace starts with them and an admin can rename or retire them.
CREATE TABLE leave_types (
    code text NOT NULL,
    name_vi text NOT NULL,
    name_en text NOT NULL,
    paid boolean DEFAULT true NOT NULL,
    requires_balance boolean DEFAULT true NOT NULL,
    color text DEFAULT ''::text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    sort integer DEFAULT 100 NOT NULL,
    CONSTRAINT leave_types_code_check CHECK ((code ~ '^[a-z][a-z0-9_]{0,29}$'::text)),
    CONSTRAINT leave_types_name_vi_check CHECK (((length(name_vi) >= 1) AND (length(name_vi) <= 60))),
    CONSTRAINT leave_types_name_en_check CHECK (((length(name_en) >= 1) AND (length(name_en) <= 60))),
    CONSTRAINT leave_types_pkey PRIMARY KEY (code)
);

CREATE TABLE master_data (
    kind text NOT NULL,
    code text NOT NULL,
    label jsonb NOT NULL,
    active boolean DEFAULT true NOT NULL,
    CONSTRAINT master_data_pkey PRIMARY KEY (kind, code)
);

CREATE TABLE master_data_versions (
    kind text NOT NULL,
    version integer NOT NULL,
    synced_at timestamp with time zone DEFAULT now() NOT NULL,
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

-- The workspace's time zone, projected from platform (one row).
CREATE TABLE workspace_settings (
    singleton boolean DEFAULT true NOT NULL,
    timezone text NOT NULL,
    version integer NOT NULL,
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

-- ── Indexes ──────────────────────────────────────────────────────────────────────────────────────

CREATE INDEX announcements_feed_idx ON announcements USING btree (publish_at DESC) WHERE (deleted_at IS NULL);
CREATE INDEX attendance_corrections_approver_idx ON attendance_corrections USING btree (approver_id, status);
CREATE INDEX attendance_corrections_user_idx ON attendance_corrections USING btree (user_id, created_at DESC);
-- One open check-in per person: check-out closes it before the next check-in (overnight shifts included).
CREATE UNIQUE INDEX attendance_open_idx ON attendance USING btree (user_id) WHERE (check_out IS NULL);
CREATE INDEX attendance_user_day_idx ON attendance USING btree (user_id, day);
CREATE INDEX dead_events_replay_requested_idx ON dead_events USING btree (id) WHERE ((replay_requested_at IS NOT NULL) AND (replayed_at IS NULL));
CREATE INDEX dead_events_waiting_idx ON dead_events USING btree (failed_at) WHERE (replayed_at IS NULL);
CREATE INDEX employees_department_idx ON employees USING btree (department_id) WHERE (department_id IS NOT NULL);
CREATE INDEX employees_manager_idx ON employees USING btree (manager_id);
CREATE INDEX leave_requests_approver_idx ON leave_requests USING btree (approver_id, status);
CREATE INDEX leave_requests_user_idx ON leave_requests USING btree (user_id);
CREATE INDEX outbox_created_idx ON outbox USING btree (created_at);
CREATE INDEX outbox_unpublished_idx ON outbox USING btree (created_at) WHERE (published_at IS NULL);
CREATE INDEX processed_events_processed_at_idx ON processed_events USING btree (processed_at);

-- ── Triggers ─────────────────────────────────────────────────────────────────────────────────────

CREATE TRIGGER outbox_notify AFTER INSERT ON outbox FOR EACH STATEMENT EXECUTE FUNCTION outbox_notify();

-- ── Grants ───────────────────────────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION outbox_claim(lim integer, skip text[]) FROM PUBLIC;
GRANT ALL ON FUNCTION outbox_claim(lim integer, skip text[]) TO workspace_employee_rw;
REVOKE ALL ON FUNCTION outbox_mark_published(ids text[]) FROM PUBLIC;
GRANT ALL ON FUNCTION outbox_mark_published(ids text[]) TO workspace_employee_rw;
REVOKE ALL ON FUNCTION outbox_prune(keep_days integer, lim integer) FROM PUBLIC;
GRANT ALL ON FUNCTION outbox_prune(keep_days integer, lim integer) TO workspace_employee_rw;
REVOKE ALL ON FUNCTION outbox_waiting() FROM PUBLIC;
GRANT ALL ON FUNCTION outbox_waiting() TO workspace_employee_rw;
REVOKE ALL ON FUNCTION prune_processed_events(keep_days integer, lim integer) FROM PUBLIC;
GRANT ALL ON FUNCTION prune_processed_events(keep_days integer, lim integer) TO workspace_employee_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE announcement_reads TO workspace_employee_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE announcements TO workspace_employee_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE attendance TO workspace_employee_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE attendance_corrections TO workspace_employee_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE code_counters TO workspace_employee_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE compensation TO workspace_employee_rw;
GRANT INSERT ON TABLE dead_events TO workspace_employee_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE dead_events TO workspace_maintenance;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE delegations TO workspace_employee_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE departments TO workspace_employee_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE employee_settings TO workspace_employee_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE employees TO workspace_employee_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE holidays TO workspace_employee_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE leave_balances TO workspace_employee_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE leave_requests TO workspace_employee_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE leave_types TO workspace_employee_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE master_data TO workspace_employee_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE master_data_versions TO workspace_employee_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE outbox TO workspace_employee_rw;
GRANT SELECT,DELETE,UPDATE ON TABLE outbox TO workspace_maintenance;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE processed_events TO workspace_employee_rw;
GRANT SELECT,DELETE ON TABLE processed_events TO workspace_maintenance;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE workspace_settings TO workspace_employee_rw;

-- ── SECURITY DEFINER functions run as workspace_maintenance ──────────────────────────────────────

ALTER FUNCTION outbox_claim(lim integer, skip text[]) OWNER TO workspace_maintenance;
ALTER FUNCTION outbox_mark_published(ids text[]) OWNER TO workspace_maintenance;
ALTER FUNCTION outbox_prune(keep_days integer, lim integer) OWNER TO workspace_maintenance;
ALTER FUNCTION outbox_waiting() OWNER TO workspace_maintenance;
ALTER FUNCTION prune_processed_events(keep_days integer, lim integer) OWNER TO workspace_maintenance;

-- ── Tables added by later migrations get the usual read/write grants (narrow them there if needed) ────

DO $$
BEGIN
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE workspace_owner IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO workspace_employee_rw', current_schema());
END
$$;
