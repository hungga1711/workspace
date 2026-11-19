-- home schema, baseline.
--
-- What each table is for, and why it is shaped this way: docs/database/home.md. New changes go in new files
-- (002_*.sql, …); never edit this one once released.
--
-- The migration runner applies it with search_path = <schema>, public, pg_temp (backend/packages/service-kit/src/migrate.ts),
-- so names below are unqualified and the file works for any schema name. SECURITY DEFINER functions pin that
-- path (SET search_path FROM CURRENT) and are owned by workspace_maintenance (NOLOGIN), so the module role can call
-- them without holding their table rights; every other object belongs to workspace_owner. The module reaches the
-- schema through workspace_home_rw, granted to its login role.

SET LOCAL check_function_bodies = false;

-- ── Schema access ────────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO workspace_home_rw', current_schema());
  -- CREATE because a SECURITY DEFINER function can only be handed to a role that may create in its schema.
  EXECUTE format('GRANT USAGE, CREATE ON SCHEMA %I TO workspace_maintenance', current_schema());
END
$$;

-- ── Job functions (SQL bodies are checked when called; check_function_bodies is off above) ───────

-- Instant pushes queued by the projector: claiming deletes them, so each is sent at most once. Quiet hours, stale rows
-- (over 30 minutes) and people with neither push nor a linked chat are filtered out here. A person who turned web
-- push off but linked Telegram or Zalo still gets them: the row carries push_enabled and the sender decides per channel.
CREATE FUNCTION claim_instant_pushes(lim integer)
    RETURNS TABLE(id text, user_id text, title text, url text, push_enabled boolean)
    LANGUAGE sql
    SET search_path FROM CURRENT
    AS $$
  WITH picked AS (
    SELECT o.id FROM push_outbox o ORDER BY o.created_at LIMIT lim FOR UPDATE SKIP LOCKED
  ), gone AS (
    DELETE FROM push_outbox o USING picked p WHERE o.id = p.id
    RETURNING o.id, o.user_id, o.title, o.url, o.created_at
  )
  SELECT g.id, g.user_id, g.title, g.url, u.push_enabled FROM gone g
    JOIN user_prefs u ON u.user_id = g.user_id
   WHERE (u.push_enabled OR EXISTS (SELECT 1 FROM notify_links l WHERE l.user_id = g.user_id))
     AND g.created_at > now() - interval '30 minutes'
     AND NOT (u.quiet_start IS NOT NULL AND u.quiet_end IS NOT NULL AND u.quiet_start <> u.quiet_end AND (
       CASE WHEN u.quiet_start < u.quiet_end
            THEN extract(hour FROM now() AT TIME ZONE u.timezone) >= u.quiet_start AND extract(hour FROM now() AT TIME ZONE u.timezone) < u.quiet_end
            ELSE extract(hour FROM now() AT TIME ZONE u.timezone) >= u.quiet_start OR extract(hour FROM now() AT TIME ZONE u.timezone) < u.quiet_end
       END))
$$;

-- People due their daily email digest: after their chosen hour, once per local day.
CREATE FUNCTION digest_candidates(lim integer)
    RETURNS TABLE(user_id text, timezone text, email text)
    LANGUAGE sql
    SET search_path FROM CURRENT
    AS $$
  SELECT u.user_id, u.zone, u.email
    FROM (SELECT p.*, coalesce(p.timezone, (SELECT w.timezone FROM workspace_settings w), 'Asia/Ho_Chi_Minh') AS zone FROM user_prefs p) u
   WHERE u.email_digest AND u.email IS NOT NULL
     AND extract(hour FROM now() AT TIME ZONE u.zone) >= u.digest_hour
     AND (u.last_digest_date IS NULL OR u.last_digest_date < (now() AT TIME ZONE u.zone)::date)
   LIMIT lim
$$;

-- "Nhắc tôi" reminders whose time has come.
CREATE FUNCTION due_personal_reminders(lim integer)
    RETURNS TABLE(id text, user_id text)
    LANGUAGE sql
    SET search_path FROM CURRENT
    AS $$
  SELECT r.id, r.user_id FROM reminders r WHERE r.sent_at IS NULL AND r.remind_at <= now() ORDER BY r.remind_at LIMIT lim
$$;

-- Tasks due within 24 hours that have not been reminded for this due date, with the assignee's zone.
CREATE FUNCTION due_reminders(lim integer)
    RETURNS TABLE(user_id text, ref_id text, title text, url text, due_at timestamp with time zone, timezone text)
    LANGUAGE sql
    SET search_path FROM CURRENT
    AS $$
  SELECT h.user_id, h.ref_id, h.title, h.url, h.due_at, coalesce(u.timezone, (SELECT w.timezone FROM workspace_settings w), 'Asia/Ho_Chi_Minh')
    FROM home_items h
    LEFT JOIN user_prefs u ON u.user_id = h.user_id
   WHERE h.kind = 'task' AND h.resolved_at IS NULL AND h.needs_action
     AND h.due_at > now() AND h.due_at <= now() + interval '24 hours'
     AND h.reminded_due IS DISTINCT FROM h.due_at
     AND NOT (coalesce(u.muted, '{}') @> ARRAY['task'])
   ORDER BY h.due_at
   LIMIT lim
$$;

-- People due their morning brief push: push on with a device, after 8:00 local, outside quiet hours, once a day.
CREATE FUNCTION push_candidates(lim integer)
    RETURNS TABLE(user_id text, timezone text)
    LANGUAGE sql
    SET search_path FROM CURRENT
    AS $$
  SELECT DISTINCT u.user_id, u.zone
    FROM (SELECT p.*, coalesce(p.timezone, (SELECT w.timezone FROM workspace_settings w), 'Asia/Ho_Chi_Minh') AS zone FROM user_prefs p) u
    JOIN push_subscriptions s ON s.user_id = u.user_id
   WHERE u.push_enabled
     AND (u.last_push_date IS NULL OR u.last_push_date < (now() AT TIME ZONE u.zone)::date)
     AND extract(hour FROM now() AT TIME ZONE u.zone) >= 8
     AND NOT (u.quiet_start IS NOT NULL AND u.quiet_end IS NOT NULL AND u.quiet_start <> u.quiet_end AND (
       CASE WHEN u.quiet_start < u.quiet_end
            THEN extract(hour FROM now() AT TIME ZONE u.zone) >= u.quiet_start AND extract(hour FROM now() AT TIME ZONE u.zone) < u.quiet_end
            ELSE extract(hour FROM now() AT TIME ZONE u.zone) >= u.quiet_start OR extract(hour FROM now() AT TIME ZONE u.zone) < u.quiet_end
       END))
   LIMIT lim
$$;

-- ── Outbox and event ledger functions ────────────────────────────────────────────────────────────

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

-- ── Retention (home/retention.ts): deletes run as workspace_maintenance, batched by ctid so each call is short ──

CREATE FUNCTION home_notifications_prune(read_days integer, unread_days integer, lim integer) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
DECLARE n integer; m integer;
BEGIN
  DELETE FROM notifications WHERE ctid IN (
    SELECT ctid FROM notifications WHERE read_at IS NOT NULL AND created_at < now() - make_interval(days => greatest(read_days, 1)) LIMIT lim);
  GET DIAGNOSTICS n = ROW_COUNT;
  DELETE FROM notifications WHERE ctid IN (
    SELECT ctid FROM notifications WHERE read_at IS NULL AND created_at < now() - make_interval(days => greatest(unread_days, 1)) LIMIT lim);
  GET DIAGNOSTICS m = ROW_COUNT;
  RETURN n + m;
END
$$;

CREATE FUNCTION home_items_prune(days integer, lim integer) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
DECLARE n integer;
BEGIN
  DELETE FROM home_items WHERE ctid IN (
    SELECT ctid FROM home_items WHERE resolved_at IS NOT NULL AND resolved_at < now() - make_interval(days => greatest(days, 1)) LIMIT lim);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

CREATE FUNCTION home_activity_prune(days integer, lim integer) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
DECLARE n integer;
BEGIN
  DELETE FROM activity WHERE ctid IN (
    SELECT ctid FROM activity WHERE created_at < now() - make_interval(days => greatest(days, 1)) LIMIT lim);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

-- push_recent only dedupes "every message" and DM pushes inside a ten-minute window; a row older than a day is dead.
CREATE FUNCTION home_push_recent_prune(days integer, lim integer) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
DECLARE n integer;
BEGIN
  DELETE FROM push_recent WHERE ctid IN (
    SELECT ctid FROM push_recent WHERE at < now() - make_interval(days => greatest(days, 1)) LIMIT lim);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

-- ── Tables ───────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE activity (
    user_id text NOT NULL,
    key text NOT NULL,
    kind text NOT NULL,
    title text NOT NULL,
    body text DEFAULT ''::text NOT NULL,
    url text NOT NULL,
    actor_id text NOT NULL,
    count integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT activity_kind_check CHECK ((kind = ANY (ARRAY['ai_task'::text, 'extracted_task'::text, 'decision'::text, 'doc_change'::text, 'agent_result'::text, 'task_done'::text]))),
    CONSTRAINT activity_pkey PRIMARY KEY (user_id, key)
);

CREATE TABLE brief_cache (
    user_id text NOT NULL,
    day date NOT NULL,
    content jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT brief_cache_pkey PRIMARY KEY (user_id, day)
);

-- Events this module's consumers gave up on. `dlq replay` (a separate process) only sets replay_requested_at: the
-- server delivers the row (events run inside the server process, ADR 0021) and stamps replayed_at.
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

CREATE TABLE home_items (
    user_id text NOT NULL,
    kind text NOT NULL,
    ref_id text NOT NULL,
    title text NOT NULL,
    subtitle text DEFAULT ''::text NOT NULL,
    url text NOT NULL,
    due_at timestamp with time zone,
    starts_at timestamp with time zone,
    needs_action boolean NOT NULL,
    priority text,
    source_version bigint DEFAULT 0 NOT NULL,
    resolved_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    reminded_due timestamp with time zone,
    CONSTRAINT home_items_kind_check CHECK ((kind = ANY (ARRAY['task'::text, 'approval'::text, 'mention'::text, 'dm'::text, 'meeting'::text, 'deadline'::text, 'decision'::text, 'blocker'::text]))),
    CONSTRAINT home_items_pkey PRIMARY KEY (user_id, kind, ref_id)
);

CREATE TABLE notifications (
    user_id text NOT NULL,
    id text NOT NULL,
    grp text NOT NULL,
    kind text NOT NULL,
    title text NOT NULL,
    body text DEFAULT ''::text NOT NULL,
    url text NOT NULL,
    ref_id text,
    read_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT notifications_grp_check CHECK ((grp = ANY (ARRAY['action'::text, 'update'::text]))),
    CONSTRAINT notifications_pkey PRIMARY KEY (user_id, id)
);

-- Telegram and Zalo OA as notification channels next to web push (docs/integrations/telegram-zalo.md). The admin
-- stores the bot / Official Account credentials (encrypted by the module before they get here); each person links
-- their own chat with a one-time code. Nothing runs while no channel is configured: the instant-push job just finds
-- no links.
CREATE TABLE notify_channels (
    kind text NOT NULL,
    -- JSON of the credentials (bot token; Zalo app id, secret, OA secret, tokens), AES-GCM sealed (service-kit secretBox).
    config_enc text NOT NULL,
    -- Shown to people: the bot's @username, the Official Account's name.
    display_name text DEFAULT ''::text NOT NULL,
    -- sha256 of the secret in the webhook URL; the URL itself is shown once to the admin (Zalo) or registered (Telegram).
    webhook_hash text NOT NULL,
    webhook_ok boolean DEFAULT false NOT NULL,
    webhook_error text,
    enabled boolean DEFAULT true NOT NULL,
    updated_by text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT notify_channels_kind_check CHECK ((kind = ANY (ARRAY['telegram'::text, 'zalo'::text]))),
    CONSTRAINT notify_channels_pkey PRIMARY KEY (kind)
);

CREATE TABLE notify_links (
    user_id text NOT NULL,
    kind text NOT NULL,
    -- Telegram chat id, Zalo follower (user) id.
    external_id text NOT NULL,
    label text DEFAULT ''::text NOT NULL,
    linked_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT notify_links_kind_check CHECK ((kind = ANY (ARRAY['telegram'::text, 'zalo'::text]))),
    CONSTRAINT notify_links_pkey PRIMARY KEY (user_id, kind)
);

CREATE TABLE notify_link_codes (
    code_hash text NOT NULL,
    user_id text NOT NULL,
    kind text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT notify_link_codes_kind_check CHECK ((kind = ANY (ARRAY['telegram'::text, 'zalo'::text]))),
    CONSTRAINT notify_link_codes_pkey PRIMARY KEY (code_hash)
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

CREATE TABLE push_outbox (
    id text NOT NULL,
    user_id text NOT NULL,
    title text NOT NULL,
    url text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT push_outbox_pkey PRIMARY KEY (id)
);

CREATE TABLE push_recent (
    user_id text NOT NULL,
    key text NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT push_recent_pkey PRIMARY KEY (user_id, key)
);

CREATE TABLE push_subscriptions (
    user_id text NOT NULL,
    endpoint text NOT NULL,
    p256dh text NOT NULL,
    auth text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT push_subscriptions_pkey PRIMARY KEY (endpoint)
);

CREATE TABLE reminders (
    id text NOT NULL,
    user_id text NOT NULL,
    remind_at timestamp with time zone NOT NULL,
    title text NOT NULL,
    url text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone,
    CONSTRAINT reminders_pkey PRIMARY KEY (id)
);

CREATE TABLE user_prefs (
    user_id text NOT NULL,
    timezone text,
    push_enabled boolean DEFAULT true NOT NULL,
    last_push_date date,
    caught_up_at timestamp with time zone,
    email text,
    email_digest boolean DEFAULT true NOT NULL,
    digest_hour smallint DEFAULT 8 NOT NULL,
    last_digest_date date,
    muted text[] DEFAULT '{}'::text[] NOT NULL,
    quiet_start smallint,
    quiet_end smallint,
    -- The UI language they last used (inbox, push and digest texts); empty until the web app reports one, and then
    -- textsFor() falls back to the workspace's language (workspace_settings).
    locale text,
    dnd_until timestamp with time zone,
    CONSTRAINT user_prefs_digest_hour_check CHECK (((digest_hour >= 0) AND (digest_hour <= 23))),
    CONSTRAINT user_prefs_locale_check CHECK ((locale = ANY (ARRAY['vi'::text, 'en'::text]))),
    CONSTRAINT user_prefs_quiet_end_check CHECK (((quiet_end >= 0) AND (quiet_end <= 23))),
    CONSTRAINT user_prefs_quiet_start_check CHECK (((quiet_start >= 0) AND (quiet_start <= 23))),
    CONSTRAINT user_prefs_pkey PRIMARY KEY (user_id)
);

-- The workspace's time zone and language, projected from the platform module (projector.ts): new user_prefs rows and
-- texts for people who never opened the app (digests, invites) follow them. One row: `singleton` only takes true.
CREATE TABLE workspace_settings (
    timezone text NOT NULL,
    version integer NOT NULL,
    locale text DEFAULT 'vi'::text NOT NULL,
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

-- ── Indexes ──────────────────────────────────────────────────────────────────────────────────────

CREATE INDEX activity_user_idx ON activity USING btree (user_id, created_at DESC);
CREATE INDEX dead_events_waiting_idx ON dead_events USING btree (failed_at) WHERE (replayed_at IS NULL);
CREATE INDEX dead_events_replay_requested_idx ON dead_events USING btree (id) WHERE replay_requested_at IS NOT NULL AND replayed_at IS NULL;
CREATE INDEX home_items_open_idx ON home_items USING btree (user_id, needs_action, due_at) WHERE (resolved_at IS NULL);
-- The projector resolves every member's copy of a task/approval/meeting item by ref_id on each event.
CREATE INDEX home_items_kind_ref_idx ON home_items USING btree (kind, ref_id);
-- due_reminders() runs every five minutes over open task items due in the next 24 hours.
CREATE INDEX home_items_due_task_idx ON home_items USING btree (due_at) WHERE kind = 'task' AND resolved_at IS NULL AND needs_action;
CREATE INDEX notifications_user_idx ON notifications USING btree (user_id, created_at DESC);
-- The top bar polls the unread action count every minute for every signed-in person; notifications_user_idx would
-- make that a walk over everything the person was ever sent.
CREATE INDEX notifications_unread_action_idx ON notifications USING btree (user_id) WHERE grp = 'action' AND read_at IS NULL;
-- Time-ordered scans for the retention functions.
CREATE INDEX notifications_created_idx ON notifications USING btree (created_at);
CREATE INDEX notifications_read_created_idx ON notifications USING btree (created_at) WHERE read_at IS NOT NULL;
CREATE INDEX notifications_unread_created_idx ON notifications USING btree (created_at) WHERE read_at IS NULL;
CREATE INDEX home_items_resolved_idx ON home_items USING btree (resolved_at) WHERE resolved_at IS NOT NULL;
CREATE INDEX activity_created_idx ON activity USING btree (created_at);
CREATE INDEX push_recent_at_idx ON push_recent USING btree (at);
CREATE UNIQUE INDEX notify_channels_webhook_idx ON notify_channels USING btree (webhook_hash);
CREATE UNIQUE INDEX notify_links_external_idx ON notify_links USING btree (kind, external_id);
CREATE INDEX notify_link_codes_user_idx ON notify_link_codes USING btree (user_id);
CREATE INDEX outbox_created_idx ON outbox USING btree (created_at);
CREATE INDEX outbox_unpublished_idx ON outbox USING btree (created_at) WHERE (published_at IS NULL);
CREATE INDEX processed_events_processed_at_idx ON processed_events USING btree (processed_at);
CREATE INDEX push_outbox_created ON push_outbox USING btree (created_at);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions USING btree (user_id);
CREATE INDEX reminders_due ON reminders USING btree (remind_at) WHERE (sent_at IS NULL);
CREATE INDEX reminders_user ON reminders USING btree (user_id, remind_at);

-- ── Triggers ─────────────────────────────────────────────────────────────────────────────────────

CREATE TRIGGER outbox_notify AFTER INSERT ON outbox FOR EACH STATEMENT EXECUTE FUNCTION outbox_notify();

-- ── Grants ───────────────────────────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION claim_instant_pushes(lim integer) FROM PUBLIC;
GRANT ALL ON FUNCTION claim_instant_pushes(lim integer) TO workspace_home_rw;
REVOKE ALL ON FUNCTION digest_candidates(lim integer) FROM PUBLIC;
GRANT ALL ON FUNCTION digest_candidates(lim integer) TO workspace_home_rw;
REVOKE ALL ON FUNCTION due_personal_reminders(lim integer) FROM PUBLIC;
GRANT ALL ON FUNCTION due_personal_reminders(lim integer) TO workspace_home_rw;
REVOKE ALL ON FUNCTION due_reminders(lim integer) FROM PUBLIC;
GRANT ALL ON FUNCTION due_reminders(lim integer) TO workspace_home_rw;
REVOKE ALL ON FUNCTION home_activity_prune(days integer, lim integer) FROM PUBLIC;
GRANT ALL ON FUNCTION home_activity_prune(days integer, lim integer) TO workspace_home_rw;
REVOKE ALL ON FUNCTION home_items_prune(days integer, lim integer) FROM PUBLIC;
GRANT ALL ON FUNCTION home_items_prune(days integer, lim integer) TO workspace_home_rw;
REVOKE ALL ON FUNCTION home_notifications_prune(read_days integer, unread_days integer, lim integer) FROM PUBLIC;
GRANT ALL ON FUNCTION home_notifications_prune(read_days integer, unread_days integer, lim integer) TO workspace_home_rw;
REVOKE ALL ON FUNCTION home_push_recent_prune(days integer, lim integer) FROM PUBLIC;
GRANT ALL ON FUNCTION home_push_recent_prune(days integer, lim integer) TO workspace_home_rw;
REVOKE ALL ON FUNCTION outbox_claim(lim integer, skip text[]) FROM PUBLIC;
GRANT ALL ON FUNCTION outbox_claim(lim integer, skip text[]) TO workspace_home_rw;
REVOKE ALL ON FUNCTION outbox_mark_published(ids text[]) FROM PUBLIC;
GRANT ALL ON FUNCTION outbox_mark_published(ids text[]) TO workspace_home_rw;
REVOKE ALL ON FUNCTION outbox_prune(keep_days integer, lim integer) FROM PUBLIC;
GRANT ALL ON FUNCTION outbox_prune(keep_days integer, lim integer) TO workspace_home_rw;
REVOKE ALL ON FUNCTION outbox_waiting() FROM PUBLIC;
GRANT ALL ON FUNCTION outbox_waiting() TO workspace_home_rw;
REVOKE ALL ON FUNCTION prune_processed_events(keep_days integer, lim integer) FROM PUBLIC;
GRANT ALL ON FUNCTION prune_processed_events(keep_days integer, lim integer) TO workspace_home_rw;
REVOKE ALL ON FUNCTION push_candidates(lim integer) FROM PUBLIC;
GRANT ALL ON FUNCTION push_candidates(lim integer) TO workspace_home_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE activity TO workspace_home_rw;
GRANT SELECT,DELETE ON TABLE activity TO workspace_maintenance;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE brief_cache TO workspace_home_rw;
GRANT INSERT ON TABLE dead_events TO workspace_home_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE dead_events TO workspace_maintenance;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE home_items TO workspace_home_rw;
GRANT SELECT,DELETE ON TABLE home_items TO workspace_maintenance;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE notifications TO workspace_home_rw;
GRANT SELECT,DELETE ON TABLE notifications TO workspace_maintenance;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE notify_channels TO workspace_home_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE notify_link_codes TO workspace_home_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE notify_links TO workspace_home_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE outbox TO workspace_home_rw;
GRANT SELECT,DELETE,UPDATE ON TABLE outbox TO workspace_maintenance;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE processed_events TO workspace_home_rw;
GRANT SELECT,DELETE ON TABLE processed_events TO workspace_maintenance;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE push_outbox TO workspace_home_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE push_recent TO workspace_home_rw;
GRANT SELECT,DELETE ON TABLE push_recent TO workspace_maintenance;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE push_subscriptions TO workspace_home_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE reminders TO workspace_home_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE user_prefs TO workspace_home_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE workspace_settings TO workspace_home_rw;

-- ── SECURITY DEFINER functions run as workspace_maintenance ──────────────────────────────────────

ALTER FUNCTION home_activity_prune(days integer, lim integer) OWNER TO workspace_maintenance;
ALTER FUNCTION home_items_prune(days integer, lim integer) OWNER TO workspace_maintenance;
ALTER FUNCTION home_notifications_prune(read_days integer, unread_days integer, lim integer) OWNER TO workspace_maintenance;
ALTER FUNCTION home_push_recent_prune(days integer, lim integer) OWNER TO workspace_maintenance;
ALTER FUNCTION outbox_claim(lim integer, skip text[]) OWNER TO workspace_maintenance;
ALTER FUNCTION outbox_mark_published(ids text[]) OWNER TO workspace_maintenance;
ALTER FUNCTION outbox_prune(keep_days integer, lim integer) OWNER TO workspace_maintenance;
ALTER FUNCTION outbox_waiting() OWNER TO workspace_maintenance;
ALTER FUNCTION prune_processed_events(keep_days integer, lim integer) OWNER TO workspace_maintenance;

-- ── Tables added by later migrations get the usual read/write grants (narrow them there if needed) ────

DO $$
BEGIN
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE workspace_owner IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO workspace_home_rw', current_schema());
END
$$;
