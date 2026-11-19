-- One database, `workspace`, with a schema per module (identity, platform, chat, work, home, employee, ai, search),
-- and `web` for the web app's sessions.
-- The schemas themselves are created by the migrations (backend/packages/service-kit/src/migrate.ts); this file only
-- creates the roles. Production does the same with real passwords: infra/production/postgres/init.sh.
--
-- Roles:
--   workspace_owner        runs migrations and owns every object (LOGIN). Never used by a request.
--   workspace_maintenance  owns the narrow SECURITY DEFINER functions the module roles may call but not write
--                          themselves (outbox relay, retention sweeps). NOLOGIN: nobody connects as it.
--   workspace_<m>_rw       what module <m> may touch: USAGE on schema <m> and the grants of its baseline. NOLOGIN.
--   workspace_<m>          the login role of module <m>'s pool: member of workspace_<m>_rw only,
--                          search_path = <m>, public.
-- The server opens one pool per module role; modules never share a role.
CREATE ROLE workspace_owner LOGIN PASSWORD 'owner_pw';
CREATE ROLE workspace_maintenance NOLOGIN;
GRANT workspace_maintenance TO workspace_owner;

DO $$
DECLARE m text;
BEGIN
  FOREACH m IN ARRAY ARRAY['identity', 'platform', 'chat', 'work', 'home', 'employee', 'ai', 'search', 'web'] LOOP
    EXECUTE format('CREATE ROLE %I NOLOGIN', 'workspace_' || m || '_rw');
    EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L IN ROLE %I', 'workspace_' || m, 'app_pw', 'workspace_' || m || '_rw');
    EXECUTE format('ALTER ROLE %I SET search_path = %I, public', 'workspace_' || m, m);
    EXECUTE format('GRANT CONNECT ON DATABASE workspace TO %I', 'workspace_' || m);
  END LOOP;
END
$$;
-- Chat's search endpoint reads the search schema (documents and two lookup functions), nothing more.
CREATE ROLE workspace_search_reader NOLOGIN;
GRANT workspace_search_reader TO workspace_chat;

-- Development only: the shared package's tests use their own tables in schema public.
CREATE ROLE workspace_app LOGIN PASSWORD 'app_pw';
GRANT CONNECT ON DATABASE workspace TO workspace_app;

REVOKE ALL ON DATABASE workspace FROM PUBLIC;
GRANT ALL ON DATABASE workspace TO workspace_owner;
\c workspace
-- public holds the extensions only (unaccent, pg_trgm, fuzzystrmatch); only the owner creates there.
ALTER SCHEMA public OWNER TO workspace_owner;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO workspace_app;
ALTER DEFAULT PRIVILEGES FOR ROLE workspace_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO workspace_app;
