-- work schema, baseline.
--
-- What each table is for, and why it is shaped this way: docs/database/work.md. New changes go in new files
-- (002_*.sql, …); never edit this one once released.
--
-- The migration runner applies it with search_path = <schema>, public, pg_temp (backend/packages/service-kit/src/migrate.ts),
-- so names below are unqualified and the file works for any schema name. SECURITY DEFINER functions pin that
-- path (SET search_path FROM CURRENT) and are owned by workspace_maintenance (NOLOGIN); every other object
-- belongs to workspace_owner. The module reaches the schema through workspace_work_rw, granted to its login role.
-- The installation holds one workspace (ADR 0023): a table with one row per installation is keyed by `singleton`.

SET LOCAL check_function_bodies = false;

-- ── Schema access ────────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO workspace_work_rw', current_schema());
  -- CREATE because a SECURITY DEFINER function can only be handed to a role that may create in its schema.
  EXECUTE format('GRANT USAGE, CREATE ON SCHEMA %I TO workspace_maintenance', current_schema());
END
$$;
-- ── Functions (SQL bodies are checked when called; check_function_bodies is off above) ─────────────

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

-- Lifetime counters on the project row, kept in step by a trigger on tasks: the project list reads them instead of
-- aggregating every task of every project; only the open tasks are read for the time-dependent numbers.
CREATE FUNCTION projects_task_counts() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path FROM CURRENT
    AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.project_id IS NOT NULL THEN
    UPDATE projects SET
      done_count = done_count - (CASE WHEN OLD.status = 'done' THEN 1 ELSE 0 END),
      total_count = total_count - (CASE WHEN OLD.status <> 'cancelled' THEN 1 ELSE 0 END)
    WHERE id = OLD.project_id;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.project_id IS NOT NULL THEN
    UPDATE projects SET
      done_count = done_count + (CASE WHEN NEW.status = 'done' THEN 1 ELSE 0 END),
      total_count = total_count + (CASE WHEN NEW.status <> 'cancelled' THEN 1 ELSE 0 END),
      last_task_at = greatest(last_task_at, NEW.updated_at)
    WHERE id = NEW.project_id;
  END IF;
  RETURN NULL;
END
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

-- The daily activity retention, in batches the job loops over.
CREATE FUNCTION work_activity_prune(days integer, lim integer) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
DECLARE n integer;
BEGIN
  DELETE FROM activity a
   USING (SELECT ctid FROM activity WHERE at < now() - make_interval(days => greatest(days, 1)) LIMIT greatest(lim, 1)) old
   WHERE a.ctid = old.ctid;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

-- Board columns and task statuses stay in step: the column a status lands in (work_task_column_sync).
CREATE FUNCTION work_column_for(p_project text, p_status text) RETURNS text
    LANGUAGE sql STABLE
    AS $$
  SELECT id FROM board_columns
   WHERE project_id = p_project
   ORDER BY CASE
              WHEN status = p_status THEN 0
              WHEN p_status = 'review' AND status = 'in_progress' THEN 1
              WHEN p_status IN ('done', 'cancelled') AND status = 'done' THEN 1
              WHEN status = 'todo' THEN 2
              ELSE 3
            END, position
   LIMIT 1
$$;

CREATE FUNCTION work_task_column_sync() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  col_status text;
BEGIN
  IF NEW.project_id IS NULL OR NEW.parent_id IS NOT NULL THEN
    NEW.column_id := NULL;
    RETURN NEW;
  END IF;
  -- A move to a named column: the status follows the column (cancelled stays cancelled).
  IF NEW.column_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.column_id IS DISTINCT FROM OLD.column_id) THEN
    SELECT status INTO col_status FROM board_columns WHERE id = NEW.column_id AND project_id = NEW.project_id;
    IF col_status IS NULL THEN
      NEW.column_id := work_column_for(NEW.project_id, NEW.status);
    ELSIF NEW.status <> 'cancelled' OR TG_OP = 'INSERT' THEN
      NEW.status := col_status;
    END IF;
    RETURN NEW;
  END IF;
  -- Otherwise the column follows the status (or the project) when they change, unless the current
  -- column already has that status.
  IF NEW.column_id IS NULL OR TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    SELECT status INTO col_status FROM board_columns WHERE id = NEW.column_id AND project_id = NEW.project_id;
    IF col_status IS NULL OR col_status <> NEW.status THEN
      NEW.column_id := work_column_for(NEW.project_id, NEW.status);
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ── Tables ─────────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE activity (
    id text NOT NULL,
    entity_type text NOT NULL,
    entity_id text NOT NULL,
    actor text NOT NULL,
    action text NOT NULL,
    changes jsonb DEFAULT '{}'::jsonb NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE approval_delegations (
    user_id text NOT NULL,
    delegate_id text NOT NULL,
    until_date date NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT approval_delegations_check CHECK ((user_id <> delegate_id))
);

CREATE TABLE approval_events (
    id text NOT NULL,
    approval_id text NOT NULL,
    actor_id text NOT NULL,
    kind text NOT NULL,
    body text DEFAULT ''::text NOT NULL,
    target_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT approval_events_kind_check CHECK ((kind = ANY (ARRAY['comment'::text, 'forwarded'::text])))
);

-- Requests (YC-001): an amount with its ISO 4217 currency, so companies outside Vietnam can use them.
CREATE TABLE approvals (
    id text NOT NULL,
    title text NOT NULL,
    details text DEFAULT ''::text NOT NULL,
    requester_id text NOT NULL,
    approver_id text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    decided_at timestamp with time zone,
    comment text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    on_behalf_of text,
    kind text DEFAULT 'other'::text NOT NULL,
    fields jsonb DEFAULT '{}'::jsonb NOT NULL,
    template_id text,
    amount numeric(18,2),
    currency character(3),
    code text,
    CONSTRAINT approvals_amount_check CHECK (((amount IS NULL) OR (amount >= (0)::numeric))),
    CONSTRAINT approvals_currency_check CHECK (((currency IS NULL) OR (currency ~ '^[A-Z]{3}$'::text))),
    CONSTRAINT approvals_kind_check CHECK ((kind = ANY (ARRAY['purchase'::text, 'payment'::text, 'advance'::text, 'trip'::text, 'other'::text]))),
    CONSTRAINT approvals_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'cancelled'::text])))
);

CREATE TABLE board_columns (
    project_id text NOT NULL,
    id text NOT NULL,
    name text NOT NULL,
    status text NOT NULL,
    "position" integer NOT NULL,
    wip_limit integer,
    CONSTRAINT board_columns_wip_limit_check CHECK (((wip_limit IS NULL) OR (wip_limit > 0)))
);

CREATE TABLE calendar_events (
    id text NOT NULL,
    title text NOT NULL,
    kind text NOT NULL,
    starts_at timestamp with time zone NOT NULL,
    ends_at timestamp with time zone NOT NULL,
    organizer_id text NOT NULL,
    location text DEFAULT ''::text NOT NULL,
    project_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    agenda text DEFAULT ''::text NOT NULL,
    notes text DEFAULT ''::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    series_id text,
    recurrence text,
    code text,
    CONSTRAINT calendar_events_check CHECK ((ends_at >= starts_at)),
    CONSTRAINT calendar_events_kind_check CHECK ((kind = ANY (ARRAY['meeting'::text, 'deadline'::text, 'event'::text]))),
    CONSTRAINT calendar_events_recurrence_check CHECK ((recurrence = ANY (ARRAY['daily'::text, 'weekdays'::text, 'weekly'::text, 'biweekly'::text, 'monthly'::text])))
);

CREATE TABLE calendar_feeds (
    user_id text NOT NULL,
    token_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Readable codes (T-001, P-001, YC-001, H-001…): one counter per entity and period. A recurring meeting series takes
-- one number and its occurrences a suffix (H-012-1, H-012-2…).
CREATE TABLE code_counters (
    entity text NOT NULL,
    period text NOT NULL,
    value bigint NOT NULL
);

CREATE TABLE custom_field_defs (
    entity text NOT NULL,
    key text NOT NULL,
    label text NOT NULL,
    type text NOT NULL,
    options text[] DEFAULT '{}'::text[] NOT NULL,
    required boolean DEFAULT false NOT NULL,
    CONSTRAINT custom_field_defs_entity_check CHECK ((entity = ANY (ARRAY['task'::text, 'project'::text]))),
    CONSTRAINT custom_field_defs_key_check CHECK ((key ~ '^[a-z][a-z0-9_]{0,39}$'::text)),
    CONSTRAINT custom_field_defs_type_check CHECK ((type = ANY (ARRAY['text'::text, 'number'::text, 'date'::text, 'select'::text, 'boolean'::text])))
);

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
    replay_requested_at timestamp with time zone
);

CREATE TABLE decisions (
    id text NOT NULL,
    title text NOT NULL,
    details text DEFAULT ''::text NOT NULL,
    decided_by text,
    project_id text,
    source jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'decided'::text NOT NULL,
    decider_id text,
    proposed_by text,
    decided_at timestamp with time zone,
    CONSTRAINT decisions_status_check CHECK ((status = ANY (ARRAY['proposed'::text, 'decided'::text, 'withdrawn'::text])))
);

CREATE TABLE doc_comments (
    id text NOT NULL,
    document_id text NOT NULL,
    parent_id text,
    author_id text NOT NULL,
    body text NOT NULL,
    quote text,
    resolved_at timestamp with time zone,
    resolved_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT doc_comments_body_check CHECK (((length(body) >= 1) AND (length(body) <= 10000)))
);

CREATE TABLE doc_presence (
    document_id text NOT NULL,
    user_id text NOT NULL,
    editing boolean DEFAULT false NOT NULL,
    seen_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE doc_stars (
    document_id text NOT NULL,
    user_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE doc_views (
    document_id text NOT NULL,
    user_id text NOT NULL,
    views integer DEFAULT 1 NOT NULL,
    viewed_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE doc_watchers (
    document_id text NOT NULL,
    user_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE document_versions (
    document_id text NOT NULL,
    version integer NOT NULL,
    content text NOT NULL,
    author_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    format text DEFAULT 'markdown'::text NOT NULL
);

CREATE TABLE documents (
    id text NOT NULL,
    code text NOT NULL,
    title text NOT NULL,
    owner_id text NOT NULL,
    project_id text,
    visibility text DEFAULT 'private'::text NOT NULL,
    shared_with text[] DEFAULT '{}'::text[] NOT NULL,
    current_version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    space_id text,
    parent_id text,
    "position" double precision DEFAULT 0 NOT NULL,
    labels text[] DEFAULT '{}'::text[] NOT NULL,
    emoji text DEFAULT ''::text NOT NULL,
    format text DEFAULT 'markdown'::text NOT NULL,
    last_editor_id text,
    CONSTRAINT documents_format_check CHECK ((format = ANY (ARRAY['markdown'::text, 'html'::text]))),
    CONSTRAINT documents_title_check CHECK (((length(title) >= 1) AND (length(title) <= 300))),
    CONSTRAINT documents_visibility_check CHECK ((visibility = ANY (ARRAY['private'::text, 'project'::text, 'workspace'::text, 'space'::text])))
);

CREATE TABLE drive_items (
    id text NOT NULL,
    kind text NOT NULL,
    name text NOT NULL,
    parent_id text,
    owner_id text NOT NULL,
    file_id text,
    size bigint DEFAULT 0 NOT NULL,
    content_type text DEFAULT ''::text NOT NULL,
    visibility text DEFAULT 'private'::text NOT NULL,
    shared_with text[] DEFAULT '{}'::text[] NOT NULL,
    editors text[] DEFAULT '{}'::text[] NOT NULL,
    trashed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT drive_items_kind_check CHECK ((kind = ANY (ARRAY['folder'::text, 'file'::text]))),
    CONSTRAINT drive_items_name_check CHECK (((length(name) >= 1) AND (length(name) <= 255))),
    CONSTRAINT drive_items_visibility_check CHECK ((visibility = ANY (ARRAY['private'::text, 'workspace'::text])))
);

CREATE TABLE drive_stars (
    item_id text NOT NULL,
    user_id text NOT NULL
);

CREATE TABLE event_attendees (
    event_id text NOT NULL,
    user_id text NOT NULL,
    response text DEFAULT 'pending'::text NOT NULL,
    CONSTRAINT event_attendees_response_check CHECK ((response = ANY (ARRAY['pending'::text, 'accepted'::text, 'declined'::text])))
);

CREATE TABLE files (
    id text NOT NULL,
    object_key text NOT NULL,
    name text NOT NULL,
    content_type text NOT NULL,
    size bigint NOT NULL,
    status text NOT NULL,
    owner_id text NOT NULL,
    attached_type text,
    attached_id text,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT files_attached_type_check CHECK ((attached_type = ANY (ARRAY['document'::text, 'task'::text, 'chat'::text, 'drive'::text, 'whiteboard'::text]))),
    CONSTRAINT files_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'active'::text, 'deleted'::text])))
);

CREATE TABLE goals (
    id text NOT NULL,
    title text NOT NULL,
    owner_id text NOT NULL,
    department text,
    period text NOT NULL,
    starts_on date NOT NULL,
    ends_on date NOT NULL,
    archived boolean DEFAULT false NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT goals_check CHECK ((ends_on > starts_on))
);

-- `direction`: "lower is better" key results (API p95 900 → 300 ms). NULL reads it from the numbers: a target below
-- the start is lower-is-better (goal-health.ts, krDirection).
CREATE TABLE key_results (
    id text NOT NULL,
    goal_id text NOT NULL,
    title text NOT NULL,
    kind text NOT NULL,
    start_value numeric DEFAULT 0 NOT NULL,
    target numeric DEFAULT 100 NOT NULL,
    current numeric DEFAULT 0 NOT NULL,
    unit text DEFAULT ''::text NOT NULL,
    project_id text,
    "position" integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    direction text,
    CONSTRAINT key_results_check CHECK (((kind <> 'project'::text) OR (project_id IS NOT NULL))),
    CONSTRAINT key_results_check1 CHECK (((kind <> 'number'::text) OR (target <> start_value))),
    CONSTRAINT key_results_direction_check CHECK (((direction IS NULL) OR (direction = ANY (ARRAY['up'::text, 'down'::text])))),
    CONSTRAINT key_results_kind_check CHECK ((kind = ANY (ARRAY['number'::text, 'project'::text])))
);

CREATE TABLE meeting_guests (
    id text NOT NULL,
    room_id text NOT NULL,
    name text NOT NULL,
    secret_hash text NOT NULL,
    status text DEFAULT 'waiting'::text NOT NULL,
    decided_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT meeting_guests_status_check CHECK ((status = ANY (ARRAY['waiting'::text, 'admitted'::text, 'denied'::text])))
);

CREATE TABLE meeting_participants (
    room_id text NOT NULL,
    user_id text NOT NULL,
    first_joined_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE meeting_recordings (
    id text NOT NULL,
    room_id text NOT NULL,
    egress_id text NOT NULL,
    object_key text NOT NULL,
    status text DEFAULT 'recording'::text NOT NULL,
    started_by text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    CONSTRAINT meeting_recordings_status_check CHECK ((status = ANY (ARRAY['recording'::text, 'ready'::text, 'failed'::text])))
);

CREATE TABLE meeting_rooms (
    id text NOT NULL,
    code text NOT NULL,
    title text NOT NULL,
    event_id text,
    created_by text NOT NULL,
    guest_access text DEFAULT 'lobby'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone DEFAULT now() NOT NULL,
    channel_id text,
    CONSTRAINT meeting_rooms_guest_access_check CHECK ((guest_access = ANY (ARRAY['open'::text, 'lobby'::text, 'off'::text])))
);

CREATE TABLE outbox (
    id text NOT NULL,
    aggregatetype text NOT NULL,
    aggregateid text NOT NULL,
    type text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    published_at timestamp with time zone
);

CREATE TABLE processed_events (
    consumer text NOT NULL,
    event_id text NOT NULL,
    processed_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE projects (
    id text NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    owner_id text NOT NULL,
    team_id text,
    status text DEFAULT 'active'::text NOT NULL,
    due_at timestamp with time zone,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    done_count integer DEFAULT 0 NOT NULL,
    total_count integer DEFAULT 0 NOT NULL,
    last_task_at timestamp with time zone,
    CONSTRAINT projects_status_check CHECK ((status = ANY (ARRAY['active'::text, 'archived'::text])))
);

CREATE TABLE request_templates (
    id text NOT NULL,
    name text NOT NULL,
    icon text DEFAULT '📝'::text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    fields jsonb DEFAULT '[]'::jsonb NOT NULL,
    money boolean DEFAULT false NOT NULL,
    approver_id text,
    archived boolean DEFAULT false NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE spaces (
    id text NOT NULL,
    key text NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    icon text DEFAULT ''::text NOT NULL,
    visibility text DEFAULT 'workspace'::text NOT NULL,
    members text[] DEFAULT '{}'::text[] NOT NULL,
    home_id text,
    created_by text NOT NULL,
    archived boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT spaces_key_check CHECK ((key ~ '^[A-Z][A-Z0-9]{1,9}$'::text)),
    CONSTRAINT spaces_name_check CHECK (((length(name) >= 1) AND (length(name) <= 120))),
    CONSTRAINT spaces_visibility_check CHECK ((visibility = ANY (ARRAY['workspace'::text, 'restricted'::text])))
);

CREATE TABLE task_ai_assists (
    task_id text NOT NULL,
    first_at timestamp with time zone NOT NULL,
    last_at timestamp with time zone NOT NULL,
    calls integer DEFAULT 1 NOT NULL,
    tokens bigint DEFAULT 0 NOT NULL,
    people text[] DEFAULT '{}'::text[] NOT NULL
);

CREATE TABLE task_comments (
    id text NOT NULL,
    task_id text NOT NULL,
    author_id text NOT NULL,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    edited_at timestamp with time zone,
    CONSTRAINT task_comments_body_check CHECK (((length(body) >= 1) AND (length(body) <= 10000)))
);

CREATE TABLE task_dependencies (
    id text NOT NULL,
    predecessor_id text NOT NULL,
    successor_id text NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT task_dependencies_check CHECK ((predecessor_id <> successor_id))
);

CREATE TABLE tasks (
    id text NOT NULL,
    code text NOT NULL,
    title text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    owner_id text NOT NULL,
    assignee_id text,
    project_id text,
    team_id text,
    status text DEFAULT 'todo'::text NOT NULL,
    priority text DEFAULT 'medium'::text NOT NULL,
    due_at timestamp with time zone,
    labels text[] DEFAULT '{}'::text[] NOT NULL,
    custom_fields jsonb DEFAULT '{}'::jsonb NOT NULL,
    rank text NOT NULL,
    parent_id text,
    source jsonb,
    completed_at timestamp with time zone,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    blocked_reason text,
    recurrence text,
    progress smallint,
    eta_at timestamp with time zone,
    checkin_at timestamp with time zone,
    checkin_prompted_at timestamp with time zone,
    column_id text,
    start_at timestamp with time zone,
    CONSTRAINT tasks_priority_check CHECK ((priority = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text, 'urgent'::text]))),
    CONSTRAINT tasks_progress_check CHECK (((progress >= 0) AND (progress <= 100))),
    CONSTRAINT tasks_recurrence_check CHECK ((recurrence = ANY (ARRAY['daily'::text, 'weekdays'::text, 'weekly'::text, 'biweekly'::text, 'monthly'::text]))),
    CONSTRAINT tasks_status_check CHECK ((status = ANY (ARRAY['todo'::text, 'in_progress'::text, 'review'::text, 'done'::text, 'cancelled'::text]))),
    CONSTRAINT tasks_title_check CHECK (((length(title) >= 1) AND (length(title) <= 300)))
);

-- Whiteboards (ADR 0024): an Excalidraw scene per board, saved as a snapshot by the people editing it. Live editing
-- goes through chat's relay (chat.whiteboard_drafts); this row is what survives and what search and AI read. The scene
-- is Excalidraw's element JSON (≤ 5 MB, checked by the module); images are files rows attached to the board, the
-- scene only names them. `text` is every element's text in reading order, derived on save.
CREATE TABLE whiteboards (
    id text NOT NULL,
    code text NOT NULL,
    title text NOT NULL,
    project_id text,
    owner_id text NOT NULL,
    visibility text DEFAULT 'workspace'::text NOT NULL,
    template text,
    scene jsonb DEFAULT '{"elements": [], "appState": {}, "files": {}}'::jsonb NOT NULL,
    scene_version integer DEFAULT 1 NOT NULL,
    text text DEFAULT ''::text NOT NULL,
    thumbnail text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by text,
    archived_at timestamp with time zone,
    CONSTRAINT whiteboards_pkey PRIMARY KEY (id),
    CONSTRAINT whiteboards_code_key UNIQUE (code),
    CONSTRAINT whiteboards_title_check CHECK (((length(title) >= 1) AND (length(title) <= 200))),
    CONSTRAINT whiteboards_visibility_check CHECK ((visibility = ANY (ARRAY['workspace'::text, 'project'::text, 'private'::text]))),
    -- A project board needs its project (projects are archived, never deleted).
    CONSTRAINT whiteboards_project_check CHECK (((visibility <> 'project'::text) OR (project_id IS NOT NULL)))
);

-- Sticky notes turned into tasks: one task per note, so a note's badge can show its task's status.
CREATE TABLE whiteboard_task_links (
    whiteboard_id text NOT NULL,
    element_id text NOT NULL,
    task_id text NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT whiteboard_task_links_pkey PRIMARY KEY (whiteboard_id, element_id)
);

-- The workspace's code formats and time zone, projected from platform events (one row).
CREATE TABLE workspace_settings (
    code_formats jsonb NOT NULL,
    timezone text DEFAULT 'Asia/Ho_Chi_Minh'::text NOT NULL,
    version integer NOT NULL,
    singleton boolean DEFAULT true NOT NULL,
    -- The workspace's language, projected like the time zone: text written without a person's request behind it
    -- (the calendar feed a calendar app polls) follows it.
    locale text,
    CONSTRAINT workspace_settings_pkey_one CHECK (singleton)
);

-- ── Identity columns ───────────────────────────────────────────────────────────────────────────────

ALTER TABLE dead_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME dead_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

-- ── Keys and other constraints ─────────────────────────────────────────────────────────────────────

ALTER TABLE ONLY activity
    ADD CONSTRAINT activity_pkey PRIMARY KEY (id);

ALTER TABLE ONLY approval_delegations
    ADD CONSTRAINT approval_delegations_pkey PRIMARY KEY (user_id);

ALTER TABLE ONLY approval_events
    ADD CONSTRAINT approval_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY approvals
    ADD CONSTRAINT approvals_pkey PRIMARY KEY (id);

ALTER TABLE ONLY board_columns
    ADD CONSTRAINT board_columns_pkey PRIMARY KEY (id);

ALTER TABLE board_columns
    ADD CONSTRAINT board_columns_status_check CHECK ((status = ANY (ARRAY['todo'::text, 'in_progress'::text, 'review'::text, 'done'::text]))) NOT VALID;

ALTER TABLE ONLY calendar_events
    ADD CONSTRAINT calendar_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY calendar_feeds
    ADD CONSTRAINT calendar_feeds_pkey PRIMARY KEY (user_id);

ALTER TABLE ONLY calendar_feeds
    ADD CONSTRAINT calendar_feeds_token_hash_key UNIQUE (token_hash);

ALTER TABLE ONLY code_counters
    ADD CONSTRAINT code_counters_pkey PRIMARY KEY (entity, period);

ALTER TABLE ONLY custom_field_defs
    ADD CONSTRAINT custom_field_defs_pkey PRIMARY KEY (entity, key);

ALTER TABLE ONLY dead_events
    ADD CONSTRAINT dead_events_consumer_stream_entry_id_key UNIQUE (consumer, stream, entry_id);

ALTER TABLE ONLY dead_events
    ADD CONSTRAINT dead_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY decisions
    ADD CONSTRAINT decisions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY doc_comments
    ADD CONSTRAINT doc_comments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY doc_presence
    ADD CONSTRAINT doc_presence_pkey PRIMARY KEY (document_id, user_id);

ALTER TABLE ONLY doc_stars
    ADD CONSTRAINT doc_stars_pkey PRIMARY KEY (document_id, user_id);

ALTER TABLE ONLY doc_views
    ADD CONSTRAINT doc_views_pkey PRIMARY KEY (document_id, user_id);

ALTER TABLE ONLY doc_watchers
    ADD CONSTRAINT doc_watchers_pkey PRIMARY KEY (document_id, user_id);

ALTER TABLE ONLY document_versions
    ADD CONSTRAINT document_versions_pkey PRIMARY KEY (document_id, version);

ALTER TABLE ONLY documents
    ADD CONSTRAINT documents_code_key UNIQUE (code);

ALTER TABLE ONLY documents
    ADD CONSTRAINT documents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY drive_items
    ADD CONSTRAINT drive_items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY drive_stars
    ADD CONSTRAINT drive_stars_pkey PRIMARY KEY (item_id, user_id);

ALTER TABLE ONLY event_attendees
    ADD CONSTRAINT event_attendees_pkey PRIMARY KEY (event_id, user_id);

ALTER TABLE ONLY files
    ADD CONSTRAINT files_pkey PRIMARY KEY (id);

ALTER TABLE ONLY goals
    ADD CONSTRAINT goals_pkey PRIMARY KEY (id);

ALTER TABLE ONLY key_results
    ADD CONSTRAINT key_results_pkey PRIMARY KEY (id);

ALTER TABLE ONLY meeting_guests
    ADD CONSTRAINT meeting_guests_pkey PRIMARY KEY (id);

ALTER TABLE ONLY meeting_participants
    ADD CONSTRAINT meeting_participants_pkey PRIMARY KEY (room_id, user_id);

ALTER TABLE ONLY meeting_recordings
    ADD CONSTRAINT meeting_recordings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY meeting_rooms
    ADD CONSTRAINT meeting_rooms_code_key UNIQUE (code);

ALTER TABLE ONLY meeting_rooms
    ADD CONSTRAINT meeting_rooms_pkey PRIMARY KEY (id);

ALTER TABLE ONLY outbox
    ADD CONSTRAINT outbox_pkey PRIMARY KEY (id);

ALTER TABLE ONLY processed_events
    ADD CONSTRAINT processed_events_pkey PRIMARY KEY (consumer, event_id);

ALTER TABLE ONLY projects
    ADD CONSTRAINT projects_code_key UNIQUE (code);

ALTER TABLE ONLY projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);

ALTER TABLE ONLY request_templates
    ADD CONSTRAINT request_templates_pkey PRIMARY KEY (id);

ALTER TABLE ONLY spaces
    ADD CONSTRAINT spaces_key_key UNIQUE (key);

ALTER TABLE ONLY spaces
    ADD CONSTRAINT spaces_pkey PRIMARY KEY (id);

ALTER TABLE ONLY task_ai_assists
    ADD CONSTRAINT task_ai_assists_pkey PRIMARY KEY (task_id);

ALTER TABLE ONLY task_comments
    ADD CONSTRAINT task_comments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY task_dependencies
    ADD CONSTRAINT task_dependencies_pkey PRIMARY KEY (id);

ALTER TABLE ONLY task_dependencies
    ADD CONSTRAINT task_dependencies_predecessor_id_successor_id_key UNIQUE (predecessor_id, successor_id);

ALTER TABLE ONLY tasks
    ADD CONSTRAINT tasks_code_key UNIQUE (code);

ALTER TABLE ONLY tasks
    ADD CONSTRAINT tasks_pkey PRIMARY KEY (id);

ALTER TABLE ONLY workspace_settings
    ADD CONSTRAINT workspace_settings_pkey PRIMARY KEY (singleton);

-- ── Indexes ────────────────────────────────────────────────────────────────────────────────────────

-- The retention job deletes by time.
CREATE INDEX activity_at_idx ON activity USING btree (at);
CREATE INDEX activity_entity_idx ON activity USING btree (entity_type, entity_id, at DESC);
CREATE INDEX approval_events_by_approval ON approval_events USING btree (approval_id, created_at);
CREATE INDEX approvals_approver_idx ON approvals USING btree (approver_id, status);
CREATE INDEX approvals_approver_status_created_idx ON approvals USING btree (approver_id, status, created_at DESC);
CREATE UNIQUE INDEX approvals_code_key ON approvals USING btree (code);
CREATE INDEX approvals_requester_idx ON approvals USING btree (requester_id, status);
CREATE INDEX board_columns_project ON board_columns USING btree (project_id, "position");
CREATE UNIQUE INDEX calendar_events_code_key ON calendar_events USING btree (code);
CREATE INDEX calendar_events_series ON calendar_events USING btree (series_id, starts_at) WHERE (series_id IS NOT NULL);
CREATE INDEX calendar_events_starts_idx ON calendar_events USING btree (starts_at);
CREATE INDEX dead_events_replay_requested_idx ON dead_events USING btree (id) WHERE ((replay_requested_at IS NOT NULL) AND (replayed_at IS NULL));
CREATE INDEX dead_events_waiting_idx ON dead_events USING btree (failed_at) WHERE (replayed_at IS NULL);
CREATE INDEX decisions_decider_idx ON decisions USING btree (decider_id, status);
CREATE INDEX decisions_project_idx ON decisions USING btree (project_id);
CREATE INDEX doc_comments_doc ON doc_comments USING btree (document_id, created_at);
CREATE INDEX doc_views_recent ON doc_views USING btree (user_id, viewed_at DESC);
CREATE INDEX documents_labels ON documents USING gin (labels);
CREATE INDEX documents_last_editor_idx ON documents USING btree (last_editor_id);
CREATE INDEX documents_owner_idx ON documents USING btree (owner_id);
CREATE INDEX documents_space_tree ON documents USING btree (space_id, parent_id, "position");
CREATE INDEX documents_updated_idx ON documents USING btree (updated_at DESC);
CREATE INDEX drive_items_kind_idx ON drive_items USING btree (kind);
CREATE INDEX drive_items_owner ON drive_items USING btree (owner_id, updated_at DESC);
CREATE INDEX drive_items_parent ON drive_items USING btree (parent_id, kind, name);
CREATE INDEX event_attendees_user_idx ON event_attendees USING btree (user_id);
CREATE INDEX files_pending_idx ON files USING btree (expires_at) WHERE (status = 'pending'::text);
CREATE INDEX goals_period_idx ON goals USING btree (ends_on DESC);
CREATE INDEX key_results_goal_idx ON key_results USING btree (goal_id, "position");
CREATE INDEX meeting_guests_room ON meeting_guests USING btree (room_id, status, created_at);
CREATE INDEX meeting_recordings_room ON meeting_recordings USING btree (room_id, started_at DESC);
CREATE INDEX meeting_rooms_channel ON meeting_rooms USING btree (channel_id, created_at DESC) WHERE (channel_id IS NOT NULL);
CREATE INDEX meeting_rooms_creator ON meeting_rooms USING btree (created_by, last_used_at DESC);
CREATE UNIQUE INDEX meeting_rooms_event ON meeting_rooms USING btree (event_id) WHERE (event_id IS NOT NULL);
CREATE INDEX outbox_created_idx ON outbox USING btree (created_at);
CREATE INDEX outbox_unpublished_idx ON outbox USING btree (created_at) WHERE (published_at IS NULL);
CREATE INDEX processed_events_processed_at_idx ON processed_events USING btree (processed_at);
CREATE INDEX task_comments_task_idx ON task_comments USING btree (task_id, created_at);
CREATE INDEX task_dependencies_successor ON task_dependencies USING btree (successor_id);
CREATE INDEX tasks_assignee_idx ON tasks USING btree (assignee_id, status, due_at);
-- The check-in prompt job (every 30 minutes) reads only open, assigned tasks by their last check-in.
CREATE INDEX tasks_checkin_due_idx ON tasks USING btree (COALESCE(checkin_at, updated_at)) WHERE ((status = ANY (ARRAY['in_progress'::text, 'review'::text])) AND (assignee_id IS NOT NULL));
CREATE INDEX tasks_column_rank ON tasks USING btree (column_id, rank) WHERE (parent_id IS NULL);
CREATE INDEX tasks_completed_idx ON tasks USING btree (completed_at DESC) WHERE (status = 'done'::text);
CREATE INDEX tasks_created_idx ON tasks USING btree (created_at DESC);
CREATE INDEX tasks_owner_idx ON tasks USING btree (owner_id);
CREATE INDEX tasks_parent_idx ON tasks USING btree (parent_id) WHERE (parent_id IS NOT NULL);
CREATE INDEX tasks_project_status_rank_idx ON tasks USING btree (project_id, status, rank);
CREATE INDEX tasks_source_event_idx ON tasks USING btree (((source ->> 'eventId'::text))) WHERE ((source ->> 'type'::text) = 'meeting'::text);
CREATE INDEX tasks_updated_idx ON tasks USING btree (updated_at DESC);
CREATE INDEX whiteboard_task_links_task_idx ON whiteboard_task_links USING btree (task_id);
CREATE INDEX whiteboards_owner_idx ON whiteboards USING btree (owner_id);
CREATE INDEX whiteboards_project_idx ON whiteboards USING btree (project_id) WHERE (project_id IS NOT NULL);
CREATE INDEX whiteboards_updated_idx ON whiteboards USING btree (updated_at DESC) WHERE (archived_at IS NULL);

-- ── Triggers ───────────────────────────────────────────────────────────────────────────────────────

CREATE TRIGGER outbox_notify AFTER INSERT ON outbox FOR EACH STATEMENT EXECUTE FUNCTION outbox_notify();
CREATE TRIGGER tasks_column_sync BEFORE INSERT OR UPDATE OF status, column_id, project_id, parent_id ON tasks FOR EACH ROW EXECUTE FUNCTION work_task_column_sync();
CREATE TRIGGER tasks_project_counts AFTER INSERT OR DELETE OR UPDATE OF status, project_id, updated_at ON tasks FOR EACH ROW EXECUTE FUNCTION projects_task_counts();

-- ── Foreign keys ───────────────────────────────────────────────────────────────────────────────────

ALTER TABLE ONLY board_columns
    ADD CONSTRAINT board_columns_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY document_versions
    ADD CONSTRAINT document_versions_document_id_fkey FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE;

ALTER TABLE ONLY event_attendees
    ADD CONSTRAINT event_attendees_event_id_fkey FOREIGN KEY (event_id) REFERENCES calendar_events(id) ON DELETE CASCADE;

ALTER TABLE ONLY key_results
    ADD CONSTRAINT key_results_goal_id_fkey FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE;

ALTER TABLE ONLY task_comments
    ADD CONSTRAINT task_comments_task_id_fkey FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE;

ALTER TABLE ONLY task_dependencies
    ADD CONSTRAINT task_dependencies_predecessor_id_fkey FOREIGN KEY (predecessor_id) REFERENCES tasks(id) ON DELETE CASCADE;

ALTER TABLE ONLY task_dependencies
    ADD CONSTRAINT task_dependencies_successor_id_fkey FOREIGN KEY (successor_id) REFERENCES tasks(id) ON DELETE CASCADE;

ALTER TABLE ONLY tasks
    ADD CONSTRAINT tasks_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL (project_id);

-- A deleted task takes its sticky's link (and so its badge) with it.
ALTER TABLE ONLY whiteboard_task_links
    ADD CONSTRAINT whiteboard_task_links_task_id_fkey FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE;

ALTER TABLE ONLY whiteboard_task_links
    ADD CONSTRAINT whiteboard_task_links_whiteboard_id_fkey FOREIGN KEY (whiteboard_id) REFERENCES whiteboards(id) ON DELETE CASCADE;

ALTER TABLE ONLY whiteboards
    ADD CONSTRAINT whiteboards_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id);

-- ── Grants ─────────────────────────────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION outbox_claim(lim integer, skip text[]) FROM PUBLIC;
GRANT ALL ON FUNCTION outbox_claim(lim integer, skip text[]) TO workspace_work_rw;
REVOKE ALL ON FUNCTION outbox_mark_published(ids text[]) FROM PUBLIC;
GRANT ALL ON FUNCTION outbox_mark_published(ids text[]) TO workspace_work_rw;
REVOKE ALL ON FUNCTION outbox_prune(keep_days integer, lim integer) FROM PUBLIC;
GRANT ALL ON FUNCTION outbox_prune(keep_days integer, lim integer) TO workspace_work_rw;
REVOKE ALL ON FUNCTION outbox_waiting() FROM PUBLIC;
GRANT ALL ON FUNCTION outbox_waiting() TO workspace_work_rw;
REVOKE ALL ON FUNCTION prune_processed_events(keep_days integer, lim integer) FROM PUBLIC;
GRANT ALL ON FUNCTION prune_processed_events(keep_days integer, lim integer) TO workspace_work_rw;
REVOKE ALL ON FUNCTION work_activity_prune(days integer, lim integer) FROM PUBLIC;
GRANT ALL ON FUNCTION work_activity_prune(days integer, lim integer) TO workspace_work_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE activity TO workspace_work_rw;
GRANT SELECT,DELETE ON TABLE activity TO workspace_maintenance;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE approval_delegations TO workspace_work_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE approval_events TO workspace_work_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE approvals TO workspace_work_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE board_columns TO workspace_work_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE calendar_events TO workspace_work_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE calendar_feeds TO workspace_work_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE code_counters TO workspace_work_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE custom_field_defs TO workspace_work_rw;
GRANT INSERT ON TABLE dead_events TO workspace_work_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE dead_events TO workspace_maintenance;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE decisions TO workspace_work_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE doc_comments TO workspace_work_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE doc_presence TO workspace_work_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE doc_stars TO workspace_work_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE doc_views TO workspace_work_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE doc_watchers TO workspace_work_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE document_versions TO workspace_work_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE documents TO workspace_work_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE drive_items TO workspace_work_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE drive_stars TO workspace_work_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE event_attendees TO workspace_work_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE files TO workspace_work_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE goals TO workspace_work_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE key_results TO workspace_work_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE meeting_guests TO workspace_work_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE meeting_participants TO workspace_work_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE meeting_recordings TO workspace_work_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE meeting_rooms TO workspace_work_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE outbox TO workspace_work_rw;
GRANT SELECT,DELETE,UPDATE ON TABLE outbox TO workspace_maintenance;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE processed_events TO workspace_work_rw;
GRANT SELECT,DELETE ON TABLE processed_events TO workspace_maintenance;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE projects TO workspace_work_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE request_templates TO workspace_work_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE spaces TO workspace_work_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE task_ai_assists TO workspace_work_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE task_comments TO workspace_work_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE task_dependencies TO workspace_work_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE tasks TO workspace_work_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE whiteboard_task_links TO workspace_work_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE whiteboards TO workspace_work_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE workspace_settings TO workspace_work_rw;

-- ── SECURITY DEFINER functions run as workspace_maintenance ────────────────────────────────────────

ALTER FUNCTION outbox_claim(lim integer, skip text[]) OWNER TO workspace_maintenance;
ALTER FUNCTION outbox_mark_published(ids text[]) OWNER TO workspace_maintenance;
ALTER FUNCTION outbox_prune(keep_days integer, lim integer) OWNER TO workspace_maintenance;
ALTER FUNCTION outbox_waiting() OWNER TO workspace_maintenance;
ALTER FUNCTION prune_processed_events(keep_days integer, lim integer) OWNER TO workspace_maintenance;
ALTER FUNCTION work_activity_prune(days integer, lim integer) OWNER TO workspace_maintenance;


-- ── Tables added by later migrations get the usual read/write grants (narrow them there if needed) ────

DO $$
BEGIN
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE workspace_owner IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO workspace_work_rw', current_schema());
END
$$;
