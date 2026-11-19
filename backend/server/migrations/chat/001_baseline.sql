-- chat schema, baseline.
--
-- What each table is for, and why it is shaped this way: docs/database/chat.md. New changes go in new files
-- (002_*.sql, …); never edit this one once released.
--
-- The migration runner applies it with search_path = <schema>, public, pg_temp (backend/packages/service-kit/src/migrate.ts),
-- so names below are unqualified and the file works for any schema name. SECURITY DEFINER functions pin that
-- path (SET search_path FROM CURRENT) and are owned by workspace_maintenance (NOLOGIN); every other object belongs
-- to workspace_owner. The module reaches the schema through workspace_chat_rw, granted to its login role.
--
-- One installation holds one workspace (ADR 0023): no table carries a workspace id. A table with one row per
-- installation is keyed by `singleton`, a column only `true` satisfies.

SET LOCAL check_function_bodies = false;

-- ── Schema access ────────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO workspace_chat_rw', current_schema());
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

-- Live co-editing drafts nobody reopened within a day; their updates go with them.
CREATE FUNCTION chat_collab_prune(lim integer) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
DECLARE n integer;
BEGIN
  DELETE FROM collab_drafts WHERE ctid IN (SELECT ctid FROM collab_drafts WHERE expires_at < now() LIMIT lim);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

-- Cached link previews unused for 30 days.
CREATE FUNCTION chat_link_previews_prune(lim integer) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
DECLARE n integer;
BEGIN
  DELETE FROM link_previews WHERE ctid IN (SELECT ctid FROM link_previews WHERE fetched_at < now() - interval '30 days' LIMIT lim);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

-- ── Tables ───────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE channel_members (
    channel_id text NOT NULL,
    user_id text NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    last_read_seq bigint DEFAULT 0 NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    starred boolean DEFAULT false NOT NULL,
    muted boolean DEFAULT false NOT NULL,
    notify text,
    muted_until timestamp with time zone,
    CONSTRAINT channel_members_notify_check CHECK ((notify = ANY (ARRAY['all'::text, 'mentions'::text, 'none'::text]))),
    CONSTRAINT channel_members_role_check CHECK ((role = ANY (ARRAY['member'::text, 'admin'::text]))),
    CONSTRAINT channel_members_pkey PRIMARY KEY (channel_id, user_id)
);

-- `name` is the handle typed after # ("ky-thuat", unique); `display_name` is the name as people read it
-- ("Kỹ thuật"), NULL meaning "show the handle".
CREATE TABLE channels (
    id text NOT NULL,
    kind text NOT NULL,
    name text,
    topic text DEFAULT ''::text NOT NULL,
    dm_key text,
    created_by text NOT NULL,
    last_seq bigint DEFAULT 0 NOT NULL,
    archived boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    auto_join boolean DEFAULT false NOT NULL,
    display_name text,
    CONSTRAINT channels_display_name_check CHECK (((display_name IS NULL) OR ((length(display_name) >= 1) AND (length(display_name) <= 80)))),
    CONSTRAINT channels_kind_check CHECK ((kind = ANY (ARRAY['public'::text, 'private'::text, 'dm'::text, 'group'::text]))),
    CONSTRAINT channels_pkey PRIMARY KEY (id),
    CONSTRAINT channels_dm_key_key UNIQUE (dm_key)
);

CREATE TABLE chat_files (
    id text NOT NULL,
    channel_id text NOT NULL,
    message_id text,
    object_key text NOT NULL,
    name text NOT NULL,
    content_type text NOT NULL,
    size bigint NOT NULL,
    status text NOT NULL,
    owner_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    CONSTRAINT chat_files_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'active'::text, 'deleted'::text]))),
    CONSTRAINT chat_files_pkey PRIMARY KEY (id)
);

-- Live co-editing drafts of docs pages (collab.ts), kept in Postgres so a draft survives a restart (a day, so
-- closing the tab loses nothing). A draft is the page version it started from plus the Yjs updates made since;
-- updates commute, so their order in the table does not matter.
CREATE TABLE collab_drafts (
    doc_id text NOT NULL,
    base_version integer NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT collab_drafts_pkey PRIMARY KEY (doc_id)
);

CREATE TABLE collab_updates (
    doc_id text NOT NULL,
    seq bigint NOT NULL,
    u bytea NOT NULL,
    CONSTRAINT collab_updates_pkey PRIMARY KEY (doc_id, seq)
);

-- The same for whiteboards (whiteboard-collab.ts, ADR 0024): the Yjs updates of a board everyone in the room shares.
-- The board's snapshot lives in work; a draft nobody has open goes after a day.
CREATE TABLE whiteboard_drafts (
    board_id text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT whiteboard_drafts_pkey PRIMARY KEY (board_id)
);

CREATE TABLE whiteboard_updates (
    board_id text NOT NULL,
    seq bigint NOT NULL,
    u bytea NOT NULL,
    CONSTRAINT whiteboard_updates_pkey PRIMARY KEY (board_id, seq)
);

-- Events are delivered inside the server process (ADR 0021), so `dlq replay` (a separate process) requests a replay
-- (replay_requested_at) and the server's replay job delivers the row and stamps replayed_at.
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

CREATE TABLE known_members (
    user_id text NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT known_members_pkey PRIMARY KEY (user_id)
);

-- Link previews (unfurl.ts): pages are fetched once and kept here (a failure too, so a dead link is not retried on
-- every message); the message keeps the cards it shows, so history reads need no join. Thumbnails are stored,
-- never hotlinked.
CREATE TABLE link_previews (
    url text NOT NULL,
    id text NOT NULL,
    ok boolean NOT NULL,
    site_name text DEFAULT ''::text NOT NULL,
    title text DEFAULT ''::text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    image bytea,
    image_type text,
    fetched_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT link_previews_check CHECK (((image IS NULL) OR ((octet_length(image) <= 262144) AND (image_type = ANY (ARRAY['image/png'::text, 'image/jpeg'::text, 'image/webp'::text, 'image/gif'::text]))))),
    CONSTRAINT link_previews_url_check CHECK ((length(url) <= 2048)),
    CONSTRAINT link_previews_pkey PRIMARY KEY (url),
    CONSTRAINT link_previews_id_key UNIQUE (id)
);

-- `link_previews`: the cards a message shows ([{id, url, siteName, title, description, image}]);
-- `previews_hidden`: its author hid them.
CREATE TABLE messages (
    id text NOT NULL,
    channel_id text NOT NULL,
    seq bigint NOT NULL,
    thread_root_id text,
    author_id text NOT NULL,
    author_type text NOT NULL,
    body text NOT NULL,
    mentions text[] DEFAULT '{}'::text[] NOT NULL,
    attachments jsonb DEFAULT '[]'::jsonb NOT NULL,
    client_msg_id text,
    reply_count integer DEFAULT 0 NOT NULL,
    last_reply_at timestamp with time zone,
    edited_at timestamp with time zone,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    import_author text,
    forward_of jsonb,
    link_previews jsonb DEFAULT '[]'::jsonb NOT NULL,
    previews_hidden boolean DEFAULT false NOT NULL,
    CONSTRAINT messages_author_type_check CHECK ((author_type = ANY (ARRAY['user'::text, 'agent'::text, 'system'::text, 'import'::text]))),
    CONSTRAINT messages_body_check CHECK (((length(body) <= 20000) AND ((length(body) >= 1) OR (attachments <> '[]'::jsonb) OR (deleted_at IS NOT NULL)))),
    CONSTRAINT messages_pkey PRIMARY KEY (id),
    CONSTRAINT messages_channel_id_client_msg_id_key UNIQUE (channel_id, client_msg_id),
    CONSTRAINT messages_channel_id_seq_key UNIQUE (channel_id, seq)
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

CREATE TABLE pins (
    channel_id text NOT NULL,
    message_id text NOT NULL,
    pinned_by text NOT NULL,
    pinned_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pins_pkey PRIMARY KEY (channel_id, message_id)
);

CREATE TABLE poll_votes (
    message_id text NOT NULL,
    option_id text NOT NULL,
    user_id text NOT NULL,
    voted_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT poll_votes_pkey PRIMARY KEY (message_id, option_id, user_id)
);

CREATE TABLE polls (
    message_id text NOT NULL,
    question text NOT NULL,
    options jsonb NOT NULL,
    multi boolean DEFAULT false NOT NULL,
    closed_at timestamp with time zone,
    CONSTRAINT polls_pkey PRIMARY KEY (message_id)
);

CREATE TABLE processed_events (
    consumer text NOT NULL,
    event_id text NOT NULL,
    processed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT processed_events_pkey PRIMARY KEY (consumer, event_id)
);

-- `created_at`: who reacted, in the order they did ("Bạn, Lan và 3 người khác").
CREATE TABLE reactions (
    message_id text NOT NULL,
    user_id text NOT NULL,
    emoji text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT reactions_emoji_check CHECK (((length(emoji) >= 1) AND (length(emoji) <= 32))),
    CONSTRAINT reactions_pkey PRIMARY KEY (message_id, user_id, emoji)
);

CREATE TABLE saved_messages (
    user_id text NOT NULL,
    message_id text NOT NULL,
    saved_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT saved_messages_pkey PRIMARY KEY (user_id, message_id)
);

CREATE TABLE scheduled_messages (
    id text NOT NULL,
    channel_id text NOT NULL,
    author_id text NOT NULL,
    body text NOT NULL,
    send_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone,
    failed text,
    CONSTRAINT scheduled_messages_pkey PRIMARY KEY (id)
);

CREATE TABLE thread_links (
    root_id text NOT NULL,
    kind text NOT NULL,
    ref_id text NOT NULL,
    title text NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT thread_links_kind_check CHECK ((kind = ANY (ARRAY['project'::text, 'document'::text]))),
    CONSTRAINT thread_links_pkey PRIMARY KEY (root_id, kind, ref_id)
);

CREATE TABLE user_status (
    user_id text NOT NULL,
    emoji text DEFAULT ''::text NOT NULL,
    text text DEFAULT ''::text NOT NULL,
    clear_at timestamp with time zone,
    dnd_until timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_status_pkey PRIMARY KEY (user_id)
);

-- The workspace's time zone, projected from the platform module (one row).
CREATE TABLE workspace_settings (
    singleton boolean DEFAULT true NOT NULL,
    timezone text NOT NULL,
    version integer NOT NULL,
    CONSTRAINT workspace_settings_pkey_one CHECK (singleton),
    CONSTRAINT workspace_settings_pkey PRIMARY KEY (singleton)
);

-- ── Sequences and identity columns ───────────────────────────────────────────────────────────────

ALTER TABLE collab_updates ALTER COLUMN seq ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME collab_updates_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

ALTER TABLE whiteboard_updates ALTER COLUMN seq ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME whiteboard_updates_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

ALTER TABLE dead_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME dead_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

-- ── Foreign keys ─────────────────────────────────────────────────────────────────────────────────

ALTER TABLE ONLY channel_members
    ADD CONSTRAINT channel_members_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE;

ALTER TABLE ONLY collab_updates
    ADD CONSTRAINT collab_updates_doc_id_fkey FOREIGN KEY (doc_id) REFERENCES collab_drafts(doc_id) ON DELETE CASCADE;

ALTER TABLE ONLY whiteboard_updates
    ADD CONSTRAINT whiteboard_updates_board_id_fkey FOREIGN KEY (board_id) REFERENCES whiteboard_drafts(board_id) ON DELETE CASCADE;

ALTER TABLE ONLY messages
    ADD CONSTRAINT messages_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE;

ALTER TABLE ONLY pins
    ADD CONSTRAINT pins_message_id_fkey FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE;

ALTER TABLE ONLY reactions
    ADD CONSTRAINT reactions_message_id_fkey FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE;

ALTER TABLE ONLY saved_messages
    ADD CONSTRAINT saved_messages_message_id_fkey FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE;

-- ── Indexes ──────────────────────────────────────────────────────────────────────────────────────

CREATE INDEX channel_members_user_idx ON channel_members USING btree (user_id);
CREATE UNIQUE INDEX channels_name_uq ON channels USING btree (lower(name)) WHERE (kind = ANY (ARRAY['public'::text, 'private'::text]));
CREATE INDEX chat_files_channel_idx ON chat_files USING btree (channel_id, created_at DESC) WHERE (status = 'active'::text);
CREATE INDEX chat_files_pending_idx ON chat_files USING btree (expires_at) WHERE (status = 'pending'::text);
CREATE INDEX collab_drafts_expires_idx ON collab_drafts USING btree (expires_at);
CREATE INDEX whiteboard_drafts_expires_idx ON whiteboard_drafts USING btree (expires_at);
CREATE INDEX dead_events_replay_requested_idx ON dead_events USING btree (id) WHERE ((replay_requested_at IS NOT NULL) AND (replayed_at IS NULL));
CREATE INDEX dead_events_waiting_idx ON dead_events USING btree (failed_at) WHERE (replayed_at IS NULL);
CREATE INDEX link_previews_fetched_idx ON link_previews USING btree (fetched_at);
CREATE INDEX messages_channel_seq_idx ON messages USING btree (channel_id, seq DESC) WHERE (thread_root_id IS NULL);
CREATE INDEX messages_created_idx ON messages USING btree (created_at);
CREATE INDEX messages_mentions_idx ON messages USING gin (mentions);
CREATE INDEX messages_thread_idx ON messages USING btree (thread_root_id, seq) WHERE (thread_root_id IS NOT NULL);
-- Threads I'm in (GET /chat/threads), newest reply first.
CREATE INDEX messages_threads_idx ON messages USING btree (last_reply_at DESC NULLS LAST) WHERE ((reply_count > 0) AND (deleted_at IS NULL));
CREATE INDEX outbox_created_idx ON outbox USING btree (created_at);
CREATE INDEX outbox_unpublished_idx ON outbox USING btree (created_at) WHERE (published_at IS NULL);
-- "Is this message pinned?" per listed message.
CREATE INDEX pins_message_idx ON pins USING btree (message_id);
CREATE INDEX poll_votes_message ON poll_votes USING btree (message_id);
CREATE INDEX processed_events_processed_at_idx ON processed_events USING btree (processed_at);
CREATE INDEX scheduled_due ON scheduled_messages USING btree (send_at) WHERE (sent_at IS NULL);

-- ── Triggers ─────────────────────────────────────────────────────────────────────────────────────

CREATE TRIGGER outbox_notify AFTER INSERT ON outbox FOR EACH STATEMENT EXECUTE FUNCTION outbox_notify();

-- ── Grants ───────────────────────────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION chat_collab_prune(lim integer) FROM PUBLIC;
GRANT ALL ON FUNCTION chat_collab_prune(lim integer) TO workspace_chat_rw;
REVOKE ALL ON FUNCTION chat_link_previews_prune(lim integer) FROM PUBLIC;
GRANT ALL ON FUNCTION chat_link_previews_prune(lim integer) TO workspace_chat_rw;
REVOKE ALL ON FUNCTION outbox_claim(lim integer, skip text[]) FROM PUBLIC;
GRANT ALL ON FUNCTION outbox_claim(lim integer, skip text[]) TO workspace_chat_rw;
REVOKE ALL ON FUNCTION outbox_mark_published(ids text[]) FROM PUBLIC;
GRANT ALL ON FUNCTION outbox_mark_published(ids text[]) TO workspace_chat_rw;
REVOKE ALL ON FUNCTION outbox_prune(keep_days integer, lim integer) FROM PUBLIC;
GRANT ALL ON FUNCTION outbox_prune(keep_days integer, lim integer) TO workspace_chat_rw;
REVOKE ALL ON FUNCTION outbox_waiting() FROM PUBLIC;
GRANT ALL ON FUNCTION outbox_waiting() TO workspace_chat_rw;
REVOKE ALL ON FUNCTION prune_processed_events(keep_days integer, lim integer) FROM PUBLIC;
GRANT ALL ON FUNCTION prune_processed_events(keep_days integer, lim integer) TO workspace_chat_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE channel_members TO workspace_chat_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE channels TO workspace_chat_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE chat_files TO workspace_chat_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE collab_drafts TO workspace_chat_rw;
GRANT SELECT,DELETE ON TABLE collab_drafts TO workspace_maintenance;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE collab_updates TO workspace_chat_rw;
GRANT SELECT,DELETE ON TABLE collab_updates TO workspace_maintenance;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE whiteboard_drafts TO workspace_chat_rw;
GRANT SELECT,DELETE ON TABLE whiteboard_drafts TO workspace_maintenance;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE whiteboard_updates TO workspace_chat_rw;
GRANT SELECT,DELETE ON TABLE whiteboard_updates TO workspace_maintenance;
GRANT INSERT ON TABLE dead_events TO workspace_chat_rw;
-- INSERT too: `dlq outbox-replay` queues outbox events here as the maintenance role.
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE dead_events TO workspace_maintenance;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE known_members TO workspace_chat_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE link_previews TO workspace_chat_rw;
GRANT SELECT,DELETE ON TABLE link_previews TO workspace_maintenance;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE messages TO workspace_chat_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE outbox TO workspace_chat_rw;
GRANT SELECT,DELETE,UPDATE ON TABLE outbox TO workspace_maintenance;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE pins TO workspace_chat_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE poll_votes TO workspace_chat_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE polls TO workspace_chat_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE processed_events TO workspace_chat_rw;
GRANT SELECT,DELETE ON TABLE processed_events TO workspace_maintenance;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE reactions TO workspace_chat_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE saved_messages TO workspace_chat_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE scheduled_messages TO workspace_chat_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE thread_links TO workspace_chat_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE user_status TO workspace_chat_rw;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE workspace_settings TO workspace_chat_rw;

-- ── SECURITY DEFINER functions run as workspace_maintenance ──────────────────────────────────────

ALTER FUNCTION chat_collab_prune(lim integer) OWNER TO workspace_maintenance;
ALTER FUNCTION chat_link_previews_prune(lim integer) OWNER TO workspace_maintenance;
ALTER FUNCTION outbox_claim(lim integer, skip text[]) OWNER TO workspace_maintenance;
ALTER FUNCTION outbox_mark_published(ids text[]) OWNER TO workspace_maintenance;
ALTER FUNCTION outbox_prune(keep_days integer, lim integer) OWNER TO workspace_maintenance;
ALTER FUNCTION outbox_waiting() OWNER TO workspace_maintenance;
ALTER FUNCTION prune_processed_events(keep_days integer, lim integer) OWNER TO workspace_maintenance;

-- ── Tables added by later migrations get the usual read/write grants (narrow them there if needed) ────

DO $$
BEGIN
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE workspace_owner IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO workspace_chat_rw', current_schema());
END
$$;
