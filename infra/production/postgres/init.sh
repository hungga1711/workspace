#!/bin/sh
# First start of the production Postgres (docker-entrypoint-initdb.d; runs only on an empty data dir).
# Same layout as infra/local/postgres/init.sql (local dev), with passwords from the environment:
#   PG_OWNER_PASSWORD  workspace_owner: owns the database's schemas, runs migrations
#   PG_APP_PASSWORD    workspace_<module>: the login role of each module (identity, platform, chat, work, home,
#                      employee, ai, search) and of the web app (web: its session store); each may use its own
#                      schema only
# The database is `workspace`, one schema per module; the migrations create the schemas.
set -e
: "${PG_OWNER_PASSWORD:?PG_OWNER_PASSWORD must be set}"
: "${PG_APP_PASSWORD:?PG_APP_PASSWORD must be set}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v owner_pw="$PG_OWNER_PASSWORD" -v app_pw="$PG_APP_PASSWORD" <<'SQL'
CREATE ROLE workspace_owner LOGIN PASSWORD :'owner_pw';
-- Owns narrow SECURITY DEFINER functions for maintenance jobs (outbox relay, retention). Nobody logs in as it.
CREATE ROLE workspace_maintenance NOLOGIN;
GRANT workspace_maintenance TO workspace_owner;
CREATE DATABASE workspace OWNER workspace_owner;
REVOKE ALL ON DATABASE workspace FROM PUBLIC;

-- Per module: workspace_<m>_rw holds the schema's grants (from its baseline migration); workspace_<m> logs in
-- with only that role and search_path = <m>, public.
SELECT set_config('workspace.app_pw', :'app_pw', false);
DO $$
DECLARE m text;
BEGIN
  FOREACH m IN ARRAY ARRAY['identity', 'platform', 'chat', 'work', 'home', 'employee', 'ai', 'search', 'web'] LOOP
    EXECUTE format('CREATE ROLE %I NOLOGIN', 'workspace_' || m || '_rw');
    EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L IN ROLE %I', 'workspace_' || m, current_setting('workspace.app_pw'), 'workspace_' || m || '_rw');
    EXECUTE format('ALTER ROLE %I SET search_path = %I, public', 'workspace_' || m, m);
    EXECUTE format('GRANT CONNECT ON DATABASE workspace TO %I', 'workspace_' || m);
  END LOOP;
END
$$;
SELECT set_config('workspace.app_pw', '', false);
-- Chat's search endpoint reads the search schema (documents and two lookup functions), nothing more.
CREATE ROLE workspace_search_reader NOLOGIN;
GRANT workspace_search_reader TO workspace_chat;
SQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname workspace <<'SQL'
-- public holds the extensions only (unaccent, pg_trgm, fuzzystrmatch); only the owner creates there.
ALTER SCHEMA public OWNER TO workspace_owner;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SQL
