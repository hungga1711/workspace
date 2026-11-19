-- search schema, baseline.
--
-- What each table is for, and why it is shaped this way: docs/database/search.md. New changes go in new files
-- (002_*.sql, …); never edit this one once released.
--
-- The migration runner applies it with search_path = <schema>, public, pg_temp (backend/packages/service-kit/src/migrate.ts),
-- so names below are unqualified and the file works for any schema name. SECURITY DEFINER functions pin that
-- path (SET search_path FROM CURRENT) and are owned by workspace_maintenance (NOLOGIN); every other
-- object belongs to workspace_owner. The module reaches the schema through workspace_search_rw, granted to its login role.

SET LOCAL check_function_bodies = false;

-- ── Extensions (database-wide, in schema public) ─────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch WITH SCHEMA public;

-- ── Schema access ────────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO workspace_search_rw', current_schema());
  -- CREATE because a SECURITY DEFINER function can only be handed to a role that may create in its schema.
  EXECUTE format('GRANT USAGE, CREATE ON SCHEMA %I TO workspace_maintenance', current_schema());
END
$$;

-- ── Functions (SQL bodies are checked when called; check_function_bodies is off above) ───────────

-- The lookups are SECURITY DEFINER so chat's role can run them without any access to search_terms.

-- search_candidates() returns the `lim` most recent readable matches. For a rare word the tsv index finds them at
-- once; for a common pair of words ("checkout flow") Postgres estimates the matches as if the words were unrelated,
-- picks the tsv bitmap and then reads every match's row (tens of thousands, on a channel of a million messages) only
-- to keep the newest `lim`. So first a probe on the tsv index alone (it stops at COMMON rows, so it is cheap either
-- way): a rare word's matches all come back from it and are sorted there. For a common one, recent first: when the
-- newest RECENT documents already hold `lim` matches, those are exactly the `lim` most recent matches, found by
-- walking the updated_at index; otherwise the tsv index after all. Same rows every way, so ranking and cursors agree.
CREATE FUNCTION search_candidates(q tsquery, containers text[], reader text, types text[], lim integer) RETURNS TABLE(entity_type text, entity_id text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $$
DECLARE
  recent CONSTANT integer := 20000;
  common CONSTANT integer := 5000;
  n integer := least(greatest(lim, 1), 5000);
  found integer;
  newest_first boolean := false;
BEGIN
  SELECT count(*) INTO found FROM (SELECT 1 FROM search_documents d WHERE d.tsv @@ q LIMIT common) x;
  IF found >= common THEN
    SELECT count(*) >= n INTO newest_first FROM (
      SELECT 1 FROM (SELECT d.* FROM search_documents d ORDER BY d.updated_at DESC LIMIT recent) d
       WHERE d.tsv @@ q
         AND (d.container_id = ANY (containers) OR d.acl_users && ARRAY[reader])
         AND (types IS NULL OR d.entity_type = ANY (types))
       LIMIT n) x;
  END IF;
  IF newest_first THEN
    RETURN QUERY
      SELECT d.entity_type, d.entity_id FROM (SELECT d.* FROM search_documents d ORDER BY d.updated_at DESC LIMIT recent) d
       WHERE d.tsv @@ q
         AND (d.container_id = ANY (containers) OR d.acl_users && ARRAY[reader])
         AND (types IS NULL OR d.entity_type = ANY (types))
       ORDER BY d.updated_at DESC
       LIMIT n;
  ELSIF found < common THEN
    -- Every match is in the probe's reach: take them from the tsv index and sort those (the planner, guessing a
    -- prefix query's matches, would otherwise walk the whole updated_at index looking for them).
    RETURN QUERY
      SELECT d.entity_type, d.entity_id FROM (SELECT d.* FROM search_documents d WHERE d.tsv @@ q LIMIT common) d
       WHERE (d.container_id = ANY (containers) OR d.acl_users && ARRAY[reader])
         AND (types IS NULL OR d.entity_type = ANY (types))
       ORDER BY d.updated_at DESC
       LIMIT n;
  ELSE
    RETURN QUERY
      SELECT d.entity_type, d.entity_id FROM search_documents d
       WHERE d.tsv @@ q
         AND (d.container_id = ANY (containers) OR d.acl_users && ARRAY[reader])
         AND (types IS NULL OR d.entity_type = ANY (types))
       ORDER BY d.updated_at DESC
       LIMIT n;
  END IF;
END
$$;

CREATE FUNCTION search_query_words(query text) RETURNS TABLE(word text, is_last boolean, near text[])
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path FROM CURRENT
    AS $_$
  WITH words AS (
    SELECT w.lexeme AS word, row_number() OVER (ORDER BY w.positions[1]) AS n
      FROM unnest(to_tsvector('workspace_search'::regconfig, left(query, 200))) AS w
     ORDER BY w.positions[1]
     LIMIT 8
  ), numbered AS (
    SELECT word, n = max(n) OVER () AS is_last, n FROM words
  )
  SELECT q.word, q.is_last,
         CASE WHEN length(q.word) < 3 OR q.word !~ '^[[:alpha:]]+$' OR EXISTS (
                SELECT 1 FROM search_terms k
                 WHERE k.word = q.word OR (q.is_last AND k.word LIKE q.word || '%')
              ) THEN '{}'::text[]
              ELSE ARRAY(
                SELECT t.word FROM search_terms t
                 WHERE t.word % q.word
                   AND levenshtein(t.word, q.word) <= CASE WHEN length(q.word) > 5 THEN 2 ELSE 1 END
                 ORDER BY levenshtein(t.word, q.word), similarity(t.word, q.word) DESC, t.word
                 LIMIT 3)
         END
    FROM numbered q
   ORDER BY q.n
$_$;

CREATE TEXT SEARCH CONFIGURATION workspace_search (
    PARSER = pg_catalog."default" );

ALTER TEXT SEARCH CONFIGURATION workspace_search
    ADD MAPPING FOR asciiword WITH unaccent, simple;

ALTER TEXT SEARCH CONFIGURATION workspace_search
    ADD MAPPING FOR word WITH unaccent, simple;

ALTER TEXT SEARCH CONFIGURATION workspace_search
    ADD MAPPING FOR numword WITH simple;

ALTER TEXT SEARCH CONFIGURATION workspace_search
    ADD MAPPING FOR email WITH simple;

ALTER TEXT SEARCH CONFIGURATION workspace_search
    ADD MAPPING FOR url WITH simple;

ALTER TEXT SEARCH CONFIGURATION workspace_search
    ADD MAPPING FOR host WITH simple;

ALTER TEXT SEARCH CONFIGURATION workspace_search
    ADD MAPPING FOR sfloat WITH simple;

ALTER TEXT SEARCH CONFIGURATION workspace_search
    ADD MAPPING FOR version WITH simple;

ALTER TEXT SEARCH CONFIGURATION workspace_search
    ADD MAPPING FOR hword_numpart WITH simple;

ALTER TEXT SEARCH CONFIGURATION workspace_search
    ADD MAPPING FOR hword_part WITH unaccent, simple;

ALTER TEXT SEARCH CONFIGURATION workspace_search
    ADD MAPPING FOR hword_asciipart WITH unaccent, simple;

ALTER TEXT SEARCH CONFIGURATION workspace_search
    ADD MAPPING FOR numhword WITH simple;

ALTER TEXT SEARCH CONFIGURATION workspace_search
    ADD MAPPING FOR asciihword WITH unaccent, simple;

ALTER TEXT SEARCH CONFIGURATION workspace_search
    ADD MAPPING FOR hword WITH unaccent, simple;

ALTER TEXT SEARCH CONFIGURATION workspace_search
    ADD MAPPING FOR url_path WITH simple;

ALTER TEXT SEARCH CONFIGURATION workspace_search
    ADD MAPPING FOR file WITH simple;

ALTER TEXT SEARCH CONFIGURATION workspace_search
    ADD MAPPING FOR "float" WITH simple;

ALTER TEXT SEARCH CONFIGURATION workspace_search
    ADD MAPPING FOR "int" WITH simple;

ALTER TEXT SEARCH CONFIGURATION workspace_search
    ADD MAPPING FOR uint WITH simple;

-- ── Tables ───────────────────────────────────────────────────────────────────────────────────────

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
    -- Events are delivered inside the server process (ADR 0021), so `dlq replay` (a separate process) requests a
    -- replay instead of performing it: the server's replay job delivers the row and stamps replayed_at.
    replay_requested_at timestamp with time zone,
    CONSTRAINT dead_events_consumer_stream_entry_id_key UNIQUE (consumer, stream, entry_id),
    CONSTRAINT dead_events_pkey PRIMARY KEY (id)
);

CREATE TABLE search_documents (
    entity_type text NOT NULL,
    entity_id text NOT NULL,
    container_id text NOT NULL,
    acl_users text[] DEFAULT '{}'::text[] NOT NULL,
    title text DEFAULT ''::text NOT NULL,
    body text DEFAULT ''::text NOT NULL,
    url text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    tsv tsvector GENERATED ALWAYS AS ((setweight(to_tsvector('workspace_search'::regconfig, title), 'A'::"char") || setweight(to_tsvector('workspace_search'::regconfig, "left"(body, 200000)), 'B'::"char"))) STORED,
    rank_tsv tsvector GENERATED ALWAYS AS ((setweight(to_tsvector('workspace_search'::regconfig, title), 'A'::"char") || setweight(to_tsvector('workspace_search'::regconfig, "left"(body, 1000)), 'B'::"char"))) STORED,
    CONSTRAINT search_documents_entity_type_check CHECK ((entity_type = ANY (ARRAY['message'::text, 'thread'::text, 'channel'::text, 'task'::text, 'project'::text, 'document'::text, 'file'::text, 'person'::text, 'whiteboard'::text]))),
    CONSTRAINT search_documents_pkey PRIMARY KEY (entity_type, entity_id)
);

-- Per-word frequencies for the planner (search_candidates): the default sample is too small to tell a common word
-- from a rare one.
ALTER TABLE search_documents ALTER COLUMN tsv SET STATISTICS 1000;

CREATE TABLE search_terms (
    word text NOT NULL,
    CONSTRAINT search_terms_pkey PRIMARY KEY (word)
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

CREATE INDEX dead_events_replay_requested_idx ON dead_events USING btree (id) WHERE ((replay_requested_at IS NOT NULL) AND (replayed_at IS NULL));
CREATE INDEX dead_events_waiting_idx ON dead_events USING btree (failed_at) WHERE (replayed_at IS NULL);
CREATE INDEX search_documents_acl_idx ON search_documents USING gin (acl_users);
CREATE INDEX search_documents_container_idx ON search_documents USING btree (container_id);
CREATE INDEX search_documents_tsv_idx ON search_documents USING gin (tsv);
CREATE INDEX search_documents_updated_idx ON search_documents USING btree (updated_at DESC);
CREATE INDEX search_terms_trgm_idx ON search_terms USING gin (word gin_trgm_ops);

-- ── Grants ───────────────────────────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION search_candidates(q tsquery, containers text[], reader text, types text[], lim integer) FROM PUBLIC;
GRANT ALL ON FUNCTION search_candidates(q tsquery, containers text[], reader text, types text[], lim integer) TO workspace_search_rw;
REVOKE ALL ON FUNCTION search_query_words(query text) FROM PUBLIC;
GRANT ALL ON FUNCTION search_query_words(query text) TO workspace_search_rw;
GRANT INSERT ON TABLE dead_events TO workspace_search_rw;
-- The maintenance role queues outbox replays here too (`dlq outbox-replay`).
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE dead_events TO workspace_maintenance;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE search_documents TO workspace_search_rw;
GRANT SELECT ON TABLE search_documents TO workspace_maintenance;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE search_terms TO workspace_search_rw;
GRANT SELECT ON TABLE search_terms TO workspace_maintenance;

-- ── SECURITY DEFINER functions run as workspace_maintenance ──────────────────────────────────────

ALTER FUNCTION search_candidates(q tsquery, containers text[], reader text, types text[], lim integer) OWNER TO workspace_maintenance;
ALTER FUNCTION search_query_words(query text) OWNER TO workspace_maintenance;

-- ── Search readers ───────────────────────────────────────────────────────────────────────────────

-- Readers outside the indexer (chat's search endpoint) get the documents and the two lookup
-- functions, nothing else.
DO $$
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO workspace_search_reader', current_schema());
END
$$;
GRANT SELECT ON TABLE search_documents TO workspace_search_reader;
GRANT ALL ON FUNCTION search_candidates(q tsquery, containers text[], reader text, types text[], lim integer) TO workspace_search_reader;
GRANT ALL ON FUNCTION search_query_words(query text) TO workspace_search_reader;

-- ── Tables added by later migrations get the usual read/write grants (narrow them there if needed) ────

DO $$
BEGIN
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE workspace_owner IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO workspace_search_rw', current_schema());
END
$$;
